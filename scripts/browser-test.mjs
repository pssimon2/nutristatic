import { chromium } from "playwright-core";

const exe = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on("console", (m) => console.log("console:", m.type(), m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));

// Home page
await page.goto("http://localhost:4517/");
await page.waitForSelector("#examples li");
console.log("home title:", await page.title());
await page.waitForFunction(
  () => document.getElementById("indexinfo").textContent.includes("in memory"),
  null,
  { timeout: 60000 },
);
console.log("index status:", await page.textContent("#indexinfo"));
await page.screenshot({ path: "home.png" });

// Search via the form
await page.fill("#q", "<aaagmnr>");
await page.click("input[type=submit]");
await page.waitForFunction(
  () => document.querySelectorAll("#results span").length > 0,
  null,
  { timeout: 60000 },
);
await page.waitForFunction(
  () => document.getElementById("after").textContent.length > 0 ||
        document.getElementById("status").textContent === "",
  null,
  { timeout: 120000 },
);
const results = await page.$$eval("#results span", (els) =>
  els.slice(0, 5).map((e) => `${e.textContent} (${e.style.fontSize})`),
);
console.log("anagram results:", results);
console.log("after:", await page.textContent("#after"));
console.log("url:", page.url());
await page.screenshot({ path: "search.png" });

// Pattern with computation limit: something open-ended
await page.goto("http://localhost:4517/?q=" + encodeURIComponent('"C*aC*eC*iC*oC*uC*yC*"'));
await page.waitForFunction(
  () => document.getElementById("after").textContent.length > 0,
  null,
  { timeout: 120000 },
);
console.log("facetiously first:", await page.$eval("#results span", (e) => e.textContent));
console.log("facetiously after:", await page.textContent("#after"));
await page.screenshot({ path: "search2.png" });

// Parse error case
await page.goto("http://localhost:4517/?q=" + encodeURIComponent("((("));
await page.waitForFunction(
  () => document.getElementById("status").textContent.includes("parse") ||
        document.getElementById("status").className === "error",
  null,
  { timeout: 60000 },
);
console.log("error case:", await page.textContent("#status"));

await browser.close();
console.log("BROWSER TEST OK");
