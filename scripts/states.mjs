import * as fs from "node:fs";
import { MemorySource } from "./src/byte-source.js";
import { IndexReader } from "./src/index-reader.js";
import { compileQuery, makeDriver } from "./src/find-expr.js";
import { Nfa, trim, optimizeToDfa } from "./src/automata.js";
import { Box, parseExprBox } from "./src/expr-parse.js";
const data = fs.readFileSync("./data/simple-wiki.index");
const reader = await IndexReader.open(new MemorySource(data));
for (const q of ["free A+", '"C*aC*eC*iC*oC*u"', "<aeglnr>"]) {
  const filter = compileQuery(q);
  const driver = makeDriver(reader, filter);
  for (let i = 0; i < 300000; ++i) { const r = driver.step(); if (r instanceof Promise) await r; if (driver.text === null && r === true) break; }
  const box = new Box(); parseExprBox(q, 0, box, false);
  const sizes = box.and.map(n => { const t = trim(n); return `nfa=${t.arcs.length},minDfa=${optimizeToDfa(n).accepting.length}`; });
  console.log(`[${q}] lazy filter states=${filter.numStates} | conjuncts: ${sizes.join(" ; ")}`);
}
