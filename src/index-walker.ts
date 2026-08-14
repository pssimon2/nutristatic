// Port of upstream index-walker.cpp: in-order traversal of every string in
// the index that has a terminal count, tracking the shared-prefix length
// (`same`) with the previously emitted string.

import { Choice, IndexReader } from "./index-reader.js";

interface Frame {
  choices: Choice[];
  next: number;
}

export class IndexWalker {
  text: string | null = null;
  same = 0;
  count = 0;

  private readonly stack: Frame[] = [];
  private stackSize = 0;
  private readonly buf: number[] = [];

  private constructor(private readonly reader: IndexReader) {}

  static async create(
    reader: IndexReader,
    node: number,
    count: number,
  ): Promise<IndexWalker> {
    const walker = new IndexWalker(reader);
    walker.stack.push({ choices: [], next: 0 });
    walker.stackSize = 1;
    await walker.reader.children(node, count, walker.stack[0].choices);
    await walker.next();
    return walker;
  }

  async next(): Promise<void> {
    while (
      this.stackSize > 0 &&
      this.stack[this.stackSize - 1].next ===
        this.stack[this.stackSize - 1].choices.length
    ) {
      this.stack[--this.stackSize].choices = [];
    }

    if (this.stackSize === 0) {
      this.text = null;
      this.same = 0;
      this.count = 0;
      return;
    }

    this.same = this.stackSize - 1;

    do {
      if (++this.stackSize > this.stack.length) {
        this.stack.push({ choices: [], next: 0 });
      }
      const parent = this.stack[this.stackSize - 2];
      const child = this.stack[this.stackSize - 1];
      const choice = parent.choices[parent.next++];

      child.next = 0;
      child.choices.length = 0;
      this.count = await this.reader.children(
        choice.next,
        choice.count,
        child.choices,
      );

      this.buf[this.stackSize - 2] = choice.ch;
    } while (this.count === 0);

    this.text = String.fromCharCode(...this.buf.slice(0, this.stackSize - 1));
  }
}
