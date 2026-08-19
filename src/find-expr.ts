// High-level query compilation, mirroring Nutrimatic find-expr.cpp: parse the
// expression, append a required trailing space (so matches are complete
// words), and build the search filter.

import { Nfa } from "./automata.js";
import { Filter, makeFilter } from "./expr-filter.js";
import { Box, parseExpr, parseExprBox } from "./expr-parse.js";
import { IndexReader } from "./index-reader.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";

export const DEFAULT_RESTART = 1e-6;

export class ParseError extends Error {
  constructor(readonly rest: string) {
    super(`can't parse "${rest}"`);
  }
}

/** Compile a query into a filter, throwing ParseError on syntax errors. */
export function compileQuery(query: string): Filter {
  const box = new Box();
  const p = parseExprBox(query, 0, box, false);
  if (p === null || p !== query.length) {
    throw new ParseError(p === null ? query : query.slice(p));
  }

  // Require a space at the end, so the matches must be complete words.
  // The suffix is a fixed-length language, so appending it distributes over
  // the intersection: (∩Ai)·s = ∩(Ai·s). That keeps conjuncts unmaterialized.
  for (const conjunct of box.and) {
    const space = new Nfa();
    parseExpr(" ", 0, space, true);
    conjunct.concat(space);
  }

  return makeFilter(box.and);
}

export function makeDriver(
  reader: IndexReader,
  filter: Filter,
  restart = DEFAULT_RESTART,
  opts: SearchDriverOptions = {},
): SearchDriver {
  return new SearchDriver(reader, filter, filter.startState, restart, opts);
}

/** Format like C's %.8g (Nutrimatic's score output format). */
export function formatScore(x: number): string {
  if (x === 0) return "0";
  let s = x.toPrecision(8);
  if (s.includes("e")) {
    let [mant, exp] = s.split("e");
    if (mant.includes(".")) mant = mant.replace(/\.?0+$/, "");
    const sign = exp[0] === "-" ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  return s;
}
