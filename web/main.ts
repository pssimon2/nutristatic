// UI thread: form handling, URL state (?q=...&comp=...&index=...), and
// rendering of streamed results — mirroring the upstream CGI's pages, but
// with the search running in a Web Worker in the visitor's browser.

const MAX_COMPUTATION = 1000000; // steps, same default as upstream
// In range mode every step can cost network bytes, so start with a smaller
// budget; "Try harder" doubles from there as usual.
const RANGE_COMPUTATION = 150000;
const PER_RUN_RESULTS = 1000;

const BUNDLED_INDEXES: Array<[string, string]> = [
  ["./en-wiki.index", "English Wikipedia (1.3 GB)"],
  ["./de-wiki.index", "German Wikipedia (Deutsch)"],
  ["./simple-wiki.index", "Simple English Wikipedia (43 MB)"],
  ["./demo.index", "web words + bigrams (20 MB)"],
];
const DEFAULT_INDEX = BUNDLED_INDEXES[0][0];

const EXAMPLES: Array<[string, string]> = [
  ['"C*aC*eC*iC*oC*uC*yC*"', "facetiously"],
  ["867-####", "for a good time call"],
  ['"_ ___ ___ _*burger"', "lol"],
  ["<aaagmnr>", "anagram"],
];

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const qInput = $<HTMLInputElement>("q");
const home = $("home");
const resultsView = $("resultsview");
const statusEl = $("status");
const resultsEl = $("results");
const afterEl = $("after");
const indexInfo = $("indexinfo");
const indexUrlInput = $<HTMLInputElement>("indexurl");
const indexPick = $<HTMLSelectElement>("indexpick");
const customRow = $("customrow");
const dlFull = $<HTMLButtonElement>("dlfull");

const params = new URLSearchParams(location.search);
// Resolve against the page URL: the worker would otherwise resolve relative
// paths against its own script URL.
const indexUrl = new URL(params.get("index") || DEFAULT_INDEX, location.href)
  .href;
indexUrlInput.value = indexUrl;

for (const [value, label] of BUNDLED_INDEXES) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  indexPick.append(opt);
}
{
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "custom URL…";
  indexPick.append(custom);
}
const bundledMatch = BUNDLED_INDEXES.find(
  ([value]) => new URL(value, location.href).href === indexUrl,
);
indexPick.value = bundledMatch ? bundledMatch[0] : "custom";
customRow.hidden = indexPick.value !== "custom";

function navigateToIndex(url: string | null): void {
  const p = new URLSearchParams(location.search);
  const isDefault =
    !url ||
    new URL(url, location.href).href === new URL(DEFAULT_INDEX, location.href).href;
  if (isDefault) p.delete("index");
  else p.set("index", url!);
  location.search = p.toString() ? `?${p}` : "";
}

indexPick.addEventListener("change", () => {
  if (indexPick.value === "custom") {
    customRow.hidden = false;
    indexUrlInput.focus();
  } else {
    navigateToIndex(indexPick.value);
  }
});

// Populate examples, preserving a custom index in links.
const examplesEl = $("examples");
for (const [query, text] of EXAMPLES) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const p = new URLSearchParams();
  p.set("q", query);
  if (params.get("index")) p.set("index", params.get("index")!);
  a.href = `?${p}`;
  a.style.textDecoration = "none";
  a.textContent = query;
  li.append(a, ` - ${text}`);
  examplesEl.append(li);
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

let indexReady = false;
let indexMode: "memory" | "range" = "memory";
let pendingQuery: string | null = null;
let searching = false;
let resultCount = 0;
let currentComp = MAX_COMPUTATION;

const fmtMB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "";
}

function fontSize(score: number): number {
  let size: number;
  if (score >= 1.0) size = 1.5 + Math.log(score) / 5.0;
  else if (score > 0.0) size = 1.5 + Math.log(score) / 50.0;
  else size = 0;
  return Math.max(size, 0.4);
}

function addResult(score: number, text: string): void {
  const span = document.createElement("span");
  span.style.fontSize = `${fontSize(score)}em`;
  span.textContent = text;
  span.title = `score ${score.toPrecision(4)}`;
  resultsEl.append(span, document.createElement("br"));
  ++resultCount;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "linkish";
  b.addEventListener("click", onClick);
  return b;
}

/** Umlauts/eszett in queries get the same transliteration as index text. */
function transliterate(query: string): string {
  return query
    .replace(/[äÄ]/g, "ae")
    .replace(/[öÖ]/g, "oe")
    .replace(/[üÜ]/g, "ue")
    .replace(/[ßẞ]/g, "ss");
}

function startSearch(query: string): void {
  resultsEl.textContent = "";
  afterEl.textContent = "";
  resultCount = 0;
  currentComp =
    parseInt(params.get("comp") || "", 10) ||
    (indexMode === "range" ? RANGE_COMPUTATION : MAX_COMPUTATION);
  searching = true;
  setStatus("searching…");
  worker.postMessage({
    type: "search",
    query: transliterate(query),
    maxSteps: currentComp,
    maxResults: PER_RUN_RESULTS,
  });
}

function tryHarder(): void {
  currentComp *= 2;
  afterEl.textContent = "";
  searching = true;
  setStatus("searching harder…");
  worker.postMessage({
    type: "continue",
    maxSteps: currentComp,
    maxResults: PER_RUN_RESULTS,
  });
}

function moreResults(): void {
  afterEl.textContent = "";
  searching = true;
  setStatus("fetching more results…");
  worker.postMessage({
    type: "continue",
    maxSteps: currentComp,
    maxResults: PER_RUN_RESULTS,
  });
}

worker.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "loading":
      if (msg.mode === "download") {
        indexInfo.textContent = msg.cached
          ? `${fmtMB(msg.bytes)} (from browser cache)`
          : `downloading… ${fmtMB(msg.loaded ?? 0)} / ${fmtMB(msg.bytes)}`;
      } else {
        indexInfo.textContent = `probing (${fmtMB(msg.bytes)}, range mode)…`;
      }
      break;
    case "ready":
      indexReady = true;
      indexMode = msg.mode === "range" ? "range" : "memory";
      if (msg.mode === "disk") {
        indexInfo.textContent = `${fmtMB(msg.bytes)} on device storage`;
        dlFull.hidden = true;
      } else if (msg.mode === "memory") {
        indexInfo.textContent = `${fmtMB(msg.bytes)} in memory${msg.cached ? " (from cache)" : ""}`;
        dlFull.hidden = true;
      } else {
        indexInfo.textContent = `${fmtMB(msg.bytes)}, loading only what's needed`;
        dlFull.textContent = `download whole index (${fmtMB(msg.bytes)}) »`;
        dlFull.disabled = false;
        dlFull.hidden = false;
      }
      if (pendingQuery !== null) {
        const q = pendingQuery;
        pendingQuery = null;
        startSearch(q);
      }
      break;
    case "result":
      addResult(msg.score, msg.text);
      break;
    case "progress":
      setStatus(`searching… (${(msg.steps / 1e6).toFixed(1)}M steps)`);
      if (msg.fetched !== undefined) {
        indexInfo.textContent = `${fmtMB(msg.fetched)} fetched so far`;
      }
      break;
    case "parse-error":
      searching = false;
      setStatus(`can't parse "${msg.rest}"`, true);
      break;
    case "error":
      searching = false;
      setStatus(`error: ${msg.message}`, true);
      if (!indexReady) {
        // Index load failed (flaky connection?): offer a clean retry.
        indexInfo.textContent = "load failed";
        afterEl.textContent = "";
        afterEl.append(
          actionButton("Retry loading index »", () => {
            afterEl.textContent = "";
            setStatus("loading index…");
            const q = qInput.value.trim();
            if (q) pendingQuery = q;
            worker.postMessage({ type: "open", url: indexUrl });
          }),
        );
      }
      break;
    case "done":
      searching = false;
      setStatus("");
      if (msg.status === "exhausted") {
        afterEl.textContent =
          resultCount > 0 ? "No more results found." : "No results found, sorry.";
      } else if (msg.status === "limit") {
        afterEl.textContent = "Computation limit reached.";
        afterEl.append(
          actionButton(
            currentComp > RANGE_COMPUTATION ? "Try even harder »" : "Try harder »",
            tryHarder,
          ),
        );
        if (indexMode === "range" && !dlFull.hidden) {
          // Broad searches walk far more of the index than streaming suits;
          // a downloaded copy runs them at full speed.
          afterEl.append(
            actionButton(
              `or download the index once (${dlFull.textContent!.match(/\(([^)]+)\)/)?.[1] ?? ""}) for much faster searching »`,
              startFullDownload,
            ),
          );
        }
      } else {
        // Result budget filled; offer the next page.
        afterEl.append(actionButton("More results »", moreResults));
      }
      break;
  }
};

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const query = qInput.value.trim();
  const p = new URLSearchParams();
  if (query) p.set("q", query);
  if (params.get("index")) p.set("index", params.get("index")!);
  history.pushState(null, "", query ? `?${p}` : location.pathname);
  applyQuery(query);
});

$("setindex").addEventListener("click", () => {
  navigateToIndex(indexUrlInput.value.trim() || null);
});

function startFullDownload(): void {
  // Cancels any running search; the current query re-runs once downloaded.
  dlFull.disabled = true;
  searching = false;
  const q = qInput.value.trim();
  if (q && !resultsView.hidden) pendingQuery = q;
  setStatus("");
  afterEl.textContent = "";
  indexReady = false;
  worker.postMessage({ type: "download-full" });
}

dlFull.addEventListener("click", startFullDownload);

function applyQuery(query: string): void {
  if (query) {
    qInput.value = query;
    document.title = `${query} - Nutristatic`;
    home.hidden = true;
    resultsView.hidden = false;
    if (indexReady) startSearch(query);
    else {
      pendingQuery = query;
      setStatus("loading index…");
    }
  } else {
    document.title = "Nutristatic";
    home.hidden = false;
    resultsView.hidden = true;
    worker.postMessage({ type: "stop" });
  }
}

window.addEventListener("popstate", () => {
  const p = new URLSearchParams(location.search);
  applyQuery((p.get("q") || "").trim());
});

async function postOpen(): Promise<void> {
  // Hand the worker whatever the inline <head> script already fetched
  // (probe + sidecar table): saves several round trips on cold loads.
  const early = (window as any).__earlyIndex;
  (window as any).__earlyIndex = null; // consume once
  if (early && early.url === indexUrl) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000));
    const settled = await Promise.race([
      Promise.all([early.probe, early.table]),
      timeout,
    ]);
    if (settled) {
      const [probe, table] = settled as [unknown, ArrayBuffer | null];
      worker.postMessage(
        { type: "open", url: indexUrl, early: { probe, table } },
        table ? [table] : [],
      );
      return;
    }
  }
  worker.postMessage({ type: "open", url: indexUrl });
}

void postOpen();
applyQuery((params.get("q") || "").trim());
