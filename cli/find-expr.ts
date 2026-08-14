// Port of upstream find-expr.cpp + search-printer.cpp: stream results for an
// expression against an index, with '# N' progress lines every 100k steps.

import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { compileQuery, formatScore, makeDriver, ParseError } from "../src/find-expr.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const args = process.argv.slice(2);
// Same default computation limit as the upstream website; upstream's CLI
// instead runs unbounded, which exhausts memory on open-ended patterns.
let maxSteps = 1000000;
const flagIdx = args.indexOf("--max-steps");
if (flagIdx !== -1) {
  maxSteps = parseInt(args[flagIdx + 1], 10);
  args.splice(flagIdx, 2);
}
const [indexPath, expr] = args;
if (!indexPath || !expr) {
  console.error("usage: find-expr [--max-steps N] input.index expression");
  process.exit(2);
}

let filter;
try {
  filter = compileQuery(expr);
} catch (e) {
  if (e instanceof ParseError) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const reader = await IndexReader.open(
  new MemorySource(fs.readFileSync(indexPath)),
);
const driver = makeDriver(reader, filter);

let count = 0;
for (;;) {
  if (maxSteps > 0 && count >= maxSteps) {
    process.stdout.write(`# computation limit reached (${count} steps)\n`);
    break;
  }
  if (++count % 100000 === 0) process.stdout.write(`# ${count}\n`);
  let r = driver.step();
  if (r instanceof Promise) r = await r;
  if (r) {
    if (driver.text === null) break;
    const text = driver.text.replace(/ +$/, "");
    process.stdout.write(`${formatScore(driver.score)} ${text}\n`);
  }
}
