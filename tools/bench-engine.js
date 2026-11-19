// Times the JavaScript and the WebAssembly engines against each other.
//   node tools/bench-engine.js [width height] [runs]
// Renders a few presets, with and without paint, on a synthetic figure and prints the median
// render and composite times of each engine (the first runs, which build the tip tables and let
// the JIT warm up, are not counted).
const path = require('path');
const js = path.join(__dirname, '..', 'disintegration-studio', 'js');
['disintegration-core.js', 'presets.js', 'engine-wasm-bin.js', 'engine-wasm.js'].forEach((f) => require(path.join(js, f)));
const D = globalThis.Disintegration, PRESETS = globalThis.DISINTEGRATION_PRESETS, C = D._core;

const W = +process.argv[2] || 957, H = +process.argv[3] || 1600, RUNS = +process.argv[4] || 7;
function scene(W, H) {
  const plate = new Uint8ClampedArray(W * H * 4), subject = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, u = x / W, v = y / H;
    plate[i] = 60 + 40 * u; plate[i + 1] = 90; plate[i + 2] = 140 - 50 * v; plate[i + 3] = 255;
    if (Math.hypot((u - 0.5) / 0.12, (v - 0.15) / 0.08) < 1 || (Math.abs(u - 0.5) < 0.22 - 0.05 * Math.abs(v - 0.55) && v > 0.22)) {
      subject[i] = 150 + 60 * u; subject[i + 1] = 100 + 50 * v; subject[i + 2] = 80; subject[i + 3] = 255;
    }
  }
  return { width: W, height: H, plate, subject };
}
const strokes = [];
for (let s = 0; s < 6; s++) {
  const pts = [];
  for (let k = 0; k < 40; k++) pts.push(0.35 + (0.3 * k) / 40, 0.3 + 0.1 * s + 0.02 * Math.sin(k));
  strokes.push({ mode: s % 2 ? 'protect' : 'add', size: 0.08, hard: 0.5, flow: 1, pts });
}
const median = (f) => {
  f(); f();
  const ts = [];
  for (let i = 0; i < RUNS; i++) { const t0 = process.hrtime.bigint(); f(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  return ts.sort((a, b) => a - b)[RUNS >> 1];
};
const ctx = D.prepare(scene(W, H));
console.log(W + '×' + H + ', median of ' + RUNS + ' runs, engine ' + D.engine);
console.log('preset'.padEnd(28) + 'render JS   wasm  speed-up | composite JS  wasm  speed-up');
const names = ['Classic dispersion', 'Fine dust', 'Shattered glass', 'Sandstorm', 'Smoke wisps', 'Snap to ash'];
let sj = 0, sw = 0;
for (const name of names) for (const paint of [false, true]) {
  const p = PRESETS.find((q) => q.name === name);
  const st = D.normalize(Object.assign({}, p.state, paint ? { strokes, blend: 0.4 } : {}));
  const tj = median(() => C.render(ctx, st)), tw = median(() => D._wasm.render(ctx, st));
  const r = C.render(ctx, st);
  const cj = median(() => C.composite(ctx, r)), cw = median(() => D._wasm.composite(ctx, r));
  sj += tj + cj; sw += tw + cw;
  console.log((name + (paint ? ' + paint' : '')).padEnd(28) + tj.toFixed(1).padStart(9) + tw.toFixed(1).padStart(7) + ('×' + (tj / tw).toFixed(2)).padStart(10) +
    ' |' + cj.toFixed(1).padStart(13) + cw.toFixed(1).padStart(6) + ('×' + (cj / cw).toFixed(2)).padStart(10));
}
console.log('all of it (render + composite): JS ' + sj.toFixed(0) + ' ms, wasm ' + sw.toFixed(0) + ' ms, ×' + (sj / sw).toFixed(2));
