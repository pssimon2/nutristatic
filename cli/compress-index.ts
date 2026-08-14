// Build a .idxz sidecar for an index file: independently deflated 32KB
// blocks plus a compressed u16-delta offset table, letting clients fetch
// ranges at ~half size. usage: compress-index input.index
// (writes input.index.idxz)

import * as fs from "node:fs";
import { buildIdxz } from "../src/idxz-build.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: compress-index input.index");
  process.exit(2);
}

const data = fs.readFileSync(input);
const out = input + ".idxz";
const sidecar = buildIdxz(data);
fs.writeFileSync(out, sidecar);
console.error(
  `${out}: ${(sidecar.length / 1048576).toFixed(1)}MB ` +
    `(${((sidecar.length / data.length) * 100).toFixed(0)}% of ${(data.length / 1048576).toFixed(1)}MB)`,
);
