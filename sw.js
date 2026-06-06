const CACHE_NAME = 'transit-v12';
const ASSETS = [
  './',
  './index.html',
  './router.js',
  './graph_v2.json',
  './frequency.json',
  './through_service.json',
  './train_types.json',
  './fares.json',
  './timetable_v2.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('transit-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first with cache fallback (ensures updates are picked up when online)
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        // Cache successful responses
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(e.request).then(r => r || new Response('Offline', { status: 503 }));
      })
  );
});
