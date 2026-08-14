# WASM search-kernel prototype

Measurement rig answering "is WebAssembly worth it for the search engine?"
Not wired into the app.

- `kernel.c` — the best-first walk (4-ary frontier heap, trie node parsing,
  dense-DFA stepping, restart logic) as freestanding C compiled with plain
  clang (`--target=wasm32-unknown-unknown`, no Emscripten). Index bytes and
  DFA tables live in linear memory; each accepted result returns to JS for
  dedup/emission.
- `bench-wasm.mjs` — head-to-head vs the production JS engine on the
  simple-wiki index, verifying result parity.

## Measured (2026-08-14, aibox)

| Query | JS | WASM | Speedup | Parity |
|---|---|---|---|---|
| `"C*aC*eC*iC*oC*u"` (pure stepping) | 18ms | 7ms | 2.7x | identical |
| `free A+` (result-heavy) | 36ms | 17ms | 2.1x | score-stream identical* |
| `n[aeiou]tr[aeiou]m_tic` | 145ms | 101ms | 1.4x | score-stream identical* |
| `solar s_stem` | 71ms | 57ms | 1.2x | score-stream identical* |

\* equal-scored results emit in a different order (both orders are valid
priority-queue behavior); the score sequences match exactly.

## Conclusions

- Real but bounded: 2-3x on stepping-dominated work, ~1.2-1.4x when JS-side
  result handling shares the time. In line with the "well-tuned typed-array
  JS is within 2-3x of native" prior.
- The kernel requires a dense DFA. Simple patterns densify fine, but the
  queries that are actually slow (big anagrams) depend on the lazy product
  filters — densifying them is exactly the state blowup the lazy engine
  exists to avoid. Porting the lazy machinery into WASM is a much larger
  project than this kernel.
- Why NOT OpenFST-in-WASM: upstream's eager OpenFST compilation is what
  makes 20+ letter anagrams fail on nutrimatic.org; reintroducing it would
  be a functional regression, and pattern compilation is already 0-11ms.
- Recommendation unchanged: the app's felt bottlenecks are network (range
  mode) and anagram search (lazy filters, not densifiable). A WASM
  integration accelerates the already-fast simple-pattern path by ~2x at
  the cost of a second engine to maintain. Revisit if mobile deep-search
  performance becomes a complaint (phones would see the largest relative
  win, and disk-mode OPFS reads are synchronous - WASM's happy path).

Build: see the comment atop kernel.c. Run: `npx tsx wasm-proto/bench-wasm.mjs`.
