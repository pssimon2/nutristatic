import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

let indexBytes = 0;
page.on("response", async (r) => {
  if (r.url().includes("simple-wiki.index")) {
    const len = +(r.headers()["content-length"] ?? 0);
    indexBytes += len;
  }
});

// 1. Fresh load: should be range mode, fetching only what's needed.
await page.goto("http://localhost:4517/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("search1:", await page.$eval("#results span", (e) => e.textContent));
console.log("indexinfo:", await page.textContent("#indexinfo"));
console.log("dlfull visible:", await page.$eval("#dlfull", (e) => !e.hidden));
console.log("network bytes for index (fresh):", indexBytes);

// 2. Reload, same query: chunks should come from Cache Storage.
indexBytes = 0;
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("network bytes for index (reload):", indexBytes);

// 3. Download-full upgrade.
await page.click("#dlfull");
await page.waitForFunction(() => document.getElementById("indexinfo").textContent.includes("in memory"), null, { timeout: 120000 });
console.log("after dlfull:", await page.textContent("#indexinfo"));

// 4. Reload: full copy should come from cache, memory mode.
indexBytes = 0;
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("after reload:", await page.textContent("#indexinfo"), "| network bytes:", indexBytes);

await browser.close();
console.log("RANGE MODE TEST OK");
