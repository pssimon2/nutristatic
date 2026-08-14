// First-result latency under throttling, per index.
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
for (const [label, extra] of [["enwiki", ""], ["simple", "&index=./simple-wiki.index"]]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 250 * 1024, uploadThroughput: 100 * 1024 });
  const t0 = Date.now();
  await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem") + extra);
  try {
    await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 240000 });
    console.log(`${label} @2Mbps/150ms: first result ${((Date.now()-t0)/1000).toFixed(1)}s`);
  } catch { console.log(`${label} @2Mbps/150ms: TIMEOUT (>240s)`); }
  await ctx.close();
}
await browser.close();
