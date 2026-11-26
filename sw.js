// Keep only the PWA shell in Cache Storage. API requests always use the network.
const CACHE_PREFIX = 'shuangbiao-';
const CACHE_NAME = CACHE_PREFIX + 'v9';
const NETWORK_POLICY = 'ledger-static-only-v1';
const PRECACHE_URLS = ['./', './index.html', './cloud.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
    PRECACHE_URLS.map(path => new Request(new URL(path, self.registration.scope), {
      cache: 'reload', credentials: 'omit', redirect: 'error'
    }))
  )));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
  if (event.data?.type === 'LEDGER_CHECK_NETWORK_POLICY') {
    event.ports?.[0]?.postMessage(NETWORK_POLICY);
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization') || request.headers.has('apikey')) return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  // A query on the app entry can still open the static shell offline.
  // No query string, API path, redirect or runtime response is ever written to the cache.
  if (request.mode === 'navigate') url.search = '';
  const path = PRECACHE_URLS.find(candidate => new URL(candidate, scope).href === url.href);
  if (!path) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const cached = await cache.match(url.href);
    return cached || fetch(request);
  }));
});
