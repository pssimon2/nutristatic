// Warm-cache range mode: query once (seeds the persistent chunk store),
// reload (clears the in-memory LRU, keeps Cache Storage), query again.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
const q = "https://nutristatic.org/?q=" + encodeURIComponent("<aciimnrttu>");

let netReqs = 0;
page.on("request", (r) => { if (r.url().includes("en-wiki.index")) ++netReqs; });

const t0 = Date.now();
await page.goto(q);
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 180000 });
console.log(`cold: first result ${((Date.now()-t0)/1000).toFixed(1)}s, ${netReqs} net requests`);

netReqs = 0;
const t1 = Date.now();
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 180000 });
console.log(`warm (chunk store): first result ${((Date.now()-t1)/1000).toFixed(1)}s, ${netReqs} net requests`);
await browser.close();
