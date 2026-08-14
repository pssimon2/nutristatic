import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
page.on("console", (m) => console.log("console:", m.type(), m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("requestfailed", (r) => console.log("reqfail:", r.url(), r.failure()?.errorText));
await page.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem"));
try {
  await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 45000 });
  console.log("first result:", await page.$eval("#results span", (e) => e.textContent));
} catch {
  console.log("NO RESULTS after 45s");
  console.log("status:", await page.textContent("#status"));
  console.log("indexinfo:", await page.textContent("#indexinfo"));
  console.log("after:", await page.textContent("#after"));
}
await page.screenshot({ path: "/tmp/claude-1000/-home-ps-nutri/0c9d7ad3-bdda-4fce-9430-0c7cf8ef8467/scratchpad/prod-debug.png" });
await browser.close();
