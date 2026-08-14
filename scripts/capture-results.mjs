// Capture (text,score) result multisets for heap-change validation.
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
const data = fs.readFileSync("data/simple-wiki.index");
const reader = await IndexReader.open(new MemorySource(data));
const out = {};
for (const q of ["n[aeiou]tr[aeiou]m_tic", "<aeglnr>", "solar s_stem", '"C*aC*eC*iC*oC*u"']) {
  const s = new SearchSession(reader, q);
  const results = [];
  await s.run(500000, 5000, (r) => results.push([r.text, r.score]));
  // Sort canonically: multiset comparison independent of tie order.
  results.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  out[q] = { steps: s.steps, results };
  console.log(`[${q}] ${results.length} results, ${s.steps} steps`);
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
