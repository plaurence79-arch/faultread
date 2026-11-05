/* Offline shell. Bump CACHE when the app files change. */
const CACHE = 'faultread-v3';
const SHELL = [
  './',
  'index.html',
  'app.css?v=1.0.1',
  'app.js?v=1.0.1',
  'codes.json',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch the API: it must always go to the network.
  if (url.hostname.endsWith('generativelanguage.googleapis.com')) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Refresh in the background so updates land next launch.
        fetch(e.request)
          .then((res) => res.ok && caches.open(CACHE).then((c) => c.put(e.request, res.clone())))
          .catch(() => {});
        return hit;
      }
      return fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html'));
    })
  );
});
