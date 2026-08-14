import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });

const ranges = [];
page.on("request", (r) => {
  if (r.url().includes("simple-wiki.index")) ranges.push(r.headers()["range"] ?? "(none)");
});

await page.goto("http://localhost:4517/?q=" + encodeURIComponent("solar s_stem"));
await page.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
// let the search finish
await page.waitForFunction(() => document.getElementById("status").textContent === "" || document.getElementById("after").textContent.length > 0, null, { timeout: 120000 });
console.log("total index requests:", ranges.length);
console.log("first 12 ranges:", ranges.slice(0, 12));
// span histogram
const sizes = {};
for (const r of ranges) {
  const m = /bytes=(\d+)-(\d+)/.exec(r);
  if (m) { const s = (+m[2] - +m[1] + 1); sizes[s] = (sizes[s] ?? 0) + 1; }
}
console.log("span sizes:", sizes);
// duplicate chunk fetches?
const seen = new Map();
for (const r of ranges) seen.set(r, (seen.get(r) ?? 0) + 1);
const dups = [...seen.entries()].filter(([, n]) => n > 1);
console.log("duplicate identical ranges:", dups.length, dups.slice(0, 5));

console.log("status:", await page.textContent("#status"), "| after:", await page.textContent("#after"));

// now try download-full and watch what happens
await page.click("#dlfull");
for (let i = 0; i < 12; ++i) {
  await page.waitForTimeout(5000);
  const info = await page.textContent("#indexinfo");
  const status = await page.textContent("#status");
  console.log(`t+${(i+1)*5}s indexinfo="${info}" status="${status}"`);
  if (info.includes("in memory")) break;
}
await browser.close();
