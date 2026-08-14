import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:4517/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("first load OK:", await page.$eval("#results span", (e) => e.textContent));
// Reload: index should come from Cache Storage now.
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("after reload:", await page.textContent("#indexinfo"));
const cacheKeys = await page.evaluate(async () => {
  const c = await caches.open("nutrimatic-index-v1");
  return (await c.keys()).map((r) => r.url);
});
console.log("cache contains:", cacheKeys);
await browser.close();
console.log("CACHE TEST OK");
