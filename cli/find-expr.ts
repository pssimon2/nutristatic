// Port of Nutrimatic find-expr.cpp + search-printer.cpp: stream results for an
// expression against an index, with '# N' progress lines every 100k steps.

import { compileQuery, formatScore, makeDriver, ParseError } from "../src/find-expr.js";
import { cliOpenIndex } from "../src/node-io.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const USAGE =
  "usage: find-expr [--max-steps N] input.index expression\n" +
  "  N: step limit (default 1000000; 0 = unlimited)";

const args = process.argv.slice(2);
// Same default computation limit as the Nutrimatic website; Nutrimatic's CLI
// instead runs unbounded, which exhausts memory on open-ended patterns.
let maxSteps = 1000000;
const flagIdx = args.indexOf("--max-steps");
if (flagIdx !== -1) {
  const raw = args[flagIdx + 1];
  // Strict: a typo'd value must not silently disable ("abc" -> NaN) or
  // destroy ("1e6" -> 1) the limit.
  if (raw === undefined || !/^\d+$/.test(raw)) {
    console.error(`error: bad --max-steps value "${raw ?? ""}"\n${USAGE}`);
    process.exit(2);
  }
  maxSteps = parseInt(raw, 10);
  args.splice(flagIdx, 2);
}
// The expression (last positional) may legitimately start with "-" (the
// optional-space operator), so only earlier args can be stray options.
const stray = args.slice(0, -1).find((a) => a.startsWith("-"));
if (stray !== undefined || args.length !== 2) {
  if (stray !== undefined) console.error(`error: unknown option "${stray}"`);
  console.error(USAGE);
  process.exit(2);
}
const [indexPath, expr] = args;

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

const reader = await cliOpenIndex(indexPath);
const driver = makeDriver(reader, filter);

try {
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
} catch (e) {
  // "pattern too complex" (filter state cap) or "index error: ..." — a
  // one-liner, not a stack trace.
  const message = e instanceof Error ? e.message : String(e);
  console.error(`error: ${message}`);
  process.exit(message.includes("pattern too complex") ? 2 : 1);
}
