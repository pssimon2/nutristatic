// The .idxz sidecar: an index file recompressed as independently-deflated
// fixed-size blocks so clients can fetch byte ranges at ~half the transfer
// size. Layout (all little-endian):
//
//   0..8    magic "nutriz01"
//   8..12   u32 block size (uncompressed bytes per block)
//   12..20  u64 uncompressed index size
//   20..20+(n+1)*8   u64 offsets of each compressed block, relative to the
//                    start of the data section; n = ceil(size / blockSize).
//                    offsets[n] = total compressed data length.
//   then    concatenated raw-deflate blocks
//
// A sidecar is valid for exactly one index file: clients compare the header's
// uncompressed size against the real index's length and ignore stale ones.

export const IDXZ_MAGIC = "nutriz01";
// 32KB blocks: matches the plain range source's chunk granularity, so the
// per-touched-node waste stays the same and compression is pure savings.
export const IDXZ_BLOCK_SIZE = 1 << 15;

export interface IdxzHeader {
  blockSize: number;
  uncompressedSize: number;
  numBlocks: number;
  /** Byte offset of the data section within the sidecar file. */
  dataStart: number;
}

export function idxzNumBlocks(size: number, blockSize: number): number {
  return Math.ceil(size / blockSize);
}

export function parseIdxzHeader(bytes: Uint8Array): IdxzHeader | null {
  if (bytes.length < 20) return null;
  for (let i = 0; i < 8; ++i) {
    if (bytes[i] !== IDXZ_MAGIC.charCodeAt(i)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const blockSize = view.getUint32(8, true);
  const uncompressedSize =
    view.getUint32(12, true) + view.getUint32(16, true) * 2 ** 32;
  if (!(blockSize > 0) || !(uncompressedSize > 0)) return null;
  const numBlocks = idxzNumBlocks(uncompressedSize, blockSize);
  return {
    blockSize,
    uncompressedSize,
    numBlocks,
    dataStart: 20 + (numBlocks + 1) * 8,
  };
}

export function buildIdxzHeader(
  blockSize: number,
  uncompressedSize: number,
): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 8; ++i) out[i] = IDXZ_MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(8, blockSize, true);
  view.setUint32(12, uncompressedSize % 2 ** 32, true);
  view.setUint32(16, Math.floor(uncompressedSize / 2 ** 32), true);
  return out;
}

/** Parse the offsets table (numBlocks+1 u64s) into a Float64Array. */
export function parseIdxzTable(
  bytes: Uint8Array,
  numBlocks: number,
): Float64Array | null {
  if (bytes.length < (numBlocks + 1) * 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const table = new Float64Array(numBlocks + 1);
  for (let i = 0; i <= numBlocks; ++i) {
    table[i] = view.getUint32(i * 8, true) + view.getUint32(i * 8 + 4, true) * 2 ** 32;
    if (i > 0 && table[i] < table[i - 1]) return null; // corrupt
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
