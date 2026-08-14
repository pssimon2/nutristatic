import * as fs from "node:fs";
import { MemorySource } from "./src/byte-source.js";
import { IndexReader } from "./src/index-reader.js";
import { SearchSession } from "./src/search-session.js";
const data = fs.readFileSync("./data/wiki-merged.index");
const reader = await IndexReader.open(new MemorySource(data));
const orig = Object.getPrototypeOf(reader).childrenInto;
let calls = 0; const seen = new Map();
Object.getPrototypeOf(reader).childrenInto = function (parent, count, out) {
  ++calls; seen.set(parent, (seen.get(parent) ?? 0) + 1);
  return orig.call(this, parent, count, out);
};
for (const q of ["<aciimnrttu>", '"C*aC*eC*iC*oC*uC*yC*"', "free A+"]) {
  calls = 0; seen.clear();
  const s = new SearchSession(reader, q);
  await s.run(300000, 1000, () => {});
  const distinct = seen.size;
  console.log(`[${q}] childrenInto calls=${calls} distinct nodes=${distinct} revisit ratio=${((1 - distinct / calls) * 100).toFixed(1)}%`);
}
