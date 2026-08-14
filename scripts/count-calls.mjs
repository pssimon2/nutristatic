import * as fs from "node:fs";
import { SyncFileSource } from "./src/byte-source.js";
import { IndexReader } from "./src/index-reader.js";
import { SearchSession } from "./src/search-session.js";
const path = "./data/dewiki-merged.index";
const size = fs.statSync(path).size;
const fd = fs.openSync(path, "r");
const file = { read(buf, opts) { return fs.readSync(fd, buf, 0, buf.length, opts.at); } };
const source = new SyncFileSource(file, size);
const proto = Object.getPrototypeOf(source);
const counters = { chunk: 0, view: 0, byte: 0, ensure: 0 };
for (const name of ["chunk", "view", "byte", "ensure"]) {
  const orig = proto[name];
  proto[name] = function (...args) { ++counters[name]; return orig.apply(this, args); };
}
const reader = await IndexReader.open(source);
const s = new SearchSession(reader, "<aeeimnrsttu>");
await s.run(100000, 50, () => {});  // 100k steps is enough to see the shape
console.log(`steps=${s.steps}`, counters);
