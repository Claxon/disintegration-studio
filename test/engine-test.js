// Headless checks for the dispersion engine. Run: node test/engine-test.js
// Writes a few pictures to test/out/ so the result can be looked at.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
require('../disintegration-studio/js/disintegration-core.js');
require('../disintegration-studio/js/presets.js');
const D = globalThis.Disintegration, PRESETS = globalThis.DISINTEGRATION_PRESETS;
// The checks below run on the JavaScript engine; section 11 compares the WebAssembly engine with
// it. ENGINE=wasm runs them all on the WebAssembly engine instead.
const loadWasm = () => { require('../disintegration-studio/js/engine-wasm-bin.js'); require('../disintegration-studio/js/engine-wasm.js'); };
if (process.env.ENGINE === 'wasm') { loadWasm(); console.log('engine:', D.engine); }

// ---- tiny PNG writer -------------------------------------------------------
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
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const saved = [];
const save = (name, img) => { fs.writeFileSync(path.join(outDir, name), png(img.width, img.height, img.data)); if (img.width === 600) saved.push(img); };

// ---- synthetic scene: a busy background and a figure with distinct colours ----
function scene(W, H) {
  const plate = new Uint8ClampedArray(W * H * 4), subject = new Uint8ClampedArray(W * H * 4);
  const s = W / 600;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, u = x / s, v = y / s;
    const n = D.noise.fbm(u * 0.03, v * 0.03, 5), stripe = Math.sin(u * 0.09 + v * 0.05) > 0.4 ? 30 : 0;
    plate[i] = 40 + 90 * n + stripe; plate[i + 1] = 80 + 100 * (v / 400) + stripe * 0.5; plate[i + 2] = 130 + 80 * (1 - n); plate[i + 3] = 255;
    // figure: head (circle) on a body (rounded block), left of centre
    const hx = 230, hy = 110, body = u > 170 && u < 290 && v > 160 && v < 380;
    const dh = Math.hypot(u - hx, v - hy);
    let a = 0;
    if (dh < 48) a = Math.min(1, 48 - dh);
    if (body) a = Math.max(a, Math.min(1, Math.min(u - 170, 290 - u, v - 160, 380 - v)));
    if (a > 0) {
      if (dh < 48 && !body) { subject[i] = 235; subject[i + 1] = 190; subject[i + 2] = 150; } // skin
      else if (v < 280) { subject[i] = 200; subject[i + 1] = (Math.floor(u / 12) % 2) * 60 + 20; subject[i + 2] = 40; } // red striped top
      else { subject[i] = 30; subject[i + 1] = 60; subject[i + 2] = 170; } // blue legs
      subject[i + 3] = a * 255;
    }
  }
  return { width: W, height: H, plate, subject };
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failed++;
}
const sumOf = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

const src = scene(600, 400);
const ctx = D.prepare(src);
console.log('subject: unit', ctx.unit.toFixed(1), 'bbox', JSON.stringify(ctx.bbox), 'centre', ctx.cx.toFixed(1), ctx.cy.toFixed(1));

// 1. defaults
const st = D.normalize({});
let t0 = Date.now();
const res = D.render(ctx, st);
const ms = Date.now() - t0;
check('auto direction points to the roomier side (right)', res.resolved.angle === 0, 'angle ' + res.resolved.angle);
check('start point is on the right edge of the figure', res.resolved.ox > 270 && res.resolved.ox < 292, 'ox ' + res.resolved.ox.toFixed(1));
check('default render makes particles', res.count > 500, res.count + ' particles in ' + ms + ' ms');
save('default.png', D.composite(ctx, res));
save('default-mask.png', D.composite(ctx, res, { view: 'mask' }));
save('before.png', D.composite(ctx, null));

// 2. amount limits
const none = D.render(ctx, D.normalize({ amount: 0 }));
check('amount 0 removes nothing', sumOf(none.erode) === 0 && none.count === 0);
const all = D.render(ctx, D.normalize({ amount: 1 }));
let kept = 0, subj = 0;
for (let i = 0; i < 600 * 400; i++) if (src.subject[i * 4 + 3] > 0) { subj++; if (all.erode[i] < 250) kept++; }
check('amount 1 removes everything', kept === 0, kept + ' of ' + subj + ' subject pixels left');

// 3. the erosion is on the leading side
let leftE = 0, rightE = 0;
for (let y = 0; y < 400; y++) for (let x = 0; x < 600; x++) { const e = res.erode[y * 600 + x]; if (x < 230) leftE += e; else rightE += e; }
check('erosion is on the side the particles fly to', rightE > leftE * 3, 'left ' + leftE + ' right ' + rightE);

// 4. deterministic
const res2 = D.render(ctx, st);
let same = true;
for (let i = 0; i < res.particles.length && same; i++) if (res.particles[i] !== res2.particles[i]) same = false;
check('same settings give the same picture', same);
const res3 = D.render(ctx, D.normalize({ seed: 2 }));
let differs = false;
for (let i = 0; i < res.particles.length && !differs; i++) if (res.particles[i] !== res3.particles[i]) differs = true;
check('a new seed gives a different picture', differs);

// 5. particle colours come from the subject (no colour variety, no texture → exact palette averages)
const flat = D.render(ctx, D.normalize({ colorVar: 0, texture: 0, amount: 0.6 }));
let off = 0, tot = 0;
for (let i = 0; i < 600 * 400; i++) {
  const a = flat.particles[i * 4 + 3];
  if (a < 200) continue;
  tot++;
  const r = flat.particles[i * 4], g = flat.particles[i * 4 + 1], b = flat.particles[i * 4 + 2];
  // every subject colour has either strong red (skin, top) or strong blue (legs); the background has neither pure form
  const skin = r > 180 && g > 140, top = r > 150 && b < 90, legs = b > 120 && r < 90;
  if (!skin && !top && !legs) off++;
}
check('particle colours come from the subject', tot > 200 && off / tot < 0.08, off + ' of ' + tot + ' opaque particle pixels off-palette');

// 6. painting
const paintOnly = D.normalize({ auto: false, blend: 0, strokes: [{ mode: 'add', size: 0.12, hard: 0.6, pts: [0.36, 0.2, 0.4, 0.3] }] });
const pr = D.render(ctx, paintOnly);
let inside = 0, outside = 0;
for (let y = 0; y < 400; y++) for (let x = 0; x < 600; x++) {
  const e = pr.erode[y * 600 + x];
  if (!e) continue;
  if (Math.hypot(x - 228, y - 100) < 70) inside += e; else outside += e;
}
check('painted region disperses with automatic off', inside > 0 && outside === 0, 'inside ' + inside + ' outside ' + outside);
save('paint-only.png', D.composite(ctx, pr));
const prot = D.normalize({ amount: 1, strokes: [{ mode: 'protect', size: 0.2, hard: 0.9, pts: [0.38, 0.27] }] });
const qr = D.render(ctx, prot);
check('protected region survives amount 1', qr.erode[110 * 600 + 228] === 0 && qr.erode[350 * 600 + 230] > 250);
const erased = D.normalize({ auto: false, strokes: [{ mode: 'add', size: 0.12, hard: 0.6, pts: [0.36, 0.2, 0.4, 0.3] }, { mode: 'erase', size: 0.4, hard: 1, pts: [0.38, 0.25] }] });
check('eraser removes paint', sumOf(D.render(ctx, erased).erode) === 0);

// 6b. blending: the dispersion tapers off towards protect paint instead of stopping at a line
const meanErode = (r, x0, x1, y0, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += r.erode[y * 600 + x]; n++; } return s / n; };
const guard = [{ mode: 'protect', size: 0.06, hard: 0.9, pts: [0.33, 0.45, 0.33, 0.9] }]; // a strip down the body, x 180…216
const hardEdge = D.render(ctx, D.normalize({ amount: 1, blend: 0, strokes: guard }));
const softEdge = D.render(ctx, D.normalize({ amount: 1, blend: 0.6, strokes: guard }));
const nearH = meanErode(hardEdge, 225, 245, 200, 340), nearS = meanErode(softEdge, 225, 245, 200, 340), farS = meanErode(softEdge, 274, 288, 200, 340);
check('without blend the dispersion runs right up to protect paint', nearH > 235, 'next to it ' + nearH.toFixed(0) + ' of 255');
check('with blend it tapers off towards protect paint', nearS > 15 && nearS < 190 && farS > nearS + 40, 'next to it ' + nearS.toFixed(0) + ', further away ' + farS.toFixed(0));
check('blend leaves the protect paint itself intact', meanErode(softEdge, 186, 210, 200, 340) === 0);
save('blend-off.png', D.composite(ctx, hardEdge));
save('blend-on.png', D.composite(ctx, softEdge));
save('blend-on-mask.png', D.composite(ctx, softEdge, { view: 'mask' }));
// disperse paint fades out beyond its edge as well
const dab = [{ mode: 'add', size: 0.08, hard: 0.9, pts: [0.38, 0.6, 0.38, 0.7] }]; // x 204…252 on the body
const dabHard = D.render(ctx, D.normalize({ auto: false, blend: 0, strokes: dab })), dabSoft = D.render(ctx, D.normalize({ auto: false, blend: 0.6, strokes: dab }));
check('disperse paint fades out past its edge with blend', meanErode(dabHard, 262, 280, 240, 280) === 0 && meanErode(dabSoft, 262, 280, 240, 280) > 4 && meanErode(dabSoft, 215, 240, 245, 275) > 235,
  'beyond the edge ' + meanErode(dabSoft, 262, 280, 240, 280).toFixed(0) + ', inside ' + meanErode(dabSoft, 215, 240, 245, 275).toFixed(0));
save('blend-dab.png', D.composite(ctx, dabSoft));
// a brush at half strength protects by half
const halfProt = D.render(ctx, D.normalize({ amount: 1, blend: 0, strokes: [{ mode: 'protect', size: 0.3, hard: 1, flow: 0.5, pts: [0.38, 0.5, 0.38, 0.8] }] }));
const halfE = meanErode(halfProt, 190, 270, 220, 320);
check('a protect brush at half strength lets part of the subject go', halfE > 40 && halfE < 235, 'mean erosion ' + halfE.toFixed(0) + ' of 255');
save('half-protect.png', D.composite(ctx, halfProt));

// 7. resolution independence: a 2x render pinned to the preview lays out the same
const src2 = scene(1200, 800), ctx2 = D.prepare(src2);
t0 = Date.now();
const big = D.render(ctx2, st, { ref: res.resolved.ref });
const ms2 = Date.now() - t0;
let dE = 0, dP = 0, nE = 0;
for (let y = 0; y < 400; y++) for (let x = 0; x < 600; x++) {
  let e = 0, pa = 0;
  for (let k = 0; k < 4; k++) { const j = (y * 2 + (k >> 1)) * 1200 + x * 2 + (k & 1); e += big.erode[j]; pa += big.particles[j * 4 + 3]; }
  dE += Math.abs(e / 4 - res.erode[y * 600 + x]); dP += Math.abs(pa / 4 - res.particles[(y * 600 + x) * 4 + 3]); nE++;
}
check('2x render matches the preview (erosion)', dE / nE < 1.2, 'mean difference ' + (dE / nE).toFixed(3) + ' of 255, ' + ms2 + ' ms');
// particles: compare how much each 10-pixel block is covered (single pixels differ by anti-aliasing)
let bd = 0, bs = 0;
for (let by = 0; by < 40; by++) for (let bx = 0; bx < 60; bx++) {
  let a1 = 0, a2 = 0;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) a1 += res.particles[((by * 10 + y) * 600 + bx * 10 + x) * 4 + 3];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) a2 += big.particles[((by * 20 + y) * 1200 + bx * 20 + x) * 4 + 3];
  bd += Math.abs(a1 / 100 - a2 / 400); bs += a1 / 100;
}
check('2x render matches the preview (particles)', bd / bs < 0.12, 'block coverage differs by ' + ((bd / bs) * 100).toFixed(1) + '%, per-pixel alpha by ' + (dP / nE).toFixed(1) + ' of 255, ' + big.count + ' vs ' + res.count + ' particles');
save('default-2x.png', D.composite(ctx2, big));

// 8. patterns, presets
['point', 'edges'].forEach((p) => {
  const r = D.render(ctx, D.normalize({ pattern: p, burst: p === 'edges' ? 1 : 0.5 }));
  check('pattern "' + p + '" renders', r.count > 200 && sumOf(r.erode) > 0, r.count + ' particles');
  save('pattern-' + p + '.png', D.composite(ctx, r));
});
PRESETS.forEach((p, i) => {
  const s = D.normalize(Object.assign({}, p.state));
  const r = D.render(ctx, s);
  check('preset "' + p.name + '" renders', r.count > 15 && r.holes > 0, r.count + ' particles, ' + r.holes + ' holes');
  save('preset-' + String(i).padStart(2, '0') + '.png', D.composite(ctx, r));
});

// 8b. brush tips: each one renders, pieces match their holes, the mix follows the weights
D.tipList().forEach((t) => {
  const r = D.render(ctx, D.normalize({ tips: { [t.id]: 1 } }));
  check('tip "' + t.label + '" renders', r.count > 15 && sumOf(r.erode) > 0, r.count + ' particles');
});
{
  const sheetTips = { width: 600, height: 400, data: new Uint8ClampedArray(600 * 400 * 4) };
  D.tipList().forEach((t, n) => {
    const a = D.tipPreview(t.id, 80), ox = 20 + (n % 7) * 82, oy = 60 + Math.floor(n / 7) * 140;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) { const j = ((oy + y) * 600 + ox + x) * 4; sheetTips.data[j] = sheetTips.data[j + 1] = sheetTips.data[j + 2] = 30 + a[y * 80 + x] * 0.85; sheetTips.data[j + 3] = 255; }
  });
  for (let i = 3; i < sheetTips.data.length; i += 4) sheetTips.data[i] = 255;
  save('tips.png', sheetTips);
}
check('every hole in the band has its piece', res.holes > 50 && res.matched / res.holes > 0.94, res.matched + ' of ' + res.holes + ' hole pieces drawn (the rest flew out of the picture)');
{
  // a hole has the shape of its tip: upright squares leave far more straight, axis-aligned mask edges than dots do
  const straightness = (r) => {
    let straight = 0, edge = 0;
    for (let y = 1; y < 399; y++) for (let x = 1; x < 599; x++) {
      const i = y * 600 + x;
      if (src.subject[i * 4 + 3] < 250) continue;
      const gx = Math.abs(r.erode[i + 1] - r.erode[i - 1]), gy = Math.abs(r.erode[i + 600] - r.erode[i - 600]);
      if (gx + gy < 200) continue;
      edge++;
      if (Math.min(gx, gy) < 40) straight++;
    }
    return edge > 200 ? straight / edge : 0;
  };
  const look = { spin: 0, softness: 0, size: 0.7, sizeVar: 0 };
  const sq = D.render(ctx, D.normalize(Object.assign({ tips: { square: 1 } }, look)));
  const sSq = straightness(sq), sDot = straightness(D.render(ctx, D.normalize(Object.assign({ tips: { dot: 1 } }, look))));
  check('holes take the shape of the tip', sSq > 0.55 && sSq > sDot + 0.2, 'axis-aligned share of mask edges: squares ' + sSq.toFixed(2) + ', dots ' + sDot.toFixed(2));
  save('holes-squares.png', D.composite(ctx, sq));
  save('holes-squares-mask.png', D.composite(ctx, sq, { view: 'mask' }));
}
check('an old design with a single shape still loads', JSON.stringify(D.normalize({ shape: 'square' }).tips) === '{"square":1}' && D.normalize({}).tips.chip > 0);
{
  // a tip of the user's own, made from a mask
  const m = new Uint8Array(200 * 100);
  for (let y = 20; y < 70; y++) for (let x = 40; x < 140; x++) if (Math.abs(y - 45) < (x - 40) / 4) m[y * 200 + x] = 255; // a wedge
  const tip = D.tipFromMask(m, 200, 100);
  check('a mask becomes a custom tip', !!tip && tip.n === 96 && tip.data.length === 96 * 96 && sumOf(tip.data) > 0);
  D.setCustomTips([{ id: 'c1', label: 'Wedge', n: tip.n, data: tip.data }]);
  const r = D.render(ctx, D.normalize({ tips: { c1: 1 }, size: 0.8 }));
  check('a custom tip renders', D.tipList().some((t) => t.id === 'c1' && t.kind === 'custom') && r.count > 15, r.count + ' particles');
  save('custom-tip.png', D.composite(ctx, r));
  // a tip from a picture: its shape if it has transparency, its dark parts if it has none
  const pic = new Uint8ClampedArray(60 * 60 * 4), inDab = (x, y) => Math.hypot(x - 30, y - 30) < 18;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) { const j = (y * 60 + x) * 4; pic[j] = pic[j + 1] = pic[j + 2] = 200; pic[j + 3] = inDab(x, y) ? 255 : 0; }
  const fromAlpha = D.tipFromImage(pic, 60, 60);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) { const j = (y * 60 + x) * 4; pic[j] = pic[j + 1] = pic[j + 2] = inDab(x, y) ? 20 : 245; pic[j + 3] = 255; }
  const fromDark = D.tipFromImage(pic, 60, 60);
  const mid = (t) => t.data[Math.floor(t.n / 2) * t.n + Math.floor(t.n / 2)], corner = (t) => t.data[0];
  check('a picture with transparency becomes a tip of its shape', !!fromAlpha && fromAlpha.from === 'alpha' && mid(fromAlpha) > 240 && corner(fromAlpha) < 10);
  check('an opaque picture becomes a tip of its dark parts', !!fromDark && fromDark.from === 'dark' && mid(fromDark) > 240 && corner(fromDark) < 10);
  pic.fill(128);
  for (let j = 3; j < pic.length; j += 4) pic[j] = 255; // opaque mid-grey
  check('a flat picture gives no tip', D.tipFromImage(pic, 60, 60) === null);
  D.setCustomTips([]);
  check('an unknown tip falls back to something', D.render(ctx, D.normalize({ tips: { c1: 1 } })).count > 15);
}

// 9. empty subject, split helper
const emptyCtx = D.prepare({ width: 64, height: 64, subject: new Uint8ClampedArray(64 * 64 * 4) });
check('empty subject renders nothing', D.render(emptyCtx, st).count === 0);
const flatImg = D.composite(ctx, null).data, mask = new Uint8Array(600 * 400);
for (let i = 0; i < mask.length; i++) mask[i] = src.subject[i * 4 + 3];
const sp = D.split(flatImg, 600, 400, mask);
let holeDiff = 0, holeN = 0;
for (let i = 0; i < mask.length; i++) if (mask[i] > 200) { holeN++; holeDiff += Math.abs(sp.plate[i * 4] - src.plate[i * 4]) + Math.abs(sp.plate[i * 4 + 1] - src.plate[i * 4 + 1]) + Math.abs(sp.plate[i * 4 + 2] - src.plate[i * 4 + 2]); }
check('quick fill is close to the real background', holeDiff / holeN / 3 < 30, 'mean error ' + (holeDiff / holeN / 3).toFixed(1) + ' of 255');
save('split-plate.png', { width: 600, height: 400, data: sp.plate });
const half = D.halve(src);
check('halve gives a half-size image', half.width === 300 && half.height === 200 && half.subject.length === 300 * 200 * 4);

// 10. the tip outline table gives what working it out exactly does, at every size and feather
{
  let worst = 0, where = '', n = 0;
  for (const t of D.tipList()) {
    D._tips.variants(t.id).forEach((v, vi) => {
      for (let k = 0; k < 4000; k++) {
        const u = (D.noise.rnd(k, 1, vi) * 2 - 1) * (v.eu + 0.5), w = (D.noise.rnd(k, 2, vi) * 2 - 1) * (v.ew + 0.5);
        const inv = [3, 8, 20, 60, 150][k % 5], fe = (k >> 3) & 1 ? 0.3 : 0;
        const d = Math.abs(D._tips.alpha(v, u, w, inv, fe) - D._tips.exact(v, u, w, inv, fe));
        n++;
        if (d > worst) { worst = d; where = t.id + ' #' + vi; }
      }
    });
  }
  check('tip outline table matches the exact outline', worst < 0.01, 'worst ' + worst.toFixed(4) + ' (' + where + ') over ' + n + ' samples');
}

// 11. the WebAssembly engine (engine-wasm.js) gives exactly the bytes the JavaScript engine gives
{
  if (!D._wasm) loadWasm();
  const C = D._core, Wm = D._wasm;
  check('the WebAssembly engine loads', D.engine === 'wasm', JSON.stringify(Wm.info()));
  // custom tips: a wedge from a mask, a blot from a picture's dark parts, and one given as a plain array
  const m = new Uint8Array(200 * 100);
  for (let y = 20; y < 70; y++) for (let x = 40; x < 140; x++) if (Math.abs(y - 45) < (x - 40) / 4) m[y * 200 + x] = 255;
  const wedge = D.tipFromMask(m, 200, 100);
  const pic = new Uint8ClampedArray(50 * 50 * 4);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) { const j = (y * 50 + x) * 4, d = Math.hypot(x - 25, y - 22) + 4 * Math.sin(x * 0.7); pic[j] = pic[j + 1] = pic[j + 2] = d < 15 ? 30 : d < 19 ? 140 : 250; pic[j + 3] = 255; }
  const blot = D.tipFromImage(pic, 50, 50);
  const customs = [{ id: 'w1', label: 'Wedge', n: wedge.n, data: wedge.data }, { id: 'w2', label: 'Blot', n: blot.n, data: blot.data }, { id: 'w3', label: 'Plain', n: blot.n, data: Array.from(blot.data) }];
  // the scenes: the test scene, twice its size, a small odd size, and one without a plate
  const ctxBig = D.prepare(scene(1200, 800)), ctxOdd = D.prepare(scene(241, 163)), ctxNoPlate = D.prepare({ width: 600, height: 400, subject: src.subject });
  const ref = res.resolved.ref;
  const P = (o) => Object.assign({ blend: 0.4 }, o);
  const stroke = (mode, size, hard, flow, pts) => ({ mode, size, hard, flow, pts });
  const paints = {
    add: [stroke('add', 0.1, 0.5, 0.8, [0.3, 0.3, 0.42, 0.5, 0.45, 0.8])],
    soft: [stroke('add', 0.2, 0.05, 0.3, [0.35, 0.6])],
    protect: [stroke('protect', 0.12, 1, 0.5, [0.38, 0.4, 0.4, 0.7])],
    mixed: [stroke('add', 0.15, 0.3, 1, [0.3, 0.5, 0.45, 0.5]), stroke('protect', 0.05, 0.8, 1, [0.38, 0.3, 0.38, 0.9]), stroke('erase', 0.06, 0.6, 0.7, [0.42, 0.45])],
  };
  const cases = [];
  const add = (name, c, s, o) => cases.push([name, c, s, o]);
  PRESETS.forEach((p) => add('preset ' + p.name, ctx, p.state));
  PRESETS.forEach((p, i) => { if (i % 3 === 0) add('preset ' + p.name + ' + paint', ctx, Object.assign({}, p.state, P({ strokes: paints.mixed }))); });
  D.tipList().forEach((t) => add('tip ' + t.id, ctx, { tips: { [t.id]: 1 } }));
  ['w1', 'w2', 'w3'].forEach((id) => add('custom tip ' + id, ctx, { tips: { [id]: 1 }, size: 0.8 }));
  add('custom tips, small and soft', ctx, { tips: { w1: 0.5, w2: 0.5 }, size: 0.15, softness: 1 });
  add('custom and built-in tips', ctx, { tips: { w1: 0.3, ash: 0.3, drybrush: 0.2, smoke: 0.2 } });
  for (const k in paints) {
    add('paint ' + k, ctx, P({ strokes: paints[k] }));
    add('paint ' + k + ', no blend', ctx, { blend: 0, strokes: paints[k], amount: 0.7 });
    add('paint ' + k + ', automatic off', ctx, P({ auto: false, strokes: paints[k] }));
  }
  add('protect paint at amount 1', ctx, { amount: 1, blend: 0.8, strokes: paints.protect });
  add('pattern point', ctx, { pattern: 'point', burst: 0.5 });
  add('pattern point, own start', ctx, { pattern: 'point', autoOrigin: false, originX: 0.3, originY: 0.6, burst: 1 });
  add('pattern edges', ctx, { pattern: 'edges', burst: 1 });
  add('sweep upwards', ctx, { autoAngle: false, angle: -90 });
  add('sweep at 37°', ctx, { autoAngle: false, angle: 37, autoOrigin: false, originX: 0.2, originY: 0.1 });
  add('burst', ctx, { burst: 1, spread: 1 });
  add('turbulence, fine', ctx, { turbulence: 1, turbScale: 0 });
  add('turbulence, broad', ctx, { turbulence: 1, turbScale: 1 });
  add('gravity down', ctx, { gravity: 1 });
  add('gravity up', ctx, { gravity: -1, distance: 1 });
  add('trails', ctx, { trail: 1 });
  add('trails and turbulence', ctx, { trail: 0.5, turbulence: 0.7, gravity: 0.3 });
  add('no spin', ctx, { spin: 0 });
  add('texture and colour variety', ctx, { texture: 1, colorVar: 1 });
  add('soft, rough, big chunks', ctx, { softness: 1, roughness: 1, chunk: 1 });
  add('hard, smooth, small chunks', ctx, { softness: 0, roughness: 0, chunk: 0 });
  add('amount 1', ctx, { amount: 1 });
  add('amount 0', ctx, { amount: 0 });
  add('density 0', ctx, { density: 0 });
  add('big pieces', ctx, { size: 1, sizeVar: 1 });
  add('tiny pieces', ctx, { size: 0, sizeVar: 0 });
  add('fade, shrink, opacity', ctx, { fade: 1, shrink: 1, opacity: 0.3 });
  add('another seed', ctx, { seed: 4321 });
  add('no particles', ctx, {}, { noParticles: true });
  add('no particles, paint', ctx, P({ strokes: paints.mixed }), { noParticles: true });
  add('2x, pinned to the preview', ctxBig, {}, { ref });
  add('2x, Sandstorm', ctxBig, PRESETS.find((p) => p.name === 'Sandstorm').state, { ref });
  add('2x, paint and trails', ctxBig, P({ strokes: paints.mixed, trail: 0.6, tips: { w1: 0.5, splat: 0.5 } }), { ref });
  add('241x163', ctxOdd, {});
  add('241x163, point, paint', ctxOdd, P({ pattern: 'point', strokes: paints.add, tips: { grit: 1 } }));
  add('no plate', ctxNoPlate, {});
  D.setCustomTips(customs);
  let bytes = 0, differing = 0, maxDiff = 0, sumDiff = 0, n = 0, tJs = 0, tWasm = 0;
  const bad = [];
  const compare = (name, a, b) => {
    if (!a || !b) { if (a !== b) bad.push(name + ' (one is missing)'); return; }
    if (a.length !== b.length || a.constructor !== b.constructor) { bad.push(name + ' (different arrays)'); return; }
    let d0 = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { d0++; sumDiff += d; if (d > maxDiff) maxDiff = d; } }
    bytes += a.length; differing += d0;
    if (d0) bad.push(name + ' (' + d0 + ' bytes)');
  };
  for (const [name, c, s, o] of cases) {
    const st = D.normalize(s);
    let t = Date.now();
    const rj = C.render(c, st, o);
    tJs += Date.now() - t; t = Date.now();
    const rw = Wm.render(c, st, o);
    tWasm += Date.now() - t; n++;
    compare(name + ': erode', rj.erode, rw.erode);
    compare(name + ': particles', rj.particles, rw.particles);
    for (const k of ['count', 'holes', 'matched', 'erodedArea', 'width', 'height']) if (rj[k] !== rw[k]) bad.push(name + ': ' + k + ' ' + rj[k] + ' vs ' + rw[k]);
    if (JSON.stringify(rj.resolved) !== JSON.stringify(rw.resolved)) bad.push(name + ': resolved');
    for (const view of ['result', 'mask']) compare(name + ': composite ' + view, C.composite(c, rj, { view }).data, Wm.composite(c, rw, { view }).data);
  }
  for (const c of [ctx, ctxBig, ctxOdd, ctxNoPlate]) compare('composite before', C.composite(c, null).data, Wm.composite(c, null).data);
  check('WebAssembly engine matches JavaScript byte for byte', !bad.length && bytes > 0,
    n + ' renders (erode, particles, composites): ' + (bytes / 1e6).toFixed(1) + ' MB compared, ' + differing + ' bytes differ, max difference ' + maxDiff + ', mean ' + (bytes ? sumDiff / bytes : 0).toFixed(6) + '; JS ' + tJs + ' ms, wasm ' + tWasm + ' ms' + (bad.length ? '; ' + bad.slice(0, 8).join(', ') : ''));
  // the switch: forcing JavaScript, the fallback after an error, a tip it can't copy exactly
  const st = D.normalize({});
  const same = (a, b) => a.erode.every((v, i) => v === b.erode[i]) && a.particles.every((v, i) => v === b.particles[i]);
  check('useWasm(false) renders with JavaScript', D.useWasm(false) === 'js' && D.engine === 'js' && same(D.render(ctx, st), C.render(ctx, st)) && D.useWasm(true) === 'wasm');
  const logs = [];
  D.engineLog = (msg) => logs.push(msg);
  Wm.failNext();
  const fallen = D.render(ctx, st), after = D.engine;
  D.render(ctx, st);
  check('an error in the WebAssembly engine falls back to JavaScript, logged once', same(fallen, C.render(ctx, st)) && after === 'js' && logs.length === 1 && /failed/.test(logs[0]), logs.join(' | '));
  D.useWasm(true);
  check('useWasm(true) starts the WebAssembly engine again', D.engine === 'wasm');
  D.setCustomTips([{ id: 'odd', n: 2, data: [0, 127.5, 255, 300] }]);
  const oddSt = D.normalize({ tips: { odd: 1 } });
  check('a tip it cannot copy exactly is rendered with JavaScript', same(D.render(ctx, oddSt), C.render(ctx, oddSt)) && D.engine === 'wasm');
  D.engineLog = null;
  D.setCustomTips([]);
}

// contact sheet of every 600-wide picture, at half size
{
  const cols = 4, rows = Math.ceil(saved.length / cols), w = 300, h = 200;
  const sheet = new Uint8ClampedArray(cols * w * rows * h * 4);
  saved.forEach((img, n) => {
    const hx = D.halve({ width: 600, height: 400, subject: null, plate: img.data }).plate, ox = (n % cols) * w, oy = Math.floor(n / cols) * h;
    for (let y = 0; y < h; y++) sheet.set(hx.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * cols * w + ox) * 4);
  });
  fs.writeFileSync(path.join(outDir, 'sheet.png'), png(cols * w, rows * h, sheet));
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
