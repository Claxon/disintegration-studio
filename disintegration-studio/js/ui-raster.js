/* Disintegration Studio — tiny raster drawing for UI pictures.
 *
 * UXP dialogs have no <canvas>, so every picture in the settings (icons, the direction dial, the
 * previews, coloured tip thumbnails) is drawn here into an RGBA buffer and handed to an <img> as a
 * PNG data URL. Shapes are anti-aliased by 4×4 supersampling, which is plenty for pictures a few
 * hundred pixels across.
 *
 *   const s = DSUI.raster.create(120, 40, 2);   // logical 120×40, drawn at 2× for sharpness
 *   s.circle(20, 20, 8, '#4C9BFF');
 *   s.line(0, 0, 120, 40, 2, 'rgba(255,255,255,0.5)');
 *   s.poly([[0,0],[10,0],[5,9]], '#F0A040');
 *   img.src = s.url();  img.style.width = '120px'; img.style.height = '40px';
 *
 * All coordinates are logical pixels. Colours are '#RGB', '#RRGGBB', '#RRGGBBAA', 'rgb()/rgba()',
 * or [r, g, b, a] with a in 0..1.
 */
(function () {
  'use strict';
  const DSUI = (window.DSUI = window.DSUI || {});

  // ---- colour --------------------------------------------------------------
  function parseColor(c) {
    if (Array.isArray(c)) return [c[0], c[1], c[2], c[3] == null ? 1 : c[3]];
    c = String(c).trim();
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length >= 8 ? n(6) / 255 : 1];
    }
    const m = c.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
    }
    return [255, 255, 255, 1];
  }
  function hsl(h, s, l, a) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, q = s * Math.min(l, 1 - l);
    const f = (n) => l - q * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255), a == null ? 1 : a];
  }

  // ---- PNG (RGBA, stored deflate) + base64 ---------------------------------
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(buf, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  // zlib stream with fixed-Huffman deflate and a simple LZ77 (one hash candidate per position).
  // UI pictures are mostly flat colour and transparency, so this shrinks them 20–100×.
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  function zlibFixed(data) {
    let out = new Uint8Array(Math.max(1024, data.length >> 2)), op = 0, bitBuf = 0, bitCnt = 0;
    const grow = () => { const n = new Uint8Array(out.length * 2); n.set(out); out = n; };
    const bits = (v, n) => { bitBuf |= v << bitCnt; bitCnt += n; while (bitCnt >= 8) { if (op >= out.length) grow(); out[op++] = bitBuf & 255; bitBuf >>>= 8; bitCnt -= 8; } };
    const rev = (code, n) => { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (code & 1); code >>= 1; } return r; };
    const sym = (s) => {
      if (s < 144) bits(rev(0x30 + s, 8), 8);
      else if (s < 256) bits(rev(0x190 + s - 144, 9), 9);
      else if (s < 280) bits(rev(s - 256, 7), 7);
      else bits(rev(0xc0 + s - 280, 8), 8);
    };
    out[op++] = 0x78; out[op++] = 0x01;
    bits(1, 1); bits(1, 2); // final block, fixed Huffman
    const HB = 15, head = new Int32Array(1 << HB).fill(-1), n = data.length;
    const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1 << HB) - 1);
    let i = 0;
    while (i < n) {
      let bestLen = 0, bestDist = 0;
      if (i + 2 < n) {
        const hsh = hash(i), cand = head[hsh];
        head[hsh] = i;
        if (cand >= 0 && i - cand <= 32768) {
          let l = 0; const max = Math.min(258, n - i);
          while (l < max && data[cand + l] === data[i + l]) l++;
          if (l >= 3) { bestLen = l; bestDist = i - cand; }
        }
        // also try the previous pixel / byte run (cheap and very common in flat pictures)
        for (const d of [1, 4]) {
          if (i - d < 0) continue;
          let l = 0; const max = Math.min(258, n - i);
          while (l < max && data[i - d + l] === data[i + l]) l++;
          if (l > bestLen && l >= 3) { bestLen = l; bestDist = d; }
        }
      }
      if (bestLen >= 3) {
        let li = 0; while (li < 28 && LEN_BASE[li + 1] <= bestLen) li++;
        sym(257 + li); if (LEN_EXTRA[li]) bits(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
        let di = 0; while (di < 29 && DIST_BASE[di + 1] <= bestDist) di++;
        bits(rev(di, 5), 5); if (DIST_EXTRA[di]) bits(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
        for (let k = 1; k < bestLen && i + k + 2 < n; k++) head[hash(i + k)] = i + k;
        i += bestLen;
      } else { sym(data[i]); i++; }
    }
    sym(256);
    if (bitCnt > 0) bits(0, 8 - bitCnt);
    let a1 = 1, a2 = 0;
    for (let k = 0; k < n; k++) { a1 = (a1 + data[k]) % 65521; a2 = (a2 + a1) % 65521; }
    const adler = ((a2 << 16) | a1) >>> 0;
    while (op + 4 > out.length) grow();
    out[op++] = adler >>> 24; out[op++] = (adler >>> 16) & 255; out[op++] = (adler >>> 8) & 255; out[op++] = adler & 255;
    return out.subarray(0, op);
  }
  function encodePngRGBA(px, w, h) {
    const rowLen = w * 4 + 1, raw = new Uint8Array(rowLen * h);
    for (let y = 0; y < h; y++) { raw[y * rowLen] = 0; raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * rowLen + 1); }
    const z = zlibFixed(raw);
    const out = new Uint8Array(8 + 25 + 12 + z.length + 12);
    let p = 0;
    const u32 = (v) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
    [137, 80, 78, 71, 13, 10, 26, 10].forEach((b) => (out[p++] = b));
    u32(13); let cs = p; [73, 72, 68, 82].forEach((b) => (out[p++] = b)); u32(w); u32(h); out[p++] = 8; out[p++] = 6; out[p++] = 0; out[p++] = 0; out[p++] = 0; u32(crc32(out, cs, p));
    u32(z.length); cs = p; [73, 68, 65, 84].forEach((b) => (out[p++] = b));
    out.set(z, p); p += z.length;
    u32(crc32(out, cs, p));
    u32(0); cs = p; [73, 69, 78, 68].forEach((b) => (out[p++] = b)); u32(crc32(out, cs, p));
    return out;
  }
  function encodePngRGBAStored(px, w, h) {
    const rowLen = w * 4 + 1, rawLen = rowLen * h;
    const nBlocks = Math.ceil(rawLen / 65535) || 1;
    const zLen = 2 + rawLen + nBlocks * 5 + 4;
    const out = new Uint8Array(8 + 25 + (12 + zLen) + 12);
    let p = 0;
    const u32 = (v) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
    [137, 80, 78, 71, 13, 10, 26, 10].forEach((b) => (out[p++] = b));
    u32(13); let cs = p; [73, 72, 68, 82].forEach((b) => (out[p++] = b)); u32(w); u32(h); out[p++] = 8; out[p++] = 6; out[p++] = 0; out[p++] = 0; out[p++] = 0; u32(crc32(out, cs, p));
    u32(zLen); cs = p; [73, 68, 65, 84].forEach((b) => (out[p++] = b));
    out[p++] = 0x78; out[p++] = 0x01;
    let a1 = 1, a2 = 0, remaining = rawLen, ri = 0;
    while (remaining > 0) {
      const len = Math.min(65535, remaining);
      remaining -= len;
      out[p++] = remaining === 0 ? 1 : 0; out[p++] = len & 255; out[p++] = len >>> 8; out[p++] = ~len & 255; out[p++] = (~len >>> 8) & 255;
      for (let k = 0; k < len; k++, ri++) {
        const y = (ri / rowLen) | 0, x = ri - y * rowLen;
        const b = x === 0 ? 0 : px[y * w * 4 + x - 1];
        out[p++] = b; a1 = (a1 + b) % 65521; a2 = (a2 + a1) % 65521;
      }
    }
    u32(((a2 << 16) | a1) >>> 0);
    u32(crc32(out, cs, p));
    u32(0); cs = p; [73, 69, 78, 68].forEach((b) => (out[p++] = b)); u32(crc32(out, cs, p));
    return out;
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(bytes) {
    let s = '';
    for (let j = 0; j < bytes.length; j += 3) {
      const b0 = bytes[j], b1 = j + 1 < bytes.length ? bytes[j + 1] : 0, b2 = j + 2 < bytes.length ? bytes[j + 2] : 0;
      s += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + (j + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=') + (j + 2 < bytes.length ? B64[b2 & 63] : '=');
    }
    return s;
  }

  // ---- surface -------------------------------------------------------------
  const SS = 4; // supersamples per axis
  function create(w, h, scale) {
    scale = scale || 2;
    const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    const px = new Uint8ClampedArray(W * H * 4);

    // composite colour col with coverage cov (0..1) onto pixel i, source-over, straight alpha
    function put(i, col, cov) {
      const sa = col[3] * cov;
      if (sa <= 0) return;
      const da = px[i + 3] / 255, oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) px[i + k] = (col[k] * sa + px[i + k] * da * (1 - sa)) / oa;
      px[i + 3] = oa * 255;
    }
    // fill using an inside(x, y) test in device pixels, over a device-pixel bounding box
    function fillBy(x0, y0, x1, y1, col, inside) {
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        let n = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) n++;
        if (n) put((y * W + x) * 4, col, n / (SS * SS));
      }
    }
    const api = {
      width: w, height: h, scale,
      clear(c) { if (c == null) { px.fill(0); return api; } const col = parseColor(c); for (let i = 0; i < px.length; i += 4) { px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = col[3] * 255; } return api; },
      rect(x, y, rw, rh, c, radius) {
        const col = parseColor(c), s = scale, r = (radius || 0) * s;
        const X0 = x * s, Y0 = y * s, X1 = (x + rw) * s, Y1 = (y + rh) * s;
        fillBy(X0, Y0, X1, Y1, col, (px_, py_) => {
          if (px_ < X0 || px_ > X1 || py_ < Y0 || py_ > Y1) return false;
          if (!r) return true;
          const cx = px_ < X0 + r ? X0 + r : px_ > X1 - r ? X1 - r : px_, cy = py_ < Y0 + r ? Y0 + r : py_ > Y1 - r ? Y1 - r : py_;
          return (px_ - cx) * (px_ - cx) + (py_ - cy) * (py_ - cy) <= r * r;
        });
        return api;
      },
      // soft: 0 = hard edge, 1 = fades from the centre to the rim
      circle(cx, cy, r, c, soft) {
        const col = parseColor(c), s = scale, X = cx * s, Y = cy * s, R = r * s;
        if (!soft) { fillBy(X - R, Y - R, X + R, Y + R, col, (a, b) => (a - X) * (a - X) + (b - Y) * (b - Y) <= R * R); return api; }
        const inner = R * (1 - Math.min(1, soft));
        const x0 = Math.max(0, Math.floor(X - R)), x1 = Math.min(W - 1, Math.ceil(X + R)), y0 = Math.max(0, Math.floor(Y - R)), y1 = Math.min(H - 1, Math.ceil(Y + R));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - X, y + 0.5 - Y);
          if (d >= R) continue;
          const t = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, R - inner);
          put((y * W + x) * 4, col, t * t * (3 - 2 * t));
        }
        return api;
      },
      ring(cx, cy, r, width, c) {
        const col = parseColor(c), s = scale, X = cx * s, Y = cy * s, R = r * s, hw = (width * s) / 2;
        fillBy(X - R - hw, Y - R - hw, X + R + hw, Y + R + hw, col, (a, b) => Math.abs(Math.hypot(a - X, b - Y) - R) <= hw);
        return api;
      },
      // a stroked segment with round caps
      line(x1, y1, x2, y2, width, c) {
        const col = parseColor(c), s = scale, ax = x1 * s, ay = y1 * s, bx = x2 * s, by = y2 * s, hw = (width * s) / 2;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
        fillBy(Math.min(ax, bx) - hw, Math.min(ay, by) - hw, Math.max(ax, bx) + hw, Math.max(ay, by) + hw, col, (px_, py_) => {
          let t = ((px_ - ax) * dx + (py_ - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * dx - px_, qy = ay + t * dy - py_;
          return qx * qx + qy * qy <= hw * hw;
        });
        return api;
      },
      // a polyline through points [[x,y],...]
      path(points, width, c) { for (let i = 1; i < points.length; i++) api.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], width, c); return api; },
      // a quadratic curve, flattened
      curve(x1, y1, cx, cy, x2, y2, width, c, steps) {
        const n = steps || 16, pts = [];
        for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]); }
        return api.path(pts, width, c);
      },
      // a filled polygon (even-odd); pass several rings as [[...],[...]] to cut holes
      poly(points, c) {
        const rings = Array.isArray(points[0][0]) ? points : [points];
        const col = parseColor(c), s = scale;
        const R = rings.map((ring) => ring.map(([x, y]) => [x * s, y * s]));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        R.forEach((ring) => ring.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }));
        fillBy(x0, y0, x1, y1, col, (px_, py_) => {
          let inside = false;
          for (const ring of R) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > py_) !== (yj > py_) && px_ < ((xj - xi) * (py_ - yi)) / (yj - yi) + xi) inside = !inside;
          }
          return inside;
        });
        return api;
      },
      // draw a coverage map (Float32Array/Uint8Array n×n, values 0..1 or 0..255) tinted with c, into a box
      mask(data, n, x, y, size, c, max) {
        const col = parseColor(c), s = scale, m = max || (data instanceof Uint8Array ? 255 : 1);
        const X0 = Math.round(x * s), Y0 = Math.round(y * s), S = Math.round(size * s);
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
          const X = X0 + xx, Y = Y0 + yy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const v = data[Math.min(n - 1, ((yy * n) / S) | 0) * n + Math.min(n - 1, ((xx * n) / S) | 0)] / m;
          if (v > 0) put((Y * W + X) * 4, col, Math.min(1, v));
        }
        return api;
      },
      pixels() { return px; },
      url() { return 'data:image/png;base64,' + toBase64(encodePngRGBA(px, W, H)); },
      // an <img> sized to the logical size, showing this picture
      img(attrs) {
        const im = document.createElement('img');
        im.src = api.url(); im.alt = '';
        im.setAttribute('draggable', 'false');
        im.style.width = w + 'px'; im.style.height = h + 'px';
        if (attrs) for (const k in attrs) im.setAttribute(k, attrs[k]);
        return im;
      },
    };
    return api;
  }

  DSUI.raster = { create, parseColor, hsl, encodePngRGBA, toBase64 };
})();
