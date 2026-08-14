import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
// A limit-hitting query on the German index (range mode).
await page.goto("https://nutristatic.org/?q=%3Caeeimnrsttu%3E&index=.%2Fde-wiki.index");
await page.waitForFunction(() => document.getElementById("after").textContent.includes("limit"), null, { timeout: 300000 });
const buttons = await page.$$eval("#after button", (els) => els.map((e) => e.textContent));
console.log("limit buttons:", JSON.stringify(buttons));
if (!buttons.some((b) => b.includes("download the index once"))) throw new Error("nudge missing");
// Click the download suggestion; wait for disk mode + the query to re-run.
await page.click("#after button:nth-of-type(2)");
await page.waitForFunction(() => document.getElementById("indexinfo").textContent.includes("device storage"), null, { timeout: 600000 });
const t0 = Date.now();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0 || document.getElementById("after").textContent.length > 0, null, { timeout: 120000 });
const n = await page.$$eval("#results span", (e) => e.length);
console.log(`after download: ${await page.textContent("#indexinfo")} | rerun -> ${n} results / "${await page.textContent("#after")}" in ${((Date.now()-t0)/1000).toFixed(1)}s`);
await browser.close();
console.log("NUDGE TEST OK");
