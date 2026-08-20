# Nutristatic — Nutrimatic, serverless

A rewrite of [Nutrimatic](https://nutrimatic.org/) ([Nutrimatic
source](https://github.com/PuzzleTechHub/nutrimatic)) that runs with **no
server-side code**, deployed at [nutristatic.org](https://nutristatic.org/).
The user-facing "what is this and how does it differ from Nutrimatic"
documentation lives in the site's
[usage guide](https://nutristatic.org/usage.html); this README covers the
implementation. The pattern engine is TypeScript running in a Web Worker
in the visitor's browser; the phrase-frequency index is a plain static file.
(A WebAssembly port of the engine — `wasm-kernel/kernel.c` driven by
`src/wasm-session.ts` — takes over automatically for fully-local indexes;
the JS engine remains the reference implementation, the fallback, and the
range-mode engine.)
Deploy the built site to any static host (GitHub Pages, S3, nginx `root`,
`python -m http.server`, …) and it works.

The index file format is **byte-compatible with Nutrimatic**: indexes built by
the original C++ tools work here, and indexes built by these TypeScript tools
work with the C++ binaries (verified byte-for-byte in CI tests).

## How it works

- `src/` — the engine, a faithful port of Nutrimatic's C++:
  - `index-reader.ts` / `index-writer.ts` / `index-walker.ts` — the trie
    index format (nodes written children-first; the root is the end of the
    file).
  - `automata.ts` — replaces OpenFST: NFA combinators, subset-construction
    determinization, minimization, product intersection, language
    equivalence. Sufficient because Nutrimatic's expressions are unweighted
    acceptors over `[a-z0-9 ]` (label 0 = epsilon, which is how `-` means
    "optional space").
  - `expr-parse.ts` — the pattern language (literals, regexp operators,
    `"quoted"`, `&` intersection, `<anagram>` with its part-collapsing and
    length/containment constraint construction, `_ # A C V` classes).
  - `search-driver.ts` — best-first search over the trie, filtered by the
    compiled DFA; results stream out in descending frequency order, with the
    `1e-6` restart penalty for phrases spanning index windows.
  - `byte-source.ts` — where "serverless" happens: an index is read either
    from memory (small indexes are downloaded whole) or via **HTTP Range
    requests** with an LRU chunk cache, so a multi-gigabyte index can be
    searched from static hosting without downloading it.
- `web/` — the Vite site: `worker.ts` owns the index + search session,
  `main.ts` renders the Nutrimatic-style UI (`?q=` URLs, font size ∝ log
  score, computation limit with "Try harder »").
- `cli/` — Node ports of the Nutrimatic binaries: `find-expr`, `make-index`,
  `merge-indexes`, `dump-index`, plus `wordlist-index` (build an index from
  frequency wordlists, used for the bundled demo index) and `compress-index`
  (build the `.idxz` sidecar the web deploy serves next to each index).

## Develop

```sh
npm install
npm test               # vitest: format round-trip, Nutrimatic test-expr golden
                       # cases, HTTP-range integration
npm run dev            # vite dev server
npm run build          # static site -> web/dist/
npm run build-offline  # self-contained single file -> web/dist-offline/
node scripts/browser-test.mjs   # drives the built site headless (needs
                                # `npm run build` + `vite preview web --port 4517`)
```

### Offline single-file build

`npm run build-offline` generates `web/dist-offline/nutristatic-offline.html`:
one self-contained file that runs by double-clicking it (`file://`, no server).
Open it, then pick (or drop) a local `.index` file — `File.slice()` serves the
same on-demand range reads the network path uses, so even a multi-GB local
index opens instantly. The site also links it under "Offline version »".

It is *generated from the same sources* — `web/main.ts`, `web/worker.ts`, and
the `src/` engine, with an `OFFLINE` build flag flipping on the file-picker
path (`scripts/build-offline.mjs` inlines the worker as a Blob and the WASM as
a data URI). Re-run it after any change; there is no separate offline codebase
to keep in sync. `npm run build` runs it automatically (via `postbuild`) and
drops the file into `web/dist/`, so the served site's "Offline version" link
resolves with no extra steps.

## Searching from the command line

```sh
npm run find-expr -- web/public/demo.index '<aaagmnr>'
npm run find-expr -- --max-steps 10000000 my.index '"C*aC*eC*iC*oC*uC*yC*"'
```

## Building an index

The demo index bundled at `web/public/demo.index` (~20 MB) is built from
[Norvig's web-corpus ngram counts](https://norvig.com/ngrams/):

```sh
curl -O https://norvig.com/ngrams/count_1w.txt
curl -O https://norvig.com/ngrams/count_2w.txt
npm run wordlist-index -- web/public/demo.index count_1w.txt count_2w.txt
```

A full Wikipedia index works exactly as Nutrimatic describes (extract text,
`make-index`, `merge-indexes` with frequency cutoffs) — either with the
Nutrimatic C++ tools or these CLI ports (the C++ tools are much faster for a
full-size corpus; the outputs are interchangeable):

```sh
find text -type f | xargs cat | npm run make-index -- wikipedia
npm run merge-indexes -- 5 wikipedia.*.index wiki-merged.index
```

## Deploying with a big index

Indexes up to 4 MB are downloaded into memory. Above that the app switches
to Range mode and fetches only the trie nodes a query actually touches
(32 KB chunks, LRU-cached), unless a full copy is already on the device.
Requirements for the index host:

- HTTP Range request support (any real static file server has this).
- CORS headers if the index lives on a different origin than the page
  (`Access-Control-Allow-Origin`, and `Range` in allowed request headers).

Point the app at it with `?index=https://example.com/wiki-merged.index` or
the "index URL" box at the bottom of the page.

Hosting the site itself needs nothing beyond a static file server. Useful
cache settings, whatever the server: long lifetimes for Vite's content-hashed
`/assets/*`, `no-cache` for the HTML shell and `sw.js` (so deploys appear
immediately), and no special caching for index/sidecar files — range
responses are managed by the app's own Cache Storage layer.

## License
 
GPL-2.0, same as Nutrimatic, which this is derived from.
- Original Nutrimatic: Copyright (C) Dan Egnor and contributors
- Nutristatic: Copyright (C) 2026 Simon Stroh and contributors
