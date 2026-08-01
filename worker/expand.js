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
/** 短網址不會長成這樣，過長的多半是拿來塞爆什麼東西的 */
const MAX_URL_LENGTH = 2048;

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

function isPrivateIPv4([a, b]) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 把 IPv6 展開成 8 組 16 bit 數字，格式不對就回 null。
 *
 * 光比對字串前綴是不夠的：URL 會把 ::ffff:127.0.0.1 正規化成 ::ffff:7f00:1，
 * 看起來完全不像迴環位址。要正確判斷就得真的把位址解出來。
 */
function parseIPv6(text) {
  let rest = text;

  // 尾端的點分十進位（::ffff:127.0.0.1）先併成兩組 hextet
  const dotted = rest.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const b = dotted.slice(2).map(Number);
    if (b.some((n) => n > 255)) return null;
    rest = `${dotted[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }

  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + fill + tail.length !== 8) return null;

  const groups = [...head, ...Array(fill).fill('0'), ...tail]
    .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

function isPrivateIPv6(groups) {
  const [a, b] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7  ULA
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local

  // 這幾種前綴的低 32 bit 其實包著一個 IPv4 位址（::1 也算在第一種裡），
  // 得挖出來套 IPv4 的規則再檢查一次，否則 ::ffff:127.0.0.1 會被當成公開位址放行
  let v4 = null;
  if (groups.slice(0, 5).every((g) => g === 0)) v4 = [groups[6], groups[7]]; // ::x:y、::ffff:x:y
  else if (a === 0x64 && b === 0xff9b) v4 = [groups[6], groups[7]]; // 64:ff9b::/96 NAT64
  else if (a === 0x2002) v4 = [groups[1], groups[2]]; // 2002::/16 6to4
  if (!v4) return false;

  const [hi, lo] = v4;
  return isPrivateIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
}

/**
 * 擋掉指向內網、迴環位址的請求（SSRF 防護）
 *
 * 這是字面檢查，擋不掉「解析到內網的公開域名」（127.0.0.1.nip.io 之類）。
 * 線上不需要另外處理——Workers 的 fetch 出口在公網，那種目的地本來就連不到；
 * dev server 則在 vite.config.js 裡另外做了 DNS 解析後的檢查。
 */
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || /(^|\.)(local|internal|localhost|home\.arpa)$/.test(h)) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIPv4(v4.slice(1).map(Number));

  // 認不出來的 IPv6 一律擋：寧可少還原一個網址，也不要放行一個看不懂的目的地
  if (h.includes(':')) {
    const groups = parseIPv6(h);
    return groups === null || isPrivateIPv6(groups);
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
async function nextHop(current, signal, doFetch) {
  const res = await doFetch(current, {
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
async function follow(startUrl, signal, doFetch) {
  let current = startUrl;
  const hops = [];

  for (let i = 0; i < MAX_HOPS; i++) {
    let hop;
    try {
      hop = await nextHop(current, signal, doFetch);
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
 * 擋掉不是從自家頁面發出來的請求。
 *
 * `Sec-Fetch-Site` 是瀏覽器自己填的，網頁上的 JS 改不掉，所以同源的 fetch 一定
 * 帶著 same-origin；curl 或爬蟲則整個標頭都不會出現。這擋不住存心偽造標頭的人，
 * 但足以濾掉絕大多數「順手把 /api/expand 當成免費轉址代理」的自動化流量——
 * 那種流量才是真正會燒掉請求額度、或讓這個 Worker 被目標站當成掃描器的來源。
 *
 * 要用命令列測的話補上標頭即可：curl -H 'sec-fetch-site: same-origin' ...
 *
 * @returns {Response|null} 該擋就回 403，是自家請求則回 null
 */
export function guardSameOrigin(request) {
  if (request.headers.get('sec-fetch-site') === 'same-origin') return null;
  return json({ ok: false, error: '這個 API 只給本站頁面使用' }, 403);
}

/**
 * GET /api/expand?url=<短網址>
 * @param {Request} request
 * @param {{ fetch?: typeof fetch }} [options] 覆寫對外的 fetch（dev server 用來多做一層檢查）
 * @returns {Promise<Response>}
 */
export async function handleExpand(request, options = {}) {
  const doFetch = options.fetch || ((...args) => globalThis.fetch(...args));

  if (request.method !== 'GET') {
    return json({ ok: false, error: '只接受 GET' }, 405);
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ ok: false, error: '缺少 url 參數' }, 400);
  if (target.length > MAX_URL_LENGTH) return json({ ok: false, error: '網址過長' }, 414);

  const checked = checkTarget(target);
  if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

  // 別讓它繞回自己
  if (checked.url.host === new URL(request.url).host) {
    return json({ ok: false, error: '這是本站網址，不需要還原' }, 400);
  }

  const start = checked.url.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await follow(start, controller.signal, doFetch);
    if (result.url === start) {
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
