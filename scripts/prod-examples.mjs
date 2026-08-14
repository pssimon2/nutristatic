import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });

const queries = ['"C*aC*eC*iC*oC*uC*yC*"', "867-####", '"_ ___ ___ _*burger"', "<aaagmnr>", "n[aeiou]tr[aeiou]m_tic"];
for (const q of queries) {
  const page = await browser.newPage();
  await page.goto("https://nutristatic.org/?q=" + encodeURIComponent(q));
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("#results span").length > 0 ||
            document.getElementById("after").textContent.length > 0 ||
            document.getElementById("status").className === "error",
      null, { timeout: 60000 });
    const n = await page.$$eval("#results span", (e) => e.length);
    const first = n ? await page.$eval("#results span", (e) => e.textContent) : "(none)";
    const after = await page.textContent("#after");
    const status = await page.textContent("#status");
    console.log(`[${q}] results=${n} first="${first}" after="${after}" status="${status}"`);
  } catch { console.log(`[${q}] TIMEOUT`); }
  await page.close();
}

// Mobile emulation (Pixel-ish)
const mob = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" });
mob.on("pageerror", (e) => console.log("mobile pageerror:", e.message));
await mob.goto("https://nutristatic.org/?q=" + encodeURIComponent("solar s_stem"));
try {
  await mob.waitForFunction(() => document.querySelectorAll("#results span").length > 0, null, { timeout: 60000 });
  console.log("mobile: OK, first =", await mob.$eval("#results span", (e) => e.textContent));
} catch { console.log("mobile: TIMEOUT, status =", await mob.textContent("#status"), "index =", await mob.textContent("#indexinfo")); }
await mob.screenshot({ path: "/tmp/claude-1000/-home-ps-nutri/0c9d7ad3-bdda-4fce-9430-0c7cf8ef8467/scratchpad/prod-mobile.png" });
await browser.close();
