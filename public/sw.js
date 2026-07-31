/**
 * Service Worker：離線可用的 App Shell 快取
 *
 * vite build 產出的檔名都帶 hash（immutable），所以這裡不維護 precache 清單，
 * 改成執行期快取：抓過一次就留著，換版時舊檔案自然不再被請求。
 *
 * 快取名稱尾巴那串數字是建置時間，由 vite 在建置時填進來，有兩個作用：
 * 1. 讓 sw.js 每次建置的內容都不同，瀏覽器才認得出「有新版」
 * 2. 快取名稱跟著換版，activate 時舊版快取（含舊的入口頁）會被整包清掉
 */

const CACHE = 'link-cleaner-__BUILD_ID__';

self.addEventListener('install', (event) => {
  // 先把入口頁抓下來，離線時才有東西可回。
  // 這裡刻意不呼叫 skipWaiting()：新版要等使用者在畫面上按「立即更新」才接手，
  // 免得正在操作時腳下的檔案被換掉。第一次安裝沒有舊版佔著，不受影響。
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add('/'))
      .catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 使用者按下「立即更新」時，前台會送這個訊息過來
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
