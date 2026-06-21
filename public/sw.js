/* zehntage-reactor service worker — app-shell offline cache.
 *
 * Strategy:
 *  - Precache the app shell (index.html, app.js, app.css, manifest, icons) on
 *    install so the UI loads offline.
 *  - Navigations (HTML): network-first, fall back to the cached shell so a
 *    cold offline launch still boots the SPA.
 *  - Same-origin GET static assets: stale-while-revalidate (serve cache fast,
 *    refresh in the background).
 *  - Everything else (API calls, /media streams, cross-origin, non-GET): left
 *    entirely to the network — never intercepted, never cached.
 */

const VERSION = "zr-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Core shell assets. app.js/app.css are served with Cache-Control: no-cache by
// the server, but precaching them here is what makes an offline cold load work.
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/app.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort: a single missing asset must not abort the whole install.
      await Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Paths that must always hit the network (dynamic data + large/streamed files).
function isBypassed(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/media/") ||
    url.pathname.startsWith("/sub/") ||
    url.pathname.startsWith("/dict/") ||
    url.pathname.endsWith(".json")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: untouched
  if (isBypassed(url)) return;

  // HTML navigations: network-first, fall back to the cached app shell.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put("/index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match("/index.html")) ||
            (await cache.match("/")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Static same-origin assets: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => undefined);
      return cached || (await network) || Response.error();
    })(),
  );
});
