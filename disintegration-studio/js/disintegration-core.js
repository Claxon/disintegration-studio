/* Disintegration Studio — dispersion engine.
 * No host APIs: runs the same way in Photoshop (UXP), a browser, or Node.
 *
 * Input:  a subject (RGBA, straight alpha — the alpha is the subject cut-out) and, for previews,
 *         a background plate (RGBA, the picture with the subject removed).
 * Output: an erosion map (how much of each subject pixel is removed) and a particle layer
 *         (RGBA) whose colours come from the subject pixels that were removed.
 *
 * Everything is measured in "subject units" (the square root of the subject's area) and all
 * randomness is hashed per particle, so a render at any resolution gives the same picture.
 */
(function (root) {
  'use strict';
  const D = {};
  const GRID = 512; // longest side of the analysis grid (direction field, paint, distance map)
  const TAU = Math.PI * 2;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    // where it disperses
    auto: true,          // automatic dispersion on/off (off = only painted regions disperse)
    pattern: 'sweep',    // 'sweep' (from one side) | 'point' (outwards from the start point) | 'edges' (from every edge inwards)
    amount: 0.45,        // how much of the subject is eaten away
    angle: 0,            // direction the particles travel, degrees (0 = right, -90 = up)
    autoAngle: true,     // pick the direction from the free space around the subject
    originX: 0.5, originY: 0.5, // start point, as a fraction of the image
    autoOrigin: true,    // put the start point on the subject's leading edge
    roughness: 0.55,     // how ragged the eaten edge is
    chunk: 0.45,         // size of the pieces the edge breaks into
    softness: 0.2,       // feathering of the eaten edge
    // particles
    density: 0.55, size: 0.45, sizeVar: 0.75, spin: 1, texture: 0.6,
    tips: null,          // which brush tips the pieces are cut with, and in what proportion: { id: weight }. null = the default mix
    // motion
    distance: 0.55, spread: 0.3, burst: 0.1, turbulence: 0.35, turbScale: 0.5, gravity: 0, trail: 0,
    // look
    fade: 0.35, shrink: 0.5, opacity: 1, colorVar: 0.12,
    seed: 1,
    blend: 0.3,          // how far painted regions fade out beyond their edge
    strokes: [],         // painted regions: { mode: 'add' | 'protect' | 'erase', size, hard, flow, pts: [x0, y0, x1, y1, …] } (fractions of the image)
  };
  const RANGES = { angle: [-180, 180], gravity: [-1, 1], seed: [1, 9999], originX: [-0.5, 1.5], originY: [-0.5, 1.5] };
  const PATTERNS = [['sweep', 'One side'], ['point', 'A point'], ['edges', 'All edges']];
  // the settings a preset carries (direction, start point and paint belong to the picture, not the preset)
  const PRESET_KEYS = ['pattern', 'amount', 'roughness', 'chunk', 'softness', 'density', 'size', 'sizeVar', 'tips', 'spin', 'texture',
    'distance', 'spread', 'burst', 'turbulence', 'turbScale', 'gravity', 'trail', 'fade', 'shrink', 'opacity', 'colorVar'];

  function normalize(s) {
    s = s || {};
    const o = {};
    for (const k in DEFAULTS) {
      if (k === 'strokes' || k === 'tips') continue;
      const d = DEFAULTS[k];
      let v = s[k];
      if (typeof d === 'number') {
        v = +v;
        if (v !== v || !isFinite(v) || s[k] == null) v = d;
        const r = RANGES[k] || [0, 1];
        v = clamp(v, r[0], r[1]);
      } else if (typeof d === 'boolean') v = v == null ? d : !!v;
      else if (v == null) v = d;
      o[k] = v;
    }
    o.seed = Math.round(o.seed);
    if (!PATTERNS.some((p) => p[0] === o.pattern)) o.pattern = DEFAULTS.pattern;
    // brush tips: { id: weight }. A design from an earlier version has a single "shape" instead.
    const src = s.tips && typeof s.tips === 'object' ? s.tips : LEGACY_SHAPES[s.shape] || DEFAULT_TIPS;
    o.tips = {};
    let any = false;
    for (const id in src) { const w = clamp(+src[id] || 0, 0, 1); if (w > 0) { o.tips[id] = Math.round(w * 1000) / 1000; any = true; } }
    if (!any) o.tips = Object.assign({}, DEFAULT_TIPS);
    o.strokes = [];
    (Array.isArray(s.strokes) ? s.strokes : []).forEach((k) => {
      if (!k || !Array.isArray(k.pts) || k.pts.length < 2) return;
      o.strokes.push({
        mode: k.mode === 'protect' || k.mode === 'erase' ? k.mode : 'add',
        size: clamp(+k.size || 0.08, 0.004, 1), hard: clamp(k.hard == null ? 0.5 : +k.hard, 0, 1), flow: clamp(k.flow == null ? 1 : +k.flow || 0, 0.05, 1),
        pts: k.pts.slice(0, k.pts.length & ~1).map((n) => +n || 0),
      });
    });
    return o;
  }

  // ---------------------------------------------------------------------------
  // Hashing and noise
  // ---------------------------------------------------------------------------
  function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  // the k-th random number of particle i
  function rnd(i, k, seed) {
    let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b) ^ Math.imul(seed + 1, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  // four octaves, stretched so it fills 0…1
  function fbm(x, y, seed) {
    let n = vnoise(x, y, seed) * 0.5 + vnoise(x * 2.13 + 7.1, y * 2.13 - 3.7, seed + 1) * 0.27 +
      vnoise(x * 4.61 - 1.3, y * 4.61 + 9.2, seed + 2) * 0.15 + vnoise(x * 9.7 + 4.4, y * 9.7 + 2.9, seed + 3) * 0.08;
    n = (n - 0.5) * 1.9 + 0.5;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  // ---------------------------------------------------------------------------
  // Subject analysis
  // ---------------------------------------------------------------------------
  // src: { width, height, subject: RGBA, plate?: RGBA }
  function prepare(src) {
    const W = src.width, H = src.height, S = src.subject;
    const gs = Math.min(1, GRID / Math.max(W, H));
    const gw = Math.max(2, Math.round(W * gs)), gh = Math.max(2, Math.round(H * gs));
    const ga = new Float32Array(gw * gh), gc = new Float32Array(gw * gh);
    const gxi = new Int32Array(W);
    for (let x = 0; x < W; x++) gxi[x] = Math.min(gw - 1, Math.floor((x * gw) / W));
    let x0 = W, y0 = H, x1 = -1, y1 = -1, sum = 0, mx = 0, my = 0;
    for (let y = 0; y < H; y++) {
      const gr = Math.min(gh - 1, Math.floor((y * gh) / H)) * gw;
      let i = y * W * 4 + 3, rowHit = false;
      for (let x = 0; x < W; x++, i += 4) {
        const g = gr + gxi[x];
        gc[g]++;
        const a = S[i];
        if (a > 8) {
          ga[g] += a; sum += a; mx += a * x; my += a * y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          rowHit = true;
        }
      }
      if (rowHit) { if (y < y0) y0 = y; y1 = y; }
    }
    let gsum = 0;
    for (let i = 0; i < ga.length; i++) { ga[i] = gc[i] ? ga[i] / (gc[i] * 255) : 0; gsum += ga[i]; }
    const empty = x1 < 0;
    // inside distance to the subject's edge, on the grid (two-pass chamfer). The image border is not an edge.
    const INF = 1e9, dt = new Float32Array(gw * gh);
    for (let i = 0; i < dt.length; i++) dt[i] = ga[i] >= 0.5 ? INF : 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x; let v = dt[i];
      if (v === 0) continue;
      if (x > 0 && dt[i - 1] + 1 < v) v = dt[i - 1] + 1;
      if (y > 0) {
        if (dt[i - gw] + 1 < v) v = dt[i - gw] + 1;
        if (x > 0 && dt[i - gw - 1] + 1.4142 < v) v = dt[i - gw - 1] + 1.4142;
        if (x < gw - 1 && dt[i - gw + 1] + 1.4142 < v) v = dt[i - gw + 1] + 1.4142;
      }
      dt[i] = v;
    }
    let maxEdt = 0;
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x; let v = dt[i];
      if (v === 0) continue;
      if (x < gw - 1 && dt[i + 1] + 1 < v) v = dt[i + 1] + 1;
      if (y < gh - 1) {
        if (dt[i + gw] + 1 < v) v = dt[i + gw] + 1;
        if (x < gw - 1 && dt[i + gw + 1] + 1.4142 < v) v = dt[i + gw + 1] + 1.4142;
        if (x > 0 && dt[i + gw - 1] + 1.4142 < v) v = dt[i + gw - 1] + 1.4142;
      }
      if (v >= INF / 2) v = Math.max(gw, gh); // the subject fills the image: no edge anywhere
      dt[i] = v;
      if (v > maxEdt) maxEdt = v;
    }
    return {
      W, H, subject: S, plate: src.plate || null, empty,
      bbox: empty ? { x0: 0, y0: 0, x1: W, y1: H } : { x0, y0, x1: x1 + 1, y1: y1 + 1 },
      cx: empty ? W / 2 : mx / sum + 0.5, cy: empty ? H / 2 : my / sum + 0.5,
      // subject unit: the square root of the subject's area, measured on the grid so it barely moves with resolution
      unit: Math.max(2, Math.sqrt(gsum * (W / gw) * (H / gh))),
      gw, gh, ga, edt: dt, maxEdt: Math.max(1, maxEdt), cache: {},
    };
  }

  // Direction with the most room for the particles to fly into: the emptier side, or up when
  // the subject fills the width.
  function autoAngle(ctx) {
    if (ctx.empty) return DEFAULTS.angle;
    const b = ctx.bbox, u = ctx.unit;
    const left = b.x0 / u, right = (ctx.W - b.x1) / u, up = b.y0 / u;
    const side = Math.max(left, right);
    if (side < 0.35 && up > 0.35 && up > side * 1.5) return -90;
    return right >= left ? 0 : 180;
  }

  // Where the dispersion starts: the subject's leading edge along the direction of travel.
  function leadPoint(ctx, angle, pattern) {
    if (ctx.empty || pattern === 'edges') return { x: ctx.cx, y: ctx.cy };
    const key = 'lead|' + angle.toFixed(2);
    if (ctx.cache.leadKey === key) return ctx.cache.lead;
    const { gw, gh, ga, W, H } = ctx;
    const dx = Math.cos((angle * Math.PI) / 180), dy = Math.sin((angle * Math.PI) / 180);
    const kx = W / gw, ky = H / gh;
    let mn = Infinity, mxp = -Infinity;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      if (ga[y * gw + x] < 0.5) continue;
      const p = (x + 0.5) * kx * dx + (y + 0.5) * ky * dy;
      if (p < mn) mn = p;
      if (p > mxp) mxp = p;
    }
    // Straight ahead of the subject's middle, as far as the subject reaches. (The furthest pixel
    // itself is often an odd corner, such as the foot of a plinth.)
    let res = { x: ctx.cx, y: ctx.cy };
    if (mxp > mn) {
      const ahead = mxp - (ctx.cx * dx + ctx.cy * dy);
      res = { x: clamp(ctx.cx + dx * ahead, 0, W), y: clamp(ctx.cy + dy * ahead, 0, H) };
    }
    ctx.cache.leadKey = key; ctx.cache.lead = res;
    return res;
  }

  // Works out the direction, start point and scale for a render. `ref` (from an earlier render,
  // usually the preview) pins them so a render at another resolution lays out identically.
  function resolve(ctx, st, ref) {
    const W = ctx.W, H = ctx.H, m = Math.max(W, H);
    if (ref) {
      return {
        angle: ref.angle, ox: ref.ox * W, oy: ref.oy * H, unit: ref.unitN * m, cx: ref.cx * W, cy: ref.cy * H,
        bbox: { x0: ref.bx0 * W, y0: ref.by0 * H, x1: ref.bx1 * W, y1: ref.by1 * H }, ref,
      };
    }
    const angle = st.autoAngle ? autoAngle(ctx) : st.angle;
    let ox, oy;
    if (st.autoOrigin) { const o = leadPoint(ctx, angle, st.pattern); ox = o.x; oy = o.y; } else { ox = st.originX * W; oy = st.originY * H; }
    const b = ctx.bbox;
    return {
      angle, ox, oy, unit: ctx.unit, cx: ctx.cx, cy: ctx.cy, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
      ref: { angle, ox: ox / W, oy: oy / H, unitN: ctx.unit / m, cx: ctx.cx / W, cy: ctx.cy / H, bx0: b.x0 / W, by0: b.y0 / H, bx1: b.x1 / W, by1: b.y1 / H },
    };
  }

  // ---------------------------------------------------------------------------
  // Fields on the analysis grid
  // ---------------------------------------------------------------------------
  // Progress field: 1 where the dispersion starts, falling to 0 at the part of the subject it reaches last.
  function progressField(ctx, st, rs) {
    const key = st.pattern + '|' + rs.angle.toFixed(2) + '|' + rs.ox.toFixed(1) + '|' + rs.oy.toFixed(1);
    if (ctx.cache.progKey === key) return ctx.cache.prog;
    const { gw, gh, ga, W, H } = ctx;
    const T = new Float32Array(gw * gh);
    const kx = W / gw, ky = H / gh;
    if (st.pattern === 'edges') {
      for (let i = 0; i < T.length; i++) T[i] = 1 - ctx.edt[i] / ctx.maxEdt;
      ctx.cache.progFar = ctx.maxEdt * kx;
    } else if (st.pattern === 'point') {
      let far = 0;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const d = Math.hypot((x + 0.5) * kx - rs.ox, (y + 0.5) * ky - rs.oy);
        T[y * gw + x] = d;
        if (ga[y * gw + x] >= 0.5 && d > far) far = d;
      }
      far = Math.max(far, ctx.unit * 0.1);
      ctx.cache.progFar = far;
      for (let i = 0; i < T.length; i++) T[i] = clamp(1 - T[i] / far, 0, 1);
    } else {
      const dx = Math.cos((rs.angle * Math.PI) / 180), dy = Math.sin((rs.angle * Math.PI) / 180);
      const po = rs.ox * dx + rs.oy * dy;
      let far = 0;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const d = po - ((x + 0.5) * kx * dx + (y + 0.5) * ky * dy); // how far behind the start point
        T[y * gw + x] = d;
        if (ga[y * gw + x] >= 0.5 && d > far) far = d;
      }
      far = Math.max(far, ctx.unit * 0.1);
      ctx.cache.progFar = far;
      for (let i = 0; i < T.length; i++) T[i] = clamp(1 - T[i] / far, 0, 1);
    }
    ctx.cache.progKey = key; ctx.cache.prog = T;
    return T;
  }

  // Paint field: +1 where the user painted "disperse", -1 where they painted "protect", 0 elsewhere.
  function paintField(ctx, strokes) {
    if (!strokes || !strokes.length) { ctx.cache.paintKey = ''; ctx.cache.paint = null; return null; }
    let h = strokes.length;
    for (let s = 0; s < strokes.length; s++) {
      const k = strokes[s], p = k.pts;
      h = (Math.imul(h, 31) + p.length + k.mode.length * 7 + Math.round(k.size * 1e4) + Math.round(k.hard * 100) + Math.round((k.flow == null ? 1 : k.flow) * 1000) * 13) | 0;
      for (let j = 0; j < p.length; j++) h = (Math.imul(h, 31) + Math.round(p[j] * 1e5)) | 0;
    }
    const key = String(h);
    if (ctx.cache.paintKey === key) return ctx.cache.paint;
    const { gw, gh } = ctx;
    const P = new Float32Array(gw * gh);
    const gm = Math.max(gw, gh);
    for (let s = 0; s < strokes.length; s++) {
      const k = strokes[s], p = k.pts;
      const r = Math.max(0.75, (k.size * gm) / 2), hard = Math.min(0.98, k.hard);
      // coverage of this stroke over its bounding box (maximum of the brush dabs, so overlaps don't build up)
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let j = 0; j < p.length; j += 2) {
        const x = p[j] * gw, y = p[j + 1] * gh;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
      const cx0 = Math.max(0, Math.floor(bx0 - r - 1)), cy0 = Math.max(0, Math.floor(by0 - r - 1));
      const cx1 = Math.min(gw - 1, Math.ceil(bx1 + r + 1)), cy1 = Math.min(gh - 1, Math.ceil(by1 + r + 1));
      if (cx1 < cx0 || cy1 < cy0) continue;
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
      const C = new Float32Array(cw * ch);
      const dab = (x, y) => {
        const ax0 = Math.max(cx0, Math.floor(x - r)), ax1 = Math.min(cx1, Math.ceil(x + r));
        const ay0 = Math.max(cy0, Math.floor(y - r)), ay1 = Math.min(cy1, Math.ceil(y + r));
        for (let yy = ay0; yy <= ay1; yy++) for (let xx = ax0; xx <= ax1; xx++) {
          const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / r;
          if (d >= 1) continue;
          const f = d <= hard ? 1 : 1 - sstep(hard, 1, d);
          const ci = (yy - cy0) * cw + (xx - cx0);
          if (f > C[ci]) C[ci] = f;
        }
      };
      const step = Math.max(0.5, r * 0.25);
      let px = p[0] * gw, py = p[1] * gh;
      dab(px, py);
      for (let j = 2; j < p.length; j += 2) {
        const x = p[j] * gw, y = p[j + 1] * gh;
        const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / step));
        for (let q = 1; q <= n; q++) dab(px + ((x - px) * q) / n, py + ((y - py) * q) / n);
        px = x; py = y;
      }
      const target = k.mode === 'add' ? 1 : k.mode === 'protect' ? -1 : 0, flow = k.flow == null ? 1 : k.flow;
      for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
        const f = C[yy * cw + xx] * flow;
        if (!f) continue;
        const gi = (yy + cy0) * gw + xx + cx0;
        P[gi] += (target - P[gi]) * f;
      }
    }
    ctx.cache.paintKey = key; ctx.cache.paint = P;
    return P;
  }

  // Lets every value in F reach its neighbours, losing `s` per cell on the way: a painted region
  // gains a slope that falls to nothing 1 / s cells beyond its edge.
  function spread(F, w, h, s) {
    const d = s * 1.41421;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      let v = F[i];
      if (x > 0 && F[i - 1] - s > v) v = F[i - 1] - s;
      if (y > 0) {
        if (F[i - w] - s > v) v = F[i - w] - s;
        if (x > 0 && F[i - w - 1] - d > v) v = F[i - w - 1] - d;
        if (x < w - 1 && F[i - w + 1] - d > v) v = F[i - w + 1] - d;
      }
      F[i] = v;
    }
    for (let y = h - 1, i = w * h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--, i--) {
      let v = F[i];
      if (x < w - 1 && F[i + 1] - s > v) v = F[i + 1] - s;
      if (y < h - 1) {
        if (F[i + w] - s > v) v = F[i + w] - s;
        if (x < w - 1 && F[i + w + 1] - d > v) v = F[i + w + 1] - d;
        if (x > 0 && F[i + w - 1] - d > v) v = F[i + w - 1] - d;
      }
      F[i] = v;
    }
  }
  // The paint as two levels, each 0…1 on the grid: `add` (painted "disperse") and `keep` (painted
  // "protect"), either of them null if there is none. Both fade out over `bw` pixels beyond the edge
  // of the paint, so that the effect tapers off there instead of stopping at a line.
  function paintLevels(ctx, P, bw) {
    if (!P) { ctx.cache.levelKey = ''; ctx.cache.levels = null; return null; }
    const { gw, gh } = ctx, n = gw * gh;
    const s = bw > 0 ? ctx.W / gw / bw : 1;
    const key = ctx.cache.paintKey + '|' + s.toFixed(5);
    if (ctx.cache.levelKey === key) return ctx.cache.levels;
    let add = null, keep = null;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (p > 0.004) { if (!add) add = new Float32Array(n); add[i] = p; }
      else if (p < -0.004) { if (!keep) keep = new Float32Array(n); keep[i] = -p; }
    }
    if (s < 1) { if (add) spread(add, gw, gh, s); if (keep) spread(keep, gw, gh, s); }
    ctx.cache.levelKey = key; ctx.cache.levels = add || keep ? { add, keep } : null;
    return ctx.cache.levels;
  }

  // ---------------------------------------------------------------------------
  // Brush tips: the shapes the subject is broken into
  // ---------------------------------------------------------------------------
  // A tip is drawn from a formula, not a picture, so it is sharp at any size. Its outline is a
  // radius for every direction (a "profile"); on top of that it can be stretched, given droplets
  // around it, a soft edge, or a dry-brush grain. Each tip comes in several variants so that
  // no two pieces need look the same.
  const TIP_K = 96, TIP_VARIANTS = 8, TIP_AREA = Math.PI * 0.75 * 0.75;
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const wrapAngle = (a) => ((a % TAU) + TAU) % TAU;
  // outline of a polygon given as [angle, radius] corners
  function polyProfile(pts) {
    pts = pts.map((p) => [wrapAngle(p[0]), p[1]]).sort((a, b) => a[0] - b[0]);
    const prof = new Float32Array(TIP_K), n = pts.length;
    for (let k = 0; k < TIP_K; k++) {
      const th = (k / TIP_K) * TAU;
      let j = 0;
      while (j < n && pts[j][0] <= th) j++;
      const a = pts[(j - 1 + n) % n], b = pts[j % n];
      const ta = j === 0 ? a[0] - TAU : a[0], tb = j === n ? b[0] + TAU : b[0];
      const den = a[1] * Math.sin(th - ta) + b[1] * Math.sin(tb - th);
      prof[k] = den > 1e-6 ? (a[1] * b[1] * Math.sin(tb - ta)) / den : Math.min(a[1], b[1]);
    }
    return prof;
  }
  function funcProfile(fn) {
    const prof = new Float32Array(TIP_K);
    for (let k = 0; k < TIP_K; k++) prof[k] = Math.max(0.05, fn((k / TIP_K) * TAU));
    return prof;
  }
  const ringPoly = (r, n, jitter, lo, hi) => { const p = []; for (let i = 0; i < n; i++) p.push([((i + (r() - 0.5) * jitter) / n) * TAU, lo + (hi - lo) * r()]); return p; };
  // roughen an outline; the noise is read round a circle so it joins up
  const roughen = (prof, amount, freq, seed) => { for (let k = 0; k < TIP_K; k++) { const th = (k / TIP_K) * TAU; prof[k] *= 1 + amount * (vnoise(Math.cos(th) * freq + 31.7, Math.sin(th) * freq + 12.3, seed) * 2 - 1); } return prof; };
  const lobes = (r, base, amps) => { const ph = amps.map(() => r() * TAU); return funcProfile((th) => base + amps.reduce((s, a, i) => s + a * Math.sin((i + 2) * th + ph[i]), 0)); };
  const droplets = (r, n, d0, d1, r0, r1) => { const s = []; for (let i = 0; i < n; i++) { const a = r() * TAU, d = d0 + (d1 - d0) * r(); s.push(Math.cos(a) * d, Math.sin(a) * d, r0 + (r1 - r0) * r()); } return s; };

  const TIPS = [
    { id: 'chip', label: 'Chips', kind: 'natural', make: (r) => ({ prof: polyProfile(ringPoly(r, 5 + Math.floor(r() * 3), 0.7, 0.6, 1)) }) },
    { id: 'flake', label: 'Flakes', kind: 'natural', make: (r) => ({ prof: roughen(polyProfile(ringPoly(r, 6 + Math.floor(r() * 4), 0.8, 0.55, 1)), 0.2, 2.6, Math.floor(r() * 1e6)) }) },
    { id: 'crumb', label: 'Crumbs', kind: 'natural', make: (r) => ({ prof: lobes(r, 0.75, [0.15, 0.09, 0.05, 0.04]) }) },
    { id: 'splat', label: 'Splatter', kind: 'natural', make: (r) => {
      const spikes = []; for (let i = 0, n = 3 + Math.floor(r() * 4); i < n; i++) spikes.push([r() * TAU, 0.25 + 0.45 * r(), 0.12 + 0.14 * r()]);
      const prof = funcProfile((th) => 0.55 + spikes.reduce((s, k) => { let d = Math.abs(th - k[0]); if (d > Math.PI) d = TAU - d; return s + k[1] * Math.exp(-(d * d) / (k[2] * k[2])); }, 0));
      return { prof: roughen(prof, 0.08, 3, Math.floor(r() * 1e6)), sats: droplets(r, 3 + Math.floor(r() * 5), 1.0, 1.75, 0.05, 0.19) };
    } },
    { id: 'grit', label: 'Grit', kind: 'natural', make: (r) => ({ prof: lobes(r, 0.34, [0.07, 0.04]), sats: droplets(r, 5 + Math.floor(r() * 5), 0.45, 1.3, 0.1, 0.27) }) },
    { id: 'ash', label: 'Ash', kind: 'natural', make: (r) => ({ prof: roughen(polyProfile(ringPoly(r, 7 + Math.floor(r() * 3), 0.9, 0.5, 1)), 0.28, 3.4, Math.floor(r() * 1e6)), grain: { t: 0.36, fu: 2.6, fw: 2.6, seed: Math.floor(r() * 1e6) }, feather: 0.12 }) },
    { id: 'sliver', label: 'Slivers', kind: 'natural', make: (r) => ({ prof: polyProfile([[0, 1], [Math.PI * (0.42 + 0.16 * r()), 0.5 + 0.2 * r()], [Math.PI, 0.8 + 0.2 * r()], [Math.PI * (1.42 + 0.16 * r()), 0.5 + 0.2 * r()]]), ax: 5 + 5 * r() }) },
    { id: 'drybrush', label: 'Dry brush', kind: 'natural', make: (r) => ({ prof: roughen(polyProfile([[0.5, 1], [Math.PI - 0.5, 1], [Math.PI + 0.5, 1], [TAU - 0.5, 1]]), 0.16, 4, Math.floor(r() * 1e6)), ax: 2.4 + 2 * r(), grain: { t: 0.4, fu: 0.9, fw: 7, seed: Math.floor(r() * 1e6) } }) },
    { id: 'petal', label: 'Petals', kind: 'natural', make: (r) => { const k = 1.2 + r(); return { prof: funcProfile((th) => 0.42 + 0.58 * Math.pow((1 + Math.cos(th)) / 2, k)), ax: 1.2 + 0.5 * r() }; } },
    { id: 'smoke', label: 'Smoke', kind: 'natural', make: (r) => ({ prof: lobes(r, 1, [0.14, 0.1, 0.06]), soft: 0.9, scale: 1.7 }) },
    { id: 'dust', label: 'Dust', kind: 'natural', make: () => ({ prof: funcProfile(() => 1), soft: 1, scale: 0.8 }) },
    { id: 'shard', label: 'Shards', kind: 'geometric', make: (r) => { const a = r() * TAU; return { prof: polyProfile([[a, 0.6 + 0.4 * r()], [a + TAU / 3 + (r() - 0.5) * 1.1, 0.45 + 0.55 * r()], [a + (2 * TAU) / 3 + (r() - 0.5) * 1.1, 0.45 + 0.55 * r()]]) }; } },
    { id: 'square', label: 'Squares', kind: 'geometric', make: (r) => ({ prof: polyProfile([[Math.PI / 4, 1], [(3 * Math.PI) / 4, 1], [(5 * Math.PI) / 4, 1], [(7 * Math.PI) / 4, 1]]), ax: 1 + 0.3 * r() }) },
    { id: 'dot', label: 'Dots', kind: 'geometric', make: () => ({ prof: funcProfile(() => 1) }) },
  ];
  const DEFAULT_TIPS = { chip: 0.35, flake: 0.3, splat: 0.12, grit: 0.13, shard: 0.1 };
  // the single-shape setting of earlier versions
  const LEGACY_SHAPES = { mixed: { shard: 0.5, square: 0.35, dot: 0.15 }, shard: { shard: 1 }, square: { square: 1 }, dot: { dot: 1 }, dust: { dust: 1 } };

  // fills in the derived numbers of a variant and scales it so every tip covers about the same area
  function finishVariant(v) {
    v.soft = v.soft || 0; v.scale = v.scale || 1; v.feather = v.feather || 0;
    v.sats = v.sats || null; v.grain = v.grain || null;
    if (!v.soft) {
      let area = 0;
      for (let k = 0; k < TIP_K; k++) area += (v.prof[k] * v.prof[k] * TAU) / TIP_K / 2;
      if (v.sats) for (let i = 0; i < v.sats.length; i += 3) area += Math.PI * v.sats[i + 2] * v.sats[i + 2];
      const k = Math.sqrt(TIP_AREA / area);
      for (let j = 0; j < TIP_K; j++) v.prof[j] *= k;
      if (v.sats) for (let i = 0; i < v.sats.length; i++) v.sats[i] *= k;
    }
    v.sx = Math.sqrt(v.ax || 1); v.isx = 1 / v.sx;
    let ext = 0;
    for (let k = 0; k < TIP_K; k++) if (v.prof[k] > ext) ext = v.prof[k];
    ext *= v.sx;
    if (v.sats) for (let i = 0; i < v.sats.length; i += 3) ext = Math.max(ext, Math.hypot(v.sats[i], v.sats[i + 1]) + v.sats[i + 2]);
    v.ext = ext;
    // how far it reaches along and across itself: a tight box for long thin tips
    let mp = 0;
    for (let k = 0; k < TIP_K; k++) if (v.prof[k] > mp) mp = v.prof[k];
    v.eu = mp * v.sx; v.ew = mp * v.isx;
    if (v.sats) for (let i = 0; i < v.sats.length; i += 3) { v.eu = Math.max(v.eu, Math.abs(v.sats[i]) + v.sats[i + 2]); v.ew = Math.max(v.ew, Math.abs(v.sats[i + 1]) + v.sats[i + 2]); }
    return v;
  }
  const tipCache = {};
  let customTips = {}; // id → { label, variants: [bitmap variant] }
  function tipVariants(id) {
    if (customTips[id]) return customTips[id].variants;
    if (tipCache[id]) return tipCache[id];
    const def = TIPS.find((t) => t.id === id);
    if (!def) return null;
    let h = 7;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    const list = [];
    for (let i = 0; i < TIP_VARIANTS; i++) list.push(finishVariant(def.make(rng(h + i * 7919 + 1))));
    return (tipCache[id] = list);
  }
  // Every tip that can be used: the built-in ones, then the user's own.
  function tipList() {
    const out = TIPS.map((t) => ({ id: t.id, label: t.label, kind: t.kind }));
    for (const id in customTips) out.push({ id, label: customTips[id].label, kind: 'custom' });
    return out;
  }
  // The user's own tips: [{ id, label, n, data }] where data is n×n coverage (0…255).
  function setCustomTips(list) {
    customTips = {};
    (list || []).forEach((t) => {
      if (!t || !t.id || !t.data || t.data.length !== t.n * t.n) return;
      let sum = 0;
      for (let i = 0; i < t.data.length; i++) sum += t.data[i];
      const cover = sum / 255 / t.data.length; // share of the square that is covered
      if (cover <= 0) return;
      const k = clamp(Math.sqrt(TIP_AREA / (4 * cover)), 0.75, 2.5); // so it covers about what the built-in tips do
      customTips[t.id] = { label: t.label || 'My tip', variants: [{ bmp: t.data, n: t.n, k, ext: k * Math.SQRT2, eu: k, ew: k, soft: 0, scale: 1, feather: 0 }] };
    });
  }
  // Turns a mask (a selection, say) into a custom tip: cropped to what is in it, squared up and
  // shrunk to at most 96 pixels. Returns { n, data } or null if the mask is empty.
  function tipFromMask(mask, W, H) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, side = Math.max(w, h), n = Math.max(8, Math.min(96, side));
    const ox = x0 - (side - w) / 2, oy = y0 - (side - h) / 2, data = new Uint8Array(n * n), step = side / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      // average the mask pixels this cell covers
      const sx0 = Math.floor(ox + i * step), sx1 = Math.max(sx0 + 1, Math.floor(ox + (i + 1) * step));
      const sy0 = Math.floor(oy + j * step), sy1 = Math.max(sy0 + 1, Math.floor(oy + (j + 1) * step));
      let s = 0, c = 0;
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) { c++; if (x >= 0 && y >= 0 && x < W && y < H) s += mask[y * W + x]; }
      data[j * n + i] = c ? s / c : 0;
    }
    return { n, data };
  }

  // Turns a picture (RGBA) into a custom tip, the way Photoshop defines a brush. If the picture has
  // transparency, its shape is the tip. If it is opaque, its dark parts are: black on white gives
  // a solid tip, greys a partly see-through one. Returns { n, data, from } or null if there is no shape.
  function tipFromImage(rgba, W, H) {
    const n = W * H, mask = new Uint8Array(n);
    let clear = 0;
    for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 250) clear++;
    let from = 'alpha';
    if (clear > n * 0.02) {
      for (let i = 0; i < n; i++) mask[i] = rgba[i * 4 + 3];
    } else {
      from = 'dark';
      let lo = 255, hi = 0;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const d = 255 - (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114);
        mask[i] = d;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      if (hi - lo < 24) return null; // one flat colour
      // the lightest tone becomes "nothing", the darkest "solid"
      for (let i = 0; i < n; i++) mask[i] = ((mask[i] - lo) * 255) / (hi - lo);
    }
    const tip = tipFromMask(mask, W, H);
    if (tip) tip.from = from;
    return tip;
  }

  // Coverage (0…1) of a tip variant at (u, w), in tip units (the tip is about 1 across from its
  // middle). inv: pixels per tip unit, for a one-pixel anti-aliased edge. fe: extra feather, in tip units.
  function tipAlpha(v, u, w, inv, fe) {
    if (v.bmp) {
      const n = v.n, fx = (u / v.k + 1) * 0.5 * n - 0.5, fy = (w / v.k + 1) * 0.5 * n - 0.5;
      if (fx <= -1 || fy <= -1 || fx >= n || fy >= n) return 0;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, b = v.bmp;
      const g = (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? 0 : b[y * n + x]);
      return (lerp(lerp(g(x0, y0), g(x0 + 1, y0), tx), lerp(g(x0, y0 + 1), g(x0 + 1, y0 + 1), tx), ty)) / 255;
    }
    // The outline is read from a table (see tipTable): working it out for every pixel of every
    // piece was most of the time a render took.
    const T = v.tab || tipTable(v);
    if (!T.F) return tipAlphaExact(v, u, w, inv, fe);
    const gx = (u + T.mu) * T.su, gy = (w + T.mw) * T.sw;
    if (gx < 0 || gy < 0 || gx >= T.n1 || gy >= T.n1) return 0;
    const x0 = gx | 0, y0 = gy | 0, tx = gx - x0, ty = gy - y0, F = T.F, i = y0 * T.N + x0;
    const top = F[i] + (F[i + 1] - F[i]) * tx, bot = F[i + T.N] + (F[i + T.N + 1] - F[i + T.N]) * tx;
    const val = top + (bot - top) * ty;
    let a;
    if (v.soft) { a = val / v.soft; a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a); }
    else {
      // Only clear cases are taken from the table: well inside the outline or well outside it. A
      // pixel on the anti-aliased edge is worked out exactly.
      const half = (1 + (fe + v.feather) * inv) / (2 * inv), err = T.E[i]; // how far either side of the outline the edge reaches
      if (val - err >= half) a = 1;
      else if (val + err <= -half) return 0;
      else return tipAlphaExact(v, u, w, inv, fe);
    }
    if (a > 0 && v.grain) { const g = v.grain; a *= sstep(g.t - 0.1, g.t + 0.1, vnoise(u * g.fu + 17.3, w * g.fw + 5.1, g.seed)); }
    return a;
  }
  // A tip's outline as a field on a grid over its box, from which tipAlpha reads the coverage at
  // any size: for a hard tip how far inside the outline (or a droplet) a point is, in tip units;
  // for a soft one 1 - distance / radius. `err` bounds how far a value read between the grid
  // points can be from the exact one (the steepest slope in the table times a cell's diagonal).
  // The box has room for the widest feather.
  const TAB_N = 128;
  function tipTable(v) {
    if (v.soft && v.sats) return (v.tab = {});
    const N = TAB_N, F = new Float32Array(N * N);
    const mu = v.eu + 0.6 * Math.max(1, v.sx), mw = v.ew + 0.6 * Math.max(1, v.isx);
    for (let j = 0; j < N; j++) {
      const w = -mw + (j / (N - 1)) * 2 * mw;
      for (let i = 0; i < N; i++) {
        const u = -mu + (i / (N - 1)) * 2 * mu;
        const x = u * v.isx, y = w * v.sx, rho = Math.sqrt(x * x + y * y);
        let ang = Math.atan2(y, x);
        if (ang < 0) ang += TAU;
        const f = ang * (TIP_K / TAU), k0 = f | 0, p0 = v.prof[k0 % TIP_K], r = p0 + (v.prof[(k0 + 1) % TIP_K] - p0) * (f - k0);
        let val = v.soft ? 1 - rho / r : r - rho;
        const s = v.sats;
        if (s) for (let q = 0; q < s.length; q += 3) {
          const d = s[q + 2] - Math.sqrt((u - s[q]) * (u - s[q]) + (w - s[q + 1]) * (w - s[q + 1]));
          if (d > val) val = d;
        }
        F[j * N + i] = val;
      }
    }
    // the steepest slope at each grid point, then for each cell the steepest one in and around it
    const cu = (2 * mu) / (N - 1), cw = (2 * mw) / (N - 1), diag = Math.hypot(cu, cw);
    const S = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let s = 0;
      if (i > 0) s = Math.max(s, Math.abs(F[k] - F[k - 1]) / cu);
      if (i < N - 1) s = Math.max(s, Math.abs(F[k + 1] - F[k]) / cu);
      if (j > 0) s = Math.max(s, Math.abs(F[k] - F[k - N]) / cw);
      if (j < N - 1) s = Math.max(s, Math.abs(F[k + N] - F[k]) / cw);
      S[k] = s;
    }
    const E = new Float32Array(N * N);
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      let s = 0;
      for (let b = Math.max(0, j - 1); b <= Math.min(N - 1, j + 2); b++) for (let a = Math.max(0, i - 1); a <= Math.min(N - 1, i + 2); a++) if (S[b * N + a] > s) s = S[b * N + a];
      E[j * N + i] = s * 1.5 * diag;
    }
    return (v.tab = { N, n1: N - 1, F, E, mu, mw, su: (N - 1) / (2 * mu), sw: (N - 1) / (2 * mw) });
  }
  function tipAlphaExact(v, u, w, inv, fe) {
    const x = u * v.isx, y = w * v.sx, rho = Math.sqrt(x * x + y * y);
    let ang = Math.atan2(y, x);
    if (ang < 0) ang += TAU;
    const f = ang * (TIP_K / TAU), k0 = f | 0, p0 = v.prof[k0 % TIP_K], r = p0 + (v.prof[(k0 + 1) % TIP_K] - p0) * (f - k0);
    const wpx = 1 + (fe + v.feather) * inv; // edge width in pixels
    let a;
    if (v.soft) { a = (1 - rho / r) / v.soft; a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a); }
    else { a = ((r - rho) * inv) / wpx + 0.5; a = a <= 0 ? 0 : a >= 1 ? 1 : a; }
    const s = v.sats;
    if (s) for (let i = 0; i < s.length; i += 3) {
      const d = Math.sqrt((u - s[i]) * (u - s[i]) + (w - s[i + 1]) * (w - s[i + 1]));
      let as = ((s[i + 2] - d) * inv) / wpx + 0.5;
      if (as > a) a = as > 1 ? 1 : as;
    }
    if (a > 0 && v.grain) { const g = v.grain; a *= sstep(g.t - 0.1, g.t + 0.1, vnoise(u * g.fu + 17.3, w * g.fw + 5.1, g.seed)); }
    return a;
  }
  // A small picture of a tip for a list: n×n coverage (0…255).
  function tipPreview(id, n) {
    const vs = tipVariants(id), out = new Uint8Array(n * n);
    if (!vs) return out;
    const v = vs[0], half = v.ext * 1.08, inv = n / 2 / half;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = tipAlpha(v, ((x + 0.5) / n * 2 - 1) * half, ((y + 0.5) / n * 2 - 1) * half, inv, 0) * 255;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Erosion: which parts of the subject have gone
  // ---------------------------------------------------------------------------
  // The subject does not fade away: it is broken into pieces, each cut with a brush tip. A piece
  // that has left takes a tip-shaped bite out of the subject's mask and flies off as a particle
  // of exactly that shape, so every hole has its piece.
  //
  // "Depth" says how long ago the dispersion front passed a spot, in band widths: below 0 it has
  // not arrived; from 0 to 1 pieces are leaving one by one; from 1 to FRONT every piece has left
  // and only the scraps between their bites remain; beyond FRONT the mask is simply solid.
  //
  // Returns a sampler: at(x, y) (pixel coordinates, pixel centres at +0.5) gives the depth and
  // leaves in .age how early that spot went (1 = first) and in .calm how freely its pieces may
  // leave (1 = as the settings say; towards 0, near the edge of paint, they are smaller and stay
  // closer). It is worked out from the grid fields and noise alone, so it answers the same at any
  // resolution.
  //
  // Paint works on the same scale. "Disperse" paint gives a depth of its own that grows with how
  // strongly a spot is painted; "protect" paint puts a ceiling on the depth, down to nothing where
  // it is solid. Since both fade out beyond their edges (paintLevels), so does the dispersion.
  const FRONT = 1.5;
  // The sampler's numbers (also handed to the WebAssembly engine, which works them out no differently).
  function samplerParams(ctx, st, rs, T) {
    const { W, H, gw, gh } = ctx;
    const auto = !!(st.auto && st.amount > 0 && T);
    const R = st.roughness * 0.45;
    const baseSize = rs.unit * (0.006 + 0.085 * st.size * st.size);
    const band = clamp(Math.max(rs.unit * (0.03 + 0.3 * st.roughness), baseSize * 1.6) / rs.far, 0.01, 0.6); // band width, as a share of the subject
    const soft = 0.04 + st.softness * 0.5; // feather of the solid front, in band widths
    const theta = lerp(1 + R + 0.002, -R - band * (FRONT + soft) - 0.002, st.amount);
    // paint: a level of LOW is where pieces start to leave, a level of 1 is past the solid front
    const LOW = 0.1, DP = (FRONT + soft + 0.3) / (1 - LOW), Rp = 0.06 + st.roughness * 0.2;
    const nk = lerp(16, 2.2, st.chunk) / rs.unit;
    const seed = st.seed * 131 + 7;
    const sxg = gw / W, syg = gh / H, gxMax = gw - 1.001, gyMax = gh - 1.001;
    // far enough behind the front that the noise can no longer matter: gone, and among the first to go
    const deep = Math.max(0.45, band * (FRONT + 1.6)) + R + 0.001;
    return { auto, R, band, soft, theta, LOW, DP, Rp, nk, seed, sxg, syg, gxMax, gyMax, deep };
  }
  function makeSampler(ctx, st, rs, T, L) {
    const gw = ctx.gw;
    const { auto, R, band, soft, theta, LOW, DP, Rp, nk, seed, sxg, syg, gxMax, gyMax, deep } = samplerParams(ctx, st, rs, T);
    const ADD = L ? L.add : null, KEEP = L ? L.keep : null;
    const o = { age: 0, calm: 1, soft, hasProtect: !!KEEP, at: null, solid: null, protect: null };
    let t = 0, l = 0, g = 0;
    const fields = (x, y) => {
      let gxf = x * sxg - 0.5, gyf = y * syg - 0.5;
      gxf = gxf < 0 ? 0 : gxf > gxMax ? gxMax : gxf;
      gyf = gyf < 0 ? 0 : gyf > gyMax ? gyMax : gyf;
      const gx0 = gxf | 0, gy0 = gyf | 0, fx = gxf - gx0, fy = gyf - gy0, i0 = gy0 * gw + gx0, i1 = i0 + gw;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      t = auto ? T[i0] * w00 + T[i0 + 1] * w10 + T[i1] * w01 + T[i1 + 1] * w11 : 0;
      l = ADD ? ADD[i0] * w00 + ADD[i0 + 1] * w10 + ADD[i1] * w01 + ADD[i1 + 1] * w11 : 0;
      g = KEEP ? KEEP[i0] * w00 + KEEP[i0 + 1] * w10 + KEEP[i1] * w01 + KEEP[i1 + 1] * w11 : 0;
    };
    // the noise has its say across a fade, and none where the paint is solid or absent
    const ragged = (v) => (v >= 1 ? 0 : v > 0.75 ? (1 - v) * 4 : v < 0.25 ? v * 4 : 1);
    const FAINT = 0.04; // below this level paint does nothing, whatever the noise
    o.at = function (x, y) {
      fields(x, y);
      o.age = 0; o.calm = 1;
      const a = g > 0.004 ? 1 - g : 1; // what protect paint allows here
      if (a < FAINT) return -1;
      const mayAuto = auto && t + R > theta, mayPaint = l > FAINT;
      if (!mayAuto && !mayPaint) return -1;
      if (mayAuto && a === 1 && t - theta > deep) { o.age = 1; return (t - theta - R) / band; }
      const n2 = fbm(x * nk, y * nk, seed) * 2 - 1;
      let depth = -1, ag = 0, calm = 1;
      if (mayAuto) {
        const v = t + R * n2 - theta;
        if (v > 0) { depth = v / band; ag = clamp(v / 0.45, 0, 1); }
      }
      if (mayPaint) {
        const v = (l + Rp * n2 * ragged(l) - LOW) * DP;
        if (v > 0) {
          ag = Math.max(ag, 0.3 + 0.35 * (n2 + 1));
          if (v > depth) { calm = lerp(sstep(LOW, 0.9, l), 1, clamp(depth, 0, 1)); depth = v; }
        }
      }
      if (a < 1) {
        const cap = (a + Rp * n2 * ragged(a) - LOW) * DP;
        if (cap <= 0) return -1;
        if (cap < depth) depth = cap;
        calm = Math.min(calm, sstep(LOW, 0.9, a));
      }
      o.age = ag; o.calm = calm;
      return depth;
    };
    // how much of a spot at this depth the solid front has removed
    o.solid = (depth) => (depth >= FRONT + soft ? 1 : depth <= FRONT - soft ? 0 : sstep(FRONT - soft, FRONT + soft, depth));
    // The same for a spot, without working out the noise wherever it could not change the answer.
    const goneLo = (FRONT - soft) * band, goneHi = (FRONT + soft) * band;
    // (With paint about, only the spots that some paint reaches need the whole of at().)
    o.gone = function (x, y) {
      fields(x, y);
      if (l > FAINT || g > 0.004) {
        // the depth at() would give, for the lowest and the highest the noise can be
        const a = g > 0.004 ? 1 - g : 1;
        if (a < FAINT) return 0;
        let hi = -1, lo = -1;
        if (auto && t + R > theta) { hi = (t + R - theta) / band; lo = (t - R - theta) / band; }
        if (l > FAINT) { const rg = Rp * ragged(l); hi = Math.max(hi, (l + rg - LOW) * DP); lo = Math.max(lo, (l - rg - LOW) * DP); }
        if (a < 1) { const rg = Rp * ragged(a), cHi = (a + rg - LOW) * DP; if (cHi <= 0) return 0; hi = Math.min(hi, cHi); lo = Math.min(lo, (a - rg - LOW) * DP); }
        if (hi <= FRONT - soft) return 0;
        if (lo >= FRONT + soft) return 1;
        return o.solid(o.at(x, y));
      }
      if (!auto) return 0;
      const v = t - theta;
      if (v + R <= goneLo) return 0;
      if (v - R >= goneHi) return 1;
      return o.solid((v + R * (fbm(x * nk, y * nk, seed) * 2 - 1)) / band);
    };
    // 1 where nothing is protected, falling to 0 where the protect paint is solid
    o.protect = (x, y) => { fields(x, y); return g > 0.86 ? 1 - sstep(0.86, 0.98, g) : 1; };
    return o;
  }

  // The solid part of the erosion: everything the front has fully passed.
  function erodePass(ctx, smp, erode) {
    const W = ctx.W, S = ctx.subject, b = ctx.bbox;
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const i = y * W + x;
        if (S[i * 4 + 3] === 0) continue;
        const e = smp.gone(x + 0.5, y + 0.5);
        if (e > 0.004) erode[i] = e * 255 + 0.5;
      }
    }
  }
  // Keeps protected paint intact, whatever bit into it; returns the removed area in pixels.
  function finishErosion(ctx, smp, erode) {
    const W = ctx.W, H = ctx.H, S = ctx.subject;
    let sum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!erode[i]) continue;
      if (smp.hasProtect) erode[i] *= smp.protect(x + 0.5, y + 0.5);
      sum += erode[i] * S[i * 4 + 3];
    }
    return sum / 65025;
  }

  // ---------------------------------------------------------------------------
  // Stamps
  // ---------------------------------------------------------------------------
  const SMALL = 3; // pixels: below this a piece is drawn as a plain dot
  // Bites a tip-shaped hole out of the erosion map. h: half-size in pixels; fe: feather in tip units.
  function stampHole(erode, W, H, v, cx, cy, h, rot, fe) {
    const reach = h * (v.ext + fe) + 1.5;
    const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(W - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(H - 1, Math.ceil(cy + reach));
    if (x0 > x1 || y0 > y1) return;
    // behind the front everything around it has gone already, and there is nothing left to bite
    if (erode[y0 * W + x0] > 250 && erode[y0 * W + x1] > 250 && erode[y1 * W + x0] > 250 && erode[y1 * W + x1] > 250 && erode[((y0 + y1) >> 1) * W + ((x0 + x1) >> 1)] > 250) return;
    if (reach < 1.6) { // a speck: one pixel
      const i = (cy | 0) * W + (cx | 0), e = Math.min(255, 255 * h * h * 1.8);
      if (cx >= 0 && cy >= 0 && cx < W && cy < H && e > erode[i]) erode[i] = e;
      return;
    }
    if (h * v.ext < SMALL) { // too small for its outline to show: a disc of the same area (or a soft dot)
      const R = v.soft ? h * v.ext : h * 0.75;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy);
        let a;
        if (v.soft) { if (d2 >= R * R) continue; a = 1 - d2 / (R * R); a *= a; } else { a = R - Math.sqrt(d2) + 0.5; if (a <= 0) continue; if (a > 1) a = 1; }
        const i = y * W + x;
        if (a * 255 > erode[i]) erode[i] = a * 255;
      }
      return;
    }
    const c = Math.cos(rot) / h, s = Math.sin(rot) / h, eu = v.eu + fe + 1.5 / h, ew = v.ew + fe + 1.5 / h;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (erode[i] === 255) continue; // gone already: nothing to bite
        const dx = x + 0.5 - cx, u = dx * c + dy * s, w = -dx * s + dy * c;
        if (u > eu || u < -eu || w > ew || w < -ew) continue;
        const a = tipAlpha(v, u, w, h, fe) * 255;
        if (a > erode[i]) erode[i] = a;
      }
    }
  }
  // Draws a piece (straight-alpha "over" into an RGBA buffer). T: { buf, W, H, S, tex, br }.
  // (px, py), hd, rd: where it is now, its half-size and its turn. (sx, sy), hs, rsrc: where it was
  // cut from, so that it can carry that part of the picture with it.
  function stampPiece(T, v, px, py, hd, rd, sx, sy, hs, rsrc, r, g, b, alpha) {
    const W = T.W, H = T.H, buf = T.buf, S = T.S, tex = S ? T.tex : 0, br = T.br;
    const reach = hd * v.ext + 1.5;
    const x0 = Math.max(0, Math.floor(px - reach)), x1 = Math.min(W - 1, Math.ceil(px + reach));
    const y0 = Math.max(0, Math.floor(py - reach)), y1 = Math.min(H - 1, Math.ceil(py + reach));
    if (x0 > x1 || y0 > y1) return;
    if (reach < 1.6) { // a speck: one pixel
      const ix = px | 0, iy = py | 0;
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
      const i = (iy * W + ix) * 4, sa = alpha * Math.min(1, hd * hd * 1.8), da = buf[i + 3] / 255, oa = sa + da * (1 - sa);
      if (oa <= 0) return;
      const ks = sa / oa, kd = 1 - ks;
      buf[i] = r * ks + buf[i] * kd; buf[i + 1] = g * ks + buf[i + 1] * kd; buf[i + 2] = b * ks + buf[i + 2] * kd; buf[i + 3] = oa * 255;
      return;
    }
    if (hd * v.ext < SMALL) { // too small for its outline or its picture to show
      const R = v.soft ? hd * v.ext : hd * 0.75;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - px) * (x + 0.5 - px) + (y + 0.5 - py) * (y + 0.5 - py);
        let cov;
        if (v.soft) { if (d2 >= R * R) continue; cov = 1 - d2 / (R * R); cov *= cov; } else { cov = R - Math.sqrt(d2) + 0.5; if (cov <= 0) continue; if (cov > 1) cov = 1; }
        const i = (y * W + x) * 4, sa = alpha * cov, da = buf[i + 3] / 255, oa = sa + da * (1 - sa);
        const ks = sa / oa, kd = 1 - ks;
        buf[i] = r * ks + buf[i] * kd; buf[i + 1] = g * ks + buf[i + 1] * kd; buf[i + 2] = b * ks + buf[i + 2] * kd; buf[i + 3] = oa * 255;
      }
      return;
    }
    const c = Math.cos(rd) / hd, s = Math.sin(rd) / hd, eu = v.eu + 1.5 / hd, ew = v.ew + 1.5 / hd;
    const cs = Math.cos(rsrc) * hs, ss = Math.sin(rsrc) * hs;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - py;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px, u = dx * c + dy * s, w = -dx * s + dy * c;
        if (u > eu || u < -eu || w > ew || w < -ew) continue;
        const cov = tipAlpha(v, u, w, hd, 0);
        if (cov <= 0) continue;
        let cr = r, cg = g, cb = b;
        if (tex > 0) {
          const tx = (sx + u * cs - w * ss) | 0, ty = (sy + u * ss + w * cs) | 0;
          if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
            const ti = (ty * W + tx) * 4;
            if (S[ti + 3] > 60) { cr += (S[ti] * br - cr) * tex; cg += (S[ti + 1] * br - cg) * tex; cb += (S[ti + 2] * br - cb) * tex; }
          }
        }
        const i = (y * W + x) * 4, sa = alpha * cov, da = buf[i + 3] / 255, oa = sa + da * (1 - sa);
        const ks = sa / oa, kd = 1 - ks;
        buf[i] = cr * ks + buf[i] * kd; buf[i + 1] = cg * ks + buf[i + 1] * kd; buf[i + 2] = cb * ks + buf[i + 2] * kd; buf[i + 3] = oa * 255;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pieces: cut from the subject, thrown along the direction of travel
  // ---------------------------------------------------------------------------
  // Scatters candidate pieces over the subject. Each one that has left bites its hole out of
  // `erode` and, if `out` is given, is drawn as a particle. Returns counts.
  // which tips, and in what proportion: [{ vs (the tip's variants), upTo }] and the weights' total
  function tipMix(st) {
    const mix = [];
    let total = 0;
    for (const id in st.tips) { const vs = st.tips[id] > 0 ? tipVariants(id) : null; if (vs) { total += st.tips[id]; mix.push({ vs, upTo: total }); } }
    if (!mix.length) { mix.push({ vs: tipVariants('chip'), upTo: 1 }); total = 1; }
    return { mix, total };
  }
  // The numbers pieces() works with (also handed to the WebAssembly engine).
  function pieceParams(ctx, st, rs) {
    const unit = rs.unit, b = rs.bbox;
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const baseSize = unit * (0.006 + 0.085 * st.size * st.size), minSize = unit * 0.0035;
    // enough pieces to cover the subject about one and a half times over
    const v = st.sizeVar, meanSq = baseSize * baseSize * (1 - 0.34 * v + 0.57 * v * v);
    const M = Math.min(1500000, Math.ceil((1.6 * bw * bh) / (0.44 * meanSq)));
    const seed = st.seed * 7919 + 13;
    const a0 = (rs.angle * Math.PI) / 180;
    const bcx = st.pattern === 'point' ? rs.ox : rs.cx, bcy = st.pattern === 'point' ? rs.oy : rs.cy;
    const Dmax = unit * (0.25 + 3 * st.distance);
    const tk = lerp(5, 0.9, st.turbScale) / unit, turb = st.turbulence * 1.7;
    const STEPS = 6, trailN = Math.round(st.trail * 7);
    const keepDeep = lerp(0.03, 1, st.density * st.density); // share of the long-gone pieces that are shown
    const fe = st.softness * 0.35;
    return { bw, bh, baseSize, minSize, M, seed, a0, bcx, bcy, Dmax, tk, turb, STEPS, trailN, keepDeep, fe };
  }
  function pieces(ctx, st, rs, smp, erode, out) {
    const stats = { drawn: 0, holes: 0, matched: 0 };
    const W = ctx.W, H = ctx.H, S = ctx.subject, b = rs.bbox;
    const { bw, bh, baseSize, minSize, M, seed, a0, bcx, bcy, Dmax, tk, turb, STEPS, trailN, keepDeep, fe } = pieceParams(ctx, st, rs);
    if (bw <= 0 || bh <= 0) return stats;
    const { mix, total } = tipMix(st);
    const T = { buf: out, W, H, S, tex: st.texture, br: 1 };
    for (let i = 0; i < M; i++) {
      const sx = b.x0 + rnd(i, 0, seed) * bw, sy = b.y0 + rnd(i, 1, seed) * bh;
      const xi = sx | 0, yi = sy | 0;
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
      const pi = yi * W + xi, sa = S[pi * 4 + 3];
      if (sa < 16) continue;
      // has this piece left yet? Through the band they go one by one.
      const depth = smp.at(sx, sy);
      if (depth <= rnd(i, 2, seed)) continue;
      const aged = smp.age, calm = smp.calm;
      // its tip, size and turn
      const pick = rnd(i, 8, seed) * total;
      let m = 0;
      while (m < mix.length - 1 && pick >= mix[m].upTo) m++;
      const vs = mix[m].vs, tip = vs[Math.floor(rnd(i, 13, seed) * vs.length) % vs.length];
      let sz = baseSize * lerp(1, 0.18 + 2.6 * Math.pow(rnd(i, 6, seed), 3), st.sizeVar);
      if (calm < 1) sz *= 0.4 + 0.6 * calm; // smaller where paint holds the dispersion back
      if (sz < minSize) sz = minSize;
      const hs = (sz / 2) * tip.scale, rsrc = rnd(i, 9, seed) * TAU * st.spin;
      // the hole it leaves. Far behind the front the mask is solid anyway.
      const inBand = depth < FRONT + smp.soft;
      if (depth < FRONT + 1.6) stampHole(erode, W, H, tip, sx, sy, hs, rsrc, fe);
      if (inBand) stats.holes++;
      if (!out) continue;
      // pieces whose holes can still be seen are always shown; of the rest, as many as Density asks for
      const keep = lerp(1, keepDeep, sstep(FRONT + 0.2, FRONT + 1.4, depth));
      if (rnd(i, 14, seed) >= keep) continue;

      // how far, and which way: pieces that broke off first (high age) have gone furthest
      let tf = (0.15 + 0.85 * Math.pow(aged, 0.8)) * (0.22 + 0.78 * Math.pow(rnd(i, 3, seed), 1.2));
      if (calm < 1) tf *= 0.1 + 0.9 * calm; // … and not thrown as far
      const dist = Dmax * tf;
      const ang = a0 + (rnd(i, 4, seed) + rnd(i, 5, seed) - 1) * st.spread * 1.9;
      let vx = Math.cos(ang), vy = Math.sin(ang);
      if (st.burst > 0) {
        const ox = sx - bcx, oy = sy - bcy, ol = Math.hypot(ox, oy);
        if (ol > 1e-3) {
          vx = lerp(vx, ox / ol, st.burst); vy = lerp(vy, oy / ol, st.burst);
          const vl = Math.hypot(vx, vy);
          if (vl > 1e-3) { vx /= vl; vy /= vl; } else { vx = Math.cos(ang); vy = Math.sin(ang); }
        }
      }
      let x = sx, y = sy, hx = vx, hy = vy;
      const step = dist / STEPS;
      for (let k = 0; k < STEPS; k++) {
        let mx = vx, my = vy;
        if (turb > 0) {
          const qx = x * tk, qy = y * tk, ee = 0.35;
          mx += ((vnoise(qx, qy + ee, seed) - vnoise(qx, qy - ee, seed)) / (2 * ee)) * turb;
          my -= ((vnoise(qx + ee, qy, seed) - vnoise(qx - ee, qy, seed)) / (2 * ee)) * turb;
        }
        my += st.gravity * 1.6 * ((k + 0.5) / STEPS);
        x += mx * step; y += my * step;
        hx = mx; hy = my;
      }
      const hd = hs * (1 - st.shrink * 0.8 * tf);
      const alpha = st.opacity * (1 - st.fade * Math.pow(tf, 0.8)) * (sa / 255);
      if (alpha < 0.02) continue;
      const reach = hd * tip.ext + 2;
      if (x < -reach || y < -reach || x > W + reach || y > H + reach) continue;
      const rd = rsrc + (rnd(i, 15, seed) - 0.5) * TAU * st.spin * Math.min(1, tf * 2.5); // it turns as it flies

      // colour: the subject around where the piece came from
      const q = Math.max(1, sz * 0.3);
      let cr = 0, cg = 0, cb = 0, cn = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const tx = (sx + dx * q) | 0, ty = (sy + dy * q) | 0;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const ti = (ty * W + tx) * 4, ta = S[ti + 3];
        if (ta < 60) continue;
        cr += S[ti] * ta; cg += S[ti + 1] * ta; cb += S[ti + 2] * ta; cn += ta;
      }
      if (!cn) { const ti = pi * 4; cr = S[ti]; cg = S[ti + 1]; cb = S[ti + 2]; cn = 1; }
      const br = 1 + (rnd(i, 7, seed) - 0.5) * 1.4 * st.colorVar;
      cr = clamp((cr / cn) * br, 0, 255); cg = clamp((cg / cn) * br, 0, 255); cb = clamp((cb / cn) * br, 0, 255);
      T.br = br;

      const hl = Math.hypot(hx, hy) || 1, ux = hx / hl, uy = hy / hl;
      for (let tr = trailN; tr >= 0; tr--) {
        const al = tr ? alpha * 0.7 * Math.pow(1 - tr / (trailN + 1), 1.5) : alpha;
        if (al < 0.01) continue;
        stampPiece(T, tip, x - ux * hd * 1.7 * tr, y - uy * hd * 1.7 * tr, hd, rd, sx, sy, hs, rsrc, cr, cg, cb, al);
      }
      stats.drawn++;
      if (inBand) stats.matched++;
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const BLEND_REACH = 0.6; // how far paint fades out at Blend 100, in subject units
  // The grid fields a render works from: progress (T, or null) and paint levels (L, or null). Sets rs.far.
  function renderFields(ctx, st, rs) {
    const T = st.auto ? progressField(ctx, st, rs) : null;
    const L = paintLevels(ctx, paintField(ctx, st.strokes), rs.unit * BLEND_REACH * st.blend);
    rs.far = T ? ctx.cache.progFar : rs.unit; // how far the dispersion sweeps, in pixels
    return { T, L };
  }
  // opts.ref: `resolved.ref` from another render — pins direction, start point and scale.
  // opts.timing: an object to receive how long each stage took, in ms.
  // Returns { width, height, erode (Uint8, 255 = fully removed), particles (RGBA), resolved, count, holes, matched }.
  function render(ctx, st, opts) {
    opts = opts || {};
    const W = ctx.W, H = ctx.H;
    const rs = resolve(ctx, st, opts.ref);
    const erode = new Uint8Array(W * H);
    const particles = opts.noParticles ? null : new Uint8ClampedArray(W * H * 4);
    let area = 0, stats = { drawn: 0, holes: 0, matched: 0 };
    if (!ctx.empty) {
      const { T, L } = renderFields(ctx, st, rs);
      const smp = makeSampler(ctx, st, rs, T, L);
      const tm = opts.timing, t0 = tm ? Date.now() : 0;
      erodePass(ctx, smp, erode);
      const t1 = tm ? Date.now() : 0;
      stats = pieces(ctx, st, rs, smp, erode, particles);
      const t2 = tm ? Date.now() : 0;
      area = finishErosion(ctx, smp, erode);
      if (tm) { tm.erode = t1 - t0; tm.pieces = t2 - t1; tm.finish = Date.now() - t2; }
    }
    // count: particles drawn. holes: pieces whose bite shows in the mask; matched: how many of those were drawn.
    return { width: W, height: H, erode, particles, resolved: rs, count: stats.drawn, holes: stats.holes, matched: stats.matched, erodedArea: area };
  }

  // Preview picture: plate, then what is left of the subject, then the particles.
  // opts.view: 'result' | 'before' | 'mask' (subject left whole, removed parts tinted red, protected parts green).
  function composite(ctx, res, opts) {
    opts = opts || {};
    const W = ctx.W, H = ctx.H, n = W * H, S = ctx.subject, B = ctx.plate;
    const out = new Uint8ClampedArray(n * 4);
    const view = res ? opts.view || 'result' : 'before';
    const E = res ? res.erode : null, Q = res && view === 'result' ? res.particles : null;
    const P = view === 'mask' && ctx.cache.levels ? ctx.cache.levels.keep : null;
    const { gw, gh } = ctx;
    for (let y = 0, i = 0, j = 0; y < H; y++) {
      const gr = Math.min(gh - 1, Math.floor((y * gh) / H)) * gw;
      for (let x = 0; x < W; x++, i++, j += 4) {
        let r, g, b;
        if (B) { r = B[j]; g = B[j + 1]; b = B[j + 2]; } else { r = g = b = ((x >> 3) + (y >> 3)) & 1 ? 96 : 72; }
        let sa = S[j + 3];
        if (sa) {
          let sr = S[j], sg = S[j + 1], sb = S[j + 2];
          if (view === 'result') sa = (sa * (255 - E[i])) / 255;
          else if (view === 'mask') {
            const e = (E[i] / 255) * 0.7;
            sr += (255 - sr) * e; sg += (40 - sg) * e; sb += (60 - sb) * e;
            if (P) { const p = P[gr + Math.min(gw - 1, Math.floor((x * gw) / W))]; if (p > 0) { const k = p * 0.55; sr += (40 - sr) * k; sg += (220 - sg) * k; sb += (120 - sb) * k; } }
          }
          const k = sa / 255;
          r += (sr - r) * k; g += (sg - g) * k; b += (sb - b) * k;
        }
        if (Q) {
          const qa = Q[j + 3];
          if (qa) { const k = qa / 255; r += (Q[j] - r) * k; g += (Q[j + 1] - g) * k; b += (Q[j + 2] - b) * k; }
        }
        out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255;
      }
    }
    return { width: W, height: H, data: out };
  }

  // ---------------------------------------------------------------------------
  // Preview overlays (drawn into the pixels: UXP has no canvas to draw them on)
  // ---------------------------------------------------------------------------
  function px(img, x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
    const d = img.data, i = (y * img.width + x) * 4;
    d[i] += (r - d[i]) * a; d[i + 1] += (g - d[i + 1]) * a; d[i + 2] += (b - d[i + 2]) * a;
  }
  function drawLine(img, x0, y0, x1, y1, w, c, a) {
    const h = w / 2 + 1;
    const ax0 = Math.floor(Math.min(x0, x1) - h), ax1 = Math.ceil(Math.max(x0, x1) + h);
    const ay0 = Math.floor(Math.min(y0, y1) - h), ay1 = Math.ceil(Math.max(y0, y1) + h);
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    for (let y = Math.max(0, ay0); y <= Math.min(img.height - 1, ay1); y++) for (let x = Math.max(0, ax0); x <= Math.min(img.width - 1, ax1); x++) {
      const t = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / l2, 0, 1);
      const d = Math.hypot(x + 0.5 - (x0 + dx * t), y + 0.5 - (y0 + dy * t));
      px(img, x, y, c[0], c[1], c[2], clamp(w / 2 - d + 0.5, 0, 1) * a);
    }
  }
  function drawRing(img, cx, cy, rad, w, c, a) {
    const h = rad + w / 2 + 1;
    for (let y = Math.max(0, Math.floor(cy - h)); y <= Math.min(img.height - 1, Math.ceil(cy + h)); y++) for (let x = Math.max(0, Math.floor(cx - h)); x <= Math.min(img.width - 1, Math.ceil(cx + h)); x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad);
      px(img, x, y, c[0], c[1], c[2], clamp(w / 2 - d + 0.5, 0, 1) * a);
    }
  }
  function drawDot(img, cx, cy, rad, c, a) {
    for (let y = Math.max(0, Math.floor(cy - rad - 1)); y <= Math.min(img.height - 1, Math.ceil(cy + rad + 1)); y++) for (let x = Math.max(0, Math.floor(cx - rad - 1)); x <= Math.min(img.width - 1, Math.ceil(cx + rad + 1)); x++) {
      px(img, x, y, c[0], c[1], c[2], clamp(rad - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5, 0, 1) * a);
    }
  }
  // o: { k (image pixels per screen pixel), aim: { ox, oy, tx, ty }, brush: { x, y, r, mode }, box: { x0, y0, x1, y1 } }
  function drawOverlay(img, o) {
    const k = Math.max(0.5, o.k || 1), dark = [0, 0, 0], white = [255, 255, 255], blue = [60, 160, 255];
    if (o.aim) {
      const { ox, oy, tx, ty } = o.aim;
      const dx = tx - ox, dy = ty - oy, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, hd = 9 * k;
      drawLine(img, ox, oy, tx, ty, 4 * k, dark, 0.45);
      drawLine(img, ox, oy, tx, ty, 1.8 * k, white, 0.95);
      for (const sgn of [-1, 1]) {
        const bx = tx - ux * hd + -uy * hd * 0.6 * sgn, by = ty - uy * hd + ux * hd * 0.6 * sgn;
        drawLine(img, tx, ty, bx, by, 4 * k, dark, 0.45);
        drawLine(img, tx, ty, bx, by, 1.8 * k, white, 0.95);
      }
      drawDot(img, ox, oy, 6.5 * k, dark, 0.5); drawDot(img, ox, oy, 5 * k, white, 1); drawDot(img, ox, oy, 2.6 * k, blue, 1);
      drawDot(img, tx, ty, 5.5 * k, dark, 0.5); drawDot(img, tx, ty, 4 * k, blue, 1);
    }
    if (o.brush) {
      const c = o.brush.mode === 'protect' ? [70, 230, 130] : o.brush.mode === 'erase' ? [255, 255, 255] : [255, 90, 90];
      drawRing(img, o.brush.x, o.brush.y, o.brush.r, 3.2 * k, dark, 0.45);
      drawRing(img, o.brush.x, o.brush.y, o.brush.r, 1.4 * k, c, 1);
    }
    if (o.box) {
      const { x0, y0, x1, y1 } = o.box;
      [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].forEach((s) => {
        drawLine(img, s[0], s[1], s[2], s[3], 3.6 * k, dark, 0.45);
        drawLine(img, s[0], s[1], s[2], s[3], 1.6 * k, [255, 225, 80], 1);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers for hosts
  // ---------------------------------------------------------------------------
  // Halves an image: { width, height, subject, plate } → the same at half size (for quick drafts while dragging).
  function halve(src) {
    const W = src.width, H = src.height, w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
    const half = (A, weighted) => {
      if (!A) return null;
      const o = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0, ws = 0;
        for (let k = 0; k < 4; k++) {
          const i = ((y * 2 + (k >> 1)) * W + x * 2 + (k & 1)) * 4, wa = weighted ? A[i + 3] : 1;
          r += A[i] * wa; g += A[i + 1] * wa; b += A[i + 2] * wa; a += A[i + 3]; ws += wa;
        }
        const j = (y * w + x) * 4;
        if (ws) { o[j] = r / ws; o[j + 1] = g / ws; o[j + 2] = b / ws; }
        o[j + 3] = a / 4;
      }
      return o;
    };
    return { width: w, height: h, subject: half(src.subject, true), plate: half(src.plate, false) };
  }

  // 1 wherever `mask` is above `thr` within `r` pixels.
  function dilate(mask, W, H, r, thr) {
    r = Math.max(0, Math.round(r)); thr = thr == null ? 8 : thr;
    const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let last = -1e9;
      for (let x = 0; x < W; x++) { if (mask[row + x] > thr) last = x; if (x - last <= r) a[row + x] = 1; }
      last = 1e9;
      for (let x = W - 1; x >= 0; x--) { if (mask[row + x] > thr) last = x; if (last - x <= r) a[row + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
      let last = -1e9;
      for (let y = 0; y < H; y++) { if (a[y * W + x]) last = y; if (y - last <= r) b[y * W + x] = 1; }
      last = 1e9;
      for (let y = H - 1; y >= 0; y--) { if (a[y * W + x]) last = y; if (last - y <= r) b[y * W + x] = 1; }
    }
    return b;
  }

  // Quick fill for the hole the subject leaves (push-pull): a smooth guess at the background, good
  // enough to preview on until Photoshop makes the real fill. hole: Uint8, non-zero = fill this pixel.
  function inpaint(rgba, W, H, hole) {
    let lv = { w: W, h: H, c: new Float32Array(W * H * 3), wt: new Float32Array(W * H) };
    for (let i = 0; i < W * H; i++) if (!hole[i]) { lv.wt[i] = 1; lv.c[i * 3] = rgba[i * 4]; lv.c[i * 3 + 1] = rgba[i * 4 + 1]; lv.c[i * 3 + 2] = rgba[i * 4 + 2]; }
    const levels = [lv];
    while (lv.w > 1 || lv.h > 1) {
      const w2 = (lv.w + 1) >> 1, h2 = (lv.h + 1) >> 1;
      const nx = { w: w2, h: h2, c: new Float32Array(w2 * h2 * 3), wt: new Float32Array(w2 * h2) };
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        let r = 0, g = 0, b = 0, sw = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const xx = x * 2 + dx, yy = y * 2 + dy;
          if (xx >= lv.w || yy >= lv.h) continue;
          const i = yy * lv.w + xx, wv = lv.wt[i];
          if (!wv) continue;
          r += lv.c[i * 3] * wv; g += lv.c[i * 3 + 1] * wv; b += lv.c[i * 3 + 2] * wv; sw += wv;
        }
        const j = y * w2 + x;
        if (sw) { nx.c[j * 3] = r / sw; nx.c[j * 3 + 1] = g / sw; nx.c[j * 3 + 2] = b / sw; nx.wt[j] = Math.min(1, sw); }
      }
      levels.push(nx); lv = nx;
    }
    for (let L = levels.length - 2; L >= 0; L--) {
      const f = levels[L], c = levels[L + 1];
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x, wv = f.wt[i];
        if (wv >= 1) continue;
        const ux = clamp((x + 0.5) / 2 - 0.5, 0, c.w - 1), uy = clamp((y + 0.5) / 2 - 0.5, 0, c.h - 1);
        const x0 = Math.floor(ux), y0 = Math.floor(uy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1), fx = ux - x0, fy = uy - y0;
        for (let k = 0; k < 3; k++) {
          const v = lerp(lerp(c.c[(y0 * c.w + x0) * 3 + k], c.c[(y0 * c.w + x1) * 3 + k], fx), lerp(c.c[(y1 * c.w + x0) * 3 + k], c.c[(y1 * c.w + x1) * 3 + k], fx), fy);
          f.c[i * 3 + k] = f.c[i * 3 + k] * wv + v * (1 - wv);
        }
        f.wt[i] = 1;
      }
    }
    const out = new Uint8ClampedArray(W * H * 4), c0 = levels[0].c;
    for (let i = 0; i < W * H; i++) { out[i * 4] = c0[i * 3]; out[i * 4 + 1] = c0[i * 3 + 1]; out[i * 4 + 2] = c0[i * 3 + 2]; out[i * 4 + 3] = 255; }
    return out;
  }

  // Builds preview buffers from a flat picture and a subject mask: the subject cut out, and a
  // plate with the hole roughly filled in.
  function split(rgba, W, H, mask) {
    const subject = new Uint8ClampedArray(rgba);
    let area = 0;
    for (let i = 0; i < W * H; i++) { const a = (rgba[i * 4 + 3] * mask[i]) / 255; subject[i * 4 + 3] = a; area += a; }
    const pad = Math.max(2, Math.sqrt(area / 255) * 0.03);
    return { width: W, height: H, subject, plate: inpaint(rgba, W, H, dilate(mask, W, H, pad, 8)) };
  }

  D.DEFAULTS = DEFAULTS; D.PATTERNS = PATTERNS; D.PRESET_KEYS = PRESET_KEYS; D.DEFAULT_TIPS = DEFAULT_TIPS;
  D.tipList = tipList; D.tipPreview = tipPreview; D.setCustomTips = setCustomTips; D.tipFromMask = tipFromMask; D.tipFromImage = tipFromImage;
  D.normalize = normalize; D.prepare = prepare; D.resolve = resolve; D.autoAngle = autoAngle;
  D.render = render; D.composite = composite; D.drawOverlay = drawOverlay;
  D.halve = halve; D.dilate = dilate; D.inpaint = inpaint; D.split = split;
  D._tips = { variants: tipVariants, alpha: tipAlpha, exact: tipAlphaExact }; // for the tests
  D.noise = { fbm, vnoise, rnd };
  // What the WebAssembly engine (engine-wasm.js) needs. render / composite here are the JavaScript
  // engine, kept as the reference: D.render / D.composite may be replaced by a faster path.
  D._core = {
    resolve, renderFields, samplerParams, pieceParams, tipMix, tipTable, FRONT, SMALL, TIP_K, TAB_N,
    render, composite,
  };
  root.Disintegration = D;
})(typeof window !== 'undefined' ? window : globalThis);
