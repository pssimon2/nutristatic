import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { lineChains } from "../src/corpus.js";

async function buildReader(entries: Array<[string, number]>) {
  const sink = new BufferSink();
  writeEntries(new IndexWriter(sink), entries.slice());
  return IndexReader.open(new MemorySource(sink.bytes()));
}

async function dumpAll(reader: IndexReader): Promise<Array<[string, number]>> {
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  const out: Array<[string, number]> = [];
  while (walker.text !== null) {
    out.push([walker.text, walker.count]);
    await walker.next();
  }
  return out;
}

describe("index round-trip", () => {
  it("stores and recovers phrases with small counts", async () => {
    const entries: Array<[string, number]> = [
      ["bar ", 3],
      ["baz ", 1],
      ["foo bar ", 2],
      ["foo ", 7],
    ];
    const reader = await buildReader(entries);
    expect(reader.count()).toBe(13);
    expect(await dumpAll(reader)).toEqual(
      entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
  });

  it("handles 2-byte and 8-byte count/offset node formats", async () => {
    // Large counts force the 0xC0 and 0xE0 node modes.
    const entries: Array<[string, number]> = [
      ["big ", 1e12],
      ["bigger ", 70000],
      ["medium ", 999],
      ["small ", 3],
      // Many siblings spread the offsets out.
      ...Array.from({ length: 200 }, (_, i): [string, number] => [
        `word${String(i).padStart(3, "0")} `,
        i + 1,
      ]),
    ];
    const reader = await buildReader(entries);
    const dumped = await dumpAll(reader);
    expect(new Map(dumped)).toEqual(new Map(entries));
    expect(reader.count()).toBe(entries.reduce((s, [, c]) => s + c, 0));
  });

  it("merges duplicate strings by accumulating counts", async () => {
    const reader = await buildReader([
      ["dup ", 2],
      ["dup ", 5],
    ]);
    expect(await dumpAll(reader)).toEqual([["dup ", 7]]);
  });
});

describe("corpus windowing", () => {
  it("normalizes text and emits word-boundary windows", () => {
    const out: string[] = [];
    lineChains("Hello, World! Don't panic.", out);
    expect(out).toEqual([
      "hello world dont panic ",
      "world dont panic ",
      "dont panic ",
      "panic ",
    ]);
  });

  it("slides a 40-char window over long lines", () => {
    const out: string[] = [];
    lineChains("aaaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh", out);
    expect(out[0]).toHaveLength(40);
    expect(out[0].startsWith("aaaaa bbbbb")).toBe(true);
    // Every window starts at a word boundary.
    for (const w of out) expect(w.startsWith(" ")).toBe(false);
  });
});
