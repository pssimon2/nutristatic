// Search worker: owns the index and the search session so the UI thread
// stays responsive. The index is fetched fully into memory when small;
// larger indexes are read lazily with HTTP Range requests, so even a
// multi-gigabyte index needs nothing but static file hosting.

import {
  ChunkStore,
  HttpRangeSource,
  MemorySource,
  SyncFileReader,
  SyncFileSource,
} from "../src/byte-source.js";
import { CompressedRangeSource } from "../src/compressed-source.js";
import { inflateRawBlock, parseIdxzHeader, parseIdxzTable } from "../src/idxz.js";
import { IndexReader } from "../src/index-reader.js";
import { ParseError } from "../src/find-expr.js";
import { SearchSession } from "../src/search-session.js";

// Indexes up to this size are simply downloaded; everything bigger defaults
// to Range mode (fetch only what a query touches) unless a full copy is
// already in the browser cache. The user can explicitly download the whole
// index ("download-full") for offline/faster searching.
const TINY_LIMIT = 4 * 1024 * 1024;
// Absolute ceiling for whole-index downloads: covers the 1.3GB Wikipedia
// index — a one-time download into the browser cache buys memory-speed
// searches (the heavy-anagram case drops from ~30s to under a second).
const FULL_DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
// Full downloads happen in ranged pieces with per-piece retry, so a flaky
// (especially mobile) connection doesn't restart the whole transfer. A few
// pieces stream concurrently to keep the pipe full across RTTs.
const DOWNLOAD_PIECE = 4 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Fetch [0, size) in retried pieces, DOWNLOAD_CONCURRENCY at a time, handing
 * each completed piece to `write(part, offset)` (offset-addressed, so
 * completion order doesn't matter). Reports progress as bytes completed.
 */
async function fetchPieces(
  url: string,
  size: number,
  write: (part: Uint8Array, offset: number) => void,
): Promise<void> {
  let nextOffset = 0;
  let loaded = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const off = nextOffset;
      if (off >= size) return;
      nextOffset += DOWNLOAD_PIECE;
      const end = Math.min(off + DOWNLOAD_PIECE, size) - 1;
      const resp = await fetchWithRetry(url, {
        headers: { Range: `bytes=${off}-${end}` },
      });
      const part = new Uint8Array(await resp.arrayBuffer());
      if (part.length !== end - off + 1) {
        throw new Error(`short range response (${part.length} bytes at ${off})`);
      }
      write(part, off);
      loaded += part.length;
      post({ type: "loading", mode: "download", bytes: size, loaded });
    }
  };
  await Promise.all(
    Array.from({ length: DOWNLOAD_CONCURRENCY }, () => runner()),
  );
}
const CACHE_NAME = "nutrimatic-index-v1";
// v2: chunk keys now include the chunk size — entries cached under a
// different chunking must never be reinterpreted.
const CHUNK_CACHE_NAME = "nutrimatic-chunks-v2";
const RANGE_CHUNK_SIZE = 1 << 15;
// Range mode: prewarm this much of the file tail (trie root region), and
// keep this many parallel prefetches going during a search. The prewarm is
// deliberately small and non-blocking: on slow links upfront bytes delay the
// first result, which is the metric that matters.
const PREWARM_BYTES = 128 * 1024;
// Broad searches (anagrams especially) have wide frontiers: deep speculative
// prefetch turns serial fetch stalls into parallel transfers.
const PREFETCH_DEPTH = 48;

interface EarlyProbe {
  ok: boolean;
  status: number;
  contentRange: string | null;
  contentLength: string | null;
}

interface OpenMsg {
  type: "open";
  url: string;
  early?: {
    probe: EarlyProbe | null;
    table: ArrayBuffer | null;
  };
}
interface SearchMsg {
  type: "search";
  query: string;
  maxSteps: number;
  maxResults: number;
}
interface ContinueMsg {
  type: "continue";
  maxSteps: number;
  maxResults: number;
}
interface StopMsg {
  type: "stop";
}
interface DownloadFullMsg {
  type: "download-full";
}
type InMsg = OpenMsg | SearchMsg | ContinueMsg | StopMsg | DownloadFullMsg;

let reader: IndexReader | null = null;
let rangeSource: HttpRangeSource | CompressedRangeSource | null = null;
let diskSource: SyncFileSource | null = null;
let session: SearchSession | null = null;
let runToken = 0; // bumped to cancel an in-flight run
let currentUrl: string | null = null;
let currentSize = 0;

const post = (msg: unknown) => postMessage(msg);

// Macrotask yield that lets queued messages (stop/continue) be processed.
// Deliberately NOT setTimeout: browsers clamp timers in background pages to
// ~1s, which turned a 1M-step search into ~50 seconds of sleeping when the
// tab wasn't focused. MessageChannel posts are never throttled.
const yieldChannel = new MessageChannel();
let yieldResolve: (() => void) | null = null;
yieldChannel.port1.onmessage = () => {
  const r = yieldResolve;
  yieldResolve = null;
  r?.();
};
function macroYield(): Promise<void> {
  return new Promise((resolve) => {
    yieldResolve = resolve;
    yieldChannel.port2.postMessage(0);
  });
}

async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempts = 4,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; ++i) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
      if (resp.status >= 400 && resp.status < 500) break; // no point retrying
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function openCache(name = CACHE_NAME): Promise<Cache | null> {
  try {
    return await caches.open(name);
  } catch {
    return null; // no Cache API (or private mode restrictions): just refetch
  }
}

// ---- OPFS-backed index storage ----
// Downloaded indexes live in the origin-private filesystem and are read with
// synchronous access handles: instant open (no whole-file load into RAM) and
// near-memory search speed via a small chunk LRU over OS-cached disk reads.

function opfsName(url: string): string {
  return "idx-" + encodeURIComponent(url);
}

async function opfsHandle(
  url: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getFileHandle(opfsName(url), { create });
  } catch {
    return null; // OPFS unavailable (old browser, private mode, no worker)
  }
}

/** Open a previously downloaded index from OPFS, or null. */
async function openOpfsIndex(
  url: string,
  expectedSize: number,
): Promise<SyncFileSource | null> {
  const handle = await opfsHandle(url, false);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    if (file.size !== expectedSize) {
      // Stale copy (index replaced on the server): drop it.
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsName(url));
      return null;
    }
    // The previous page's worker may not have released its lock yet right
    // after a reload: retry briefly before giving up.
    for (let attempt = 0; ; ++attempt) {
      try {
        const sync = await (handle as any).createSyncAccessHandle();
        return new SyncFileSource(sync as SyncFileReader, expectedSize);
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  } catch {
    return null; // locked by another tab, or sync handles unsupported
  }
}

/** Download the index into OPFS (retried pieces); null if OPFS unavailable. */
async function downloadToOpfs(
  url: string,
  size: number,
): Promise<SyncFileSource | null> {
  const handle = await opfsHandle(url, true);
  if (!handle) return null;
  let sync: any;
  try {
    sync = await (handle as any).createSyncAccessHandle();
  } catch {
    return null;
  }
  try {
    sync.truncate(0);
    const viaZ = await downloadViaSidecar(url, size, (part, off) =>
      sync.write(part, { at: off }),
    );
    if (!viaZ) {
      await fetchPieces(url, size, (part, off) => sync.write(part, { at: off }));
    }
    sync.flush();
    return new SyncFileSource(sync as SyncFileReader, size);
  } catch (e) {
    try {
      sync.close();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsName(url));
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

/** Persists range chunks so repeat queries and visits reuse them. */
class CacheChunkStore implements ChunkStore {
  private readonly cachePromise = openCache(CHUNK_CACHE_NAME);
  constructor(
    private readonly url: string,
    private readonly chunkSize: number,
  ) {}

  private key(chunk: number): string {
    return `${this.url}?nutrimatic-chunk=${this.chunkSize}-${chunk}`;
  }

  async get(chunk: number): Promise<Uint8Array | undefined> {
    try {
      const cache = await this.cachePromise;
      const hit = cache && (await cache.match(this.key(chunk)));
      return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
    } catch {
      return undefined;
    }
  }

  put(chunk: number, data: Uint8Array): void {
    void this.cachePromise
      .then((cache) => cache?.put(this.key(chunk), new Response(data.slice())))
      .catch(() => {});
  }
}

/**
 * Whole-index download via the .idxz sidecar (~half the transfer), writing
 * decompressed blocks through `write`. Returns false if there is no valid
 * sidecar (caller falls back to plain ranges; on partial failure the plain
 * path rewrites every offset, so no torn state survives).
 */
async function downloadViaSidecar(
  url: string,
  size: number,
  write: (part: Uint8Array, offset: number) => void,
): Promise<boolean> {
  const sidecarUrl = url + ".idxz";
  try {
    const headResp = await fetchWithRetry(sidecarUrl, {
      headers: { Range: "bytes=0-65535" },
    });
    let buf = new Uint8Array(await headResp.arrayBuffer());
    const header = parseIdxzHeader(buf);
    if (!header || header.uncompressedSize !== size) return false;
    if (buf.length < header.dataStart) {
      const rest = await fetchWithRetry(sidecarUrl, {
        headers: { Range: `bytes=${buf.length}-${header.dataStart - 1}` },
      });
      const more = new Uint8Array(await rest.arrayBuffer());
      const joined = new Uint8Array(header.dataStart);
      joined.set(buf);
      joined.set(more, buf.length);
      buf = joined;
    }
    const table = await parseIdxzTable(
      buf.subarray(24, header.dataStart),
      header.numBlocks,
    );
    if (!table) return false;

    // Group blocks into ~piece-sized compressed spans.
    const spans: Array<[number, number]> = [];
    let spanStart = 0;
    for (let b = 1; b <= header.numBlocks; ++b) {
      if (table[b] - table[spanStart] >= DOWNLOAD_PIECE || b === header.numBlocks) {
        spans.push([spanStart, b]);
        spanStart = b;
      }
    }

    const totalComp = table[header.numBlocks];
    let nextSpan = 0;
    let loaded = 0;
    const runner = async (): Promise<void> => {
      for (;;) {
        const idx = nextSpan++;
        if (idx >= spans.length) return;
        const [s, e] = spans[idx];
        const from = header.dataStart + table[s];
        const to = header.dataStart + table[e] - 1;
        const resp = await fetchWithRetry(sidecarUrl, {
          headers: { Range: `bytes=${from}-${to}` },
        });
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length !== to - from + 1) throw new Error("idxz short span");
        const jobs: Promise<void>[] = [];
        for (let b = s; b < e; ++b) {
          const off = table[b] - table[s];
          const len = table[b + 1] - table[b];
          jobs.push(
            inflateRawBlock(buf.subarray(off, off + len)).then((data) => {
              const expected = Math.min(header.blockSize, size - b * header.blockSize);
              if (data.length !== expected) throw new Error(`idxz bad block ${b}`);
              write(data, b * header.blockSize);
            }),
          );
        }
        await Promise.all(jobs);
        loaded += buf.length;
        post({ type: "loading", mode: "download", bytes: totalComp, loaded });
      }
    };
    await Promise.all(
      Array.from({ length: DOWNLOAD_CONCURRENCY }, () => runner()),
    );
    return true;
  } catch {
    return false;
  }
}

async function downloadWhole(
  url: string,
  size: number,
  ranged: boolean,
): Promise<Uint8Array> {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      if (buf.length === size) {
        post({ type: "loading", mode: "download", bytes: size, loaded: size, cached: true });
        return buf;
      }
      await cache.delete(url); // stale (index was replaced): refetch
    }
  }

  const data = new Uint8Array(size);
  if (ranged) {
    const viaZ = await downloadViaSidecar(url, size, (part, off) =>
      data.set(part, off),
    );
    if (!viaZ) await fetchPieces(url, size, (part, off) => data.set(part, off));
  } else {
    const resp = await fetchWithRetry(url);
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length !== size) {
      throw new Error(`short response (${buf.length} of ${size} bytes)`);
    }
    data.set(buf);
  }

  if (cache) {
    try {
      await cache.put(url, new Response(data.slice().buffer));
    } catch {
      // Quota exceeded etc. — caching is best-effort.
    }
  }
  return data;
}

const retryFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetchWithRetry(String(input), init)) as typeof fetch;

async function useMemory(data: Uint8Array, cached: boolean): Promise<void> {
  reader = await IndexReader.open(new MemorySource(data));
  rangeSource = null;
  session = null;
  post({
    type: "ready",
    bytes: data.length,
    mode: "memory",
    cached,
    total: reader.count(),
  });
}

/** Interpret an early page-side probe response (same logic as the source). */
function parseEarlyProbe(
  probe: EarlyProbe,
): { length: number; supportsRanges: boolean } | null {
  if (!probe.ok) return null;
  if (probe.status === 206 && probe.contentRange) {
    const m = /\/(\d+)\s*$/.exec(probe.contentRange);
    if (m) return { length: parseInt(m[1], 10), supportsRanges: true };
  }
  if (probe.contentLength) {
    return { length: parseInt(probe.contentLength, 10), supportsRanges: false };
  }
  return null;
}

async function openIndex(url: string, early?: OpenMsg["early"]): Promise<void> {
  reader = null;
  rangeSource = null;
  diskSource?.close(); // release the OPFS lock before (re)opening anything
  diskSource = null;
  session = null;
  currentUrl = url;
  let probe = early?.probe ? parseEarlyProbe(early.probe) : null;
  if (!probe) {
    const p = await HttpRangeSource.open(url, { fetchFn: retryFetch });
    probe = { length: p.length, supportsRanges: p.supportsRanges };
  }
  currentSize = probe.length;

  // An OPFS copy opens instantly: sync disk reads, no RAM load.
  const disk = await openOpfsIndex(url, probe.length);
  if (disk) {
    diskSource = disk;
    reader = await IndexReader.open(disk);
    post({
      type: "ready",
      bytes: probe.length,
      mode: "disk",
      cached: true,
      total: reader.count(),
    });
    return;
  }

  // A previously downloaded full copy means zero network traffic.
  const cache = await openCache();
  const hit = cache && (await cache.match(url));
  if (hit) {
    const data = new Uint8Array(await hit.arrayBuffer());
    if (data.length === probe.length) {
      await useMemory(data, true);
      return;
    }
    await cache.delete(url); // index changed on the server: start over
  }

  if (probe.length <= TINY_LIMIT || !probe.supportsRanges) {
    // Automatic downloads stay small; only the explicit "download whole
    // index" button may pull gigabytes.
    if (probe.length > 256 * 1024 * 1024) {
      throw new Error(
        `index is ${Math.round(probe.length / 1048576)} MB and its server ` +
          `does not support Range requests`,
      );
    }
    post({ type: "loading", bytes: probe.length, loaded: 0, mode: "download" });
    await useMemory(
      await downloadWhole(url, probe.length, probe.supportsRanges),
      false,
    );
  } else {
    // Default for big indexes: fetch only what queries touch, and remember
    // those pieces across visits. A .idxz sidecar (if published next to the
    // index) roughly halves the bytes on the wire.
    post({ type: "loading", bytes: probe.length, mode: "range" });
    rangeSource =
      (await CompressedRangeSource.open(url, probe.length, {
        fetchFn: retryFetch,
        prefixBytes: early?.table ? new Uint8Array(early.table) : undefined,
        makeStore: (blockSize) => new CacheChunkStore(url + ".idxz", blockSize),
        tableStore: {
          get: async () => {
            const cache = await openCache(CHUNK_CACHE_NAME);
            const hit = cache && (await cache.match(`${url}?nutrimatic-idxz-table`));
            return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
          },
          put: (data) => {
            void openCache(CHUNK_CACHE_NAME)
              .then((c) => c?.put(`${url}?nutrimatic-idxz-table`, new Response(data as BodyInit)))
              .catch(() => {});
          },
        },
      })) ??
      (await HttpRangeSource.open(url, {
        fetchFn: retryFetch,
        known: probe,
        chunkStore: new CacheChunkStore(url, RANGE_CHUNK_SIZE),
        // Smaller chunks waste fewer bytes per touched trie node (~4KB
        // spans); the prefetch parallelism hides the per-request latency.
        chunkSize: RANGE_CHUNK_SIZE,
        maxChunks: 4096,
      }));
    // Prewarm the trie root region (the file tail) in the background: every
    // query starts there. Not awaited — the first search's own fetches
    // dedupe against it and win the bandwidth race.
    const prewarm = rangeSource.ensure(
      Math.max(0, probe.length - PREWARM_BYTES),
      probe.length,
    );
    if (prewarm) prewarm.catch(() => {});
    reader = await IndexReader.open(rangeSource);
    post({ type: "ready", bytes: probe.length, mode: "range", total: reader.count() });
  }
}

async function downloadFull(): Promise<void> {
  if (!currentUrl) throw new Error("no index loaded");
  if (currentSize > FULL_DOWNLOAD_LIMIT) {
    throw new Error("index too large to download whole");
  }
  post({ type: "loading", bytes: currentSize, loaded: 0, mode: "download" });

  const disk = await downloadToOpfs(currentUrl, currentSize);
  if (disk) {
    diskSource = disk;
    reader = await IndexReader.open(disk);
    rangeSource = null;
    session = null;
    // The OPFS copy supersedes any Cache Storage full copy: free the quota.
    void openCache().then((c) => c?.delete(currentUrl!)).catch(() => {});
    post({
      type: "ready",
      bytes: currentSize,
      mode: "disk",
      cached: false,
      total: reader.count(),
    });
    return;
  }

  // OPFS unavailable: fall back to the in-memory + Cache Storage path.
  await useMemory(await downloadWhole(currentUrl, currentSize, true), false);
}

async function runSession(maxSteps: number, maxResults: number): Promise<void> {
  if (!session) return;
  const token = ++runToken;
  const active = session;
  try {
    const status = await active.run(
      maxSteps,
      maxResults,
      (r) => post({ type: "result", score: r.score, text: r.text }),
      (steps) =>
        post({
          type: "progress",
          steps,
          fetched: rangeSource?.bytesFetched,
          requests: rangeSource?.requests,
        }),
      () => {
        if (token !== runToken) throw new StopError();
        // Yield so incoming messages (stop / continue) are processed.
        return macroYield();
      },
    );
    if (token !== runToken) return;
    post({
      type: "done",
      status, // "limit" (step budget), "results" (page full), "exhausted"
      steps: active.steps,
      fetched: rangeSource?.bytesFetched,
      requests: rangeSource?.requests,
    });
  } catch (e) {
    if (e instanceof StopError || token !== runToken) return;
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

class StopError extends Error {}

onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "open":
        ++runToken;
        await openIndex(msg.url, msg.early);
        break;
      case "search": {
        if (!reader) throw new Error("no index loaded");
        ++runToken;
        try {
          session = new SearchSession(reader, msg.query, undefined, {
            prefetchDepth: rangeSource ? PREFETCH_DEPTH : 0,
          });
        } catch (e) {
          if (e instanceof ParseError) {
            post({ type: "parse-error", rest: e.rest });
            return;
          }
          throw e;
        }
        await runSession(msg.maxSteps, msg.maxResults);
        break;
      }
      case "continue":
        await runSession(msg.maxSteps, msg.maxResults);
        break;
      case "download-full":
        ++runToken; // cancel any in-flight search run
        await downloadFull();
        break;
      case "stop":
        ++runToken;
        break;
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
