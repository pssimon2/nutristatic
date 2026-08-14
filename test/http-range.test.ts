// Integration test for range-request mode: serve the demo index over a
// local HTTP server that honors Range headers, and verify a search via
// HttpRangeSource returns exactly what the in-memory source returns.

import * as fs from "node:fs";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpRangeSource, MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession, SearchResult } from "../src/search-session.js";

const INDEX_PATH = new URL("../web/public/demo.index", import.meta.url)
  .pathname;

let server: http.Server;
let baseUrl: string;
const data = fs.readFileSync(INDEX_PATH);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = parseInt(range[1], 10);
      const end = Math.min(parseInt(range[2], 10), data.length - 1);
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${data.length}`,
        "content-length": end - start + 1,
      });
      res.end(data.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "content-length": data.length });
      res.end(data);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function collect(
  reader: IndexReader,
  query: string,
  maxSteps: number,
  prefetchDepth = 0,
): Promise<SearchResult[]> {
  const session = new SearchSession(reader, query, undefined, { prefetchDepth });
  const results: SearchResult[] = [];
  await session.run(maxSteps, 50, (r) => results.push(r));
  return results;
}

describe("HttpRangeSource", () => {
  it("reports the file length from a range probe", async () => {
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    expect(source.length).toBe(data.length);
  });

  it("search over ranges matches search over memory", async () => {
    const memReader = await IndexReader.open(new MemorySource(data));
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`, {
      chunkSize: 1 << 14,
      maxChunks: 64, // force LRU eviction
    });
    const rangeReader = await IndexReader.open(source);

    expect(rangeReader.count()).toBe(memReader.count());

    const memResults = await collect(memReader, "n[aeiou]tr[aeiou]m_tic", 200000);
    // prefetchDepth exercises speculative fetches + in-flight dedupe.
    const rangeResults = await collect(
      rangeReader,
      "n[aeiou]tr[aeiou]m_tic",
      200000,
      6,
    );
    expect(rangeResults).toEqual(memResults);
    expect(source.requests).toBeGreaterThan(0);
  }, 60000);

  it("fetches a bounded volume with a realistic cache", async () => {
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    const reader = await IndexReader.open(source);
    const results = await collect(reader, "n[aeiou]tr[aeiou]m_tic", 200000);
    expect(results.length).toBeGreaterThan(0);
    // Over loopback the measured RTT/bandwidth make the adaptive read-ahead
    // legitimately aggressive, so only assert we don't grossly re-fetch.
    expect(source.bytesFetched).toBeLessThan(data.length * 1.5);
  }, 60000);
});
