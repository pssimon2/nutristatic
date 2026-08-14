// Random-access byte sources backing an index file.
//
// The index trie is read with small backwards scans from node offsets, so a
// source only needs: total length, "make [start,end) available", and
// single-byte reads. ensure() may complete synchronously (memory) or return a
// promise (HTTP Range fetch); callers use maybeAsync() to stay on the fast
// path when everything is already cached.

/** Reusable holder for view(): bytes[pos - base] is the byte at file offset pos. */
export class ViewHolder {
  bytes: Uint8Array = new Uint8Array(0);
  base = 0;
}

export interface ByteSource {
  readonly length: number;
  /** Make bytes [start, end) available for byte(). May resolve synchronously. */
  ensure(start: number, end: number): void | Promise<void>;
  /** Read one byte inside a previously ensured range. */
  byte(pos: number): number;
  /**
   * Fill `out` with a contiguous view covering the previously ensured range
   * [start, end) if one is cheaply available; returns false if the range is
   * not contiguous in memory (caller falls back to byte()).
   */
  view(start: number, end: number, out: ViewHolder): boolean;
}

/** Await only if needed, keeping the common cached case synchronous. */
export function maybeAsync<T>(
  prep: void | Promise<void>,
  fn: () => T,
): T | Promise<T> {
  if (prep) return prep.then(fn);
  return fn();
}

export class MemorySource implements ByteSource {
  constructor(private readonly data: Uint8Array) {}
  get length(): number {
    return this.data.length;
  }
  ensure(): void {}
  byte(pos: number): number {
    return this.data[pos];
  }
  view(_start: number, _end: number, out: ViewHolder): boolean {
    out.bytes = this.data;
    out.base = 0;
    return true;
  }
}

/** Optional persistent store for fetched chunks (e.g. browser Cache API). */
export interface ChunkStore {
  get(chunk: number): Promise<Uint8Array | undefined>;
  /** Fire-and-forget; failures must be swallowed by the store. */
  put(chunk: number, data: Uint8Array): void;
}

export interface HttpRangeSourceOptions {
  chunkSize?: number;
  maxChunks?: number;
  fetchFn?: typeof fetch;
  chunkStore?: ChunkStore;
}

/**
 * Reads an index served as a plain static file, fetching fixed-size chunks
 * with HTTP Range requests and keeping an LRU cache. This is what lets a
 * multi-gigabyte index live on any static host with no server-side code.
 */
export class HttpRangeSource implements ByteSource {
  private readonly cache = new Map<number, Uint8Array>();
  // Chunks currently being loaded, so concurrent ensure()/prefetch calls for
  // the same chunk share one request instead of double-fetching.
  private readonly inflight = new Map<number, Promise<void>>();
  bytesFetched = 0;
  requests = 0;
  /** Whether the probe confirmed the server honors Range requests. */
  supportsRanges = false;

  private constructor(
    private readonly url: string,
    readonly length: number,
    private readonly chunkSize: number,
    private readonly maxChunks: number,
    private readonly fetchFn: typeof fetch,
    private readonly chunkStore?: ChunkStore,
  ) {}

  static async open(
    url: string,
    opts: HttpRangeSourceOptions = {},
  ): Promise<HttpRangeSource> {
    const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    // Probe with a 1-byte range GET: works on static hosts that disallow
    // HEAD, and verifies Range support in one round trip.
    const probe = await fetchFn(url, { headers: { Range: "bytes=0-0" } });
    if (!probe.ok) throw new Error(`can't fetch ${url}: HTTP ${probe.status}`);
    let length: number;
    let supportsRanges = false;
    const contentRange = probe.headers.get("content-range");
    if (probe.status === 206 && contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (!m) throw new Error(`bad Content-Range from ${url}: ${contentRange}`);
      length = parseInt(m[1], 10);
      supportsRanges = true;
    } else {
      // Server ignored the Range header; it must have sent the whole file.
      const len = probe.headers.get("content-length");
      if (!len) throw new Error(`no Content-Length from ${url}`);
      length = parseInt(len, 10);
    }
    await probe.body?.cancel();
    const source = new HttpRangeSource(
      url,
      length,
      opts.chunkSize ?? 1 << 16,
      opts.maxChunks ?? 1024,
      fetchFn,
      opts.chunkStore,
    );
    source.supportsRanges = supportsRanges;
    return source;
  }

  ensure(start: number, end: number): void | Promise<void> {
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    let missing: number[] | null = null;
    for (let c = first; c <= last; ++c) {
      const hit = this.cache.get(c);
      if (hit) {
        // Refresh LRU position (Map preserves insertion order).
        this.cache.delete(c);
        this.cache.set(c, hit);
      } else {
        (missing ??= []).push(c);
      }
    }
    if (!missing) return;
    return this.loadChunks(missing);
  }

  private loadChunks(missing: number[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const mine: number[] = [];
    for (const c of missing) {
      const shared = this.inflight.get(c);
      if (shared) waits.push(shared);
      else mine.push(c);
    }
    if (mine.length > 0) {
      const p = this.loadOwnChunks(mine).finally(() => {
        for (const c of mine) this.inflight.delete(c);
      });
      for (const c of mine) this.inflight.set(c, p);
      waits.push(p);
    }
    return Promise.all(waits).then(() => {});
  }

  private async loadOwnChunks(missing: number[]): Promise<void> {
    // Consult the persistent store first; only truly-missing chunks go to the
    // network.
    let still = missing;
    if (this.chunkStore) {
      still = [];
      for (const c of missing) {
        const hit = await this.chunkStore.get(c);
        if (hit && hit.length > 0) this.insertChunk(c, hit, false);
        else still.push(c);
      }
    }
    if (still.length > 0) {
      await this.fetchChunks(still[0], still[still.length - 1]);
    }
  }

  private async fetchChunks(firstChunk: number, lastChunk: number): Promise<void> {
    const start = firstChunk * this.chunkSize;
    const end = Math.min((lastChunk + 1) * this.chunkSize, this.length) - 1;
    const resp = await this.fetchFn(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok) {
      throw new Error(`range fetch failed for ${this.url}: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (resp.status !== 206 && buf.length !== end - start + 1) {
      throw new Error(`server at ${this.url} does not support Range requests`);
    }
    this.requests += 1;
    this.bytesFetched += buf.length;
    for (let c = firstChunk; c <= lastChunk; ++c) {
      const off = (c - firstChunk) * this.chunkSize;
      this.insertChunk(c, buf.subarray(off, off + this.chunkSize), true);
    }
    while (this.cache.size > this.maxChunks) {
      const oldest = this.cache.keys().next().value!;
      if (oldest >= firstChunk && oldest <= lastChunk) break; // keep what we just loaded
      this.cache.delete(oldest);
    }
  }

  private insertChunk(c: number, data: Uint8Array, persist: boolean): void {
    this.cache.set(c, data);
    if (persist) this.chunkStore?.put(c, data);
  }

  byte(pos: number): number {
    const chunk = this.cache.get(Math.floor(pos / this.chunkSize));
    if (!chunk) throw new Error(`byte ${pos} not ensured`);
    return chunk[pos % this.chunkSize];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const c = Math.floor(start / this.chunkSize);
    if (c !== Math.floor((end - 1) / this.chunkSize)) return false;
    const chunk = this.cache.get(c);
    if (!chunk) return false;
    // Refresh LRU position, matching what byte() reads would have done.
    this.cache.delete(c);
    this.cache.set(c, chunk);
    out.bytes = chunk;
    out.base = c * this.chunkSize;
    return true;
  }
}
