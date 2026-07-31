/**
 * 比較各種 User-Agent 對同一個網址的回應
 *
 * expand.js 固定送 macOS Safari 的 UA，那是實測挑出來的（見該檔開頭的說明）。
 * 各站的判斷隨時會變，哪天還原不了就用這支重跑一次，看當下哪種 UA 過得去。
 *
 * 執行：node tools/probe-ua.mjs <網址> [更多網址...]
 */

const USER_AGENTS = {
  'macOS-Safari17（現用）': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'macOS-Safari26': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  'macOS-Chrome': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Win-Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'iPhone-Safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'iOS-Chrome': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  'Android-Chrome': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'bot': 'Mozilla/5.0 (compatible; LinkCleanerBot/1.0)',
  'curl': 'curl/8.4.0',
};

/** 看不到 Location 時，翻翻 HTML 有沒有藏轉址目的地 */
function describeHtml(html) {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"';]+)/i);
  if (meta) return `meta refresh → ${meta[1].trim()}`;

  const input = html.match(/<input[^>]*\bid=["']?target["']?[^>]*>/i);
  const value = input?.[0].match(/\bvalue=["']([^"']+)["']/i);
  if (value) return `頁面內轉址 → ${value[1]}`;

  return `沒有轉址（${html.length} bytes）`;
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法：node tools/probe-ua.mjs <網址> [更多網址...]');
  process.exit(1);
}

for (const target of targets) {
  console.log(`\n### ${target}`);
  for (const [name, ua] of Object.entries(USER_AGENTS)) {
    try {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      });

      const location = res.headers.get('location');
      const detail = location
        ? `→ ${location}`
        : describeHtml(await res.text());
      console.log(`  ${name.padEnd(22)} ${res.status}  ${detail}`);
    } catch (err) {
      console.log(`  ${name.padEnd(22)} 失敗：${err.message}`);
    }
  }
}
