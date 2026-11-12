// Woogles-TV service worker: network-first with a cache fallback so the app shell opens offline-ish
// and installs as a PWA. Game traffic (/api, /ws, /qr) is never cached.
const CACHE = 'wt-v2';
const SHELL = ['/', '/static/app.css', '/static/play.css', '/static/common.js', '/static/index.js', '/static/play.js',
  '/static/cast.js', '/static/confetti.js', '/static/announcer.js', '/static/fonts/fonts.css', '/static/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|ws|qr|app\/)/.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(async () => (await caches.match(e.request, { ignoreSearch: u.pathname === '/' })) ||
    (e.request.mode === 'navigate' ? (await caches.match('/')) : Response.error())));
});
