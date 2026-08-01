import { lookup } from 'node:dns/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { guardSameOrigin, handleExpand, isPrivateHost } from './worker/expand.js';

/** 建置時間（台北時區），當作版本號用：2026-07-31 14:23:05 */
const BUILD_TIME = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
/** 同一個時間的緊湊版，給 Service Worker 的快取名稱用 */
const BUILD_ID = BUILD_TIME.replace(/\D/g, '');

const SW_SOURCE = resolve(import.meta.dirname, 'public/sw.js');

/**
 * dev 專用的 fetch：連出去之前先把主機名解析成 IP，再檢查一次。
 *
 * 線上不需要這層——Workers 的 fetch 出口在公網，本來就到不了 loopback 和私有網段。
 * 但 dev server 跑在自己的機器上，那裡的 127.0.0.1 和內網是真的連得到，
 * 少了這層的話，127.0.0.1.nip.io 這種「解析到迴環位址的公開域名」就能繞過
 * expand.js 的字面檢查，把 /api/expand 變成一台內網掃描器（hops 還會把結果吐回去）。
 */
async function guardedFetch(input, init) {
  const { hostname } = new URL(typeof input === 'string' ? input : input.url);
  const { address } = await lookup(hostname);
  if (isPrivateHost(address)) {
    throw new Error(`${hostname} 解析到內部位址 ${address}，已阻擋`);
  }
  return fetch(input, init);
}

/**
 * 開發伺服器上重用 Worker 的 /api/expand，
 * 這樣 `npm run dev` 的行為就和線上的 Cloudflare Worker 一致。
 */
function apiDev() {
  return {
    name: 'link-cleaner-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/expand')) return next();

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        // 標頭要一起帶過去，同源檢查才看得到 Sec-Fetch-Site
        const request = new Request(url, { method: req.method, headers: req.headers });
        const response = guardSameOrigin(request)
          || await handleExpand(request, { fetch: guardedFetch });

        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

/**
 * 把建置時間蓋進 sw.js。
 *
 * sw.js 放在 public/ 不經過 vite 轉換，所以 define 換不到它；
 * 而且它的內容必須每次建置都不一樣，瀏覽器才會發現有新版 Service Worker
 * （瀏覽器是逐位元組比對 sw.js 來判斷要不要更新的）。
 */
function swBuildStamp() {
  let outDir = 'dist';
  const stamp = (code) => code.replaceAll('__BUILD_ID__', BUILD_ID);

  return {
    name: 'link-cleaner-sw-stamp',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/sw.js') return next();
        res.setHeader('content-type', 'text/javascript');
        res.setHeader('cache-control', 'no-cache');
        res.end(stamp(readFileSync(SW_SOURCE, 'utf8')));
      });
    },
    // closeBundle 是最後一步，這時 public/ 已經複製完成，不會再被蓋回去
    closeBundle() {
      const file = resolve(import.meta.dirname, outDir, 'sw.js');
      writeFileSync(file, stamp(readFileSync(file, 'utf8')));
    },
  };
}

export default defineConfig({
  plugins: [vue(), apiDev(), swBuildStamp()],
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    target: 'es2022',
  },
});
