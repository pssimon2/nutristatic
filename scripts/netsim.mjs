// Simulated-network harness: drives HttpRangeSource with a fake fetch that
// reads the index file directly and models RTT + bandwidth per request.
import * as fs from "node:fs";
import { HttpRangeSource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";

const INDEX = process.argv[2] ?? "data/wiki-merged.index";
const RTT = Number(process.argv[3] ?? 40) / 1000;      // ms -> s
const BW = Number(process.argv[4] ?? 30) * 1024 * 1024; // MB/s -> B/s
const data = fs.readFileSync(INDEX);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const fakeFetch = async (url, init) => {
  const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
  const start = range ? +range[1] : 0;
  const end = range ? Math.min(+range[2], data.length - 1) : data.length - 1;
  const body = data.subarray(start, end + 1);
  await sleep(RTT + body.length / BW);
  return new Response(new Uint8Array(body), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${data.length}` },
  });
};

for (const q of ["<aciimnrttu>", '"C*aC*eC*iC*oC*uC*yC*"', "solar s_stem"]) {
  const source = await HttpRangeSource.open("http://sim/index", {
    fetchFn: fakeFetch, chunkSize: 1 << 15, maxChunks: 4096,
  });
  const reader = await IndexReader.open(source);
  const t0 = performance.now();
  const session = new SearchSession(reader, q, undefined, { prefetchDepth: 48 });
  let first = null, tFirst = 0;
  await session.run(150000, 1000, (r) => { if (!first) { first = r.text; tFirst = performance.now() - t0; } });
  const total = performance.now() - t0;
  console.log(`[${q}] first="${first}" ${(tFirst/1000).toFixed(1)}s | run ${(total/1000).toFixed(1)}s | ${(source.bytesFetched/1048576).toFixed(1)}MB in ${source.requests} reqs${source.readAheadStats ? " | " + source.readAheadStats() : ""}`);
}
