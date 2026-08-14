import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const profileDir = "/tmp/claude-1000/-home-ps-nutri/0c9d7ad3-bdda-4fce-9430-0c7cf8ef8467/scratchpad/chrome-profile";
const ctx = await chromium.launchPersistentContext(profileDir, { executablePath: exe });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.addInitScript(() => {
  window.__marks = [];
  const obs = new MutationObserver(() => {
    const t = document.getElementById("status")?.textContent ?? "";
    const m = /\((\d+\.\d)M steps\)/.exec(t);
    if (m) window.__marks.push([performance.now(), m[1]]);
  });
  addEventListener("DOMContentLoaded", () => obs.observe(document.getElementById("status"), { childList: true, characterData: true, subtree: true }));
  window.__t0 = performance.now();
});
await page.goto("https://nutristatic.org/?q=%3Caeeimnrsttu%3E&index=.%2Fde-wiki.index");
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0 || document.getElementById("after").textContent.length > 0, null, { timeout: 300000 });
const marks = await page.evaluate(() => ({ marks: window.__marks, t0: window.__t0 }));
let prev = 0;
for (const [t, steps] of marks.marks) {
  console.log(`${steps}M steps at t=${(t/1000).toFixed(1)}s (+${((t - prev)/1000).toFixed(1)}s)`);
  prev = t;
}
await ctx.close();
