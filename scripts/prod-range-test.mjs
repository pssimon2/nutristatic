import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
let fullFetches = 0, rangedBytes = 0, reqs = 0;
page.on("request", (r) => {
  if (!r.url().includes("simple-wiki.index")) return;
  ++reqs;
  const range = r.headers()["range"];
  if (!range) { ++fullFetches; return; }
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (m) rangedBytes += +m[2] - +m[1] + 1;
});
const t0 = Date.now();
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 90000 });
console.log(`first result after ${((Date.now()-t0)/1000).toFixed(1)}s: "${await page.$eval("#results span", (e) => e.textContent)}"`);
console.log(`requests so far=${reqs} full=${fullFetches} rangedMB=${(rangedBytes/1048576).toFixed(2)}`);
await page.waitForFunction(() => document.getElementById("after").textContent.length > 0 || document.getElementById("status").textContent === "", null, { timeout: 120000 });
console.log(`search finished: requests=${reqs} full=${fullFetches} rangedMB=${(rangedBytes/1048576).toFixed(2)}`);
console.log("indexinfo:", await page.textContent("#indexinfo"));
await browser.close();
console.log("PROD RANGE TEST OK");
