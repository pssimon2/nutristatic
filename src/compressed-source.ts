// ByteSource over a .idxz sidecar: fetches compressed block ranges and
// decompresses in the client, roughly halving range-mode transfer sizes.
// Mirrors HttpRangeSource's behavior: LRU of (decompressed) blocks, in-flight
// dedupe, persistent chunk store, bandwidth/RTT estimation with post-order
// backward read-ahead, and budgeted speculative prefetch.

import { ByteSource, ChunkStore, ViewHolder } from "./byte-source.js";
import {
  IDXZ_HEADER_SIZE,
  IdxzHeader,
  inflateRawBlock,
  parseIdxzHeader,
  parseIdxzTable,
} from "./idxz.js";

/** Persistence for the sidecar's header+table prefix across visits. */
export interface TableStore {
  get(): Promise<Uint8Array | undefined>;
  /** Fire-and-forget; failures must be swallowed by the store. */
  put(data: Uint8Array): void;
}

export interface CompressedRangeSourceOptions {
  maxBlocks?: number;
  fetchFn?: typeof fetch;
  /**
   * Store factory invoked with the sidecar's actual block size, which must
   * be part of the store's key namespace (block indexes are meaningless
   * across different block sizes).
   */
  makeStore?: (blockSize: number) => ChunkStore | undefined;
  /** Cache for the header+table prefix (skips its fetch on revisits). */
  tableStore?: TableStore;
  /**
   * Sidecar prefix bytes fetched ahead of time (e.g. by the page before the
   * worker booted). Validated like any other source; ignored when invalid.
   */
  prefixBytes?: Uint8Array;
}

export class CompressedRangeSource implements ByteSource {
  private readonly cache = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<void>>();
  bytesFetched = 0; // compressed bytes over the wire
  requests = 0;
  private ewmaBw = 1e6;
  private ewmaRtt = 0.08;

  private constructor(
    private readonly sidecarUrl: string,
    private readonly header: IdxzHeader,
    private readonly table: Float64Array,
    private readonly maxBlocks: number,
    private readonly fetchFn: typeof fetch,
    private readonly chunkStore?: ChunkStore,
  ) {}

  get length(): number {
    return this.header.uncompressedSize;
  }

  /** Compression ratio (compressed/uncompressed), for diagnostics. */
  get ratio(): number {
    return this.table[this.header.numBlocks] / this.header.uncompressedSize;
  }

  /**
   * Open `indexUrl`'s sidecar (`<indexUrl>.idxz`). Returns null if the
   * sidecar is missing, malformed, or stale (wrong uncompressed size) —
   * callers then fall back to plain ranges.
   */
  static async open(
    indexUrl: string,
    expectedSize: number,
    opts: CompressedRangeSourceOptions = {},
  ): Promise<CompressedRangeSource | null> {
    const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    const url = indexUrl + ".idxz";
    try {
      // A cached header+table prefix skips all table traffic on revisits.
      let prefix = await opts.tableStore?.get().catch(() => undefined);
      let header = prefix ? parseIdxzHeader(prefix) : null;
      if (
        !header ||
        header.uncompressedSize !== expectedSize ||
        prefix!.length < header.dataStart
      ) {
        prefix = undefined;
        header = null;
      }

      // Fetch the remainder when a first chunk didn't cover the table.
      const complete = async (
        buf: Uint8Array,
        h: IdxzHeader,
      ): Promise<Uint8Array | null> => {
        if (buf.length >= h.dataStart) return buf.subarray(0, h.dataStart);
        const rest = await fetchFn(url, {
          headers: { Range: `bytes=${buf.length}-${h.dataStart - 1}` },
        });
        if (!rest.ok) return null;
        const more = new Uint8Array(await rest.arrayBuffer());
        const joined = new Uint8Array(h.dataStart);
        joined.set(buf);
        joined.set(more, buf.length);
        return joined;
      };

      // Prefix bytes handed in by an early page-side fetch.
      if (!prefix && opts.prefixBytes) {
        const h = parseIdxzHeader(opts.prefixBytes);
        if (h && h.uncompressedSize === expectedSize) {
          const full = await complete(opts.prefixBytes, h);
          if (full) {
            header = h;
            prefix = full;
            opts.tableStore?.put(prefix.slice());
          }
        }
      }

      if (!prefix) {
        // Optimistic first fetch: 64KB covers header+table for indexes up
        // to roughly 2GB, making the open a single round trip.
        const first = await fetchFn(url, { headers: { Range: "bytes=0-65535" } });
        if (!first.ok) return null;
        const buf = new Uint8Array(await first.arrayBuffer());
        header = parseIdxzHeader(buf);
        if (!header || header.uncompressedSize !== expectedSize) return null;
        const full = await complete(buf, header);
        if (!full) return null;
        prefix = full;
        opts.tableStore?.put(prefix.slice());
      }
      if (!header || !prefix) return null;

      const table = await parseIdxzTable(
        prefix.subarray(IDXZ_HEADER_SIZE, header.dataStart),
        header.numBlocks,
      );
      if (!table) return null;

      return new CompressedRangeSource(
        url,
        header,
        table,
        opts.maxBlocks ?? 4096,
        fetchFn,
        opts.makeStore?.(header.blockSize),
      );
    } catch {
      return null;
    }
  }

  ensure(start: number, end: number): void | Promise<void> {
    return this.ensureInternal(start, end);
  }

  private ensureInternal(start: number, end: number): void | Promise<void> {
    const bs = this.header.blockSize;
    const first = Math.floor(start / bs);
    const last = Math.floor((end - 1) / bs);
    let missing: number[] | null = null;
    for (let b = first; b <= last; ++b) {
      const hit = this.cache.get(b);
      if (hit) {
        this.cache.delete(b);
        this.cache.set(b, hit);
      } else {
        (missing ??= []).push(b);
      }
    }
    if (!missing) return;
    return this.loadBlocks(missing);
  }

  private loadBlocks(missing: number[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const mine: number[] = [];
    for (const b of missing) {
      const shared = this.inflight.get(b);
      if (shared) waits.push(shared);
      else mine.push(b);
    }
    if (mine.length > 0) {
      const p = this.loadOwnBlocks(mine).finally(() => {
        for (const b of mine) this.inflight.delete(b);
      });
      for (const b of mine) this.inflight.set(b, p);
      waits.push(p);
    }
    return Promise.all(waits).then(() => {});
  }

  private async loadOwnBlocks(missing: number[]): Promise<void> {
    let still = missing;
    if (this.chunkStore) {
      still = [];
      for (const b of missing) {
        const hit = await this.chunkStore.get(b);
        if (hit && hit.length > 0) this.insertBlock(b, hit, false);
        else still.push(b);
      }
    }
    if (still.length === 0) return;

    // Backward read-ahead by bandwidth-delay product, in compressed bytes
    // (descendants precede a node in the post-order index layout), capped at
    // 32 blocks like the uncompressed source — an uncapped BDP on a fast
    // link would balloon into fetching large fractions of the index.
    const budget = this.ewmaBw * this.ewmaRtt;
    let first = still[0];
    let extra = 0;
    while (
      first > 0 &&
      still[0] - first < 32 &&
      extra + (this.table[first] - this.table[first - 1]) <= budget &&
      !this.cache.has(first - 1) &&
      !this.inflight.has(first - 1)
    ) {
      --first;
      extra += this.table[first + 1] - this.table[first];
    }

    const lastBlock = still[still.length - 1];
    const compStart = this.header.dataStart + this.table[first];
    const compEnd = this.header.dataStart + this.table[lastBlock + 1] - 1;
    const t0 = Date.now();
    const resp = await this.fetchFn(this.sidecarUrl, {
      headers: { Range: `bytes=${compStart}-${compEnd}` },
    });
    if (!resp.ok) {
      throw new Error(`idxz fetch failed: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length !== compEnd - compStart + 1) {
      throw new Error(`idxz short response (${buf.length} bytes)`);
    }
    this.requests += 1;
    this.bytesFetched += buf.length;
    const dt = Math.max(0.001, (Date.now() - t0) / 1000);
    const rttSample = Math.max(0.005, dt - buf.length / this.ewmaBw);
    this.ewmaRtt = 0.8 * this.ewmaRtt + 0.2 * rttSample;
    const bwSample = buf.length / Math.max(0.005, dt - this.ewmaRtt);
    this.ewmaBw = 0.8 * this.ewmaBw + 0.2 * Math.min(bwSample, 5e8);

    const jobs: Promise<void>[] = [];
    for (let b = first; b <= lastBlock; ++b) {
      const off = this.table[b] - this.table[first];
      const len = this.table[b + 1] - this.table[b];
      jobs.push(
        inflateRawBlock(buf.subarray(off, off + len)).then((data) => {
          const expected = Math.min(
            this.header.blockSize,
            this.length - b * this.header.blockSize,
          );
          if (data.length !== expected) {
            throw new Error(`idxz block ${b} decompressed to ${data.length}`);
          }
          this.insertBlock(b, data, true);
        }),
      );
    }
    await Promise.all(jobs);
    this.evict(first, lastBlock);
  }

  private insertBlock(b: number, data: Uint8Array, persist: boolean): void {
    this.cache.set(b, data);
    if (persist) this.chunkStore?.put(b, data);
  }

  private evict(keepFirst: number, keepLast: number): void {
    while (this.cache.size > this.maxBlocks) {
      const oldest = this.cache.keys().next().value!;
      if (oldest >= keepFirst && oldest <= keepLast) break;
      this.cache.delete(oldest);
    }
  }

  byte(pos: number): number {
    const bs = this.header.blockSize;
    const block = this.cache.get(Math.floor(pos / bs));
    if (!block) throw new Error(`byte ${pos} not ensured`);
    return block[pos % bs];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const bs = this.header.blockSize;
    const b = Math.floor(start / bs);
    if (b !== Math.floor((end - 1) / bs)) return false;
    const block = this.cache.get(b);
    if (!block) return false;
    this.cache.delete(b);
    this.cache.set(b, block);
    out.bytes = block;
    out.base = b * bs;
    return true;
  }

  prefetchHint(start: number, end: number): void {
    const budget = Math.max(
      1,
      Math.floor((this.ewmaBw * this.ewmaRtt) / (this.header.blockSize / 2)),
    );
    if (this.inflight.size >= budget) return;
    const r = this.ensureInternal(start, end);
    if (r) r.catch(() => {});
  }
}
