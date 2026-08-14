import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
for (const q of ["brandenburger A+", "müller", "<einstein>"]) {
  const t0 = Date.now();
  await page.goto("https://nutristatic.org/?q=" + encodeURIComponent(q) + "&index=./de-wiki.index");
  await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
  console.log(`[${q}] first="${await page.$eval("#results span", (e) => e.textContent)}" in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
console.log("index line:", await page.textContent("#indexinfo"));
await browser.close();
console.log("GERMAN PROD OK");
