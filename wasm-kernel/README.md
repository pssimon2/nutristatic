# WASM search kernel

The full search engine — best-first walk plus the lazy-filter machinery
(on-demand subset construction per conjunct NFA, lazy product of conjuncts,
tuple/subset interning via open-addressed hashes) — compiled to WebAssembly
from freestanding C. The web worker runs it for fully-local indexes (memory
mode, or an OPFS disk copy, with the index copied into linear memory);
range mode and any WASM failure use the JS engine, which is the reference
implementation and the fallback. The kernel's link-time memory cap is 3 GB;
the index may use up to ~2.4 GB of it (`KERNEL_INDEX_CAP` in
src/wasm-session.ts), which admits every bundled index including the
English device copy.

- `kernel.c` — the engine in freestanding C, compiled with plain clang
  (`--target=wasm32-unknown-unknown`, no Emscripten). Index bytes and the
  lazy DFA / product tables live in linear memory; each accepted result
  returns to JS for dedup and emission. `heap_mark` / `heap_reset` bracket
  per-query allocations so tables are reused rather than leaked.

`src/wasm-session.ts` drives the kernel behind `SearchSession`'s interface,
and `test/wasm-session.test.ts` locks parity (identical score streams), the
per-query heap reset, resumability, and the engine-ownership guard that stops
a superseded run from stepping a re-seeded kernel.

The kernel runs the same walk noticeably faster than the JS engine on
fully-local indexes (heavy anagrams especially); the JS engine stays the
*correctness* reference and the fallback — both emit identical score
streams, locked by the parity tests.

Build with `npm run build-wasm` (the web build bundles `kernel.wasm` as an
asset).
