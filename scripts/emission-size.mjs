// How much of free A+ time is result emission? Compare normal run vs a run
// where accepted results are still detected but string-building is skipped
// (monkey-patched expand that skips reconstruction).
import * as fs from "node:fs";
import { MemorySource } from "./src/byte-source.js";
import { IndexReader } from "./src/index-reader.js";
import { SearchSession } from "./src/search-session.js";
const data = fs.readFileSync("./data/simple-wiki.index");
const reader = await IndexReader.open(new MemorySource(data));

for (let round = 0; round < 2; ++round) {
  const t = performance.now();
  const s = new SearchSession(reader, "free A+");
  let n = 0;
  await s.run(2000000, 100000, () => { ++n; });
  console.log(`normal: ${(performance.now()-t).toFixed(0)}ms (${n} results)`);
}
// crude upper bound: skip the onResult trim+callback cost only
for (let round = 0; round < 2; ++round) {
  const t = performance.now();
  const s = new SearchSession(reader, "free A+");
  const driver = s["driver"];
  let steps = 0, results = 0;
  for (;;) {
    if (steps >= 2000000 || results >= 100000) break;
    ++steps;
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) { if (driver.text === null) break; ++results; }
  }
  console.log(`no-trim/no-callback: ${(performance.now()-t).toFixed(0)}ms (${results} results)`);
}
