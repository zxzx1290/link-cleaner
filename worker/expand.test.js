/**
 * /api/expand 的測試：node --test
 *
 * 全部離線跑——把全域 fetch 換成假的網路，因為真的短網址服務隨時會改行為，
 * 拿它們當測試對象只會得到一組時好時壞的測試。要看真實站台的反應請用
 * tools/expand.mjs 和 tools/probe-ua.mjs。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { guardSameOrigin, handleExpand, isPrivateHost } from './expand.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * 假網路：routes 的 key 是網址，值可以是
 * - { status, location }        回一個轉址
 * - { status, body }            回一頁 HTML
 * - function                    自己決定要回什麼或丟什麼例外
 * 沒登記的網址一律當成連不上。
 */
function mockNetwork(routes) {
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init?.headers || {} });

    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    if (typeof route === 'function') return route(url, init);

    const { status = 200, location, body = '', type = 'text/html; charset=utf-8' } = route;
    const headers = { 'content-type': type };
    if (location) headers.location = location;
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  };

  return requests;
}

/** 呼叫一次 /api/expand，回傳解析後的 JSON 與狀態碼 */
async function expand(target, method = 'GET') {
  const url = `https://link-cleaner.test/api/expand?url=${encodeURIComponent(target)}`;
  const response = await handleExpand(new Request(url, { method }));
  return { status: response.status, ...(await response.json()) };
}

const html = (body) => ({ status: 200, body: `<!DOCTYPE html><html>${body}</html>` });

describe('跟隨轉址', () => {
  test('一路跟到底，回傳最終網址與每一跳', async () => {
    mockNetwork({
      'https://short.test/a': { status: 301, location: 'https://mid.test/b' },
      'https://mid.test/b': { status: 302, location: 'https://final.test/c' },
      'https://final.test/c': html('<p>到站</p>'),
    });

    const result = await expand('https://short.test/a');

    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://final.test/c');
    assert.deepEqual(result.hops.map((h) => h.to), ['https://mid.test/b', 'https://final.test/c']);
  });

  test('相對路徑的 Location 會用當下網址解析', async () => {
    mockNetwork({
      'https://short.test/a': { status: 302, location: '/landing?x=1' },
      'https://short.test/landing?x=1': html('<p>到站</p>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.url, 'https://short.test/landing?x=1');
  });

  test('沒有轉址就直說，不假裝有還原', async () => {
    mockNetwork({ 'https://final.test/c': html('<p>到站</p>') });

    const result = await expand('https://final.test/c');
    assert.equal(result.ok, false);
    assert.match(result.error, /已經是最終網址/);
  });

  test('固定送出 macOS Safari 的 User-Agent', async () => {
    const requests = mockNetwork({ 'https://final.test/c': html('') });
    await expand('https://final.test/c');

    assert.match(requests[0].headers['user-agent'], /Macintosh.+Safari/);
  });
});

describe('空殼頁轉址', () => {
  test('認得 meta refresh', async () => {
    mockNetwork({
      'https://short.test/a': html('<head><meta http-equiv="refresh" content="0;url=https://final.test/c"></head>'),
      'https://final.test/c': html('<p>到站</p>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.url, 'https://final.test/c');
    assert.equal(result.hops[0].status, 'meta refresh');
  });

  test('目的地自己帶著 share_url= 參數時，不會抓錯（Facebook 的 /share/p/）', async () => {
    const target = 'https://www.facebook.test/story.php?story_fbid=1&id=2&share_url=https%3A%2F%2Fwww.facebook.test%2Fshare%2Fp%2Fabc%2F';
    mockNetwork({
      'https://www.facebook.test/share/p/abc/': html(
        `<head><meta http-equiv="refresh" content="0;url=${target.replace(/&/g, '&amp;')}" /></head>`,
      ),
      [target]: html('<p>到站</p>'),
    });

    const result = await expand('https://www.facebook.test/share/p/abc/');
    assert.equal(result.url, target);
  });

  test('認得藏在 hidden input 的目的地，並還原 &amp;', async () => {
    mockNetwork({
      'https://short.test/a': html('<body><input type="hidden" id="target" value="https://final.test/c?a=1&amp;b=2"></body>'),
      'https://final.test/c?a=1&b=2': html('<p>到站</p>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.url, 'https://final.test/c?a=1&b=2');
    assert.equal(result.hops[0].status, '頁面內轉址');
  });

  test('目的地在 body 深處也找得到（不是只讀 head）', async () => {
    mockNetwork({
      'https://short.test/a': html(`<head>${'<!-- 填充 -->'.repeat(500)}</head><body><input id="target" value="https://final.test/c"></body>`),
      'https://final.test/c': html('<p>到站</p>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.url, 'https://final.test/c');
  });

  test('hidden input 是相對路徑就不跟——那多半只是一般表單欄位', async () => {
    mockNetwork({
      'https://short.test/a': html('<body><input type="hidden" id="target" value="/somewhere"></body>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.ok, false);
  });

  test('一般頁面的其他 input 不會被誤認', async () => {
    mockNetwork({
      'https://short.test/a': html('<body><input id="search" value="https://example.com/"></body>'),
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.ok, false);
  });

  test('非 HTML 的回應不會被當成轉址頁去讀', async () => {
    mockNetwork({
      'https://short.test/a': { status: 200, type: 'application/json', body: '{"url":"https://final.test/c"}' },
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.ok, false);
  });
});

describe('停下來的情況', () => {
  test('被同一個站踢回首頁時，停在上一步', async () => {
    mockNetwork({
      'https://short.test/a': { status: 302, location: 'https://site.test/post/1' },
      'https://site.test/post/1': { status: 302, location: 'https://site.test/?error=invalid_post' },
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.url, 'https://site.test/post/1');
    assert.equal(result.hops.length, 1);
  });

  test('超過跳數上限會回報，但保留已經走到的位置', async () => {
    const routes = {};
    for (let i = 0; i <= 12; i++) {
      routes[`https://hop.test/${i}`] = { status: 302, location: `https://hop.test/${i + 1}` };
    }
    mockNetwork(routes);

    const result = await expand('https://hop.test/0');
    assert.equal(result.ok, true);
    assert.equal(result.hops.length, 10);
    assert.match(result.stopped, /10 跳上限/);
  });

  test('半路連不上時，前面走過的成果不會被丟掉', async () => {
    mockNetwork({
      'https://short.test/a': { status: 302, location: 'https://broken.test/b' },
      // broken.test 沒登記 → 連不上
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://broken.test/b');
    assert.match(result.stopped, /連不上/);
  });

  test('逾時也停在當下，並說明原因', async () => {
    mockNetwork({
      'https://short.test/a': { status: 302, location: 'https://slow.test/b' },
      'https://slow.test/b': () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.hops.length, 1);
    assert.equal(result.stopped, '解析逾時');
  });
});

describe('SSRF 防護', () => {
  test('擋掉轉向內網的下一跳', async () => {
    mockNetwork({
      'https://short.test/a': { status: 302, location: 'http://192.168.1.1/admin' },
    });

    const result = await expand('https://short.test/a');
    assert.equal(result.ok, false);
    assert.match(result.error, /內部網段/);
  });

  for (const host of ['127.0.0.1', 'localhost', '10.0.0.1', '172.16.0.1', '169.254.169.254', '[::1]']) {
    test(`擋掉 ${host}`, async () => {
      mockNetwork({});
      const result = await expand(`http://${host}/`);
      assert.equal(result.status, 400);
      assert.match(result.error, /內部網段/);
    });
  }

  test('放行一般的公開網址', async () => {
    mockNetwork({ 'https://172.32.0.1/': html('') }); // 172.16-31 才是私有
    const result = await expand('https://172.32.0.1/');
    assert.equal(result.status, 200);
  });

  // URL 會把這些正規化成看不出原形的樣子，光比對字串前綴會全部漏掉
  for (const host of [
    '[::ffff:127.0.0.1]', // IPv4-mapped，正規化後長成 ::ffff:7f00:1
    '[::ffff:169.254.169.254]', // 同上，指向雲端 metadata 位址
    '[::ffff:192.168.0.1]',
    '[::127.0.0.1]', // 舊的 IPv4-compatible 寫法
    '[64:ff9b::127.0.0.1]', // NAT64
    '[2002:7f00:1::]', // 6to4 包著 127.0.0.1
    '[0:0:0:0:0:0:0:1]', // 展開寫法的 ::1
    '[fd00::1]', // ULA
    '[fe80::1]', // link-local
  ]) {
    test(`擋掉 ${host}`, async () => {
      mockNetwork({});
      const result = await expand(`http://${host}/`);
      assert.equal(result.status, 400);
      assert.match(result.error, /內部網段/);
    });
  }

  test('放行一般的公開 IPv6', async () => {
    mockNetwork({ 'https://[2001:4860:4860::8888]/': html('') });
    const result = await expand('https://[2001:4860:4860::8888]/');
    assert.equal(result.status, 200);
  });

  test('解析不出來的 IPv6 一律當成內網擋掉', () => {
    for (const bad of ['1:2:3::4::5', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
      assert.equal(isPrivateHost(bad), true, bad);
    }
  });

  test('十進位／八進位／簡寫的 IPv4 也擋得住', () => {
    // 這些是 new URL 先正規化成點分十進位，不是這裡自己處理的，加測試釘住這個前提
    for (const raw of ['2130706433', '0177.0.0.1', '0x7f.0.0.1', '127.1']) {
      assert.equal(isPrivateHost(new URL(`http://${raw}/`).hostname), true, raw);
    }
  });
});

describe('參數檢查', () => {
  test('只接受 GET', async () => {
    const result = await expand('https://short.test/a', 'POST');
    assert.equal(result.status, 405);
  });

  test('缺少 url 參數', async () => {
    const response = await handleExpand(new Request('https://link-cleaner.test/api/expand'));
    assert.equal(response.status, 400);
  });

  test('擋掉非 http(s) 的協定', async () => {
    const result = await expand('javascript:alert(1)');
    assert.equal(result.status, 400);
    assert.match(result.error, /不支援的協定|無法解析/);
  });

  test('擋掉指向本站的網址', async () => {
    const result = await expand('https://link-cleaner.test/something');
    assert.equal(result.status, 400);
    assert.match(result.error, /本站網址/);
  });

  test('擋掉過長的 url', async () => {
    const result = await expand(`https://short.test/${'a'.repeat(3000)}`);
    assert.equal(result.status, 414);
  });
});

describe('同源檢查', () => {
  const guard = (headers) => guardSameOrigin(
    new Request('https://link-cleaner.test/api/expand?url=x', { headers }),
  );

  test('自家頁面發的請求放行', () => {
    assert.equal(guard({ 'sec-fetch-site': 'same-origin' }), null);
  });

  for (const [name, headers] of [
    ['沒有 Sec-Fetch-Site 的請求（curl、腳本）', {}],
    ['別的網站發的 fetch', { 'sec-fetch-site': 'cross-site' }],
    ['直接在網址列打開', { 'sec-fetch-site': 'none' }],
  ]) {
    test(`擋掉${name}`, async () => {
      const response = guard(headers);
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /只給本站頁面/);
    });
  }
});
