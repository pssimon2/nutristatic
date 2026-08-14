import * as fs from "node:fs";
import { MemorySource } from "./src/byte-source.js";
import { IndexReader } from "./src/index-reader.js";
for (const f of ["data/wiki-merged.index", "data/simple-wiki.index", "web/public/demo.index"]) {
  const data = fs.readFileSync(f);
  const r = await IndexReader.open(new MemorySource(data));
  console.log(`${f}: ${(data.length / 1048576).toFixed(0)}MB, total count ${r.count().toExponential(3)}`);
}
