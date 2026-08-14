// Node-only helpers: file-backed sink for IndexWriter and line reading.

import * as fs from "node:fs";
import { ByteSink } from "./index-writer.js";

export class FileSink implements ByteSink {
  private readonly fd: number;
  private readonly buf = new Uint8Array(1 << 16);
  private len = 0;

  constructor(path: string) {
    this.fd = fs.openSync(path, "w");
  }

  put(b: number): void {
    if (this.len === this.buf.length) this.flush();
    this.buf[this.len++] = b & 0xff;
  }

  flush(): void {
    if (this.len > 0) {
      fs.writeSync(this.fd, this.buf, 0, this.len);
      this.len = 0;
    }
  }

  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}
