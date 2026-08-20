// Service worker: caches the Nutristatic app shell (HTML + hashed JS/WASM/CSS)
// so the site loads and searches run with NO network, once an index has been
// stored on the device via "download whole index" (OPFS). Index and sidecar
// files are never cached here — they are large and managed by the app's own
// OPFS / Cache Storage layers.
//
// The precache list and cache version are injected at build time by
// scripts/build-sw.mjs from the content-hashed asset filenames.
const CACHE = "nutristatic-shell-__VERSION__";
const PRECACHE = [/*__PRECACHE__*/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop shell caches from previous deploys.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("nutristatic-shell-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only ever touch our own app shell.
  if (url.origin !== location.origin) return; // custom remote index URLs
  if (url.pathname.startsWith("/stats")) return; // private dashboard
  if (req.headers.has("range")) return; // range reads for the index stream
  // Index data and everything that must match the index byte for byte: a
  // `.head` answers *as* the first page of results and a `.meta.json`
  // describes the index's own conventions, so a copy cached past a rebuild
  // would answer from a corpus the index no longer contains. The app manages
  // index bytes in its own caches; these simply pass through to the network.
  if (
    url.pathname.endsWith(".index") ||
    url.pathname.endsWith(".idxz") ||
    url.pathname.endsWith(".head") ||
    url.pathname.endsWith(".meta.json")
  ) {
    return;
  }

  // Page navigations: network-first (so redeploys show up immediately), then
  // fall back to the cached page — or the app shell — when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const key = url.pathname === "/" ? "/index.html" : url.pathname;
        try {
          const net = await fetch(req);
          if (net && net.ok) cache.put(key, net.clone());
          return net;
        } catch {
          return (
            (await cache.match(key)) ||
            (await cache.match("/index.html")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Hashed assets and other shell files: cache-first (they are immutable),
  // populating on a miss so anything not precached still becomes offline-able.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req);
        if (net && net.ok) cache.put(req, net.clone());
        return net;
      } catch {
        return hit || Response.error();
      }
    })(),
  );
});
