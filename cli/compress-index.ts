// Build a .idxz sidecar for an index file: independently deflated 32KB
// blocks plus a compressed u16-delta offset table, letting clients fetch
// ranges at ~half size. usage: compress-index input.index
// (writes input.index.idxz)

import * as fs from "node:fs";
import { buildIdxzTo } from "../src/idxz-build.js";

const input = process.argv[2];
if (!input || process.argv.length > 3) {
  console.error("usage: compress-index input.index");
  process.exit(2);
}

let fd: number;
let size: number;
try {
  fd = fs.openSync(input, "r");
  size = fs.fstatSync(fd).size;
} catch {
  console.error(`error: can't read "${input}"`);
  process.exit(1);
}
if (size === 0) {
  console.error(`error: "${input}" is empty`);
  process.exit(1);
}

const out = input + ".idxz";
// Build into a temp file and rename into place: a failed rebuild must not
// destroy a pre-existing valid sidecar.
const tmp = out + ".tmp";
const outFd = fs.openSync(tmp, "w");
// Stream: the index is read per 32KB block and the sidecar written as
// produced — neither is ever held whole in memory.
const blockBuf = Buffer.alloc(1 << 15);
let compressed = 0;
try {
  compressed = buildIdxzTo(
    size,
    (start, len) => {
      const buf = len === blockBuf.length ? blockBuf : Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) throw new Error(`short read at ${start + got}`);
        got += n;
      }
      return buf;
    },
    (chunk) => void fs.writeSync(outFd, chunk),
  );
  fs.closeSync(outFd);
  fs.renameSync(tmp, out);
} catch (e) {
  try {
    fs.closeSync(outFd);
  } catch {
    // already closed
  }
  try {
    fs.unlinkSync(tmp); // never leave a partial temp file behind
  } catch {
    // best-effort
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
fs.closeSync(fd);
console.error(
  `${out}: ${(compressed / 1048576).toFixed(1)}MB ` +
    `(${((compressed / size) * 100).toFixed(0)}% of ${(size / 1048576).toFixed(1)}MB)`,
);
