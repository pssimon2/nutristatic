// ByteSource over a local File (offline mode): reads chunks on demand with
// File.slice() — the same "fetch only what a query touches" model as the HTTP
// range source, but backed by disk instead of the network, so a multi-GB
// local index opens instantly and never loads whole into RAM. No server
// needed; this is what the double-click offline build uses.

import { ByteSource, ViewHolder } from "./byte-source.js";

export class FileRangeSource implements ByteSource {
  readonly length: number;
  bytesFetched = 0; // bytes read from disk (mirrors the HTTP source's stat)
  requests = 0;
  private readonly cache = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<void>>();

  constructor(
    private readonly file: Blob,
    private readonly chunkSize = 1 << 16,
    // Local reads are cheap, but a broad search still touches a large working
    // set; cap the cache so a huge index doesn't accumulate unbounded.
    private readonly maxChunks = 8192,
  ) {
    this.length = file.size;
  }

  ensure(start: number, end: number): void | Promise<void> {
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    const missing: number[] = [];
    for (let c = first; c <= last; ++c) {
      if (!this.cache.has(c)) missing.push(c);
    }
    if (missing.length === 0) return;
    return Promise.all(missing.map((c) => this.load(c))).then(() => {});
  }

  private load(c: number): Promise<void> {
    const existing = this.inflight.get(c);
    if (existing) return existing;
    const startByte = c * this.chunkSize;
    const endByte = Math.min(startByte + this.chunkSize, this.length);
    const p = this.file
      .slice(startByte, endByte)
      .arrayBuffer()
      .then((buf) => {
        this.bytesFetched += buf.byteLength;
        ++this.requests;
        this.insert(c, new Uint8Array(buf));
        this.inflight.delete(c);
      });
    this.inflight.set(c, p);
    return p;
  }

  private insert(c: number, data: Uint8Array): void {
    this.cache.set(c, data);
    if (this.cache.size > this.maxChunks) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }

  byte(pos: number): number {
    const c = Math.floor(pos / this.chunkSize);
    const chunk = this.cache.get(c);
    if (!chunk) throw new Error(`byte ${pos} not ensured`);
    return chunk[pos - c * this.chunkSize];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const c = Math.floor(start / this.chunkSize);
    if (c !== Math.floor((end - 1) / this.chunkSize)) return false;
    const chunk = this.cache.get(c);
    if (!chunk) return false;
    // Refresh LRU recency, matching byte() reads.
    this.cache.delete(c);
    this.cache.set(c, chunk);
    out.bytes = chunk;
    out.base = c * this.chunkSize;
    return true;
  }
}
