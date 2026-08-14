// Port of upstream merge-indexes.cpp: merge sorted indexes with a frequency
// cutoff. usage: merge-indexes min input.index ... out.index

import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";
import { IndexWriter } from "../src/index-writer.js";
import { mergeWalkers } from "../src/merge.js";
import { FileSink } from "../src/node-io.js";

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("usage: merge-indexes min input.index ... out.index");
  process.exit(2);
}

const cutoff = parseInt(args[0], 10);
if (!(cutoff > 0)) {
  console.error(`error: illegal frequency threshold "${args[0]}"`);
  process.exit(2);
}

const outPath = args[args.length - 1];
if (fs.existsSync(outPath)) {
  console.error(`error: output "${outPath}" already exists`);
  process.exit(1);
}

const walkers = [];
for (const path of args.slice(1, -1)) {
  const reader = await IndexReader.open(
    new MemorySource(fs.readFileSync(path)),
  );
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  if (walker.text === null) {
    console.error(`warning: empty input "${path}"`);
  } else {
    walkers.push(walker);
  }
}

const sink = new FileSink(outPath);
await mergeWalkers(walkers, cutoff, new IndexWriter(sink));
sink.close();
