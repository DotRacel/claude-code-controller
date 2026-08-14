/**
 * Write the PWA PNG icons (no extra deps — zlib CRC + deflate).
 * Run: node web/scripts/gen-icons.mjs
 */
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function writePng(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * w * 4, (y + 1) * w * 4));
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(file, png);
}

function sdRoundBox(px, py, cx, cy, hw, hh, rad) {
  const dx = Math.abs(px - cx) - (hw - rad);
  const dy = Math.abs(py - cy) - (hh - rad);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - rad;
}

function paint(size, { padFrac, bg }) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = size * padFrac;
  const inner = size - pad * 2;
  const cx = size / 2;
  const cy = size / 2;
  const hw = inner / 2;
  const hh = inner / 2;
  const rad = inner * 0.22;
  const c0 = [0xc9, 0x64, 0x42];
  const c1 = [0x2a, 0x6b, 0x5f];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * (size - 1));
      const sd = sdRoundBox(x + 0.5, y + 0.5, cx, cy, hw, hh, rad);
      const a = Math.max(0, Math.min(1, 0.5 - sd));
      const r = c0[0] + (c1[0] - c0[0]) * t;
      const g = c0[1] + (c1[1] - c0[1]) * t;
      const b = c0[2] + (c1[2] - c0[2]) * t;
      // composite over bg
      rgba[i] = Math.round(r * a + bg[0] * (1 - a));
      rgba[i + 1] = Math.round(g * a + bg[1] * (1 - a));
      rgba[i + 2] = Math.round(b * a + bg[2] * (1 - a));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT, { recursive: true });
const dark = [0x0f, 0x0f, 0x0f];
writePng(join(OUT, 'icon-192.png'), 192, 192, paint(192, { padFrac: 0.06, bg: dark }));
writePng(join(OUT, 'icon-512.png'), 512, 512, paint(512, { padFrac: 0.06, bg: dark }));
writePng(join(OUT, 'icon-512-maskable.png'), 512, 512, paint(512, { padFrac: 0.18, bg: dark }));
writePng(join(OUT, 'apple-touch-icon.png'), 180, 180, paint(180, { padFrac: 0.0, bg: dark }));
writePng(join(OUT, 'favicon-32.png'), 32, 32, paint(32, { padFrac: 0.06, bg: dark }));
console.log('wrote icons to', OUT);
