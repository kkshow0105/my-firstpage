// Service Worker for 双表记账 — offline support
const CACHE = 'shuangbiao-v1';
const URLS = [self.location.href.replace(/\/sw\.js.*$/, '/双表记账.html'), './'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only handle navigation requests (HTML pages)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('./双表记账.html'))
    );
  }
});
