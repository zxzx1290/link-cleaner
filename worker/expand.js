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
 * 跟隨跳轉時固定送出的 User-Agent：macOS 版 Safari。
 *
 * 挑這個是實測出來的，理由有三：
 * 1. 不帶 UA 或用非瀏覽器 UA 的請求常被有 WAF 的站直接擋掉，得裝成真的瀏覽器
 * 2. Threads 的 /share/ 對「桌面 Chromium」和「Android」都只回 200 的空殼頁
 *    （後者是要導去 app），WebKit 系的 UA 才乖乖回 302
 * 3. 手機 UA 會讓目的地站回行動版網址（例如 Google Docs 的 /edit 被轉成
 *    /mobilebasic），那並不是使用者想要的原始連結；桌面 UA 就不會
 *
 * 這串裡有兩個看起來過時、但其實都不能改的地方：
 * - 「Intel Mac OS X 10_15_7」是 Apple 從 macOS 11 起就鎖死的，真正的 Safari
 *   送出來的還是這串，改成新版號反而不像真的
 * - 「Version/17.6」是刻意留舊的：Threads 拿 Safari 版本號判斷瀏覽器能力，
 *   17.x 以下才回 302，18 以上就改回一頁 JS 空殼頁（實測 16.6~17.6 都通，18.0 起失效）
 *
 * 要驗證這些前提還成不成立，跑 node tools/probe-ua.mjs <網址>。
 */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

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

/** HTML 屬性值裡的 &amp; 要還原，不然帶多個參數的網址會壞掉 */
function decodeEntities(text) {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 從 HTML 裡找出這一頁其實要去哪，找不到就回 null。
 *
 * 兩種都是「不回 3xx，改用一頁空殼頁轉址」的做法：
 * 1. meta refresh —— 老派做法，一定在 <head> 裡
 * 2. <input id="target"> —— reurl.cc 這類服務把目的地藏在 hidden input，
 *    再由頁面上的 JS 讀出來跳過去（順便讓那頁的追蹤碼有機會執行）
 */
function findTargetInHtml(html) {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"';]+)/i);
  if (meta) {
    return { raw: decodeEntities(meta[1].trim().replace(/^['"]|['"]$/g, '')), via: 'meta refresh' };
  }

  const input = html.match(/<input[^>]*\bid=["']?target["']?[^>]*>/i);
  const value = input?.[0].match(/\bvalue=["']([^"']+)["']/i);
  // 這個慣例太鬆，只認絕對網址；相對路徑很可能只是一般表單欄位，不是轉址目標
  if (value && /^https?:\/\//i.test(value[1].trim())) {
    return { raw: decodeEntities(value[1].trim()), via: '頁面內轉址' };
  }

  return null;
}

/** 讀回應內容找轉址目的地，讀到就停，最多讀 MAX_HTML_BYTES */
async function readHtmlTarget(response, currentUrl) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('html') || !response.body) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let found = null;
  try {
    while (html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      found = findTargetInHtml(html);
      if (found) break;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!found) return null;
  const checked = checkTarget(found.raw, currentUrl);
  return checked.ok ? { next: checked.url.toString(), via: found.via } : null;
}

/** 走一跳：回傳下一個網址，走不下去就回 null。 */
async function nextHop(current, signal) {
  const res = await fetch(current, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      'user-agent': USER_AGENT,
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

  // 少數服務不回 3xx，而是拿一頁空殼頁轉址
  const inPage = await readHtmlTarget(res, current);
  if (inPage && inPage.next !== current) return { next: inPage.next, status: inPage.via };
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

/** 把跟隨途中的例外翻成看得懂的中文 */
function describeError(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return '解析逾時';
  return `這一跳連不上（${err?.message || err}）`;
}

/** 一跳一跳跟隨到最終網址 */
async function follow(startUrl, signal) {
  let current = startUrl;
  const hops = [];

  for (let i = 0; i < MAX_HOPS; i++) {
    let hop;
    try {
      hop = await nextHop(current, signal);
    } catch (err) {
      // 半路壞掉時別把前面走過的成果一起丟掉，停在這裡並說明原因
      return { url: current, hops, stopped: describeError(err) };
    }
    if (!hop) return { url: current, hops };
    if (hop.stopped) return { url: current, hops, stopped: hop.stopped };
    // 被踢回首頁就停在上一步，那才是真正的目的地
    if (looksLikeBounce(current, hop.next)) return { url: current, hops };

    hops.push({ from: current, to: hop.next, status: hop.status });
    current = hop.next;
  }

  return { url: current, hops, stopped: `已達 ${MAX_HOPS} 跳上限` };
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
