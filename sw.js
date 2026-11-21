// sw.js — makes the translator work offline.
// Strategy: serve from the cache first, refresh the cache from the network in
// the background. Edits you publish show up on the next visit after that.
// Change CACHE (e.g. v2) to force every device to drop the old files.
const CACHE = "offline-translator-v1";
const FILES = [
  "./", "./index.html", "./manifest.json",
  "./js/translator.js", "./js/grammar-engine.js", "./js/tokenizer.js",
  "./data/dictionary.json", "./data/grammar.json",
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // add() one by one so a single missing file doesn't block the rest
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(FILES.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);

    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === "navigate") {
      return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
    }
    return Response.error();
  })());
});
