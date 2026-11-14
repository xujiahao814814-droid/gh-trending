#!/usr/bin/env node
'use strict';
/**
 * 生成 PWA 应用图标（纯 Node 零依赖，手写 PNG 编码 + 像素绘制）
 * 设计：深色圆角底 + 金色五角星（GitHub 星标的意象）
 * 输出到 public/icons/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- PNG 编码 ---------------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePNG(file, size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(OUT, file), png);
  console.log('生成', file, `(${size}x${size})`);
}

/* ---------------- 绘制 ---------------- */
function starPts(cx, cy, R, r) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rad = k % 2 === 0 ? R : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 圆角矩形符号距离（<0 在内部） */
function rrSdf(x, y, half, rad) {
  const dx = Math.abs(x) - (half - rad);
  const dy = Math.abs(y) - (half - rad);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rad;
}

// 以 512 逻辑坐标绘制，缩放输出任意尺寸；3x3 超采样抗锯齿
function render(size, rounded) {
  const bg = [13, 17, 23];    // #0d1117
  const gold = [227, 179, 65]; // #e3b341
  const star = starPts(256, 250, 168, 66);
  const px = Buffer.alloc(size * size * 4);
  const ss = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = (x + (sx + 0.5) / ss) * (512 / size);
          const Y = (y + (sy + 0.5) / ss) * (512 / size);
          let alpha = 1;
          let col = bg;
          if (rounded && rrSdf(X - 256, Y - 256, 256, 100) >= 0) {
            alpha = 0;
            col = [0, 0, 0];
          } else if (inPoly(X, Y, star)) {
            col = gold;
          }
          r += col[0]; g += col[1]; b += col[2]; a += alpha;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

writePNG('icon-192.png', 192, render(192, true));
writePNG('icon-512.png', 512, render(512, true));
writePNG('icon-maskable-192.png', 192, render(192, false));
writePNG('icon-maskable-512.png', 512, render(512, false));
writePNG('apple-touch-icon.png', 180, render(180, false));
console.log('完成 →', OUT);
