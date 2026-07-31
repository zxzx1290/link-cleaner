import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { handleExpand } from './worker/expand.js';

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

export default defineConfig({
  plugins: [vue(), apiDev()],
  server: {
    host: true, // 方便用手機連進來測分享流程
  },
  build: {
    target: 'es2022',
  },
});
