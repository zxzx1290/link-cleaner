import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { handleExpand } from './worker/expand.js';

/** 建置時間（台北時區），當作版本號用：2026-07-31 14:23:05 */
const BUILD_TIME = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
/** 同一個時間的緊湊版，給 Service Worker 的快取名稱用 */
const BUILD_ID = BUILD_TIME.replace(/\D/g, '');

const SW_SOURCE = resolve(import.meta.dirname, 'public/sw.js');

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
        const response = await handleExpand(new Request(url, { method: req.method }));

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
  server: {
    host: true, // 方便用手機連進來測分享流程
  },
  build: {
    target: 'es2022',
  },
});
