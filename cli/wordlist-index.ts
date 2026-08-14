// Build a demo index from frequency wordlists (Norvig ngram format:
// "word<TAB>count" and "word1 word2<TAB>count" lines).
//
// Bigram counts are folded under their first word so trie prefix counts stay
// consistent with upstream semantics: the count of node "foo " equals the
// total frequency of "foo", split between terminal weight and per-bigram
// continuations.
//
// usage: wordlist-index out.index count_1w.txt [count_2w.txt]

import * as fs from "node:fs";
import { IndexWriter, writeEntries } from "../src/index-writer.js";
import { FileSink } from "../src/node-io.js";

const [outPath, unigramPath, bigramPath] = process.argv.slice(2);
if (!outPath || !unigramPath) {
  console.error("usage: wordlist-index out.index count_1w.txt [count_2w.txt]");
  process.exit(2);
}

const WORD = /^[a-z0-9]+$/;

function parseList(path: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const phrase = line.slice(0, tab).toLowerCase();
    const count = Number(line.slice(tab + 1));
    if (!(count > 0)) continue;
    if (!phrase.split(" ").every((w) => WORD.test(w))) continue;
    out.set(phrase, (out.get(phrase) ?? 0) + count);
  }
  return out;
}

const unigrams = parseList(unigramPath);
const bigrams = bigramPath ? parseList(bigramPath) : new Map<string, number>();

// Sum of bigram continuations per first word.
const continuations = new Map<string, number>();
for (const [phrase, count] of bigrams) {
  const first = phrase.slice(0, phrase.indexOf(" "));
  continuations.set(first, (continuations.get(first) ?? 0) + count);
}

const entries: Array<[string, number]> = [];
for (const [phrase, count] of bigrams) {
  entries.push([phrase + " ", count]);
}
for (const [word, count] of unigrams) {
  const residual = count - (continuations.get(word) ?? 0);
  if (residual > 0) entries.push([word + " ", residual]);
}
// Bigram first words missing from the unigram list keep their summed count
// purely from continuations, which the trie derives automatically.

console.error(
  `writing ${entries.length} entries (${unigrams.size} words, ${bigrams.size} bigrams)`,
);
const sink = new FileSink(outPath);
writeEntries(new IndexWriter(sink), entries);
sink.close();
console.error(`wrote ${outPath}`);
