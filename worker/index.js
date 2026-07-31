/**
 * Cloudflare Worker 進入點
 *
 * 靜態檔案（vite build 產出的 dist/）由 assets binding 直接供應，
 * Worker 本身只負責 /api/expand 這個唯一的伺服器端功能。
 */

import { handleExpand } from './expand.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/expand') return handleExpand(request);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
