// Measure main-thread blocking (long tasks) while a fast search floods
// results, plus time from first to last result appended.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__long.push(e.duration);
  }).observe({ entryTypes: ["longtask"] });
});
// Warm the chunk store first so the second run floods results quickly.
const url = "https://nutristatic.org/?q=" + encodeURIComponent("free A+") + "&index=./simple-wiki.index";
await page.goto(url);
await page.waitForFunction(() => document.getElementById("after").textContent.length > 0, null, { timeout: 180000 });
await page.reload();
const t0 = Date.now();
await page.waitForFunction(() => document.getElementById("after").textContent.length > 0, null, { timeout: 180000 });
const wall = Date.now() - t0;
const stats = await page.evaluate(() => ({
  results: document.querySelectorAll("#results span").length,
  longTasks: window.__long.length,
  blockedMs: Math.round(window.__long.reduce((a, b) => a + b, 0)),
}));
console.log(`warm page fill: ${stats.results} results in ${wall}ms | long tasks: ${stats.longTasks}, total blocked ${stats.blockedMs}ms`);
await browser.close();
