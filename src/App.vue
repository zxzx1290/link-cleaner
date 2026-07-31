<script setup>
/**
 * 整個 App 就這一個檔案：規則表、解封裝、清理、UI 全部在這裡。
 *
 * 刻意不做任何持久化：沒有設定畫面、沒有歷史紀錄，不寫 localStorage / cookie，
 * 狀態只活在這次開啟的分頁裡。分享或貼上進來就自動清理，清理完自動複製。
 */

import { ref, computed, onMounted, watch } from 'vue';

// ==================== 追蹤參數規則表 ====================
//
// 設計原則：採「黑名單移除」而非白名單保留，避免誤刪網站運作必要的參數。
// 每條規則的 params 可以是字串（完全比對，不分大小寫）或 RegExp（比對參數名稱）。

/** 套用於所有網域的通用追蹤參數 */
const GLOBAL_RULE = {
  id: 'global',
  name: '通用追蹤參數',
  params: [
    // --- UTM / Google Analytics 家族 ---
    /^utm_/i,
    /^ga_/i,
    '_ga', '_gl', '_gac', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
    'gad_source', 'gad_campaignid', 'srsltid',

    // --- 各廣告平台點擊 ID ---
    'fbclid', // Facebook
    'igshid', // Instagram
    'igsh', // Instagram（新版）
    'msclkid', // Microsoft Ads
    'yclid', // Yandex
    'twclid', // Twitter/X
    'ttclid', // TikTok
    'ScCid', // Snapchat
    'rdt_cid', // Reddit Ads
    'li_fat_id', // LinkedIn
    'epik', // Pinterest
    'irclickid', // Impact Radius
    'rb_clickid',
    'cjevent', // CJ Affiliate
    'wickedid',
    'obOrigUrl', 'dicbo', // Outbrain
    'tblci', // Taboola
    'ysclid', 'ymclid', // Yandex（yclid 之外的變體）
    'trk_contact', 'trk_msg', 'trk_module', 'trk_sid',

    // --- 聯盟行銷 ---
    'awc', // Awin
    'zanpid', // Zanox
    'ranMID', 'ranEAID', 'ranSiteID', // Rakuten
    'gdffi', 'gdfms', 'gdftrk', // Goodway
    'mkwid', 'pcrid', 'pkw', 'pmt', // Marin / CJ 的關鍵字回傳參數

    // --- EDM / 行銷自動化 ---
    'mc_cid', 'mc_eid', // Mailchimp
    'mkt_tok', // Marketo
    '_hsenc', '_hsmi', 'hsCtaTracking', /^hsa_/i, // HubSpot
    /^sfmc_/i, // Salesforce Marketing Cloud
    'elq', 'elqTrackId', 'elqaid', 'elqat', 'elqCampaignId', // Oracle Eloqua
    'ck_subscriber_id', // ConvertKit
    '_kx', // Klaviyo
    '_bta_tid', '_bta_c', // Bronto
    'dm_i', // dotdigital
    'ml_subscriber', 'ml_subscriber_hash', // MailerLite
    'vgo_ee', 'nr_email_referer', // ActiveCampaign
    'spMailingID', 'spUserID', 'spJobID', 'spReportId', // Silverpop
    'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
    'sc_campaign', 'sc_channel', 'sc_content', 'sc_medium', 'sc_outcome',
    'sc_geo', 'sc_country', 'ef_id', 's_kwcid', 'cmpid', 'campaignid',
    'adgroupid', 'ncid',

    // --- 站內流量標記 ---
    /^itm_/i, // BBC、Guardian 等的 internal traffic monitor
    /^pk_/i, /^piwik_/i, /^matomo_/i, /^mtm_/i, // Piwik / Matomo 各代命名
    'int_source', 'int_medium', 'int_campaign',
    'wt_mc', 'wt_zmc', 'wt.mc_id', 'wt.mc_ev',

    // --- 其他常見 ---
    'ref_src', 'ref_url', '__s', '_openstat',
    '_branch_match_id', '_branch_referrer', // Branch deep link
    'CNDID', 'mbid', // Condé Nast
    'at_medium', 'at_campaign', 'at_custom1', 'at_custom2', 'at_custom3',
    'at_custom4', 'at_recipient_id', 'at_recipient_list',
    'xtor', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
  ],
};

/**
 * 網域專屬規則。
 * hosts 使用「網域後綴」比對：example.com 會同時比對 www.example.com、m.example.com。
 */
const DOMAIN_RULES = [
  {
    id: 'meta',
    name: 'Facebook / Instagram / Threads',
    hosts: ['facebook.com', 'fb.com', 'instagram.com', 'threads.net', 'threads.com', 'messenger.com'],
    params: [
      'xmt', // Threads 新版合併追蹤字串
      'slof', // App 分享選單帶的來源標記（Threads / Instagram）
      'mibextid', 'rdid', 'share_url', 'comment_tracking', 'notif_id', 'notif_t',
      'ref', 'refsrc', 'hrc', 'dti', 'app', 'video_source', 'ftentidentifier',
      'pageid', 'padding', 'ls_ref', 'action_history', 'tracking', 'referral_code',
      'referral_story_type', 'eid', 'sfnsn', 'idorvanity', 'wtsid', 'extid', 'shem',
      /^__cft__/i, '__tn__', '__xts__', '__eep__',
    ],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    // 保留 v / t / list / index / start / end 等播放必要參數
    params: ['si', 'feature', 'pp', 'kw', 'ab_channel', 'app', 'embeds_referring_euri', 'embeds_referring_origin', 'source_ve_path', 'themeRefresh'],
  },
  {
    id: 'twitter',
    name: 'X / Twitter',
    hosts: ['twitter.com', 'x.com', 't.co'],
    params: ['s', 't', 'cxt', 'src', 'ref_src', 'ref_url', 'twgr', 'twterm'],
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    hosts: ['tiktok.com'],
    params: [
      '_r', '_t', '_d', 'u_code', 'preview_pb', 'share_app_id', 'share_link_id',
      'share_item_id', 'sharer_language', 'tt_from', 'source', 'sec_user_id',
      'is_from_webapp', 'sender_device', 'sender_web_id', 'checksum', 'timestamp',
      'user_id', 'share_author_id', 'enter_from', 'enter_method', 'social_share_type',
      'utm_campaign', 'iid', 'region', 'mid', 'is_copy_url', 'is_from_webapp_v1',
    ],
  },
  {
    id: 'amazon',
    name: 'Amazon',
    hosts: ['amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
      'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.sg',
      'amazon.in', 'amazon.com.mx', 'amazon.com.br', 'amazon.nl', 'amazon.se'],
    params: [
      /^pd_rd_/i, /^pf_rd_/i, /^_encoding$/i, 'psc', 'ref', 'ref_', 'tag',
      'linkCode', 'linkId', 'creative', 'creativeASIN', 'ascsubtag', 'smid',
      'qid', 'sr', 'dib', 'dib_tag', 'content-id', 'sprefix', 'crid', 'th',
      'keywords', 'camp', 'ie', 'colid', 'coliid', 'pldnSite', 'spIA', 'currency',
    ],
    // 移除路徑中的 /ref=xxxxx 片段
    pathPatterns: [/\/ref=[^/?#]*/gi],
  },
  {
    id: 'google',
    name: 'Google 搜尋',
    hosts: ['google.com', 'google.com.tw', 'google.co.jp', 'google.co.uk', 'google.de',
      'google.fr', 'google.com.hk', 'google.ca', 'google.com.au'],
    params: [
      'ved', 'ei', 'sa', 'source', 'sca_esv', 'sca_upv', 'oq', 'gs_lcrp', 'gs_lp',
      'sclient', 'usg', 'uact', 'cd', 'cad', 'rlz', 'biw', 'bih', 'dpr', 'sourceid',
      'client', 'aqs', 'ictx', 'stick', 'csuir', 'iflsig', 'bshm', 'sxsrf', 'esrc',
    ],
  },
  {
    id: 'bilibili',
    name: 'bilibili',
    hosts: ['bilibili.com', 'b23.tv'],
    params: [
      'spm_id_from', 'from_source', 'vd_source', 'share_source', 'share_medium',
      'share_plat', 'share_tag', 'share_session_id', 'share_from', 'unique_k',
      'buvid', 'is_story_h5', 'mid', 'plat_id', 'msource', 'bbid', 'ts', 'up_id',
      'timestamp', 'from_spmid', 'referfrom', 'seid', 'broadcast_type', 'is_room_feed',
      'session_id', 'launch_id', 'live_from', 'visit_id', 'refer_from', 'hotRank',
    ],
  },
  {
    id: 'xiaohongshu',
    name: '小紅書',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    params: [
      'xsec_source', 'share_from_user_hidden', 'type', 'author_share', 'apptime',
      'share_id', 'shareRedId', 'exSource', 'app_platform', 'app_version',
      'source', 'from', 'share_source',
    ],
  },
  {
    id: 'shopee',
    name: '蝦皮購物',
    hosts: ['shopee.tw', 'shopee.com', 'shopee.com.my', 'shopee.sg', 'shopee.co.th',
      'shopee.ph', 'shopee.vn', 'shopee.co.id', 'shp.ee', 's.shopee.tw'],
    params: [
      'sp_atk', 'xptdk', 'is_from_login', 'publish_id', 'uls_trackid', 'gads_t_sig',
      'view_index', 'utm_content', 'af_click_lookback', 'af_reengagement_window',
      'pid', 'c', 'af_siteid', 'af_sub1', 'af_sub2', 'af_sub3', 'af_sub4', 'af_sub5',
      'is_retargeting', 'deep_link_value', 'af_channel', 'smtt', 'from_source',
    ],
  },
  {
    id: 'alibaba',
    name: '淘寶 / 天貓 / 速賣通',
    hosts: ['taobao.com', 'tmall.com', 'aliexpress.com', 'aliexpress.us', '1688.com', 'alibaba.com'],
    params: [
      'spm', 'scm', 'pvid', 'utparam', 'ali_refid', 'ali_trackid', /^mm_/i,
      'ws_ab_test', /^algo_/i, 'btsid', /^pdp_/i, 'gatewayAdapt', /^_randl_/i,
      'curPageLogUid', 'gps-id', 'scm-url', 'scm_id', 'aff_fcid', 'aff_fsk',
      'aff_platform', 'aff_trace_key', 'aff_short_key', 'terminal_id', 'afSmartRedirect',
      'sk', 'cv', 'bftTag', 'sourceType', 'suid', 'utparam-url', 'search_p4p_id',
    ],
  },
  {
    id: 'jd',
    name: '京東',
    hosts: ['jd.com', 'jd.hk'],
    params: ['utm_user', 'gx', 'gxd', 'ad_od', 'PTAG', 'cu', 'abt', 'jdaId', 'shopId'],
  },
  {
    id: 'reddit',
    name: 'Reddit',
    hosts: ['reddit.com', 'redd.it'],
    params: ['share_id', 'correlation_id', 'ref_campaign', 'ref_source', 'rdt', 'context', '$deep_link', '$original_url', 'post_fullname', 'rdt_cid', 'chainedPosts'],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    hosts: ['spotify.com', 'spotify.link'],
    params: ['si', 'nd', 'context', '_branch_match_id', '_branch_referrer', 'go', 'utm_source'],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    hosts: ['linkedin.com', 'lnkd.in'],
    params: ['trackingId', 'refId', 'originalSubdomain', 'midToken', 'midSig', 'trk', 'trkEmail', 'lipi', 'licu', 'eid', 'otpToken'],
  },
  {
    id: 'medium',
    name: 'Medium',
    hosts: ['medium.com'],
    params: ['source', 'sk', 'gi', 'postPublishedType'],
  },
  {
    id: 'steam',
    name: 'Steam',
    hosts: ['steampowered.com', 'steamcommunity.com'],
    params: ['snr', 'curator_clanid', 'utm_source'],
  },
  {
    id: 'ebay',
    name: 'eBay',
    hosts: ['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.com.au'],
    params: [/^_trk/i, 'hash', 'mkevt', 'mkcid', 'mkrid', 'campid', 'customid', 'toolid', 'norover', 'siteid', 'ufes_redirect'],
  },
  {
    id: 'pixnet-tw',
    name: '台灣常見站點',
    hosts: ['pixnet.net', 'ettoday.net', 'ltn.com.tw', 'chinatimes.com', 'udn.com',
      'setn.com', 'tvbs.com.tw', 'cna.com.tw', 'nownews.com', 'ebc.net.tw',
      'businessweekly.com.tw', 'gvm.com.tw', 'commonhealth.com.tw'],
    params: ['from', 'utm_content', 'ctrack', 'source', 'redirect', 'fromline', 'openExternalBrowser'],
  },
  {
    id: 'momo-pchome',
    name: 'momo / PChome / 露天',
    hosts: ['momoshop.com.tw', 'pchome.com.tw', 'ruten.com.tw', 'books.com.tw', 'shopping.friday.tw'],
    params: ['cid', 'oid', 'osm', 'memid', 'str_category_code', 'mdiv', 'ctype', 'utm_content', 'atc', 'loc', 'source', 'sourceType', 'sid', 'ch'],
  },
  {
    id: 'line',
    name: 'LINE',
    hosts: ['line.me', 'today.line.me'],
    params: ['openExternalBrowser', 'utm_content', 'from', 'liff_id', 'shareTo'],
  },
  {
    id: 'apple',
    name: 'Apple',
    hosts: ['apple.com', 'apple.co'],
    params: ['ct', 'ls', 'app', 'itscg', 'itsct', 'mttnsubad', 'mt', 'uo', 'at'],
  },
  {
    id: 'stackoverflow',
    name: 'Stack Overflow',
    hosts: ['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com'],
    params: ['r', 'rq', 'noredirect', 'newreg', 'lq'],
  },
  {
    id: 'github',
    name: 'GitHub',
    hosts: ['github.com'],
    params: ['email_source', 'email_token', 'notification_referrer_id', 'ref_cta', 'ref_loc', 'ref_page'],
  },
];

/** 會出現在 hash（#）中的追蹤片段 */
const HASH_PARAM_RULES = [/^utm_/i, 'xtor', 'Echobox', 'ref', '_ga', 'fbclid'];

/**
 * 已知短網址服務（需要連網才能還原）。
 * 用「網域後綴」比對；部分服務（reddit、facebook）改由 SHORT_PATH_PATTERNS 判斷。
 */
const SHORTENER_HOSTS = [
  't.co', 'bit.ly', 'bitly.com', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'is.gd', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 't.ly', 'shorte.st',
  'lnkd.in', 'amzn.to', 'amzn.asia', 'a.co', 'ebay.us', 'fb.me', 'm.me',
  'redd.it', 'v.redd.it', 'youtu.be', 'spotify.link', 'apple.co', 'forms.gle',
  'maps.app.goo.gl', 'g.co', 'wa.me', 'vt.tiktok.com', 'vm.tiktok.com',
  'b23.tv', 'xhslink.com', 'douyin.com', 'dwz.cn', 't.cn', 'url.cn', 'suo.im',
  'shp.ee', 's.shopee.tw', 'reurl.cc', 'pse.is', 'lihi.cc', 'lihi.io', 'lihi1.cc',
  'lihi2.cc', 'lihi3.cc', 'myppt.cc', 'piee.pw', 'sc.piee.pw', 'bit.do', 'han.gl',
  'tiny.cc', 'soo.gd', 'clck.ru', 'trib.al', 'dlvr.it', 'ift.tt', 'flip.it',
  'nyti.ms', 'wapo.st', 'reut.rs', 'on.wsj.com', 'cnn.it', 'bbc.in', 'go.nasa.gov',
];

/** 路徑符合這些樣式時，視為需要連網還原的短連結 */
const SHORT_PATH_PATTERNS = [
  { host: 'reddit.com', pattern: /^\/r\/[^/]+\/s\/[\w]+/i },
  { host: 'facebook.com', pattern: /^\/share\/(p|r|v)?\/?[\w]+/i },
  { host: 'threads.net', pattern: /^\/(t|share)\/[\w-]+/i },
  { host: 'threads.com', pattern: /^\/(t|share)\/[\w-]+/i },
];

/** youtu.be 本身即為正式短網址，不視為需連網還原 */
const SAFE_SHORTENERS = ['youtu.be'];

// ==================== 解封裝（不需連網） ====================
//
// 處理兩類情形：
// 1. 重導向包裝：真正的目標網址就藏在某個 query 參數裡（Facebook l.php、Google /url 等）
// 2. 編碼包裝：目標網址經過 base64 / URL-encode（Bing ck/a、AMP 等）

/** 解 base64url（容忍缺少 padding） */
function decodeBase64Url(str) {
  try {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    while (s.length % 4 !== 0) s += '=';
    const bin = atob(s);
    // 以 UTF-8 解碼，避免中文網址亂碼
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 判斷字串是否為看得懂的 http(s) 網址 */
function looksLikeUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return false;
  try {
    const u = new URL(v);
    return Boolean(u.hostname) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** 反覆 decodeURIComponent，處理雙重編碼 */
function deepDecode(value, max = 3) {
  let cur = value;
  for (let i = 0; i < max; i++) {
    if (looksLikeUrl(cur)) return cur;
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function hostMatches(hostname, domain) {
  const h = hostname.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/**
 * 重導向包裝規則。
 * - params：依序嘗試這些 query 參數，取出後解碼即為目標網址
 * - custom：自訂處理函式，回傳目標網址字串或 null
 */
const UNWRAPPERS = [
  {
    name: 'Facebook 外連跳轉',
    hosts: ['l.facebook.com', 'lm.facebook.com', 'l.messenger.com', 'l.instagram.com', 'l.threads.net', 'l.threads.com'],
    exactHost: true,
    params: ['u', 'url'],
  },
  {
    name: 'Google 跳轉',
    hosts: ['google.com'],
    pathTest: (p) => p === '/url' || p === '/imgres' || p === '/searchurl',
    params: ['q', 'url', 'imgurl'],
  },
  {
    name: 'YouTube 外連跳轉',
    hosts: ['youtube.com'],
    pathTest: (p) => p === '/redirect',
    params: ['q'],
  },
  {
    name: 'Outlook Safe Links',
    hosts: ['safelinks.protection.outlook.com'],
    params: ['url'],
  },
  {
    name: 'Proofpoint URL Defense',
    hosts: ['urldefense.com', 'urldefense.proofpoint.com'],
    params: ['u'],
    custom: (url) => {
      // v3 格式：/v3/__https://example.com__;!!...
      const m = url.pathname.match(/\/v3\/__(.+?)__;/);
      if (m) return deepDecode(m[1]);
      return null;
    },
  },
  { name: 'Slack 跳轉', hosts: ['slack-redir.net'], params: ['url'] },
  { name: 'Medium 跳轉', hosts: ['medium.com'], pathTest: (p) => p === '/r' || p === '/r/', params: ['url'] },
  { name: 'Steam 外連過濾', hosts: ['steamcommunity.com'], pathTest: (p) => p.startsWith('/linkfilter'), params: ['url', 'u'] },
  { name: 'VK 跳轉', hosts: ['vk.com'], pathTest: (p) => p === '/away.php', params: ['to'] },
  { name: 'Tumblr 跳轉', hosts: ['t.umblr.com'], exactHost: true, params: ['z'] },
  { name: 'Disqus 跳轉', hosts: ['disq.us'], exactHost: true, params: ['url'] },
  { name: 'Reddit 外連', hosts: ['out.reddit.com'], exactHost: true, params: ['url'] },
  { name: 'href.li', hosts: ['href.li'], exactHost: true, custom: (url) => deepDecode(url.search.slice(1)) },
  { name: 'DuckDuckGo 跳轉', hosts: ['duckduckgo.com'], pathTest: (p) => p === '/l' || p === '/l/', params: ['uddg'] },
  { name: 'Yandex 跳轉', hosts: ['yandex.ru', 'yandex.com'], params: ['url', 'text'] },
  { name: 'Baidu 跳轉', hosts: ['baidu.com'], pathTest: (p) => p === '/link', params: ['url'] },
  { name: 'Twitter 外連', hosts: ['twitter.com', 'x.com'], pathTest: (p) => p === '/i/redirect', params: ['url'] },
  { name: '微信 / QQ 跳轉', hosts: ['weixin110.qq.com', 'c.pc.qq.com'], params: ['url', 'pfurl'] },
  { name: 'LINE 跳轉', hosts: ['line.me'], pathTest: (p) => p.includes('/redirect'), params: ['url', 'u'] },
  {
    name: 'Bing 跳轉',
    hosts: ['bing.com'],
    pathTest: (p) => p.startsWith('/ck/a'),
    custom: (url) => {
      const u = url.searchParams.get('u');
      if (!u) return null;
      // Bing 以 "a1" 開頭，後接 base64url
      const payload = u.startsWith('a1') ? u.slice(2) : u;
      const decoded = decodeBase64Url(payload);
      return looksLikeUrl(decoded) ? decoded : null;
    },
  },
  {
    name: 'Google AMP',
    hosts: ['google.com'],
    pathTest: (p) => p.startsWith('/amp/'),
    custom: (url) => {
      // /amp/s/example.com/path → https://example.com/path
      const m = url.pathname.match(/^\/amp\/(s\/)?(.+)$/);
      if (!m) return null;
      const scheme = m[1] ? 'https' : 'http';
      return `${scheme}://${m[2]}${url.search}`;
    },
  },
  {
    name: 'AMP CDN',
    hosts: ['cdn.ampproject.org'],
    custom: (url) => {
      // xxx-com.cdn.ampproject.org/v/s/example.com/path
      const m = url.pathname.match(/^\/[a-z]\/(s\/)?(.+)$/);
      if (!m) return null;
      const scheme = m[1] ? 'https' : 'http';
      return `${scheme}://${m[2]}`;
    },
  },
  {
    name: 'Google Translate 代理',
    hosts: ['translate.google.com', 'translate.googleusercontent.com'],
    params: ['u'],
  },
  {
    name: '通用重導向參數',
    hosts: ['*'],
    // 僅在參數值本身就是完整 http(s) 網址時才拆，避免誤判
    params: ['redirect_url', 'redirectUrl', 'redirect_uri', 'redirect_to', 'redirectTo',
      'returnUrl', 'return_url', 'target_url', 'targetUrl', 'destination', 'dest_url',
      'originalUrl', 'original_url', 'jump_url', 'linkurl', 'link_url'],
    strict: true,
  },
];

/** 對單一網址嘗試解一層包裝 */
function unwrapOnce(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  for (const rule of UNWRAPPERS) {
    const hostOk = rule.hosts.includes('*')
      || rule.hosts.some((h) => (rule.exactHost ? url.hostname.toLowerCase() === h : hostMatches(url.hostname, h)));
    if (!hostOk) continue;
    if (rule.pathTest && !rule.pathTest(url.pathname)) continue;

    if (rule.custom) {
      const result = rule.custom(url);
      if (looksLikeUrl(result)) return { url: result, via: rule.name };
    }
    for (const param of rule.params || []) {
      const raw = url.searchParams.get(param);
      if (!raw) continue;
      const decoded = deepDecode(raw);
      if (looksLikeUrl(decoded) && decoded !== rawUrl) {
        return { url: decoded, via: rule.name };
      }
      // 有些服務會把網址 base64 後放進參數
      const b64 = decodeBase64Url(raw);
      if (!rule.strict && looksLikeUrl(b64)) {
        return { url: b64, via: `${rule.name}（Base64）` };
      }
    }
  }
  return null;
}

/** 反覆解封裝直到無法再拆（最多 6 層，避免循環） */
function unwrapAll(rawUrl, max = 6) {
  let current = rawUrl;
  const steps = [];
  const seen = new Set([rawUrl]);

  for (let i = 0; i < max; i++) {
    const result = unwrapOnce(current);
    if (!result || seen.has(result.url)) break;
    steps.push({ from: current, to: result.url, via: result.via });
    seen.add(result.url);
    current = result.url;
  }
  return { url: current, steps };
}

// ==================== 清理核心 ====================

/** 從一段文字中抽出所有 http(s) 網址（分享過來的通常夾在文案中） */
function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/\bhttps?:\/\/[^\s<>"'()\[\]，。、！？]+/gi) || [];
  return matches
    .map((m) => m.replace(/[.,;:!?'"）】」』]+$/u, '')) // 去掉句尾標點
    .filter((m, i, arr) => arr.indexOf(m) === i);
}

/** 把使用者輸入正規化成可解析的網址（缺 scheme 時補 https://） */
function normalizeInput(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (!text) return null;

  const found = extractUrls(text);
  if (found.length) return found[0];

  // 沒有 scheme：例如 example.com/path?utm_source=x
  const bare = text.split(/\s+/)[0];
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(bare)) return 'https://' + bare;
  return null;
}

function matchParam(name, rule) {
  if (rule instanceof RegExp) return rule.test(name);
  return String(rule).toLowerCase() === name.toLowerCase();
}

/** 取得適用於此網域的所有規則 */
function rulesForHost(hostname) {
  const applied = [GLOBAL_RULE];
  for (const rule of DOMAIN_RULES) {
    if (rule.hosts.some((h) => hostMatches(hostname, h))) applied.push(rule);
  }
  return applied;
}

/**
 * 以原始字串方式解析 query，保留每個參數原本的編碼形式，
 * 避免 URLSearchParams 重新序列化時改動未被移除的參數。
 */
function parseQueryRaw(search) {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (!q) return [];
  return q.split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    const rawKey = i < 0 ? pair : pair.slice(0, i);
    const rawValue = i < 0 ? null : pair.slice(i + 1);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch { /* 保留原字串 */ }
    let value = rawValue;
    try {
      value = rawValue === null ? null : decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch { /* 保留原字串 */ }
    return { raw: pair, rawKey, rawValue, key, value };
  });
}

function serializeQueryRaw(pairs) {
  return pairs.map((p) => p.raw).join('&');
}

/** 判斷網址是否為需要連網才能還原的短連結 */
function detectShortener(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { isShort: false };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (SAFE_SHORTENERS.includes(host)) return { isShort: false };

  for (const s of SHORTENER_HOSTS) {
    if (host === s || host.endsWith('.' + s)) {
      // 短網址的路徑通常很短；根目錄不算
      if (url.pathname.length <= 1) return { isShort: false };
      return { isShort: true, service: s };
    }
  }
  for (const { host: h, pattern } of SHORT_PATH_PATTERNS) {
    if (hostMatches(host, h) && pattern.test(url.pathname)) {
      return { isShort: true, service: h };
    }
  }
  return { isShort: false };
}

/**
 * 清理一個網址。跳轉解包裝與 hash 追蹤參數一律處理，沒有開關。
 * @param {string} input 使用者輸入或分享進來的文字
 * @param {string[]} keep 使用者手動要求保留的參數名稱
 */
function cleanUrl(input, keep = []) {
  const keepSet = new Set(keep.map((k) => k.toLowerCase()));

  const normalized = normalizeInput(input);
  if (!normalized) {
    return { ok: false, error: '找不到有效的網址', original: input ?? '' };
  }

  const unwrapped = unwrapAll(normalized);

  let url;
  try {
    url = new URL(unwrapped.url);
  } catch {
    return { ok: false, error: '網址格式無法解析', original: normalized };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: `不支援的協定：${url.protocol}`, original: normalized };
  }

  const applied = rulesForHost(url.hostname);
  const removed = [];
  const kept = [];

  const survivors = parseQueryRaw(url.search).filter((pair) => {
    if (keepSet.has(pair.key.toLowerCase())) {
      kept.push({ key: pair.key, value: pair.value });
      return true;
    }
    for (const rule of applied) {
      if (rule.params.some((r) => matchParam(pair.key, r))) {
        removed.push({ key: pair.key, value: pair.value, rule: rule.name, ruleId: rule.id });
        return false;
      }
    }
    return true;
  });

  url.search = survivors.length ? '?' + serializeQueryRaw(survivors) : '';

  // 路徑內的追蹤片段（例如 Amazon 的 /ref=xxx）
  const pathRemoved = [];
  for (const rule of applied) {
    for (const pattern of rule.pathPatterns || []) {
      const before = url.pathname;
      const after = before.replace(new RegExp(pattern.source, pattern.flags), '');
      if (after !== before) {
        pathRemoved.push({ rule: rule.name, before, after });
        url.pathname = after || '/';
      }
    }
  }

  // hash 中的追蹤參數
  if (url.hash.length > 1) {
    const hashBody = url.hash.slice(1);
    // 只有看起來像 query string 的 hash 才處理，避免破壞 SPA 路由
    if (/^[\w.-]+=[^=]*(&[\w.-]+=[^=]*)*$/.test(hashBody)) {
      const hashSurvivors = parseQueryRaw(hashBody).filter((pair) => {
        if (keepSet.has(pair.key.toLowerCase())) return true;
        const hit = HASH_PARAM_RULES.some((r) => matchParam(pair.key, r));
        if (hit) removed.push({ key: pair.key, value: pair.value, rule: 'Hash 追蹤參數', ruleId: 'hash' });
        return !hit;
      });
      url.hash = hashSurvivors.length ? '#' + serializeQueryRaw(hashSurvivors) : '';
    }
  }

  let cleaned = url.toString();
  // URL 物件在沒有路徑時會補上結尾斜線，若原本沒有就還原
  if (cleaned.endsWith('/') && !normalized.replace(/[?#].*$/, '').endsWith('/')
    && url.pathname === '/' && !url.search && !url.hash) {
    cleaned = cleaned.slice(0, -1);
  }

  return {
    ok: true,
    original: normalized,
    cleaned,
    removed,
    kept,
    pathRemoved,
    unwrapSteps: unwrapped.steps,
    changed: cleaned !== normalized,
    shortener: detectShortener(cleaned),
    allUrls: extractUrls(String(input ?? '')),
  };
}

/** 把清理結果整理成一句好讀的說明 */
function summarize(result) {
  if (!result.ok) return result.error;
  const parts = [];
  if (result.unwrapSteps.length) parts.push(`解開 ${result.unwrapSteps.length} 層跳轉包裝`);
  if (result.removed.length) parts.push(`移除 ${result.removed.length} 個追蹤參數`);
  if (result.pathRemoved.length) parts.push('清理路徑追蹤片段');
  return parts.length ? parts.join('、') : '這個連結很乾淨，沒有需要清理的地方';
}

// ==================== 介面狀態 ====================

const input = ref('');
const result = ref(null);
/** 使用者手動要求保留的參數名稱 */
const keep = ref([]);
const expanding = ref(false);
const inputEl = ref(null);
const canShare = typeof navigator !== 'undefined' && !!navigator.share;

const status = computed(() => (result.value ? summarize(result.value) : ''));
const others = computed(() => {
  if (!result.value?.ok) return [];
  return (result.value.allUrls || []).filter((u) => u !== result.value.original);
});

const toastText = ref('');
let toastTimer;
function toast(message, ms = 2200) {
  toastText.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 舊版 / 非安全環境的備援
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/**
 * @param {string} text 使用者輸入或分享進來的文字
 * @param {boolean} [silent] 只更新畫面、不自動複製（邊打字邊預覽時用）
 */
async function run(text, silent = false) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    result.value = null;
    return null;
  }

  const res = cleanUrl(trimmed, keep.value);
  result.value = res;

  // 清理完成一律自動複製
  if (res.ok && !silent) {
    toast(await copyText(res.cleaned) ? '已清理並複製' : '已清理，請按「複製」');
  }
  return res;
}

function clean() {
  keep.value = [];
  run(input.value);
}

function reset() {
  input.value = '';
  keep.value = [];
  result.value = null;
  inputEl.value?.focus();
}

function useUrl(url) {
  input.value = url;
  keep.value = [];
  run(url);
}

/** 點掉的參數放回來 / 再拿掉 */
function toggleParam(key, restore) {
  keep.value = restore
    ? [...keep.value, key]
    : keep.value.filter((k) => k.toLowerCase() !== key.toLowerCase());
  run(input.value, true);
  toast(restore ? `已還原 ${key}` : `已再次移除 ${key}`);
}

async function pasteIn() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast('剪貼簿是空的');
    useUrl(text);
  } catch {
    toast('無法讀取剪貼簿，請手動貼上');
    inputEl.value?.focus();
  }
}

async function copyResult() {
  if (!result.value?.ok) return;
  toast(await copyText(result.value.cleaned) ? '已複製' : '複製失敗，請長按選取');
}

function openResult() {
  if (!result.value?.ok) return;
  window.open(result.value.cleaned, '_blank', 'noopener,noreferrer');
}

async function shareResult() {
  if (!result.value?.ok) return;
  try {
    await navigator.share({ url: result.value.cleaned });
  } catch { /* 使用者取消 */ }
}

/** 短網址還原：交給自家 Worker 跟隨重導向，不經過任何第三方 */
async function expand() {
  if (!result.value?.ok || expanding.value) return;
  const target = result.value.cleaned;

  expanding.value = true;
  try {
    const res = await fetch(`/api/expand?url=${encodeURIComponent(target)}`);
    const data = await res.json();

    if (!data.ok) {
      toast(data.error || '無法還原這個短網址');
      return;
    }

    // 還原後再跑一次清理，短網址背後往往還藏著一整串追蹤參數
    input.value = data.url;
    keep.value = [];
    const cleaned = await run(data.url, true);
    if (cleaned?.ok) {
      const hops = data.hops?.length || 1;
      const copied = await copyText(cleaned.cleaned);
      // 半路停下來時要講清楚，不然使用者會把中間的網址當成最終結果
      if (data.stopped) {
        toast(`跟隨 ${hops} 次後停下：${data.stopped}，這可能不是最終網址`, 4500);
      } else {
        toast(copied ? `已跟隨 ${hops} 次跳轉並複製` : `已跟隨 ${hops} 次跳轉`);
      }
    }
  } catch {
    toast('連不上還原服務，請確認網路');
  } finally {
    expanding.value = false;
  }
}

// ---------- 離線快取 / 安裝（都要使用者自己按） ----------

/** 建置時間，當版本號用（vite 建置時注入） */
const buildTime = __BUILD_TIME__;
/** 是否已註冊 Service Worker */
const offline = ref(false);
/** 有新版 Service Worker 裝好了，等使用者決定何時換過去 */
const updateReady = ref(false);
/** Chrome 的安裝提示事件，攔下來等使用者按按鈕才用 */
const installPrompt = ref(null);
const installing = ref(false);

let swReg = null;
/** 使用者按過「立即更新」才把頁面重載，第一次安裝的 claim() 不算 */
let updating = false;

/** 盯著這個註冊，有新版裝好就把按鈕亮出來 */
function watchForUpdate(reg) {
  swReg = reg;
  if (reg.waiting) updateReady.value = true;

  reg.addEventListener('updatefound', () => {
    const incoming = reg.installing;
    if (!incoming) return;
    incoming.addEventListener('statechange', () => {
      // 有 controller 才代表是換版；沒有的話只是第一次安裝，不用打擾使用者
      if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
        updateReady.value = true;
      }
    });
  });
}

/** 讓等待中的新版接手，接手後頁面會自己重載 */
async function applyUpdate() {
  const reg = swReg || await navigator.serviceWorker.getRegistration();
  if (!reg?.waiting) return location.reload();
  updating = true;
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) location.reload();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 不讓瀏覽器自己跳
    installPrompt.value = e;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt.value = null;
    toast('已安裝到主畫面');
  });
}

/**
 * Chrome 要先看到「有 fetch handler 的 Service Worker」才會丟出 beforeinstallprompt，
 * 所以剛註冊完得等它一下；等太久會超出使用者操作的有效期間，最多等 3 秒。
 */
function waitForPrompt(ms = 3000) {
  if (installPrompt.value) return Promise.resolve(installPrompt.value);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, ms);
    const stop = watch(installPrompt, (value) => {
      if (!value) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}

/** 一顆按鈕包辦：註冊 Service Worker（離線）＋叫出系統安裝提示 */
async function toggleInstall() {
  if (!('serviceWorker' in navigator)) return toast('這個瀏覽器不支援安裝');

  // 已經裝了 → 移除，順手把快取清乾淨
  if (offline.value) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    offline.value = false;
    updateReady.value = false;
    installPrompt.value = null;
    swReg = null;
    return toast('已移除，裝置上不再留任何東西');
  }

  installing.value = true;
  try {
    // updateViaCache: 'none' → 檢查更新時一定重新抓 sw.js，不吃 HTTP 快取
    watchForUpdate(await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
    offline.value = true;
  } catch {
    installing.value = false;
    // 非 HTTPS 會失敗，但 Firefox 的隱私瀏覽視窗（或關掉 SW 的瀏覽器設定）也會，
    // 這種情況下環境本身是安全的，講 HTTPS 只會誤導。
    return toast(window.isSecureContext
      ? '安裝失敗：隱私瀏覽視窗不支援'
      : '安裝失敗：需要 HTTPS');
  }

  const prompt = await waitForPrompt();
  installing.value = false;

  // Firefox 與 iOS Safari 沒有 beforeinstallprompt，只能請使用者自己從選單加
  if (!prompt) {
    return toast('已可離線使用；要放到主畫面請用瀏覽器選單「加到主畫面」');
  }

  installPrompt.value = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome !== 'accepted') toast('已可離線使用，尚未加到主畫面');
}

// ---------- 輸入 ----------

let debounce;
watch(input, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!value.trim()) result.value = null;
    else run(value, true);
  }, 400);
});

function onPaste() {
  // 等瀏覽器把內容寫進 textarea 之後再處理
  setTimeout(() => { keep.value = []; run(input.value); }, 0);
}

function onEnter(e) {
  e.preventDefault();
  clean();
}

/** 從 Web Share Target 的 query 取連結；Android 常把網址塞在 text 而非 url */
function readSharedUrl() {
  const params = new URLSearchParams(location.search);
  const candidates = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean);
  for (const candidate of candidates) {
    if (extractUrls(candidate).length) return candidate;
  }
  return candidates[0] || null;
}

onMounted(async () => {
  // 只是讀取現況，不會主動註冊
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    offline.value = !!reg;
    if (reg) {
      watchForUpdate(reg);
      reg.update().catch(() => {}); // 每次開啟主動問一次伺服器有沒有新版
    }
  }

  const shared = readSharedUrl();
  if (shared) {
    input.value = shared;
    run(shared); // 分享進來一律自動清理並複製
    // 清掉網址列的分享參數，避免重新整理時重複處理
    history.replaceState(null, '', location.pathname);
  } else {
    inputEl.value?.focus();
  }
});
</script>

<template>
  <header class="topbar">
    <h1 class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="brand-icon">
        <path d="M9.5 14.5 14.5 9.5" stroke-linecap="round" />
        <path d="M11 6.5 12.6 4.9a4.1 4.1 0 0 1 5.8 5.8L16.8 12.3" stroke-linecap="round" />
        <path d="M13 17.5 11.4 19.1a4.1 4.1 0 0 1-5.8-5.8L7.2 11.7" stroke-linecap="round" />
      </svg>
      連結清理
    </h1>
  </header>

  <main class="wrap">
    <section class="card">
      <label class="label" for="input">貼上連結，或從其他 App 分享到這裡</label>
      <textarea
        id="input"
        ref="inputEl"
        v-model="input"
        rows="3"
        spellcheck="false"
        enterkeyhint="go"
        placeholder="https://www.threads.com/@user/post/XXXX?xmt=..."
        @paste="onPaste"
        @keydown.enter.exact="onEnter"
      />
      <div class="actions input-actions">
        <button class="btn ghost" type="button" @click="pasteIn">從剪貼簿貼上</button>
        <button class="btn ghost" type="button" @click="reset">清空</button>
        <button class="btn primary" type="button" @click="clean">清理</button>
      </div>
    </section>

    <section v-if="result" class="card">
      <div class="status" :class="{ error: !result.ok, neutral: result.ok && !result.changed }">
        {{ status }}
      </div>

      <template v-if="result.ok">
        <div class="block-label">清理後</div>
        <output class="url cleaned">{{ result.cleaned }}</output>

        <div class="actions">
          <button class="btn primary" type="button" @click="copyResult">複製</button>
          <button class="btn" type="button" @click="openResult">開啟</button>
          <button v-if="canShare" class="btn" type="button" @click="shareResult">分享</button>
        </div>

        <div v-if="result.shortener.isShort" class="expand-row">
          <div class="expand-text">
            <strong>偵測到短網址</strong>
            <span class="muted">{{ result.shortener.service }} 的連結背後可能還藏著追蹤參數</span>
          </div>
          <button class="btn small" type="button" :disabled="expanding" @click="expand">
            {{ expanding ? '跟隨中…' : '還原原始網址' }}
          </button>
        </div>

        <details class="details">
          <summary>清理細節</summary>
          <div class="detail-body">
            <div class="result-block">
              <div class="block-label">原始網址</div>
              <div class="url original">{{ result.original }}</div>
            </div>

            <div v-if="result.unwrapSteps.length" class="result-block">
              <div class="block-label">解開的跳轉</div>
              <ol class="steps">
                <li v-for="(step, i) in result.unwrapSteps" :key="i">
                  <span class="via">{{ step.via }}</span> → {{ step.to }}
                </li>
              </ol>
            </div>

            <div v-if="result.removed.length" class="result-block">
              <div class="block-label">
                移除的參數<span class="muted">（點一下可還原）</span>
              </div>
              <div class="chips">
                <button
                  v-for="(item, i) in result.removed"
                  :key="i"
                  type="button"
                  class="chip"
                  :title="`${item.key}=${item.value ?? ''}｜規則：${item.rule}`"
                  @click="toggleParam(item.key, true)"
                >{{ item.key }}={{ item.value ?? '' }}</button>
              </div>
            </div>

            <div v-if="result.kept.length" class="result-block">
              <div class="block-label">已還原保留<span class="muted">（點一下改回移除）</span></div>
              <div class="chips">
                <button
                  v-for="(item, i) in result.kept"
                  :key="i"
                  type="button"
                  class="chip restored"
                  @click="toggleParam(item.key, false)"
                >{{ item.key }}={{ item.value ?? '' }}</button>
              </div>
            </div>
          </div>
        </details>
      </template>
    </section>

    <section v-if="others.length" class="card">
      <div class="block-label">這段文字含有多個連結</div>
      <div class="multi-list">
        <button
          v-for="url in others"
          :key="url"
          type="button"
          class="multi-item"
          @click="useUrl(url)"
        >{{ url }}</button>
      </div>
    </section>

    <div class="app-actions">
      <button class="btn small ghost" type="button" :disabled="installing" @click="toggleInstall">
        {{ installing ? '安裝中…' : (offline ? '已安裝（點此移除）' : '安裝到這台裝置') }}
      </button>
    </div>

    <p class="footnote">
      清理與解包裝全部在這台裝置上完成，不會留下任何紀錄或設定。
      只有你按下「還原原始網址」時，該連結才會送到本站 Cloudflare Workers 代為跟隨跳轉。
      「安裝到這台裝置」會把 App 裝在這台裝置上，之後沒網路也能用。
    </p>

    <p class="version">
      <span>版本 {{ buildTime }}</span>
      <button v-if="updateReady" class="version-update" type="button" @click="applyUpdate">
        有新版本，立即更新
      </button>
    </p>
  </main>

  <div class="toast" :class="{ show: toastText }" role="status" aria-live="polite">{{ toastText }}</div>
</template>
