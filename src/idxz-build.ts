// Sidecar builder (Node-only: uses zlib). Kept separate from idxz.ts so
// browser code never pulls in node:zlib.

import * as zlib from "node:zlib";
import { IDXZ_BLOCK_SIZE, buildIdxzHeader, idxzNumBlocks } from "./idxz.js";

/**
 * Build a .idxz (format 02) sidecar, streaming output through `write` so the
 * caller never holds the whole sidecar: header+table first, then each
 * compressed block. `readBlock(start, len)` supplies index bytes (a memory
 * view, or pread-style file access). Returns total compressed bytes.
 *
 * The compressed blocks are necessarily buffered until the (length-prefixed)
 * table is written; that is ~60% of the input and the floor for a one-pass
 * build without a temp file.
 */
export function buildIdxzTo(
  size: number,
  readBlock: (start: number, len: number) => Uint8Array,
  write: (chunk: Uint8Array) => void,
  blockSize = IDXZ_BLOCK_SIZE,
  level = 9,
): number {
  if (size <= 0) throw new Error("refusing to build a sidecar for an empty index");
  const numBlocks = idxzNumBlocks(size, blockSize);
  const blocks: Buffer[] = [];
  // Explicit little-endian (the reader parses LE): a host-endian Uint16Array
  // would silently corrupt the table on big-endian hardware.
  const sizes = Buffer.alloc(numBlocks * 2);
  for (let b = 0; b < numBlocks; ++b) {
    const start = b * blockSize;
    const len = Math.min(blockSize, size - start);
    const packed = zlib.deflateRawSync(readBlock(start, len), { level });
    if (packed.length > 0xffff) {
      throw new Error(`block ${b} compressed to ${packed.length} bytes (>u16)`);
    }
    blocks.push(packed);
    sizes.writeUInt16LE(packed.length, b * 2);
  }
  const table = zlib.deflateRawSync(sizes, { level });
  write(buildIdxzHeader(blockSize, size, table.length));
  write(table);
  let total = 24 + table.length;
  for (const block of blocks) {
    write(block);
    total += block.length;
  }
  return total;
}

/** Build a complete .idxz sidecar in memory (tests and small inputs). */
export function buildIdxz(
  data: Uint8Array,
  blockSize = IDXZ_BLOCK_SIZE,
  level = 9,
): Uint8Array {
  const parts: Uint8Array[] = [];
  buildIdxzTo(
    data.length,
    (start, len) => data.subarray(start, start + len),
    (chunk) => parts.push(chunk),
    blockSize,
    level,
  );
  return Buffer.concat(parts);
}
