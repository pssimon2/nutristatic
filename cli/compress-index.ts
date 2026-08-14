// Build a .idxz sidecar for an index file: independently deflated 64KB
// blocks plus an offset table, letting clients fetch ranges at ~half size.
// usage: compress-index input.index  (writes input.index.idxz)

import * as fs from "node:fs";
import * as zlib from "node:zlib";
import { IDXZ_BLOCK_SIZE, buildIdxzHeader, idxzNumBlocks } from "../src/idxz.js";
import { FileSink } from "../src/node-io.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: compress-index input.index");
  process.exit(2);
}

const data = fs.readFileSync(input);
const numBlocks = idxzNumBlocks(data.length, IDXZ_BLOCK_SIZE);
const blocks: Buffer[] = [];
const offsets = new Float64Array(numBlocks + 1);
let total = 0;
for (let b = 0; b < numBlocks; ++b) {
  const start = b * IDXZ_BLOCK_SIZE;
  const raw = data.subarray(start, Math.min(start + IDXZ_BLOCK_SIZE, data.length));
  const packed = zlib.deflateRawSync(raw, { level: 9 });
  offsets[b] = total;
  total += packed.length;
  blocks.push(packed);
  if (b % 2000 === 0) {
    process.stderr.write(`\r${b}/${numBlocks} blocks`);
  }
}
offsets[numBlocks] = total;
process.stderr.write(`\r${numBlocks}/${numBlocks} blocks\n`);

const out = input + ".idxz";
const sink = new FileSink(out);
sink.write(buildIdxzHeader(IDXZ_BLOCK_SIZE, data.length));
const tableBuf = Buffer.alloc((numBlocks + 1) * 8);
for (let i = 0; i <= numBlocks; ++i) {
  tableBuf.writeUInt32LE(offsets[i] % 2 ** 32, i * 8);
  tableBuf.writeUInt32LE(Math.floor(offsets[i] / 2 ** 32), i * 8 + 4);
}
sink.write(tableBuf);
for (const block of blocks) sink.write(block);
sink.close();

const outSize = fs.statSync(out).size;
console.error(
  `${out}: ${(outSize / 1048576).toFixed(1)}MB ` +
    `(${((outSize / data.length) * 100).toFixed(0)}% of ${(data.length / 1048576).toFixed(1)}MB)`,
);
