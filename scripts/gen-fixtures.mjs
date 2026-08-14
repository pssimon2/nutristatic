// Regenerate the committed search-result fixtures from the demo index.
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
const data = fs.readFileSync(new URL("../web/public/demo.index", import.meta.url));
const reader = await IndexReader.open(new MemorySource(data));
const out = {};
for (const q of ["n[aeiou]tr[aeiou]m_tic", "<aeglnr>", "solar s_stem", "free A+", '"C*aC*eC*iC*oC*u"']) {
  const s = new SearchSession(reader, q);
  const results = [];
  await s.run(200000, 200, (r) => results.push([r.text, r.score]));
  results.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  out[q] = { steps: s.steps, results };
}
fs.writeFileSync(new URL("../test/fixtures/demo-results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("fixtures written:", Object.keys(out).map((q) => `${q}=${out[q].results.length}r/${out[q].steps}s`).join(", "));
