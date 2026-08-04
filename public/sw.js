// sw.js — minimal service worker. Its main job is to make the app installable as a PWA.
// Strategy: network-first for our own pages/assets so deployed code is never stale, with a
// cached copy as an offline fallback. API calls and cross-origin requests (map tiles,
// postcodes.io) are left to the network entirely.
const CACHE = 'fuelscan-v1.1.0';   // keep in sync with APP_VERSION in index.js

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/styles.css', '/index.js', '/icon-192.png', '/icon-512.png',
  ])).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle our own static pages/assets; never the API or cross-origin tiles.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
