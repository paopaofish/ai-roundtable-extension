// Generates the extension icons (16/48/128 px) without any dependency.
// Design: rounded blue square + three white dots (three speakers) + a bottom bar.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

const BG = hex('#2f6fed');
const FG = [255, 255, 255];

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.22; // corner radius
  const inRoundRect = (x, y, w, h, rad) => {
    const cx = Math.min(Math.max(x, rad), w - rad);
    const cy = Math.min(Math.max(y, rad), h - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5, size, size, r)) {
        px[i + 3] = 0;
        continue;
      }
      px[i] = BG[0];
      px[i + 1] = BG[1];
      px[i + 2] = BG[2];
      px[i + 3] = 255;

      // three dots
      const cy = size * 0.44;
      const dotR = size * 0.085;
      for (const cx of [size * 0.3, size * 0.5, size * 0.7]) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= dotR ** 2) {
          px[i] = FG[0];
          px[i + 1] = FG[1];
          px[i + 2] = FG[2];
        }
      }
      // speech bar
      const barY = size * 0.64;
      const barH = Math.max(1, size * 0.075);
      if (x + 0.5 > size * 0.24 && x + 0.5 < size * 0.76 && y + 0.5 > barY && y + 0.5 < barY + barH) {
        px[i] = FG[0];
        px[i + 1] = FG[1];
        px[i + 2] = FG[2];
      }
    }
  }
  return Buffer.from(px);
}

for (const size of [16, 48, 128]) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png(size, size, render(size)));
  console.log('wrote', file);
}
