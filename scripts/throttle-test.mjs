import { chromium } from "playwright-core";
const target = process.argv[2] ?? "http://localhost:4517";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 150,                       // 150ms RTT
  downloadThroughput: 250 * 1024,     // ~2 Mbps
  uploadThroughput: 100 * 1024,
});
const t0 = Date.now();
await page.goto(`${target}/?q=` + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 180000 });
console.log(`${target}: first result after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
