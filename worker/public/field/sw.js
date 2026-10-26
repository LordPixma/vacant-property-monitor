// VacantWatch field service worker. The app shell works offline; writes go through the
// IndexedDB outbox in the page, so the API itself is never served from cache.
const VERSION = "vw-field-v2";
const SHELL = `${VERSION}-shell`;
const TILES = "vw-tiles";
const MAX_TILES = 600;

const PRECACHE = [
  "/field/",
  "/field/index.html",
  "/field/field.js",
  "/field/field.css",
  "/field/store.js",
  "/field/sync.js",
  "/field/manifest.webmanifest",
  "/field/icons/icon-192.png",
  "/shared/styles.css",
  "/shared/ui.js",
  "/shared/api.js",
  "/shared/map.js",
  "/shared/icon.svg",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/images/marker-icon.png",
  "/vendor/leaflet/images/marker-icon-2x.png",
  "/vendor/leaflet/images/marker-shadow.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("vw-field-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Map tiles: cache what has been viewed, so a street seen online still shows offline.
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === "opaque") {
            cache.put(req, res.clone());
            trimTiles();
          }
          return res;
        } catch {
          return new Response("", { status: 504 });
        }
      }),
    );
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Pages: network first, fall back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/field/index.html")));
    return;
  }
  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? refresh;
    }),
  );
});

// Background Sync: wake any open page to flush its outbox.
self.addEventListener("sync", (event) => {
  if (event.tag === "vw-outbox") {
    event.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ type: "sync-now" }))));
  }
});
