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
await page.goto("http://localhost:4517/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.getElementById("after").textContent.length > 0 || document.getElementById("status").textContent === "", null, { timeout: 120000 });
console.log(`search done: requests=${reqs} fullFetches=${fullFetches} rangedMB=${(rangedBytes/1048576).toFixed(2)}`);
console.log("after:", await page.textContent("#after"));
await browser.close();
