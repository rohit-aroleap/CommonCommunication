// Minimal service worker for PWA installability + offline app-shell.
// Strategy: network-first for everything (so message data stays fresh), with
// a same-origin cache fallback so the app shell can boot when offline. We
// deliberately don't cache Firebase RTDB / Worker API calls — those should
// always hit the network so messages don't go stale.

const CACHE = "cc-mobile-v1";
const SHELL = [
  "/",
  "/mobile.html",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept cross-origin (Firebase, Worker, gstatic) — let them go direct.
  if (url.origin !== self.location.origin) return;

  // For the app shell HTML, prefer network so users get the latest version
  // immediately on refresh, but fall back to cache if offline.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Last-resort fallback for navigations: serve the shell page.
      if (req.mode === "navigate") {
        const shell = await caches.match("/mobile.html");
        if (shell) return shell;
      }
      throw new Error("offline and not in cache");
    }
  })());
});
