/**
 * Cloudflare Worker 進入點
 *
 * 靜態檔案（vite build 產出的 dist/）由 assets binding 直接供應，
 * Worker 本身只負責 /api/expand 這個唯一的伺服器端功能。
 */

import { guardSameOrigin, handleExpand } from './expand.js';

/**
 * 依來源 IP 限流。
 *
 * /api/expand 一個請求會對外打最多 MAX_HOPS 次 fetch，是個現成的流量放大器。
 * 沒有這道閘門的話，任何人都能拿它去轟第三方網站——對方看到的來源是 Cloudflare 的
 * IP，被投訴時要負責的是我們的帳號；順帶還會把免費方案的每日請求額度燒光。
 *
 * 用 ratelimits binding 而不是 WAF 規則，是因為 WAF 只能掛在自己的 zone 上，
 * 而這個 Worker 目前跑在 workers.dev 底下。binding 不受這個限制。
 * 沒設定 binding 時（例如 wrangler dev 沒帶設定檔）就直接放行，不讓限流本身變成故障點。
 */
async function rateLimited(request, env) {
  const limiter = env.EXPAND_LIMITER;
  if (!limiter) return false;

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

function tooManyRequests() {
  return new Response(JSON.stringify({ ok: false, error: '太頻繁了，請稍後再試' }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/expand') {
      const blocked = guardSameOrigin(request);
      if (blocked) return blocked;
      if (await rateLimited(request, env)) return tooManyRequests();
      return handleExpand(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
