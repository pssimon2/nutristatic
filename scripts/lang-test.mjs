import { chromium } from "playwright-core";
const [lang, ...pairs] = process.argv.slice(2);
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
for (let i = 0; i < pairs.length; i += 2) {
  const q = pairs[i], expect = pairs[i + 1];
  const t0 = Date.now();
  await page.goto(`https://nutristatic.org/?q=${encodeURIComponent(q)}&index=.%2F${lang}-wiki.index`);
  await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 120000 });
  const first = await page.$eval("#results span", (e) => e.textContent);
  const ok = first === expect || expect === "*";
  console.log(`[${lang}] "${q}" -> "${first}" in ${((Date.now()-t0)/1000).toFixed(1)}s ${ok ? "OK" : "EXPECTED " + expect}`);
  if (!ok) process.exitCode = 1;
}
await browser.close();
