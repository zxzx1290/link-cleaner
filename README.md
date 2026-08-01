# 連結清理（Link Cleaner）

一個 Vue 3 的 PWA：把手機上任何 App 的連結**分享**進來，自動移除追蹤參數、還原被包裝過的網址，並自動複製結果。部署在 Cloudflare Workers 上。

## 行為

- 從其他 App 分享進來 → 立刻清理 → 結果直接寫進剪貼簿
- 貼上、按 Enter、按「清理」也是一樣：清完就複製
- 邊打字會即時預覽結果，但不會動到剪貼簿
- 沒有設定畫面、沒有歷史紀錄，不寫 localStorage 也不寫 cookie
- 頁面下方一顆「安裝到這台裝置」包辦離線與安裝，預設不開，再按一次就完全移除
- 頁面最底下顯示版本號（建置時間），有新版時旁邊會出現「立即更新」

## 功能

**清除追蹤參數**
- 通用規則：`utm_*`、`fbclid`、`gclid`、`igsh`、`ttclid`、`mc_cid`、`mkt_tok`、`msclkid` 等
- 網域專屬規則：Threads / Instagram / Facebook、YouTube、X、TikTok、Amazon、蝦皮、淘寶、bilibili、小紅書、Reddit、Spotify、LinkedIn、momo / PChome、台灣新聞網站等
- 保守設計：採黑名單移除，不會誤刪 `?v=`、`?id=`、`?p=` 這類網站運作必要的參數
- 一併清理路徑內的追蹤片段（例如 Amazon 的 `/ref=sr_1_3`）與 hash 中的 `#utm_source=`
- 誤刪了？結果頁的每個參數 chip 點一下就能還原

**還原包裝過的網址**（離線即可完成）
- 跳轉包裝：`l.facebook.com/l.php?u=`、`l.instagram.com`、`l.threads.net`、`google.com/url?q=`、`youtube.com/redirect`、Outlook Safe Links、Proofpoint、Slack、Steam、VK、DuckDuckGo、百度等
- 編碼包裝：Bing `ck/a?u=a1<base64>`、雙重 URL-encode
- AMP 還原：`google.com/amp/s/...`、`cdn.ampproject.org`
- 多層包裝會一路拆到底（最多 6 層）

**還原短網址**（需連網，由自家 Worker 處理）
- 偵測到 `bit.ly`、`t.co`、`reurl.cc`、`lihi*.cc`、`pse.is`、`shp.ee`、`vt.tiktok.com`、`b23.tv`、`xhslink.com`、Reddit `/s/`、Facebook `/share/` 等短連結時，會出現「還原原始網址」按鈕
- 按下後由 `/api/expand` 用 `redirect: 'manual'` 一跳一跳跟到底（最多 10 跳，8 秒逾時），**不經過任何第三方解析服務**
- 不回 3xx、改用一頁空殼頁轉址的服務也跟得到，兩種都認：`<meta http-equiv="refresh">`，以及 `reurl.cc` 那種把目的地藏在 `<input id="target">` 再由 JS 跳過去的做法（後者只接受絕對網址，避免把一般表單欄位當成轉址目標）
- 固定以 **macOS Safari 17** 的 User-Agent 發送，每個部分都是實測挑出來的：
  - 不帶瀏覽器 UA 常被有 WAF 的站直接擋掉
  - Threads 的 `/share/` 對桌面 Chromium 和 Android UA 只回空殼頁，WebKit 系才回 302
  - 手機 UA 會讓目的地站回行動版網址（Google Docs 的 `/edit` 被轉成 `/mobilebasic`），那不是使用者要的原始連結
  - 版本號 `Version/17.6` 是**刻意留舊的**：Threads 拿 Safari 版本判斷瀏覽器能力，16.6～17.6 都回 302，18.0 起改回一頁 JS 空殼頁。那頁 259 KB 全是 React bundle，不含貼文網址、`og:url` 或 canonical，除非執行 JS 否則解析不出目的地
  - `Intel Mac OS X 10_15_7` 同樣不是沒更新——Apple 從 macOS 11 起就把 UA 的系統版本鎖死在這串
- 跟到目的地後又被同一個站踢回首頁 / 登入頁 / 錯誤頁時，會停在上一步（那才是真正要的網址）
- 目的地若指向內網 / 迴環位址會直接擋掉（SSRF 防護）
- 還原後自動再跑一次清理，因為短網址背後往往還藏著一整串追蹤參數

## 專案結構

```
index.html              Vite 入口
vite.config.js          建置設定；產生版本號、開發時把 /api/expand 接到 Worker 的同一份程式碼
wrangler.toml           Cloudflare Worker 設定（dist/ 當靜態資產）
src/
  main.js               掛載 Vue（不自動註冊 Service Worker）
  App.vue               ★ 全部都在這裡：規則表、解封裝、清理、UI
  styles.css            樣式（深/淺色）
worker/
  index.js              Worker 進入點：/api/expand 之外一律交給靜態資產
  expand.js             跟隨重導向的實作（只用 Web 標準 API，可在 Node 直接跑）
  expand.test.js        上面那支的測試（node --test，換掉全域 fetch，不連外）
public/
  manifest.webmanifest  PWA 設定，含 share_target
  sw.js                 Service Worker（離線快取；快取名稱的建置時間由 vite 填入）
  icons/                PWA 圖示
tools/
  make-icons.mjs        產生 PWA 圖示（單色，與標題列的 SVG 同一組路徑）
  expand.mjs            在命令列跑一次還原，用 Worker 的同一份程式碼
  probe-ua.mjs          比較各種 User-Agent 對同一個網址的回應
```

## 排查短網址還原

還原壞掉時（通常是對方改了擋 UA 的規則），不用起開發伺服器，直接在命令列跑：

```bash
node tools/expand.mjs https://reurl.cc/xxxx     # 跑完整流程，印出每一跳
node tools/probe-ua.mjs https://reurl.cc/xxxx   # 8 種 UA 各試一次，看誰過得去
```

`probe-ua.mjs` 會分辨三種轉址方式（`Location`、meta refresh、`<input id="target">`），
所以也能用來確認某個新的短網址服務是哪一種做法。挑到合用的 UA 後，改
`worker/expand.js` 開頭的 `USER_AGENT`。

跟隨邏輯本身的迴歸測試是 `npm test`：它把全域 `fetch` 換成假的網路，
所以不連外、跑得快，也不會因為某個短網址服務今天心情不好就紅一片。

## /api/expand 的濫用防護

這個端點一個請求會對外跟隨最多 10 跳，本質上是個流量放大器。沒有防護的話，
任何人都能拿它去轟第三方網站——對方看到的來源是 Cloudflare 的 IP，被投訴時
要負責的是我們的帳號，順帶還會把免費方案的每日請求額度燒光。三道閘門由外而內：

| 閘門 | 位置 | 作用 |
| --- | --- | --- |
| 同源檢查 | `worker/index.js` | 沒帶 `Sec-Fetch-Site: same-origin` 就回 403，濾掉 curl 和爬蟲 |
| 速率限制 | `wrangler.toml` 的 `[[ratelimits]]` | 每個 IP 每分鐘 20 次 |
| SSRF 檢查 | `worker/expand.js` 的 `isPrivateHost` | 擋掉指向內網、迴環、雲端 metadata 的目的地（含 `::ffff:` 這類包著 IPv4 的 IPv6 寫法） |

要用命令列測這個端點，補上標頭即可：

```bash
curl -H 'sec-fetch-site: same-origin' 'http://localhost:5173/api/expand?url=https://reurl.cc/xxxx'
```

`tools/expand.mjs` 直接呼叫 `handleExpand`，不經過這些閘門，所以照舊能用。

## 開發與部署

```bash
npm install
npm run dev       # http://localhost:5173，/api/expand 會用 Node 跑 Worker 的同一份邏輯
npm run dev -- --host   # 額外綁 0.0.0.0，讓手機連進來測分享流程（預設只綁 localhost）
npm test          # node --test，跑 worker/expand.test.js
npm run build     # 產出 dist/
npm run preview   # wrangler dev：用真正的 Workers runtime 跑 dist/ + Worker
npm run deploy    # build + wrangler deploy
npm run icons     # 重新產生 public/icons/
```

第一次部署前先 `npx wrangler login`。部署後在 Cloudflare 的 Workers 設定裡綁自己的網域即可（PWA 的安裝與分享目標必須在 HTTPS 下才會生效）。

## 在手機上使用

**Android（Chrome）— 完整支援分享**

1. 用 Chrome 開啟部署後的網址
2. 按頁面下方的「安裝到這台裝置」：它會註冊 Service Worker，再自動叫出系統的安裝提示
3. 之後在任何 App 按分享，分享清單中就會出現「連結清理」
4. 分享進來就自動清理並複製，直接貼到要傳的地方即可

**Firefox — 只有離線那半邊**

Firefox 支援 Service Worker，所以按下按鈕後離線可用；但它沒有 `beforeinstallprompt`（Chromium 專屬），不會跳安裝視窗，這時會提示改用瀏覽器選單的「加到主畫面」。而且 Firefox 不支援 Web Share Target，**不會出現在系統分享選單**，只能手動貼上。

**iOS（Safari）— 系統不支援 Web Share Target**

iOS 至今沒有實作 Web Share Target API，所以無法出現在分享選單中。實際用法：

1. Safari 開啟網址 → 分享 →「加入主畫面」
2. 在別的 App 複製連結後，開啟本 App 按「從剪貼簿貼上」
3. 想一步到位可以搭配捷徑 App：建立一個接受「分享工作表」輸入的捷徑，動作為「打開 URL：`https://你的網址/?url=[分享輸入]`」

## 新增規則

規則表就在 `src/App.vue` 最上面：

```js
// 全站通用：加進 GLOBAL_RULE.params，支援字串或 RegExp
const GLOBAL_RULE = { params: ['fbclid', /^utm_/i, ...] };

// 特定網域：加一筆到 DOMAIN_RULES，hosts 用網域後綴比對
{ id: 'example', name: '站名', hosts: ['example.com'], params: ['tracking_id'] }
```

## 版本與更新

版本號就是**建置時間**（台北時區，`YYYY-MM-DD HH:MM:SS`），在 `vite.config.js` 產生後往兩個地方送：

- `define` 注入 `__BUILD_TIME__`，顯示在頁面最底下
- 建置時填進 `public/sw.js` 的快取名稱（`link-cleaner-<建置時間>`）

第二點是更新機制的關鍵：瀏覽器是**逐位元組比對 sw.js** 來判斷有沒有新版的，所以 sw.js 的內容每次建置都必須不一樣。以前得手動調 `CACHE` 版本號，現在自動處理，不用再記。

已安裝的使用者拿到新版的流程：

1. 每次開啟 App 時前台呼叫 `registration.update()` 主動問伺服器（註冊時帶 `updateViaCache: 'none'`，不吃 HTTP 快取）
2. 內容有變 → 新的 Service Worker 安裝完成後停在 waiting，**不會自己接手**
3. 「安裝到這台裝置」旁邊亮出「有新版本，立即更新」→ 使用者按下才 `postMessage({ type: 'SKIP_WAITING' })`，新版接手後頁面重載
4. 重載時在網址留 `#updated` 當旗標，新的頁面靠它知道要 toast 一句「已更新到 \<版本\>」，載入後立刻把 hash 清掉。用 hash 而不是 sessionStorage，是為了維持「不在裝置上寫任何東西」

刻意不自動換版，是因為使用者可能正在輸入或看結果；也刻意不在第一次安裝時提示（用 `navigator.serviceWorker.controller` 是否存在來區分換版與初次安裝）。

沒安裝的一般瀏覽也不會卡舊版：導覽請求走 network-first，而 JS / CSS 檔名都帶 hash。

## 隱私

- 清理、解包裝、規則比對全部在瀏覽器裡完成，沒有任何網路請求
- 不寫 localStorage / cookie，關掉分頁就什麼都不剩
- Service Worker **不會自動註冊**：離線快取是唯一會寫入裝置的東西，要按頁面下方的「安裝到這台裝置」才會開；再按一次（「已安裝（點此移除）」）會反註冊並清掉快取。快取的只有 App 本身的檔案，不含任何清理過的連結
- 「還原短網址」是唯一會連外的功能：連結只會送到本站自己的 Cloudflare Worker，由它代為跟隨跳轉，不會轉交給任何第三方服務
