// Sidecar builder (Node-only: uses zlib). Kept separate from idxz.ts so
// browser code never pulls in node:zlib.

import * as zlib from "node:zlib";
import { IDXZ_BLOCK_SIZE, buildIdxzHeader, idxzNumBlocks } from "./idxz.js";

/** Build a complete .idxz (format 02) sidecar for an index. */
export function buildIdxz(
  data: Uint8Array,
  blockSize = IDXZ_BLOCK_SIZE,
  level = 9,
): Uint8Array {
  const numBlocks = idxzNumBlocks(data.length, blockSize);
  const blocks: Buffer[] = [];
  const sizes = new Uint16Array(numBlocks);
  for (let b = 0; b < numBlocks; ++b) {
    const start = b * blockSize;
    const packed = zlib.deflateRawSync(
      data.subarray(start, Math.min(start + blockSize, data.length)),
      { level },
    );
    if (packed.length > 0xffff) {
      throw new Error(`block ${b} compressed to ${packed.length} bytes (>u16)`);
    }
    blocks.push(packed);
    sizes[b] = packed.length;
  }
  const table = zlib.deflateRawSync(
    Buffer.from(sizes.buffer, sizes.byteOffset, numBlocks * 2),
    { level },
  );
  const header = buildIdxzHeader(blockSize, data.length, table.length);
  return Buffer.concat([Buffer.from(header), table, ...blocks]);
}
