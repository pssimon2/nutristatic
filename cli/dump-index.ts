// Port of upstream dump-index.cpp: print every stored string with its count.

import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: dump-index input.index");
  process.exit(2);
}

const reader = await IndexReader.open(new MemorySource(fs.readFileSync(path)));
const walker = await IndexWalker.create(reader, reader.root(), reader.count());
const out: string[] = [];
while (walker.text !== null) {
  out.push(`${String(walker.count).padStart(5)} [${walker.text}]`);
  if (out.length >= 10000) {
    process.stdout.write(out.join("\n") + "\n");
    out.length = 0;
  }
  await walker.next();
}
if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
