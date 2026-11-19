/* Disintegration Studio — live pictures for the Particles, Motion and Look settings.
 *
 * UXP has no <canvas>, so each picture is drawn with DSUI.raster into a PNG data URL and shown in
 * an <img>. Every factory takes get(), which returns the current settings (main.js passes
 * () => fx), and returns an element with _sync() to redraw it from get():
 *
 *   DSUI.previews.particles(get)    340×96 well: scattered chips (density, size, sizeVar, spin, texture, seed)
 *   DSUI.previews.motion(get)       340×96 well: streams leaving a subject (distance, spread, burst,
 *                                   turbulence, turbScale, gravity, trail, seed)
 *   DSUI.previews.look(get)         340×96 well: one piece over its lifetime (fade, shrink, opacity, colorVar, spin, seed)
 *   DSUI.previews.colourStrip(get)  340×18 strip: 12 swatches spread by colorVar (seed)
 *   DSUI.previews.seedRow({ get, set })  the Seed row: number box and a Reroll control; set(v) is called with 1..999
 *
 * _sync() is cheap to call on every slider event: it skips the redraw when the inputs it uses have
 * not changed, draws at most once per SYNC_MS and always follows a burst with a trailing redraw.
 * _sync(true) forces a redraw.
 *
 * Randomness is hashed from the seed (mulberry32), so a preview only changes with its own settings.
 */
(function () {
  'use strict';
  const DSUI = (window.DSUI = window.DSUI || {});

  const W = 340, H = 96, SCALE = 1.5, SYNC_MS = 30;
  const TEAL = [63, 181, 163];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- seeded randomness ----------------------------------------------------
  function mulberry32(a) {
    a >>>= 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // a generator for item i of stream salt under seed, so items stay put when the count changes
  function rngFor(seed, salt, i) {
    let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35) ^ Math.imul(i + 1, 0x27d4eb2f);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return mulberry32(h ^ (h >>> 13));
  }
  const seedOf = (s) => clamp(Math.round(num(s && s.seed, 1)), 1, 999);

  // ---- helpers --------------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pictureImg(w, h) {
    const im = el('img', 'dsp-pic');
    im.alt = '';
    im.setAttribute('draggable', 'false');
    im.style.width = w + 'px'; im.style.height = h + 'px';
    return im;
  }
  // a key of the inputs a picture depends on, so unchanged inputs skip the redraw
  function keyOf(s, props) {
    let k = '';
    for (const p of props) k += (Math.round(num(s && s[p], 0) * 1e4)) + ',';
    return k;
  }
  // _sync with change detection, at most one draw per SYNC_MS, and a trailing draw after a burst
  function syncer(get, props, paint) {
    let last = null, lastAt = -1e9, timer = null;
    function run() {
      timer = null;
      const s = get() || {};
      const k = keyOf(s, props);
      if (k === last) return;
      last = k; lastAt = now();
      paint(s);
    }
    return function sync(force) {
      if (force) last = null;
      if (timer) return;
      const wait = SYNC_MS - (now() - lastAt);
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    };
  }
  function rgbMix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function rotPts(pts, cx, cy, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  }

  // ---- fast surface -----------------------------------------------------------
  // DSUI.raster.create() anti-aliases by 4×4 supersampling and its PNG/base64 path builds the data
  // URL a byte at a time: right for icons, too slow for pictures redrawn while a slider moves. This
  // draws into the same pixel buffer (a raster surface's pixels()) with one sample per pixel and
  // coverage from the distance to the shape's edge, and encodes with block copies. Same calls as a
  // raster surface: rect, circle, poly (convex), path, url.
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc(buf, a, b) { let c = 0xffffffff; for (let i = a; i < b; i++) c = crcT[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function encodePng(px, w, h) {
    const rowLen = w * 4 + 1, rawLen = rowLen * h, raw = new Uint8Array(rawLen);
    for (let y = 0; y < h; y++) raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * rowLen + 1);
    let a1 = 1, a2 = 0;
    for (let i = 0; i < rawLen;) {
      const e = Math.min(rawLen, i + 5552);
      for (; i < e; i++) { a1 += raw[i]; a2 += a1; }
      a1 %= 65521; a2 %= 65521;
    }
    const nB = Math.ceil(rawLen / 65535) || 1, zLen = 2 + rawLen + nB * 5 + 4;
    const out = new Uint8Array(8 + 25 + 12 + zLen + 12);
    let p = 0;
    const u32 = (v) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
    out.set([137, 80, 78, 71, 13, 10, 26, 10], 0); p = 8;
    u32(13); let cs = p; out.set([73, 72, 68, 82], p); p += 4; u32(w); u32(h); out.set([8, 6, 0, 0, 0], p); p += 5; u32(crc(out, cs, p));
    u32(zLen); cs = p; out.set([73, 68, 65, 84, 0x78, 0x01], p); p += 6;
    for (let off = 0; off < rawLen;) {
      const len = Math.min(65535, rawLen - off);
      out[p++] = off + len >= rawLen ? 1 : 0; out[p++] = len & 255; out[p++] = len >>> 8; out[p++] = ~len & 255; out[p++] = (~len >>> 8) & 255;
      out.set(raw.subarray(off, off + len), p); p += len; off += len;
    }
    u32(((a2 << 16) | a1) >>> 0); u32(crc(out, cs, p));
    u32(0); cs = p; out.set([73, 69, 78, 68], p); p += 4; u32(crc(out, cs, p));
    return out;
  }
  const B64C = new Uint8Array(64);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => (B64C[i] = c.charCodeAt(0)));
  function base64(b) {
    const n = b.length, o = new Uint8Array(Math.ceil(n / 3) * 4);
    let j = 0, i = 0;
    for (; i + 2 < n; i += 3) {
      const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      o[j++] = B64C[v >> 18]; o[j++] = B64C[(v >> 12) & 63]; o[j++] = B64C[(v >> 6) & 63]; o[j++] = B64C[v & 63];
    }
    if (i < n) {
      const v = (b[i] << 16) | ((i + 1 < n ? b[i + 1] : 0) << 8);
      o[j++] = B64C[v >> 18]; o[j++] = B64C[(v >> 12) & 63];
      o[j++] = i + 1 < n ? B64C[(v >> 6) & 63] : 61; o[j++] = 61;
    }
    let s = '';
    for (let k = 0; k < o.length; k += 8192) s += String.fromCharCode.apply(null, o.subarray(k, k + 8192));
    return s;
  }
  function surf(w, h, scale) {
    const base = DSUI.raster.create(w, h, scale), px = base.pixels();
    const SW_ = Math.max(1, Math.round(w * scale)), SH_ = Math.max(1, Math.round(h * scale)), s = scale;
    const col = (c) => DSUI.raster.parseColor(c);
    function put(i, c, cov) {
      const sa = c[3] * cov;
      if (sa <= 0.002) return;
      const da = px[i + 3] / 255, f = da * (1 - sa), oa = sa + f;
      px[i] = (c[0] * sa + px[i] * f) / oa; px[i + 1] = (c[1] * sa + px[i + 1] * f) / oa; px[i + 2] = (c[2] * sa + px[i + 2] * f) / oa;
      px[i + 3] = oa * 255;
    }
    const box = (x0, y0, x1, y1) => [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(SW_ - 1, Math.ceil(x1)), Math.min(SH_ - 1, Math.ceil(y1))];
    const api = {
      width: w, height: h, scale,
      rect(x, y, rw, rh, c, radius) {
        c = col(c);
        const r = (radius || 0) * s, hx = (rw * s) / 2, hy = (rh * s) / 2, cx = x * s + hx, cy = y * s + hy;
        const [x0, y0, x1, y1] = box(x * s - 1, y * s - 1, (x + rw) * s + 1, (y + rh) * s + 1);
        for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) {
          const qx = Math.max(Math.abs(X + 0.5 - cx) - (hx - r), 0), qy = Math.max(Math.abs(Y + 0.5 - cy) - (hy - r), 0);
          const d = (r ? Math.sqrt(qx * qx + qy * qy) - r : Math.max(Math.abs(X + 0.5 - cx) - hx, Math.abs(Y + 0.5 - cy) - hy));
          const cov = 0.5 - d;
          if (cov > 0) put((Y * SW_ + X) * 4, c, cov > 1 ? 1 : cov);
        }
        return api;
      },
      circle(cx, cy, r, c) {
        c = col(c);
        const X0 = cx * s, Y0 = cy * s, R = r * s;
        const [x0, y0, x1, y1] = box(X0 - R - 1, Y0 - R - 1, X0 + R + 1, Y0 + R + 1);
        for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) {
          const cov = R + 0.5 - Math.hypot(X + 0.5 - X0, Y + 0.5 - Y0);
          if (cov > 0) put((Y * SW_ + X) * 4, c, cov > 1 ? 1 : cov);
        }
        return api;
      },
      // a filled convex polygon, either winding
      poly(points, c) {
        c = col(c);
        const n = points.length, P = points.map(([x, y]) => [x * s, y * s]);
        let area = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const a = P[i], b = P[(i + 1) % n];
          area += a[0] * b[1] - b[0] * a[1];
          if (a[0] < bx0) bx0 = a[0]; if (a[0] > bx1) bx1 = a[0]; if (a[1] < by0) by0 = a[1]; if (a[1] > by1) by1 = a[1];
        }
        if (!area) return api;
        const sg = area > 0 ? 1 : -1, E = [];
        for (let i = 0; i < n; i++) {
          const a = P[i], b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
          if (L < 1e-6) continue;
          const ea = (-dy / L) * sg, eb = (dx / L) * sg;
          E.push(ea, eb, -(ea * a[0] + eb * a[1]));
        }
        // pieces under a pixel get their coverage from their area
        const small = Math.min(1, Math.abs(area) / 2);
        const [x0, y0, x1, y1] = box(bx0 - 1, by0 - 1, bx1 + 1, by1 + 1);
        for (let Y = y0; Y <= y1; Y++) {
          const py = Y + 0.5;
          for (let X = x0; X <= x1; X++) {
            const pxx = X + 0.5;
            let d = 1e9;
            for (let k = 0; k < E.length; k += 3) { const v = E[k] * pxx + E[k + 1] * py + E[k + 2]; if (v < d) { d = v; if (d <= -0.5) break; } }
            const cov = d + 0.5;
            if (cov > 0) put((Y * SW_ + X) * 4, c, (cov > 1 ? 1 : cov) * small);
          }
        }
        return api;
      },
      // a polyline with round end caps; each segment owns the pixels beside it, so joints are not drawn twice
      path(points, width, c) {
        c = col(c);
        const hw = (width * s) / 2, thin = Math.min(1, hw * 2), last = points.length - 2;
        for (let k = 0; k <= last; k++) {
          const ax = points[k][0] * s, ay = points[k][1] * s, bx = points[k + 1][0] * s, by = points[k + 1][1] * s;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
          const [x0, y0, x1, y1] = box(Math.min(ax, bx) - hw - 1, Math.min(ay, by) - hw - 1, Math.max(ax, bx) + hw + 1, Math.max(ay, by) + hw + 1);
          for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) {
            const pxx = X + 0.5, py = Y + 0.5;
            let t = ((pxx - ax) * dx + (py - ay) * dy) / L2;
            if (t < 0) { if (k > 0) continue; t = 0; } else if (t >= 1) { if (k < last) continue; t = 1; }
            const qx = ax + t * dx - pxx, qy = ay + t * dy - py;
            const cov = hw + 0.5 - Math.sqrt(qx * qx + qy * qy);
            if (cov > 0) put((Y * SW_ + X) * 4, c, (cov > 1 ? 1 : cov) * thin);
          }
        }
        return api;
      },
      pixels() { return px; },
      // compressed (ui-raster's deflate): a few ms more to make, 10–30× less for UXP to decode
      url() { const R = window.DSUI.raster; return 'data:image/png;base64,' + base64(R && R.encodePngRGBA ? R.encodePngRGBA(px, SW_, SH_) : encodePng(px, SW_, SH_)); },
    };
    return api;
  }
  function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }

  // ---- Particles ------------------------------------------------------------
  const P_PROPS = ['density', 'size', 'sizeVar', 'spin', 'texture', 'seed'];
  const FLAT = [166, 156, 144]; // the one warm grey of texture 0
  // a made-up picture for the pieces to carry: warm tones with cooler patches
  function pictureAt(x, y, ph) {
    const a = Math.sin(x * 0.043 + ph) * 0.6 + Math.sin(y * 0.13 + ph * 2.1) * 0.4;
    const cool = Math.sin(x * 0.021 + ph * 3.3) * Math.cos(y * 0.07 + ph) > 0.35;
    const hue = cool ? 205 + a * 15 : 26 + a * 16;
    const light = 52 + 16 * Math.sin(x * 0.09 + y * 0.05 + ph * 1.7);
    return DSUI.raster.hsl(hue, cool ? 28 : 48, light);
  }
  function drawParticles(s) {
    const R = DSUI.raster, seed = seedOf(s);
    const density = clamp(num(s.density, 0.55), 0, 1), size = clamp(num(s.size, 0.45), 0, 1);
    const sizeVar = clamp(num(s.sizeVar, 0.75), 0, 1), spin = clamp(num(s.spin, 1), 0, 1), texture = clamp(num(s.texture, 0.6), 0, 1);
    const sf = surf(W, H, SCALE);
    const base = 2 + 22 * Math.pow(size, 1.5);            // typical edge in px
    const cover = (0.03 + 0.3 * density) * W * H;         // area the pieces cover
    const count = clamp(Math.round(cover / (base * base)), 3, 600);
    const ph = mulberry32(seed * 7919)() * 6.283;
    for (let i = 0; i < count; i++) {
      const r = rngFor(seed, 1, i);
      const x = 4 + r() * (W - 8), y = 4 + r() * (H - 8);
      const g = (r() + r() + r()) / 1.5 - 1;              // about -1..1, centred
      const e = clamp(base * Math.exp(sizeVar * 1.1 * g), 1.1, 44);
      const asp = 0.8 + r() * 0.4;
      const hw = e / 2, hh = (e * asp) / 2, j = 0.32 * spin;
      const corner = (sx, sy) => [sx * hw * (1 + (r() - 0.5) * j), sy * hh * (1 + (r() - 0.5) * j)];
      const quad = rotPts([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], x, y, (r() - 0.5) * Math.PI * spin);
      const pic = pictureAt(x, y, ph);
      const jit = (r() - 0.5) * 50 * texture;             // per-piece variation that grows with texture
      const col = rgbMix(FLAT, [pic[0] + jit, pic[1] + jit, pic[2] + jit], texture);
      const alpha = 0.95;
      if (e < 2.2) { sf.rect(x - hw, y - hh, e, e * asp, [col[0], col[1], col[2], alpha]); continue; }
      sf.poly(quad, [col[0], col[1], col[2], alpha]);
      // larger pieces carry a second tone at high detail: half the piece in a neighbouring colour
      if (texture > 0.3 && e >= 6) {
        const p2 = pictureAt(x + 9, y + 5, ph);
        sf.poly([quad[0], quad[1], quad[2]], [p2[0], p2[1], p2[2], (texture - 0.3) * 0.8]);
      }
    }
    return sf;
  }

  // ---- Motion ---------------------------------------------------------------
  const M_PROPS = ['distance', 'spread', 'burst', 'turbulence', 'turbScale', 'gravity', 'trail', 'seed'];
  const STREAMS = 14;
  const BLOCK = { x: 12, y: 24, w: 40, h: 48 };
  function drawMotion(s) {
    const R = DSUI.raster, seed = seedOf(s);
    const dist = clamp(num(s.distance, 0.55), 0, 1), spread = clamp(num(s.spread, 0.3), 0, 1), burst = clamp(num(s.burst, 0.1), 0, 1);
    const turb = clamp(num(s.turbulence, 0.35), 0, 1), tScale = clamp(num(s.turbScale, 0.5), 0, 1);
    const grav = clamp(num(s.gravity, 0), -1, 1), trail = clamp(num(s.trail, 0), 0, 1);
    const sf = surf(W, H, SCALE);
    sf.rect(BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, '#5C5C5C', 3);
    const cx = BLOCK.x + BLOCK.w / 2, cy = BLOCK.y + BLOCK.h / 2;
    const fan = spread * 1.05;                              // half-angle, radians (up to ~60°)
    const freq = lerp(2.4, 0.35, tScale);                   // small swirls: neighbours differ a lot
    const waves = lerp(2.6, 0.7, tScale);                   // wiggles along a stream
    const ph = mulberry32(seed * 104729)() * 6.283;
    const ends = [];
    for (let i = 0; i < STREAMS; i++) {
      const r = rngFor(seed, 2, i), u = i / (STREAMS - 1);
      const sy = BLOCK.y + 4 + u * (BLOCK.h - 8) + (r() - 0.5) * 3;
      const sx = BLOCK.x + BLOCK.w - 1;
      let ang = lerp(-fan, fan, u) + (r() - 0.5) * 0.25 * spread;
      // burst: turn the stream to point away from the subject's centre
      const radial = Math.atan2(sy - cy, sx - cx) * 1.3;
      ang = lerp(ang, radial, burst * 0.7);
      let L = (28 + dist * 245) * (1 - burst * 0.55 * r());
      // shorten a stream that would leave the well, so its end stays in sight
      const vx = Math.cos(ang), vy = Math.sin(ang) * 0.6 + grav * 0.34; // the well is wide and low: angles are drawn squashed
      if (vx > 0.01) L = Math.min(L, (W - 6 - sx) / vx);
      if (vy > 0.01) L = Math.min(L, (H - 5 - sy) / vy);
      else if (vy < -0.01) L = Math.min(L, (sy - 5) / -vy);
      L = Math.max(10, L);
      const ex = sx + vx * L, ey = clamp(sy + vy * L, 4, H - 4);
      // control point on the unbent line, pushed sideways by turbulence
      const dy0 = Math.sin(ang) * 0.6, dl = Math.hypot(vx, dy0) || 1;
      const mx = sx + (vx * L) / 2, my = sy + (dy0 * L) / 2;
      const nx = -dy0 / dl, ny = vx / dl;
      const push = turb * L * 0.28 * Math.sin(ph + i * freq);
      const qx = mx + nx * push, qy = my + ny * push;
      const amp = turb * (1.2 + 3.2 * (1 - tScale)), wph = ph * 1.3 + i * freq * 0.7;
      const n = Math.max(8, Math.min(22, Math.round(L / 9)));
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, v = 1 - t;
        let x = v * v * sx + 2 * v * t * qx + t * t * ex, y = v * v * sy + 2 * v * t * qy + t * t * ey;
        const w = amp * Math.sin(wph + t * waves * 6.283) * Math.sin(t * Math.PI);
        x += nx * w; y += ny * w;
        pts.push([x, clamp(y, 1, H - 1)]);
      }
      const shade = 0.45 + 0.4 * r();
      sf.path(pts, 1.1, [TEAL[0], TEAL[1], TEAL[2], shade]);
      ends.push(pts);
    }
    // trails and end dots drawn over the streams
    for (const pts of ends) {
      const end = pts[pts.length - 1];
      if (trail > 0.001) {
        const back = Math.max(2, Math.round((pts.length - 1) * (0.12 + 0.3 * trail)));
        sf.path(pts.slice(pts.length - 1 - back), 2.4 + 2.6 * trail, [TEAL[0], TEAL[1], TEAL[2], 0.12 + 0.2 * trail]);
      }
      sf.circle(end[0], end[1], 1.9, '#E6F4F1');
    }
    return sf;
  }

  // ---- Look -----------------------------------------------------------------
  const L_PROPS = ['fade', 'shrink', 'opacity', 'colorVar', 'spin', 'seed'];
  const LOOK_H = 78, CHIPS = 7, BASE = [217, 162, 106]; // #D9A26A
  function chipShape(seed) {
    const r = rngFor(seed, 3, 0), n = 7, pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 6.283 + (r() - 0.5) * 0.5, d = 0.68 + r() * 0.32;
      pts.push([Math.cos(a) * d, Math.sin(a) * d]);
    }
    return hull(pts);
  }
  function drawLook(s) {
    const R = DSUI.raster, seed = seedOf(s);
    const fade = clamp(num(s.fade, 0.35), 0, 1), shrink = clamp(num(s.shrink, 0.5), 0, 1), opacity = clamp(num(s.opacity, 1), 0, 1);
    const colorVar = clamp(num(s.colorVar, 0.12), 0, 1), spin = clamp(num(s.spin, 1), 0, 1);
    const sf = surf(W, LOOK_H, SCALE);
    const shape = chipShape(seed), size = 15, cy = LOOK_H / 2 + 1;
    for (let i = 0; i < CHIPS; i++) {
      const t = i / (CHIPS - 1), r = rngFor(seed, 4, i);
      const cx = 26 + t * (W - 52);
      const rad = Math.max(1.2, size * (1 - shrink * t));
      const a = opacity * (1 - fade * t * 0.92);
      const lv = (r() - 0.5) * 2 * colorVar * 55;           // lighter or darker along the way
      const col = [BASE[0] + lv, BASE[1] + lv, BASE[2] + lv * 0.8, a];
      const pts = rotPts(shape.map(([x, y]) => [x * rad, y * rad]), cx, cy, spin * i * 0.42);
      if (a > 0.003) sf.poly(pts, col);
    }
    return sf;
  }

  // ---- Colour strip ---------------------------------------------------------
  const C_PROPS = ['colorVar', 'seed'];
  const SW = 12, STRIP_H = 18;
  function drawStrip(s) {
    const R = DSUI.raster, seed = seedOf(s), cv = clamp(num(s.colorVar, 0.12), 0, 1);
    const sf = surf(W, STRIP_H, SCALE), gap = 4, w = (W - gap * (SW - 1)) / SW;
    for (let i = 0; i < SW; i++) {
      const r = rngFor(seed, 5, i);
      const hue = 31 + (r() - 0.5) * 2 * cv * 28, light = 63 + (r() - 0.5) * 2 * cv * 30;
      sf.rect(i * (w + gap), 2, w, STRIP_H - 4, R.hsl(hue, 58, clamp(light, 12, 92)), 3);
    }
    return sf;
  }

  // ---- factories ------------------------------------------------------------
  function well(cls) { return el('div', 'dsp-well ' + cls); }
  function particles(get) {
    const root = well('dsp-particles'), img = pictureImg(W, H);
    root.appendChild(img);
    root._sync = syncer(get, P_PROPS, (s) => { img.src = drawParticles(s).url(); });
    root._sync(true);
    return root;
  }
  function motion(get) {
    const root = well('dsp-motion'), img = pictureImg(W, H);
    root.appendChild(img);
    root.appendChild(el('div', 'dsp-caption dsp-caption-tr', 'Shown flying right'));
    root._sync = syncer(get, M_PROPS, (s) => { img.src = drawMotion(s).url(); });
    root._sync(true);
    return root;
  }
  function look(get) {
    const root = well('dsp-look'), img = pictureImg(W, LOOK_H);
    const caps = el('div', 'dsp-lookCaps');
    caps.appendChild(el('span', 'dsp-caption', 'Leaves the subject'));
    caps.appendChild(el('span', 'dsp-caption', 'End of its flight'));
    root.appendChild(img); root.appendChild(caps);
    root._sync = syncer(get, L_PROPS, (s) => { img.src = drawLook(s).url(); });
    root._sync(true);
    return root;
  }
  function colourStrip(get) {
    const root = el('div', 'dsp-strip'), img = pictureImg(W, STRIP_H);
    root.appendChild(img);
    root._sync = syncer(get, C_PROPS, (s) => { img.src = drawStrip(s).url(); });
    root._sync(true);
    return root;
  }

  let diceUrl = null;
  function dice() {
    if (diceUrl) return diceUrl;
    const sf = DSUI.raster.create(14, 14, 2);
    sf.rect(1, 1, 12, 12, '#D0D0D0', 3);
    [[4, 4], [7, 7], [10, 10], [10, 4], [4, 10]].forEach(([x, y]) => sf.circle(x, y, 1.3, '#2A2A2A'));
    return (diceUrl = sf.url());
  }
  function seedRow(opts) {
    const get = opts.get, set = opts.set;
    const row = el('div', 'dsp-seedRow');
    const lbls = el('div', 'dsp-seedLbls');
    lbls.appendChild(el('span', 'dsp-seedLbl', 'Seed'));
    lbls.appendChild(el('span', 'dsp-seedHint', 'same seed, same scatter'));
    const box = el('input', 'dsp-seedNum');
    box.setAttribute('type', 'number'); box.setAttribute('min', '1'); box.setAttribute('max', '999'); box.setAttribute('step', '1');
    const roll = el('div', 'dsp-reroll');
    roll.setAttribute('tabindex', '0'); roll.setAttribute('role', 'button'); roll.setAttribute('title', 'A new random seed');
    const ic = pictureImg(14, 14); ic.className = 'dsp-dice'; ic.src = dice();
    roll.appendChild(ic); roll.appendChild(el('span', 'dsp-rerollTxt', 'Reroll'));
    row.appendChild(lbls); row.appendChild(box); row.appendChild(roll);

    const apply = (v) => { set(clamp(Math.round(v), 1, 999)); row._sync(); };
    const fromBox = () => { const v = parseFloat(box.value); if (isFinite(v)) apply(v); };
    box.addEventListener('input', fromBox);
    box.addEventListener('change', () => { fromBox(); box.value = String(seedOf(get())); });
    const reroll = () => {
      const cur = seedOf(get());
      let v = cur;
      while (v === cur) v = 1 + Math.floor(Math.random() * 999);
      apply(v);
    };
    roll.addEventListener('click', reroll);
    roll.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); reroll(); } });
    row._sync = function () {
      const v = String(seedOf(get()));
      // leave the box alone while it is being typed in
      if (document.activeElement !== box && box.value !== v) box.value = v;
    };
    box.value = String(seedOf(get()));
    return row;
  }

  DSUI.previews = {
    particles, motion, look, colourStrip, seedRow,
    // the pure drawing functions (settings -> raster surface), for tests and benchmarks
    _draw: { particles: drawParticles, motion: drawMotion, look: drawLook, colourStrip: drawStrip },
    _mulberry32: mulberry32,
  };
})();
