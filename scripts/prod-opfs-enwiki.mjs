// At-scale verification on production: download the 1.3GB en-wiki index to
// OPFS, search from disk, reload, confirm instant reopen.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
const t0 = Date.now();
await page.click("#dlfull");
await page.waitForFunction(() => document.getElementById("indexinfo").textContent.includes("device storage"), null, { timeout: 900000 });
console.log(`1.3GB downloaded to OPFS in ${((Date.now()-t0)/1000/60).toFixed(1)} min`);

// Heavy query from disk:
const t1 = Date.now();
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("<aciimnrttu>"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
console.log(`<aciimnrttu> from OPFS: "${await page.$eval("#results span", (e) => e.textContent)}" in ${((Date.now()-t1)/1000).toFixed(1)}s (includes page load + reopen)`);
console.log("index line:", await page.textContent("#indexinfo"));
await browser.close();
console.log("PROD OPFS AT SCALE OK");
