// オフラインでも開けるようにファイルを保存しておく。
// ファイルを更新したら CACHE の番号を上げること（上げないと iPhone 側が古いまま）。
const CACHE = "pm-v1";
const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./pm-core.js",
  "./jsQR.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
