// The search filter: a DFA over the parsed expression NFA, built lazily.
//
// Upstream compiles the full DFA upfront (OpenFST determinize + minimize),
// which explodes on big anagram/intersection patterns — mostly into states
// no real search ever visits. Here subset construction runs on demand: a
// (state, symbol) transition is computed the first time the index walk asks
// for it, then memoized in a dense table. The index prunes hard, so only a
// tiny reachable fraction of the automaton ever materializes, and patterns
// that would blow up eagerly become pay-as-you-go.

import { ALPHABET, CHAR_TO_SYM, EPSILON, NSYM, Nfa, trim } from "./automata.js";

const UNCOMPUTED = -2;
const DEAD = -1;
const MAX_STATES = 500000;

/** What the search driver needs from a compiled expression. */
export interface Filter {
  readonly startState: number;
  isAccepting(state: number): boolean;
  /** Next state on `ch` (a character code), or -1 if no transition. */
  transition(state: number, ch: number): number;
}

export class ExprFilter implements Filter {
  readonly startState: number;

  private readonly nfa: Nfa | null; // null = empty language
  private trans: Int32Array; // [state*NSYM+sym]: target, DEAD, or UNCOMPUTED
  private accepting: number[] = [];
  private members: number[][] = []; // NFA state set per DFA state
  private readonly setIds = new Map<string, number>();
  private readonly closures: Array<number[] | null>;

  constructor(parsedExpr: Nfa) {
    // Trim to useful states first (linear): without this, states that can
    // never reach acceptance survive (eager minimization used to drop them),
    // and the search would wander them — including via endless restarts.
    parsedExpr = trim(parsedExpr);
    if (parsedExpr.start === -1) {
      // Empty language: one non-accepting state with no transitions.
      this.nfa = null;
      this.closures = [];
      this.trans = new Int32Array(NSYM).fill(DEAD);
      this.accepting = [0];
      this.members = [[]];
      this.startState = 0;
      return;
    }
    // The NFA is captured by reference and must not be mutated afterwards.
    this.nfa = parsedExpr;
    this.closures = new Array(parsedExpr.arcs.length).fill(null);
    this.trans = new Int32Array(0);
    this.startState = this.intern(this.closeSet([parsedExpr.start]));
  }

  get numStates(): number {
    return this.accepting.length;
  }

  isAccepting(state: number): boolean {
    return this.accepting[state] !== 0;
  }

  /** Next state on `ch` (a character code), or -1 if no transition. */
  transition(state: number, ch: number): number {
    const sym = ch < 128 ? CHAR_TO_SYM[ch] : -1;
    if (sym === -1) return DEAD;
    const t = this.trans[state * NSYM + sym];
    return t === UNCOMPUTED ? this.compute(state, sym) : t;
  }

  private compute(state: number, sym: number): number {
    const label = ALPHABET[sym];
    const targets: number[] = [];
    for (const s of this.members[state]) {
      for (const a of this.nfa!.arcs[s]) {
        if (a.label === label) targets.push(a.to);
      }
    }
    const t = targets.length === 0 ? DEAD : this.intern(this.closeSet(targets));
    this.trans[state * NSYM + sym] = t;
    return t;
  }

  private closureOf(s: number): number[] {
    const cached = this.closures[s];
    if (cached) return cached;
    const seen = new Set<number>([s]);
    const work = [s];
    while (work.length > 0) {
      const q = work.pop()!;
      for (const a of this.nfa!.arcs[q]) {
        if (a.label === EPSILON && !seen.has(a.to)) {
          seen.add(a.to);
          work.push(a.to);
        }
      }
    }
    const list = [...seen].sort((x, y) => x - y);
    this.closures[s] = list;
    return list;
  }

  private closeSet(states: number[]): number[] {
    const seen = new Set<number>();
    for (const s of states) for (const c of this.closureOf(s)) seen.add(c);
    return [...seen].sort((x, y) => x - y);
  }

  private intern(sorted: number[]): number {
    const key = sorted.join(",");
    const existing = this.setIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.members.length;
    if (id >= MAX_STATES) throw new Error("pattern too complex");
    this.setIds.set(key, id);
    this.members.push(sorted);
    let acc = 0;
    for (const s of sorted) {
      if (this.nfa!.finals.has(s)) {
        acc = 1;
        break;
      }
    }
    this.accepting.push(acc);

    if ((id + 1) * NSYM > this.trans.length) {
      const grown = new Int32Array(Math.max(64 * NSYM, this.trans.length * 2));
      grown.fill(UNCOMPUTED);
      grown.set(this.trans);
      this.trans = grown;
    } else {
      this.trans.fill(UNCOMPUTED, id * NSYM, (id + 1) * NSYM);
    }
    return id;
  }
}

/**
 * Lazy product of per-conjunct lazy filters: the intersection semantics of
 * `a&b` (and of an anagram's constraint set) without ever materializing the
 * product automaton. States are interned tuples of component states; a
 * transition exists iff every component has one.
 */
export class ProductFilter implements Filter {
  readonly startState: number;

  private readonly subs: ExprFilter[];
  private trans = new Int32Array(0);
  private accepting: number[] = [];
  private tuples: number[][] = [];
  private readonly tupleIds = new Map<string, number>();

  constructor(conjuncts: Nfa[]) {
    this.subs = conjuncts.map((nfa) => new ExprFilter(nfa));
    this.startState = this.intern(this.subs.map((f) => f.startState));
  }

  get numStates(): number {
    return this.accepting.length;
  }

  isAccepting(state: number): boolean {
    return this.accepting[state] !== 0;
  }

  transition(state: number, ch: number): number {
    const sym = ch < 128 ? CHAR_TO_SYM[ch] : -1;
    if (sym === -1) return DEAD;
    const t = this.trans[state * NSYM + sym];
    return t === UNCOMPUTED ? this.compute(state, sym, ch) : t;
  }

  private compute(state: number, sym: number, ch: number): number {
    const tuple = this.tuples[state];
    const next: number[] = new Array(this.subs.length);
    for (let i = 0; i < this.subs.length; ++i) {
      const t = this.subs[i].transition(tuple[i], ch);
      if (t === DEAD) {
        this.trans[state * NSYM + sym] = DEAD;
        return DEAD;
      }
      next[i] = t;
    }
    const id = this.intern(next);
    this.trans[state * NSYM + sym] = id;
    return id;
  }

  private intern(tuple: number[]): number {
    const key = tuple.join(",");
    const existing = this.tupleIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.tuples.length;
    if (id >= MAX_STATES) throw new Error("pattern too complex");
    this.tupleIds.set(key, id);
    this.tuples.push(tuple);
    let acc = 1;
    for (let i = 0; i < this.subs.length; ++i) {
      if (!this.subs[i].isAccepting(tuple[i])) {
        acc = 0;
        break;
      }
    }
    this.accepting.push(acc);

    if ((id + 1) * NSYM > this.trans.length) {
      const grown = new Int32Array(Math.max(64 * NSYM, this.trans.length * 2));
      grown.fill(UNCOMPUTED);
      grown.set(this.trans);
      this.trans = grown;
    } else {
      this.trans.fill(UNCOMPUTED, id * NSYM, (id + 1) * NSYM);
    }
    return id;
  }
}

/** Build the appropriate filter for a conjunct list. */
export function makeFilter(conjuncts: Nfa[]): Filter {
  if (conjuncts.length === 1) return new ExprFilter(conjuncts[0]);
  return new ProductFilter(conjuncts);
}
