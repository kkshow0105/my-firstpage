// ═══════════════════════════════════════════════════════
// Service Worker — 双表记账 PWA
// 策略：缓存优先（Cache First）
//   - install 时预缓存 HTML + manifest
//   - 所有请求先查缓存，命中直接返回；未命中再走网络并写入缓存
//   - 完全离线时从缓存返回，不影响使用
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'shuangbiao-v4';

// 需要预缓存的资源（相对于 sw.js 所在目录）
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json'
];

// ── install：预缓存核心资源 ──────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 逐个缓存，单个失败不影响整体
      return Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── activate：清理旧版本缓存 ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── fetch：缓存优先策略 ─────────────────────────────────
self.addEventListener('fetch', event => {
  // 只处理 GET 请求，忽略其他方法（POST 等）
  if (event.request.method !== 'GET') return;

  // 忽略非 http/https 请求（如 chrome-extension://）
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      // 1. 先查缓存
      const cached = await cache.match(event.request);
      if (cached) {
        // 命中缓存：后台静默更新（不阻塞响应）
        fetch(event.request)
          .then(response => {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone());
            }
          })
          .catch(() => {}); // 离线时后台更新失败，静默忽略
        return cached;
      }

      // 2. 缓存未命中：走网络，成功后写入缓存
      try {
        const response = await fetch(event.request);
        if (response && response.status === 200) {
          cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        // 3. 离线且无缓存：导航请求返回主页兜底
        if (event.request.mode === 'navigate') {
          const fallback = await cache.match('./') || await cache.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('离线中，请稍后重试', {
          status: 503,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        });
      }
    })
  );
});
