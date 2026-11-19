// Renders the plugin icons with the dispersion engine itself: a block breaking up into squares.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
require('../disintegration-studio/js/disintegration-core.js');
const D = globalThis.Disintegration;
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const LOOK = { amount: 0.5, roughness: 0.55, chunk: 0.75, softness: 0, density: 0.42, size: 1, sizeVar: 0.7, tips: { square: 1 }, spin: 0, texture: 0,
  distance: 0.3, spread: 0.3, burst: 0.1, turbulence: 0.05, fade: 0.25, shrink: 0.55, colorVar: 0, angle: 0, autoAngle: false, seed: 6 };
function icon(size, color) {
  const K = 8, W = size * K;
  const subject = new Uint8ClampedArray(W * W * 4);
  const x0 = W * 0.06, x1 = W * 0.6, y0 = W * 0.17, y1 = W * 0.83, rad = W * 0.07;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = Math.max(x0 + rad - x, 0, x - (x1 - rad)), dy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
    if (x < x0 || x >= x1 || y < y0 || y >= y1 || Math.hypot(dx, dy) > rad) continue;
    const i = (y * W + x) * 4;
    subject[i] = color[0]; subject[i + 1] = color[1]; subject[i + 2] = color[2]; subject[i + 3] = 255;
  }
  const ctx = D.prepare({ width: W, height: W, subject });
  const res = D.render(ctx, D.normalize(LOOK));
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let v = 0; v < K; v++) for (let u = 0; u < K; u++) {
      const p = (y * K + v) * W + x * K + u, i = p * 4;
      const sa = (subject[i + 3] * (255 - res.erode[p])) / 65025, pa = res.particles[i + 3] / 255; // particles over what is left of the block
      const oa = pa + sa * (1 - pa);
      r += res.particles[i] * pa + subject[i] * sa * (1 - pa); g += res.particles[i + 1] * pa + subject[i + 1] * sa * (1 - pa); b += res.particles[i + 2] * pa + subject[i + 2] * sa * (1 - pa); a += oa;
    }
    const j = (y * size + x) * 4;
    if (a > 0) { out[j] = r / a; out[j + 1] = g / a; out[j + 2] = b / a; }
    out[j + 3] = (a / (K * K)) * 255;
  }
  return png(size, size, out);
}
const dir = path.join(__dirname, '../disintegration-studio/icons');
fs.mkdirSync(dir, { recursive: true });
const light = [220, 220, 220], blue = [40, 150, 255];
fs.writeFileSync(path.join(dir, 'panel.png'), icon(23, light));
fs.writeFileSync(path.join(dir, 'panel@2x.png'), icon(46, light));
fs.writeFileSync(path.join(dir, 'plugin.png'), icon(48, blue));
fs.writeFileSync(path.join(dir, 'plugin@2x.png'), icon(96, blue));
console.log('icons written');
