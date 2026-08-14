# Nutristatic — Nutrimatic, serverless

A rewrite of [Nutrimatic](https://nutrimatic.org/) ([upstream
source](https://github.com/PuzzleTechHub/nutrimatic)) that runs with **no
server-side code**, deployed at [nutristatic.org](https://nutristatic.org/).
The user-facing "what is this and how does it differ from Nutrimatic"
documentation lives in the site's
[usage guide](https://nutristatic.org/usage.html); this README covers the
implementation. The pattern engine is TypeScript running in a Web Worker
in the visitor's browser; the phrase-frequency index is a plain static file.
Deploy the built site to any static host (GitHub Pages, S3, nginx `root`,
`python -m http.server`, …) and it works.

The index file format is **byte-compatible with upstream**: indexes built by
the original C++ tools work here, and indexes built by these TypeScript tools
work with the C++ binaries (verified byte-for-byte in CI tests).

## How it works

- `src/` — the engine, a faithful port of upstream's C++:
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
  `main.ts` renders the upstream-style UI (`?q=` URLs, font size ∝ log
  score, computation limit with "Try harder »").
- `cli/` — Node ports of the upstream binaries: `find-expr`, `make-index`,
  `merge-indexes`, `dump-index`, plus `wordlist-index` (build an index from
  frequency wordlists, used for the bundled demo index).

## Develop

```sh
npm install
npm test               # vitest: format round-trip, upstream test-expr golden
                       # cases, HTTP-range integration
npm run dev            # vite dev server
npm run build          # static site -> web/dist/
node scripts/browser-test.mjs   # drives the built site headless (needs
                                # `npm run build` + `vite preview web --port 4517`)
```

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

A full Wikipedia index works exactly as upstream describes (extract text,
`make-index`, `merge-indexes` with frequency cutoffs) — either with the
upstream C++ tools or these CLI ports (the C++ tools are much faster for a
full-size corpus; the outputs are interchangeable):

```sh
find text -type f | xargs cat | npm run make-index -- wikipedia
npm run merge-indexes -- 5 wikipedia.*.index wiki-merged.index
```

## Server caching headers

The Caddy site block sets `Cache-Control` explicitly: Vite's content-hashed
`/assets/*` are `public, max-age=31536000, immutable` (no revalidation
round trips, ever — a new deploy changes the hash), the HTML shell is
`no-cache` (revalidates so deploys appear immediately), and small statics get
a day. Index/sidecar files intentionally get none: range responses are
managed by the app's own Cache Storage layer.

## Deploying with a big index

Indexes up to 64 MB are downloaded into memory. Above that the app switches
to Range mode and fetches only the trie nodes a query actually touches
(64 KB chunks, LRU-cached). Requirements for the index host:

- HTTP Range request support (any real static file server has this).
- CORS headers if the index lives on a different origin than the page
  (`Access-Control-Allow-Origin`, and `Range` in allowed request headers).

Point the app at it with `?index=https://example.com/wiki-merged.index` or
the "index URL" box at the bottom of the page.

## License

GPL-2.0, same as upstream Nutrimatic, which this is derived from.
Original Nutrimatic is by Dan Egnor and contributors.
