/**
 * Service Worker：離線可用的 App Shell 快取
 *
 * vite build 產出的檔名都帶 hash（immutable），所以這裡不維護 precache 清單，
 * 改成執行期快取：抓過一次就留著，換版時舊檔案自然不再被請求。
 */

const CACHE = 'link-cleaner-v2';

self.addEventListener('install', (event) => {
  // 先把入口頁抓下來，離線時才有東西可回
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add('/'))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 短網址還原一定要走網路，不快取
  if (url.pathname.startsWith('/api/')) return;

  // 導覽請求（含分享進來的 ?text=...）：優先走網路，離線時退回快取的入口頁
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/', { ignoreSearch: true })),
    );
    return;
  }

  // 靜態資源：cache first，順便補進快取
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
