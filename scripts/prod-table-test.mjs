// Cold + warm sidecar-open cost: table bytes on first visit, zero on revisit.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
let idxzReqs = [];
page.on("request", (r) => {
  if (r.url().includes("en-wiki.index.idxz")) idxzReqs.push(r.headers()["range"] ?? "(full)");
});
const t0 = Date.now();
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
console.log(`cold: first result ${((Date.now()-t0)/1000).toFixed(1)}s; first idxz requests: ${idxzReqs.slice(0, 3).join(" | ")}`);
idxzReqs = [];
const t1 = Date.now();
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
const tableRefetched = idxzReqs.some((r) => r.startsWith("bytes=0-"));
console.log(`warm: first result ${((Date.now()-t1)/1000).toFixed(1)}s; table refetched: ${tableRefetched}; requests: ${idxzReqs.length}`);
await browser.close();
console.log("TABLE TEST OK");
