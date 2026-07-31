/**
 * 短網址還原：由自家 Worker 代為跟隨重導向
 *
 * 瀏覽器受 CORS 限制讀不到跨網域的最終位址，所以交給伺服器端處理。
 * 這裡只用 fetch 的 manual redirect 自己一跳一跳走，不經過任何第三方服務。
 *
 * 只依賴 Web 標準 API（Request / Response / fetch / AbortSignal），
 * 因此同一份程式碼可以跑在 Workers 上，也可以在 Vite 開發伺服器裡直接重用。
 */

const MAX_HOPS = 10;
const TIMEOUT_MS = 8000;
/** 讀 meta refresh 時最多讀多少內容，避免把整個大頁面吃進記憶體 */
const MAX_HTML_BYTES = 64 * 1024;

/**
 * 跟隨跳轉時送出的 User-Agent，依序嘗試。
 *
 * 不帶 UA 的請求常被短網址服務直接擋掉，而且不同站看 UA 給的東西差很多：
 * - Threads 的 /share/ 對桌面瀏覽器 UA 只回 200 的空殼頁面，對其他 UA 才回 302
 * - 部分有 WAF 的站則相反，非瀏覽器 UA 一律 403
 * 所以同一跳最多用兩種 UA 各試一次，只要其中一種給得出跳轉就繼續。
 */
const USER_AGENTS = [
  'Mozilla/5.0 (compatible; LinkCleanerBot/1.0)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

/** 擋掉指向內網、迴環位址的請求（SSRF 防護） */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || /(^|\.)(local|internal|localhost|home\.arpa)$/.test(h)) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h); // ULA / link-local
  }

  return false;
}

/** 檢查一個目的地是否可以連 */
function checkTarget(raw, base) {
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return { ok: false, error: '網址格式無法解析' };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: `不支援的協定：${url.protocol}` };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: '目的地指向內部網段，已阻擋' };
  }
  return { ok: true, url };
}

/** 少數短網址服務不回 3xx，而是用 meta refresh 轉址 */
async function readMetaRefresh(response, currentUrl) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('html') || !response.body) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    while (html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      // meta refresh 一定在 <head> 裡，讀到 </head> 就夠了
      if (/<\/head>/i.test(html)) break;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }

  const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"';]+)/i);
  if (!m) return null;
  const checked = checkTarget(m[1].trim().replace(/^['"]|['"]$/g, ''), currentUrl);
  return checked.ok ? checked.url.toString() : null;
}

/**
 * 走一跳：回傳下一個網址，走不下去就回 null。
 * 同一個網址最多用兩種 UA 各試一次。
 */
async function nextHop(current, signal) {
  for (const ua of USER_AGENTS) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) return null;

      const checked = checkTarget(location, current);
      if (!checked.ok) return { stopped: checked.error };

      const next = checked.url.toString();
      return next === current ? null : { next, status: res.status };
    }

    // 少數服務不回 3xx，而是用 meta refresh 轉址
    const meta = await readMetaRefresh(res, current);
    if (meta && meta !== current) return { next: meta, status: 'meta refresh' };
  }
  return null;
}

/**
 * 判斷這一跳是不是「已經到站，卻被同一個站踢回首頁 / 登入頁 / 錯誤頁」。
 *
 * 例如 Threads 的 /share/ 會先正確跳到貼文網址，接著因為我們不是登入中的瀏覽器，
 * 又被跳到 threads.com/?error=invalid_post —— 真正要的是上一步那個網址。
 * 跨網域的跳轉不套用這個判斷，那才是短網址本來的用途。
 */
function looksLikeBounce(from, to) {
  let a; let b;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (a.host !== b.host || a.pathname === '/') return false;
  if (b.pathname === '/' || b.pathname === '') return true;
  return /(^|\/)(login|signin|sign_in|accounts\/login|error)(\/|$)/i.test(b.pathname)
    || /(^|[?&])(error|denied)/i.test(b.search);
}

/** 一跳一跳跟隨到最終網址 */
async function follow(startUrl, signal) {
  let current = startUrl;
  const hops = [];

  for (let i = 0; i < MAX_HOPS; i++) {
    const hop = await nextHop(current, signal);
    if (!hop) return { url: current, hops };
    if (hop.stopped) return { url: current, hops, stopped: hop.stopped };
    // 被踢回首頁就停在上一步，那才是真正的目的地
    if (looksLikeBounce(current, hop.next)) return { url: current, hops };

    hops.push({ from: current, to: hop.next, status: hop.status });
    current = hop.next;
  }

  return { url: current, hops, stopped: `超過 ${MAX_HOPS} 次跳轉` };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * GET /api/expand?url=<短網址>
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleExpand(request) {
  if (request.method !== 'GET') {
    return json({ ok: false, error: '只接受 GET' }, 405);
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ ok: false, error: '缺少 url 參數' }, 400);

  const checked = checkTarget(target);
  if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

  // 別讓它繞回自己
  if (checked.url.host === new URL(request.url).host) {
    return json({ ok: false, error: '這是本站網址，不需要還原' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await follow(checked.url.toString(), controller.signal);
    if (result.url === checked.url.toString()) {
      return json({
        ok: false,
        error: result.stopped || '這個連結沒有再跳轉，已經是最終網址',
      });
    }
    return json({ ok: true, url: result.url, hops: result.hops, stopped: result.stopped });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return json({ ok: false, error: '解析逾時，請稍後再試' }, 504);
    }
    return json({ ok: false, error: `解析失敗：${err?.message || err}` }, 502);
  } finally {
    clearTimeout(timer);
  }
}
