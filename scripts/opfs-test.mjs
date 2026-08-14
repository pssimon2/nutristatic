// Full OPFS flow against the local preview: range mode -> download to OPFS
// ("on device storage") -> reload -> instant reopen from OPFS -> search works.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto("http://localhost:4517/?q=" + encodeURIComponent("solar s_stem") + "&index=./simple-wiki.index");
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log("range mode:", await page.textContent("#indexinfo"));

await page.click("#dlfull");
await page.waitForFunction(() => document.getElementById("indexinfo").textContent.includes("device storage"), null, { timeout: 120000 });
console.log("after download:", await page.textContent("#indexinfo"));

const t0 = Date.now();
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
const info = await page.textContent("#indexinfo");
console.log(`after reload: "${info}", first result "${await page.$eval("#results span", (e) => e.textContent)}" in ${((Date.now()-t0)/1000).toFixed(1)}s`);
if (!info.includes("device storage")) throw new Error("OPFS reopen failed");
await browser.close();
console.log("OPFS TEST OK");
