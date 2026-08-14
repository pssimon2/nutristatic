import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
const t0 = Date.now();
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("<abcdefghijklmnopqrstuvwxy>"));
await page.waitForFunction(() => document.getElementById("after").textContent.length > 0 || document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log(`25-letter anagram: ${((Date.now()-t0)/1000).toFixed(1)}s — after="${await page.textContent("#after")}" status="${await page.textContent("#status")}" results=${await page.$$eval("#results span", e => e.length)}`);
await browser.close();
