import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext()).newPage();
let assetHits = 0;
page.on("request", (r) => { if (r.url().includes("/assets/")) ++assetHits; });
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem") + "&index=./simple-wiki.index");
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
console.log(`cold: ${assetHits} asset requests`);
assetHits = 0;
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
// Memory-cache/disk-cache hits still surface as "requests" in playwright; check served-from-cache
console.log(`warm: ${assetHits} asset request events (network layer decides via immutable)`);
await browser.close();
console.log("OK");
