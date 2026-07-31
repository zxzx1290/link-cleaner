/**
 * 產生 PWA 圖示（不依賴任何第三方套件）
 *
 * 圖案：一條被剪斷的鏈結，代表「切斷追蹤」。
 * 執行：node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, "public", "icons");

// ---------- 最小 PNG 編碼器 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba 長度為 size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 每列前面加一個 filter byte（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + src, size * 4).copy(raw, dst + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 距離場繪圖 ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 點到線段的距離 */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2);
  const dx = wx - t * vx, dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

/** 圓角矩形的有號距離 */
function roundRectDist(px, py, half, radius) {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * 半圓的距離：只算法線 n 指的那半邊，另一半退回到直徑兩端的端點（圓頭線帽）。
 */
function halfCircleDist(px, py, cx, cy, r, nx, ny) {
  const dx = px - cx, dy = py - cy;
  if (dx * nx + dy * ny >= 0) return Math.abs(Math.hypot(dx, dy) - r);
  const ux = -ny, uy = nx; // 直徑方向
  return Math.min(
    Math.hypot(px - (cx + ux * r), py - (cy + uy * r)),
    Math.hypot(px - (cx - ux * r), py - (cy - uy * r)),
  );
}

/** 疊上一層顏色（src-over） */
function over(dst, i, rgb, alpha) {
  const a = clamp01(alpha);
  if (a <= 0) return;
  const inv = 1 - a;
  dst[i] = rgb[0] * a + dst[i] * inv;
  dst[i + 1] = rgb[1] * a + dst[i + 1] * inv;
  dst[i + 2] = rgb[2] * a + dst[i + 2] * inv;
  dst[i + 3] = 255 * a + dst[i + 3] * inv;
}

// 底色用標題列圖示的主色 --accent #3d5afe，線條全白
// （深色模式的 --accent #7c8cff 太淺，配白線對比不足，圖示是固定的一張圖所以取深的那個）
const BG = [61, 90, 254];
const LINK = [255, 255, 255];

/**
 * 圖案與標題列那個 SVG 完全相同：viewBox 0 0 24 24、stroke-width 1.9、圓頭線條，
 * 一條中央斜線加上左右兩個鉤子。
 *
 * 原本路徑裡的 `a 4.1 4.1 0 0 1 5.8 5.8` 弦長 8.2024 剛好等於直徑，所以那就是半圓：
 * 圓心取起訖點的中點，凸出去的是法線 n 指的那一邊。
 */
const STROKE = 1.9 / 2;

/** 直線段（24 單位座標） */
const GLYPH_SEGMENTS = [
  [9.5, 14.5, 14.5, 9.5], // 中央斜線
  [11, 6.5, 12.6, 4.9], // 右上鉤子的兩端
  [18.4, 10.7, 16.8, 12.3],
  [13, 17.5, 11.4, 19.1], // 左下鉤子的兩端
  [5.6, 13.3, 7.2, 11.7],
];

/** 半圓：[圓心x, 圓心y, 半徑, 法線x, 法線y] */
const GLYPH_ARCS = [
  [15.5, 7.8, 4.1012, Math.SQRT1_2, -Math.SQRT1_2], // 往右上凸
  [8.5, 16.2, 4.1012, -Math.SQRT1_2, Math.SQRT1_2], // 往左下凸
];

/** 圖案在 24 單位座標裡離中心最遠 7.35，換算成佔畫面 ±0.60 */
const GLYPH_FIT = 0.6 * 12 / 7.35;

/**
 * @param {number} size 邊長（像素）
 * @param {object} opts
 * @param {boolean} [opts.maskable] maskable 版：背景鋪滿、圖案縮小留安全區
 * @param {boolean} [opts.opaque]   不透明背景（Apple touch icon 需要）
 */
function drawIcon(size, opts = {}) {
  const { maskable = false, opaque = false } = opts;
  const SS = 3; // 每軸 3 倍超取樣做反鋸齒
  const px = new Float32Array(size * size * 4);

  // 座標系：中心為 0，邊界為 ±1
  const bgHalf = maskable ? 1.6 : 0.94;     // maskable 讓背景超出可視範圍
  const bgRadius = maskable ? 0.2 : 0.24;
  const scale = maskable ? 0.72 : 1;        // 圖案控制在 maskable 安全區（中心 80% 圓）內
  const fit = GLYPH_FIT * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
          const fy = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
          const sample = new Float32Array(4);

          // 背景
          const bgD = roundRectDist(fx, fy, bgHalf, bgRadius);
          over(sample, 0, BG, opaque ? 1 : clamp01(0.5 - bgD * size * 0.5));

          // 圖案：把取樣點換回 24 單位的 SVG 座標算距離，再換算回畫面單位
          const gx = fx * 12 / fit + 12;
          const gy = fy * 12 / fit + 12;

          let d = Infinity;
          for (const [ax, ay, bx, by] of GLYPH_SEGMENTS) {
            d = Math.min(d, segDist(gx, gy, ax, ay, bx, by));
          }
          for (const [cx, cy, cr, nx, ny] of GLYPH_ARCS) {
            d = Math.min(d, halfCircleDist(gx, gy, cx, cy, cr, nx, ny));
          }
          const stroke = (d - STROKE) * fit / 12;
          over(sample, 0, LINK, clamp01(0.5 - stroke * size * 0.5));

          r += sample[0]; g += sample[1]; b += sample[2]; a += sample[3];
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n; px[i + 3] = a / n;
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.max(0, Math.min(255, px[i])));
  return encodePng(out, size);
}

// ---------- 產出 ----------

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true, opaque: true }],
  ['apple-touch-icon.png', 180, { opaque: true }],
];

for (const [name, size, opts] of targets) {
  const buf = drawIcon(size, opts);
  writeFileSync(join(OUT_DIR, name), buf);
  console.log(`產生 icons/${name}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
