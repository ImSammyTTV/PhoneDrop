// Keeps the app's own files on the phone, so PhoneDrop opens instantly, and
// still opens away from home, when the hub is only reachable over Tailscale.
// Served from the cache first and refreshed in the background. Clips, files
// and the hub's address list always go over the network.
const CACHE = 'phonedrop-v2';
const SHELL = ['/', '/app.js', '/style.css', '/shared/crypto.js', '/shared/connect.js', '/manifest.webmanifest', '/icon.svg', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
      .catch(() => cached);
    return cached || fresh;
  }));
});
