import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
let ranged = 0;
page.on("request", (r) => { const m = /bytes=(\d+)-(\d+)/.exec(r.headers()["range"] ?? ""); if (m && r.url().includes("en-wiki")) ranged += +m[2] - +m[1] + 1; });
for (const q of ["solar s_stem", "<aciimnrttu>", '"C*aC*eC*iC*oC*uC*yC*"']) {
  const t0 = Date.now();
  await page.goto("https://nutristatic.org/?q=" + encodeURIComponent(q));
  await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0 || document.getElementById("after").textContent.length > 0, null, { timeout: 120000 });
  const n = await page.$$eval("#results span", (e) => e.length);
  const first = n ? await page.$eval("#results span", (e) => e.textContent) : "(none)";
  console.log(`[${q}] first="${first}" after ${((Date.now()-t0)/1000).toFixed(1)}s, fetched so far ${(ranged/1048576).toFixed(1)}MB total`);
}
console.log("index line:", await page.textContent("#indexinfo"));
await browser.close();
console.log("ENWIKI PROD OK");
