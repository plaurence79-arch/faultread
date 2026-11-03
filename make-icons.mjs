/* Renders the app icons with no dependencies: a flat amber tile and the bolt mark.
   Run:  node tools/make-icons.mjs                                                */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [180, 192, 512];

const AMBER = [0xf0, 0xa0, 0x30];
const SLATE = [0x12, 0x14, 0x16];

// The bolt from the in-app mark, in its original 24×24 box.
const BOLT = [
  [13, 2], [4, 14], [11, 14], [10, 22], [19, 10], [12, 10]
];

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(size) {
  // The 24-unit box scaled to 56% of the tile, centred.
  const span = size * 0.56;
  const unit = span / 24;
  const offX = (size - span) / 2;
  const offY = (size - span) / 2;

  const SS = 4;                     // supersampling for smooth edges
  const step = 1 / SS;
  const rows = [];

  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;                     // filter: none
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) * step - offX) / unit;
          const y = (py + (sy + 0.5) * step - offY) / unit;
          if (inPoly(x, y, BOLT)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const o = 1 + px * 3;
      for (let c = 0; c < 3; c++) {
        row[o + c] = Math.round(AMBER[c] * (1 - a) + SLATE[c] * a);
      }
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

/* ── minimal PNG writer ── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
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

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
