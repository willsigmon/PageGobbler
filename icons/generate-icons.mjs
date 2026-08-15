/**
 * PageGobbler toolbar PNG generator.
 * Run: node icons/generate-icons.mjs
 * Draws size-aware turkeys (16px = silhouette + 3 feathers) and writes icon{16,32,48,128}.png
 */

import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCALE = 8;

const C = {
  roast: [26, 16, 8],
  copper: [212, 118, 44],
  gold: [232, 168, 73],
  red: [192, 57, 43],
  body: [139, 69, 19],
  breast: [160, 82, 45],
  tan: [210, 163, 106],
  parchment: [245, 230, 208],
};

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcSrc = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcSrc));
  return Buffer.concat([len, crcSrc, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createBuf(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function blend(buf, x, y, r, g, b, a = 255) {
  x = x | 0;
  y = y | 0;
  if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return;
  const i = (y * buf.w + x) * 4;
  const da = buf.data[i + 3] / 255;
  const sa = a / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) return;
  buf.data[i] = Math.round((r * sa + buf.data[i] * da * (1 - sa)) / outA);
  buf.data[i + 1] = Math.round((g * sa + buf.data[i + 1] * da * (1 - sa)) / outA);
  buf.data[i + 2] = Math.round((b * sa + buf.data[i + 2] * da * (1 - sa)) / outA);
  buf.data[i + 3] = Math.round(outA * 255);
}

function fillEllipse(buf, cx, cy, rx, ry, rgb) {
  const x0 = Math.floor(cx - rx);
  const x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) blend(buf, x, y, rgb[0], rgb[1], rgb[2]);
    }
  }
}

function fillCircle(buf, cx, cy, r, rgb) {
  fillEllipse(buf, cx, cy, r, r, rgb);
}

function fillTriangle(buf, x1, y1, x2, y2, x3, y3, rgb) {
  const minx = Math.floor(Math.min(x1, x2, x3));
  const maxx = Math.ceil(Math.max(x1, x2, x3));
  const miny = Math.floor(Math.min(y1, y2, y3));
  const maxy = Math.ceil(Math.max(y1, y2, y3));
  const area = (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  if (area === 0) return;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w1 = ((px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)) / area;
      const w2 = ((px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)) / area;
      const w3 = 1 - w1 - w2;
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) blend(buf, x, y, rgb[0], rgb[1], rgb[2]);
    }
  }
}

function fillRoundRect(buf, x, y, w, h, r, rgb) {
  const x1 = x + w;
  const y1 = y + h;
  for (let py = Math.floor(y); py <= Math.ceil(y1); py++) {
    for (let px = Math.floor(x); px <= Math.ceil(x1); px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      if (cx < x || cy < y || cx > x1 || cy > y1) continue;
      let inside = true;
      if (cx < x + r && cy < y + r) {
        const dx = cx - (x + r);
        const dy = cy - (y + r);
        inside = dx * dx + dy * dy <= r * r;
      } else if (cx > x1 - r && cy < y + r) {
        const dx = cx - (x1 - r);
        const dy = cy - (y + r);
        inside = dx * dx + dy * dy <= r * r;
      } else if (cx < x + r && cy > y1 - r) {
        const dx = cx - (x + r);
        const dy = cy - (y1 - r);
        inside = dx * dx + dy * dy <= r * r;
      } else if (cx > x1 - r && cy > y1 - r) {
        const dx = cx - (x1 - r);
        const dy = cy - (y1 - r);
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside) blend(buf, px, py, rgb[0], rgb[1], rgb[2]);
    }
  }
}

function strokeRoundRect(buf, x, y, w, h, r, rgb, t) {
  fillRoundRect(buf, x, y, w, h, r, rgb);
  fillRoundRect(buf, x + t, y + t, w - t * 2, h - t * 2, Math.max(0, r - t), C.roast);
}

function downsample(buf, scale) {
  const w = buf.w / scale;
  const h = buf.h / scale;
  const out = Buffer.alloc(w * h * 4);
  const n = scale * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let oy = 0; oy < scale; oy++) {
        for (let ox = 0; ox < scale; ox++) {
          const i = ((y * scale + oy) * buf.w + (x * scale + ox)) * 4;
          r += buf.data[i];
          g += buf.data[i + 1];
          b += buf.data[i + 2];
          a += buf.data[i + 3];
        }
      }
      const j = (y * w + x) * 4;
      out[j] = Math.round(r / n);
      out[j + 1] = Math.round(g / n);
      out[j + 2] = Math.round(b / n);
      out[j + 3] = Math.round(a / n);
    }
  }
  return { w, h, data: out };
}

function setPx(buf, x, y, rgb) {
  if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return;
  const i = (y * buf.w + x) * 4;
  buf.data[i] = rgb[0];
  buf.data[i + 1] = rgb[1];
  buf.data[i + 2] = rgb[2];
  buf.data[i + 3] = 255;
}

function render16() {
  const buf = createBuf(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) setPx(buf, x, y, C.roast);
  }
  for (let i = 1; i < 15; i++) {
    setPx(buf, i, 0, C.copper);
    setPx(buf, i, 15, C.copper);
    setPx(buf, 0, i, C.copper);
    setPx(buf, 15, i, C.copper);
  }
  setPx(buf, 1, 1, C.copper);
  setPx(buf, 14, 1, C.copper);
  setPx(buf, 1, 14, C.copper);
  setPx(buf, 14, 14, C.copper);

  const stamp = (x, y, rgb) => setPx(buf, x, y, rgb);

  // Three separated plumes — 1px roast gutters so they don't melt.
  for (let y = 3; y <= 7; y++) {
    stamp(3, y, C.red);
    stamp(4, y, C.red);
  }
  stamp(3, 3, C.roast);
  stamp(4, 2, C.red);

  for (let y = 2; y <= 6; y++) {
    stamp(7, y, C.gold);
    stamp(8, y, C.gold);
  }
  stamp(7, 2, C.roast);
  stamp(8, 1, C.gold);

  for (let y = 3; y <= 7; y++) {
    stamp(11, y, C.copper);
    stamp(12, y, C.copper);
  }
  stamp(12, 3, C.roast);
  stamp(11, 2, C.copper);

  // Tan head silhouette
  for (let y = 6; y <= 10; y++) {
    for (let x = 6; x <= 10; x++) {
      const dx = x - 8;
      const dy = y - 8;
      if (dx * dx + dy * dy <= 5) stamp(x, y, C.tan);
    }
  }
  stamp(8, 10, C.gold);
  stamp(7, 10, C.gold);
  stamp(9, 10, C.gold);

  // Body
  for (let y = 11; y <= 13; y++) {
    for (let x = 5; x <= 11; x++) {
      if (y === 11 && (x === 5 || x === 11)) continue;
      if (y === 13 && (x === 5 || x === 11)) continue;
      stamp(x, y, C.body);
    }
  }
  stamp(6, 11, C.breast);
  stamp(7, 11, C.breast);
  stamp(8, 11, C.breast);
  stamp(9, 11, C.breast);
  stamp(10, 11, C.breast);

  return buf;
}

function drawTurkey(buf, size) {
  const u = (n) => (n / 32) * size * SCALE;
  const showEyes = size >= 32;
  const showWattle = size >= 32;
  const showOuterFeathers = size >= 48;
  const showSpec = size >= 128;

  if (showOuterFeathers) {
    fillEllipse(buf, u(4.8), u(13.5), u(3.6), u(8.6), C.red);
    fillEllipse(buf, u(27.2), u(13.5), u(3.6), u(8.6), C.red);
  }

  fillEllipse(buf, u(8.2), u(13.4), u(3.6), u(8.8), C.red);
  fillEllipse(buf, u(23.8), u(13.4), u(3.6), u(8.8), C.copper);
  fillEllipse(buf, u(16), u(11.8), u(3.8), u(9.4), C.gold);

  fillEllipse(buf, u(16), u(22.0), u(7.4), u(6.4), C.body);
  fillEllipse(buf, u(16), u(21.2), u(5.4), u(4.8), C.breast);
  fillCircle(buf, u(16), u(14.6), u(4.8), C.tan);
  fillTriangle(buf, u(14.0), u(16.6), u(16), u(19.6), u(18.0), u(16.6), C.gold);

  if (showWattle) {
    fillEllipse(buf, u(17.2), u(19.6), u(1.35), u(2.1), C.red);
  }
  if (showEyes) {
    fillCircle(buf, u(14.2), u(13.7), u(1.15), C.roast);
    fillCircle(buf, u(17.8), u(13.7), u(1.15), C.roast);
    if (showSpec) {
      fillCircle(buf, u(14.55), u(13.3), u(0.36), C.parchment);
      fillCircle(buf, u(18.15), u(13.3), u(0.36), C.parchment);
    }
  }
}

function render(size) {
  if (size === 16) return render16();
  const buf = createBuf(size * SCALE, size * SCALE);
  const pad = size * 0.05 * SCALE;
  const rad = size * 0.2 * SCALE;
  fillRoundRect(buf, pad, pad, buf.w - pad * 2, buf.h - pad * 2, rad, C.roast);
  const stroke = Math.max(SCALE * 0.55, size * 0.018 * SCALE);
  strokeRoundRect(buf, pad, pad, buf.w - pad * 2, buf.h - pad * 2, rad, C.copper, stroke);
  drawTurkey(buf, size);
  return downsample(buf, SCALE);
}

for (const size of [16, 32, 48, 128]) {
  const img = render(size);
  const png = encodePNG(img.w, img.h, img.data);
  const dest = join(ROOT, `icon${size}.png`);
  writeFileSync(dest, png);
  console.log(`wrote ${dest} (${png.length} bytes)`);
}
