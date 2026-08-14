// The .idxz sidecar: an index file recompressed as independently-deflated
// fixed-size blocks so clients can fetch byte ranges at ~half the transfer
// size. Format 02 layout (all little-endian):
//
//   0..8    magic "nutriz02"
//   8..12   u32 block size (uncompressed bytes per block)
//   12..20  u64 uncompressed index size
//   20..24  u32 compressed table length (ctl)
//   24..24+ctl   raw-deflate of a u16 array: compressed size of each block
//                (offsets are its prefix sums); n = ceil(size / blockSize)
//   then    concatenated raw-deflate blocks
//
// The u16-delta table is ~8x smaller than v01's u64 offsets before its own
// compression (the enwiki table dropped from 340KB to ~45KB on the wire) —
// it is fetched before any search can run, so its size is pure cold-start
// latency. A sidecar is valid for exactly one index file: clients compare
// the header's uncompressed size against the real index's length.

export const IDXZ_MAGIC = "nutriz02";
// 32KB blocks: matches the plain range source's chunk granularity, so the
// per-touched-node waste stays the same and compression is pure savings.
export const IDXZ_BLOCK_SIZE = 1 << 15;
export const IDXZ_HEADER_SIZE = 24;

export interface IdxzHeader {
  blockSize: number;
  uncompressedSize: number;
  numBlocks: number;
  /** Length of the compressed table section. */
  tableBytes: number;
  /** Byte offset of the block data section within the sidecar file. */
  dataStart: number;
}

export function idxzNumBlocks(size: number, blockSize: number): number {
  return Math.ceil(size / blockSize);
}

export function parseIdxzHeader(bytes: Uint8Array): IdxzHeader | null {
  if (bytes.length < IDXZ_HEADER_SIZE) return null;
  for (let i = 0; i < 8; ++i) {
    if (bytes[i] !== IDXZ_MAGIC.charCodeAt(i)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const blockSize = view.getUint32(8, true);
  const uncompressedSize =
    view.getUint32(12, true) + view.getUint32(16, true) * 2 ** 32;
  const tableBytes = view.getUint32(20, true);
  if (!(blockSize > 0) || !(uncompressedSize > 0) || !(tableBytes > 0)) {
    return null;
  }
  const numBlocks = idxzNumBlocks(uncompressedSize, blockSize);
  return {
    blockSize,
    uncompressedSize,
    numBlocks,
    tableBytes,
    dataStart: IDXZ_HEADER_SIZE + tableBytes,
  };
}

export function buildIdxzHeader(
  blockSize: number,
  uncompressedSize: number,
  tableBytes: number,
): Uint8Array {
  const out = new Uint8Array(IDXZ_HEADER_SIZE);
  for (let i = 0; i < 8; ++i) out[i] = IDXZ_MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(8, blockSize, true);
  view.setUint32(12, uncompressedSize % 2 ** 32, true);
  view.setUint32(16, Math.floor(uncompressedSize / 2 ** 32), true);
  view.setUint32(20, tableBytes, true);
  return out;
}

/**
 * Decompress the table section and return absolute block offsets (relative
 * to the data section): Float64Array of numBlocks+1 entries.
 */
export async function parseIdxzTable(
  compressed: Uint8Array,
  numBlocks: number,
): Promise<Float64Array | null> {
  const raw = await inflateRawBlock(compressed);
  if (raw.length !== numBlocks * 2) return null;
  const view = new DataView(raw.buffer, raw.byteOffset);
  const table = new Float64Array(numBlocks + 1);
  for (let i = 0; i < numBlocks; ++i) {
    table[i + 1] = table[i] + view.getUint16(i * 2, true);
  }
  return table;
}

/** Decompress one raw-deflate block using the browser-native stream API. */
export async function inflateRawBlock(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
