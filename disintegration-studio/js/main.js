/* Disintegration Studio — dialog UI + host bridges (Photoshop UXP, or a plain browser for testing). */
(function () {
  'use strict';
  const D = window.Disintegration;
  const PRESETS = window.DISINTEGRATION_PRESETS;
  const $ = (id) => document.getElementById(id);

  let IS_UXP = false;
  try { IS_UXP = typeof require === 'function' && !!require('uxp'); } catch (e) { IS_UXP = false; }
  // read the wheel through a focused field (Photoshop needs it; "?catch" tries it in a browser)
  const USE_CATCH = IS_UXP || (typeof location !== 'undefined' && /[?&]catch\b/.test(location.search || ''));

  // ---------------------------------------------------------------------------
  // Diagnostics log (UXP: written to the plugin data folder as disintegration-log.txt)
  // ---------------------------------------------------------------------------
  let logBuf = '', logTimer = null;
  function log(...args) {
    const line = new Date().toISOString() + ' ' + args.map((a) => {
      if (a instanceof Error) return (a.message || '') + '\n' + (a.stack || '');
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    try { console.log(line); } catch (e) { /* ignore */ }
    logBuf = (logBuf + line + '\n').slice(-60000);
    if (!IS_UXP) return;
    clearTimeout(logTimer);
    logTimer = setTimeout(async () => {
      try {
        const fs = require('uxp').storage.localFileSystem;
        const folder = await fs.getDataFolder();
        const f = await folder.createFile('disintegration-log.txt', { overwrite: true });
        await f.write(logBuf);
      } catch (e) { /* ignore */ }
    }, 200);
  }

  // ---------------------------------------------------------------------------
  // Minimal PNG (stored deflate) + base64 — preview fallback that needs no host encoder
  // ---------------------------------------------------------------------------
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(buf, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function encodePng(rgb, w, h) {
    const rowLen = w * 3 + 1, rawLen = rowLen * h;
    const nBlocks = Math.ceil(rawLen / 65535) || 1;
    const zLen = 2 + rawLen + nBlocks * 5 + 4;
    const total = 8 + 25 + (12 + zLen) + 12;
    const out = new Uint8Array(total);
    let p = 0;
    const u32 = (v) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
    [137, 80, 78, 71, 13, 10, 26, 10].forEach((b) => (out[p++] = b));
    u32(13); let cs = p; [73, 72, 68, 82].forEach((b) => (out[p++] = b)); u32(w); u32(h); out[p++] = 8; out[p++] = 2; out[p++] = 0; out[p++] = 0; out[p++] = 0; u32(crc32(out, cs, p));
    u32(zLen); cs = p; [73, 68, 65, 84].forEach((b) => (out[p++] = b));
    out[p++] = 0x78; out[p++] = 0x01;
    let a1 = 1, a2 = 0, remaining = rawLen, ri = 0;
    const rawByte = (i) => { const y = (i / rowLen) | 0, x = i - y * rowLen; return x === 0 ? 0 : rgb[y * w * 3 + x - 1]; };
    while (remaining > 0) {
      const len = Math.min(65535, remaining);
      remaining -= len;
      out[p++] = remaining === 0 ? 1 : 0; out[p++] = len & 255; out[p++] = len >>> 8; out[p++] = ~len & 255; out[p++] = (~len >>> 8) & 255;
      for (let k = 0; k < len; k++, ri++) { const b = rawByte(ri); out[p++] = b; a1 = (a1 + b) % 65521; a2 = (a2 + a1) % 65521; }
    }
    u32(((a2 << 16) | a1) >>> 0);
    u32(crc32(out, cs, p));
    u32(0); cs = p; [73, 69, 78, 68].forEach((b) => (out[p++] = b)); u32(crc32(out, cs, p));
    return out;
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i += 30000) {
      let s = '';
      const end = Math.min(bytes.length, i + 30000);
      for (let j = i; j < end; j += 3) {
        const b0 = bytes[j], b1 = j + 1 < end ? bytes[j + 1] : 0, b2 = j + 2 < end ? bytes[j + 2] : 0;
        s += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + (j + 1 < end ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=') + (j + 2 < end ? B64[b2 & 63] : '=');
      }
      parts.push(s);
    }
    return parts.join('');
  }

  function fromBase64(str) {
    const clean = str.replace(/=+$/, ''), out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    for (let i = 0, j = 0, acc = 0, bits = 0; i < clean.length; i++) {
      acc = (acc << 6) | B64.indexOf(clean[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out[j++] = (acc >> bits) & 255; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const LS_STATE = 'disintegration.state.v1', LS_USER = 'disintegration.userPresets.v1', LS_UI = 'disintegration.ui.v1', LS_FX = 'disintegration.fx.', LS_TIPS = 'disintegration.customTips.v1';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

  // Brush tips of the user's own: [{ id, label, n, b64 }] (n×n coverage, base64). They have to be
  // handed to the engine before any design that uses them is read.
  const MAX_TIPS = 12;
  let customTips = store.get(LS_TIPS, []);
  function applyCustomTips() {
    customTips = (Array.isArray(customTips) ? customTips : []).filter((t) => t && t.id && t.b64 && t.n > 0);
    D.setCustomTips(customTips.map((t) => ({ id: t.id, label: '\u2605 ' + t.label, n: t.n, data: fromBase64(t.b64) })));
  }
  applyCustomTips();
  let fx = D.normalize(store.get(LS_STATE, null) || PRESETS[0].state);
  let ui = Object.assign({ quality: '1000', guides: true, fill: 'generative', brush: 0.08, hard: 0.5, flow: 1, fine: false, open: { disp: true, tips: true, part: true, motion: true, look: false } }, store.get(LS_UI, {}));
  if (!ui.tab) ui.tab = 'subject';
  if (['600', '1000', '1600', '2400'].indexOf(String(ui.quality)) < 0) ui.quality = '1000';
  if (['generative', 'contentAware', 'none'].indexOf(ui.fill) < 0) ui.fill = 'generative';
  let userPresets = store.get(LS_USER, []);
  let tool = 'aim';            // 'aim' | 'add' | 'protect' | 'erase' | 'box'
  let viewMode = 'result';     // 'result' | 'before' | 'mask'
  let session = null;          // what the host gave us: { width, height, subject, plate, docW, docH, editing, built, approx, key, note }
  let ctx = null, ctxDraft = null, ctxTiny = null; // engine contexts: preview size, half size and quarter size
  let lastRef = null;          // direction / start point / scale of the last render, as fractions of the image
  const undoStack = [], redoStack = [];
  let lastSnapshot = JSON.stringify(fx);

  function snapshot() {
    const s = JSON.stringify(fx);
    if (s === lastSnapshot) return;
    undoStack.push(lastSnapshot);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    lastSnapshot = s;
  }
  let snapTimer = null, saveTimer = null;
  // The settings (paint strokes and all) are written to storage once they stop changing, not on
  // every step of a slider: writing them took longer than the step itself.
  function saveState() { clearTimeout(saveTimer); saveTimer = null; store.set(LS_STATE, fx); }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 500); }
  function commit() {
    saveSoon();
    clearTimeout(snapTimer);
    snapTimer = setTimeout(snapshot, 350);
    syncPreviews();
    scheduleRender();
  }
  function restore(s) {
    fx = D.normalize(JSON.parse(s));
    lastSnapshot = s;
    store.set(LS_STATE, fx);
    renderInspector(); renderBrushFields(); scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Preview view — zooms (wheel / buttons) and pans (drag an empty area)
  // ---------------------------------------------------------------------------
  const views = [];
  let previewUrl = null, previewW = 0, previewH = 0, docW = 0;
  const MIN_ZOOM = 0.2; // relative to Fit
  function makeView(prefix) {
    const v = { name: prefix, wrap: $(prefix + 'Wrap'), img: $(prefix + 'Img'), empty: $(prefix + 'Empty'), label: $(prefix + 'Zoom'), zoom: 1, cx: null, cy: null, lastUrl: null };
    v.metrics = () => {
      const r = v.wrap.getBoundingClientRect();
      const fit = Math.min(r.width / previewW, r.height / previewH) || 1;
      return { r, fit, s: fit * v.zoom };
    };
    v.layout = () => {
      if (!previewW) return;
      const { r, s } = v.metrics();
      if (!r.width || !r.height) return;
      if (v.cx == null) { v.cx = previewW / 2; v.cy = previewH / 2; }
      const hw = r.width / 2 / s, hh = r.height / 2 / s;
      v.cx = previewW * s <= r.width ? previewW / 2 : clampN(v.cx, hw, previewW - hw);
      v.cy = previewH * s <= r.height ? previewH / 2 : clampN(v.cy, hh, previewH - hh);
      const st = v.img.style;
      // where the picture is, kept so that a mouse move needn't measure anything (see placeRing)
      v.place = { left: Math.round(r.width / 2 - v.cx * s), top: Math.round(r.height / 2 - v.cy * s), w: Math.round(previewW * s), h: Math.round(previewH * s), wrapLeft: r.left, wrapTop: r.top, wrapW: r.width, wrapH: r.height };
      st.left = v.place.left + 'px';
      st.top = v.place.top + 'px';
      st.width = v.place.w + 'px';
      st.height = v.place.h + 'px';
      if (v.label) v.label.textContent = docW ? Math.round((s * previewW * 100) / docW) + '%' : Math.round(v.zoom * 100) + '%';
      placeRing();
    };
    v.show = () => {
      if (previewUrl && v.lastUrl !== previewUrl) { v.img.src = previewUrl; v.lastUrl = previewUrl; }
      v.empty.style.display = previewUrl ? 'none' : '';
      v.img.style.display = previewUrl ? '' : 'none';
      v.layout();
    };
    // pointer position in preview pixels (k: preview pixels per screen pixel)
    // (from where layout() put the picture: measuring it on every mouse move made the brush outline lag)
    v.point = (e) => {
      const pl = v.place;
      if (!session || !pl || !pl.w) return null;
      const left = pl.wrapLeft + pl.left, top = pl.wrapTop + pl.top;
      return { x: ((e.clientX - left) / pl.w) * previewW, y: ((e.clientY - top) / pl.h) * previewH, k: previewW / pl.w };
    };
    v.zoomBy = (factor, clientX, clientY) => {
      if (!previewW) return;
      const { r, s } = v.metrics();
      if (v.cx == null) { v.cx = previewW / 2; v.cy = previewH / 2; }
      const mx = clientX == null ? r.width / 2 : clientX - r.left, my = clientY == null ? r.height / 2 : clientY - r.top;
      const px = v.cx + (mx - r.width / 2) / s, py = v.cy + (my - r.height / 2) / s;
      v.zoom = clampN(v.zoom * factor, MIN_ZOOM, 40);
      const s2 = v.metrics().s;
      v.cx = px - (mx - r.width / 2) / s2; v.cy = py - (my - r.height / 2) / s2;
      v.layout();
      kickSoon(); // guide line widths follow the zoom
    };
    v.fit = () => { v.zoom = 1; v.cx = null; v.layout(); kickSoon(); };
    v.actual = () => { const { fit } = v.metrics(); v.zoom = clampN(docW ? docW / previewW / fit : 1 / fit, MIN_ZOOM, 40); v.layout(); kickSoon(); };
    const btn = (id, fn) => { const b = $(prefix + id); if (b) b.addEventListener('click', fn); };
    btn('ZoomIn', () => v.zoomBy(1.4));
    btn('ZoomOut', () => v.zoomBy(1 / 1.4));
    btn('Fit', () => v.fit());
    btn('Actual', () => v.actual());
    v.wrap.addEventListener('mousedown', (e) => onDown(v, e));
    v.wrap.addEventListener('mousemove', onMove);
    v.wrap.addEventListener('mouseup', onUp);
    v.wrap.addEventListener('mouseleave', () => { if (hover && !drag) { hover = null; placeRing(); } }); // (Photoshop rarely sends this: see stillOverPreview)
    v.wrap.addEventListener('wheel', (e) => onWheel(e, 'wrap'), { passive: false });
    v.wrap.addEventListener('contextmenu', (e) => e.preventDefault && e.preventDefault());
    views.push(v);
    return v;
  }
  // size the dialog's columns explicitly (UXP doesn't always honour percentage heights)
  let lastLayoutKey = '';
  // Size requested for the open dialog and the first size measured after it appeared. Only a
  // change from that baseline (the user dragging the dialog edge) is remembered, so the saved
  // size can never creep upwards on its own.
  let dlgReq = null, dlgBase = null;
  function layoutAll(force) {
    const dlg = $('studio');
    const R = dlg.getBoundingClientRect();
    if (!R.width || !R.height) return;
    const W = Math.min(R.width, dlg.clientWidth > 0 ? dlg.clientWidth : R.width);
    // The dialog element is only as tall as its content (which is given a pixel height here), so
    // it never grows when the user drags the window taller. Its width does follow the window.
    // 100vh is the window's own height (UXP has no window.innerHeight).
    const vh = IS_UXP ? $('heightProbe').getBoundingClientRect().height : 0;
    const H0 = vh > 0 ? vh : Math.min(R.height, dlg.clientHeight > 0 ? dlg.clientHeight : R.height);
    const key = [W, H0, previewW, previewH].join(',');
    if (!force && key === lastLayoutKey) return;
    lastLayoutKey = key;
    let Hfit = H0;
    if (IS_UXP && studioOpen && dlgReq) {
      // forced: the dialog came up much taller than requested because its content was (UXP grows
      // a dialog to fit). Lay out to the requested height instead, plus whatever the user drags.
      if (!dlgBase) dlgBase = { w: W, h: H0, forced: H0 > dlgReq.h + 60 };
      else if (Math.abs(W - dlgBase.w) > 4 || Math.abs(H0 - dlgBase.h) > 4) {
        ui.dlgW2 = Math.round(dlgReq.w + W - dlgBase.w);
        ui.dlgH2 = Math.round(dlgReq.h + H0 - dlgBase.h);
        store.set(LS_UI, ui);
      }
      if (dlgBase.forced) Hfit = dlgReq.h + H0 - dlgBase.h;
    }
    sizeColumns(W, Hfit);
    views.forEach((v) => v.layout());
    if (lastComp) kickSoon();
  }
  // Explicit pixel sizes for the columns, the preview and the scrolling controls.
  function sizeColumns(W, H0) {
    const H = Math.max(300, H0);
    // a third or so of the dialog, and in a wide one room for every tab's name
    const need = tabSwitch && tabSwitch._need() ? tabSwitch._need() + 2 : 0; // (+ the column's border, and a pixel to spare)
    let rightW = Math.max(340, Math.min(480, Math.round(W / 3.2)));
    if (need > rightW && need <= Math.min(620, W * 0.36)) rightW = need;
    $('dlgRoot').style.height = H + 'px';
    $('right').style.width = rightW + 'px';
    $('left').style.width = Math.max(200, W - rightW - 2) + 'px';
    // before the dialog is on screen nothing can be measured, so use typical heights
    const lb = ($('bigBar').getBoundingClientRect().height || 30) + ($('leftFoot').getBoundingClientRect().height || 44);
    $('bigWrap').style.height = Math.max(150, H - lb - 26) + 'px';
    const rt = ($('rightTop').getBoundingClientRect().height || 96) + ($('tabBar').getBoundingClientRect().height || 36);
    $('scroll').style.height = Math.max(100, H - rt - 4) + 'px';
    if (tabSwitch) tabSwitch._fit(rightW - 1); // all the tab names, if the column is wide enough (less its left border)
  }

  // The brush outline, laid over the preview in the manner of Photoshop's: thin light lines with a
  // dark edge, so they show on any picture. (Drawing it into the picture would mean encoding the
  // whole preview again every time the pointer moves.)
  //  - solid: the edge of the brush, where its paint ends;
  //  - dashed: where the brush's soft edge starts to fade (Edge below 100);
  //  - dotted: how far the paint's effect reaches past that, fading out (Blend above 0). Blend
  //    tapers from where the paint is solid, so it reaches Blend's distance beyond the dashed ring.
  // The rings sit in one container. A mouse move only moves the container; the rings are sized
  // again only when the brush, the zoom or Blend changes. A burst of moves is drawn once.
  const BLEND_REACH = 0.6; // the engine's: how far paint fades out at Blend 100, in subject units
  // (A timer rather than requestAnimationFrame, which isn't documented for UXP dialogs.)
  let ringKey = '', ringQueued = false;
  function scheduleRing() {
    if (ringQueued) return;
    ringQueued = true;
    setTimeout(() => { ringQueued = false; placeRing(); }, 8);
  }
  function placeRing() {
    const box = $('brushCursor'), v = views[0];
    const on = !!(hover && v && v.place && previewW && (tool === 'add' || tool === 'protect' || tool === 'erase'));
    if (!on) { if (box.style.display !== 'none') box.style.display = 'none'; return; }
    const pl = v.place, k = pl.w / previewW; // screen pixels per preview pixel
    const r = Math.max(2, (ui.brush * Math.max(previewW, previewH) * k) / 2);
    const core = r * Math.min(1, ui.hard);
    const unit = lastRef ? lastRef.unitN * Math.max(previewW, previewH) * k : 0;
    const reach = fx.blend > 0.005 && unit ? core + unit * BLEND_REACH * fx.blend : 0;
    const key = [r, core, reach].map((n) => n.toFixed(1)).join('|');
    if (key !== ringKey) {
      ringKey = key;
      // a ring of radius rad whose line (width w) is centred on that radius
      const ring = (id, rad, w, show) => {
        const st = $(id).style;
        if (!show) { st.display = 'none'; return; }
        const d = 2 * rad - w;
        st.left = st.top = Math.round(-rad - w / 2) + 'px';
        st.width = st.height = Math.max(0, Math.round(d)) + 'px';
        st.borderRadius = Math.ceil(rad + w / 2) + 'px';
        st.display = 'block';
      };
      ring('ringEdgeB', r, 3, true); ring('ringEdge', r, 1, true);
      // the dashed and dotted rings: one picture (Photoshop draws dashed CSS borders as solid lines)
      const showCore = ui.hard < 0.97 && core > 3 && r - core > 2;
      const showReach = reach > r + 2;
      const im = $('ringDashes');
      if (!showCore && !showReach) im.style.display = 'none';
      else {
        const half = Math.ceil(Math.max(showCore ? core : 0, showReach ? reach : 0) + 3), D = half * 2;
        const s = window.DSUI.raster.create(D, D, Math.min(1, 700 / D)); // big rings at less than full resolution, so they stay quick to draw
        const dashes = (rad, on, off, light) => {
          const n = Math.max(6, Math.round((2 * Math.PI * rad) / (on + off)));
          for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < n; i++) {
              const a0 = (i / n) * 2 * Math.PI, a1 = a0 + ((on / (on + off)) * 2 * Math.PI) / n;
              s.line(half + Math.cos(a0) * rad, half + Math.sin(a0) * rad, half + Math.cos(a1) * rad, half + Math.sin(a1) * rad,
                pass ? 1 : 3, pass ? light : 'rgba(0,0,0,0.4)');
            }
          }
        };
        if (showReach) dashes(reach, 1.6, 3.4, 'rgba(255,255,255,0.75)'); // dotted
        if (showCore) dashes(core, 4, 3, 'rgba(255,255,255,0.85)'); // dashed
        im.src = s.url();
        im.style.width = im.style.height = D + 'px';
        im.style.left = im.style.top = -half + 'px';
        im.style.display = 'block';
      }
    }
    const st = box.style;
    st.left = Math.round(pl.left + hover.x * k) + 'px';
    st.top = Math.round(pl.top + hover.y * k) + 'px';
    if (st.display !== 'block') st.display = 'block';
  }

  // Wheel: zoom only when the pointer is over the preview; over the controls, scroll them.
  // Routed by pointer position because UXP can deliver wheel events to the preview even when
  // the pointer is over the controls column.
  function inRect(node, e) {
    if (typeof e.clientX !== 'number') return false;
    const r = node.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  }
  //
  // In Photoshop the wheel does not go to what is under the pointer. It goes to whatever has the
  // keyboard focus: with nothing in the dialog focused, the document behind the dialog zooms; with
  // a number box or slider focused, that setting changes. So while the user isn't typing somewhere
  // the dialog keeps the focus on a number box of its own, out of sight, and reads the wheel from
  // the way that box's value moves. The first few turns of a session go to the log, because how
  // Photoshop behaves here has changed between versions.
  const WHEEL_BASE = 5000;
  let hoverSeen = 0, wheelSeen = 0, lastWheelAt = 0, keyAt = 0, wheelUnit = 0, catchTimer = null, catchLast = WHEEL_BASE, catchAt = 0, nudge = 0, nudgeTimer = null;
  const pointer = { x: -1, y: -1 };
  const FOCUS_LOG = 12; // how many changes of focus a session may put in the log
  let sliderEl = null, sliderVal = '', sliderAt = 0;
  let focusName = '', focusSeen = 0;
  // a field the user may be typing in, or a list that may be open: the focus is left with those
  const isTyping = (a) => !!a && a.id !== 'wheelCatch' && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && ['range', 'checkbox', 'button', 'file'].indexOf(a.type) < 0));
  // force: take the focus even from a field the user was typing in (the pointer has moved to the preview)
  function holdFocus(force) {
    const c = $('wheelCatch');
    if (!USE_CATCH || !studioOpen || !c) return;
    const a = document.activeElement;
    if (a === c || (!force && isTyping(a))) return;
    try { c.focus(); } catch (e) { /* nothing to be done */ }
  }
  // Is the pointer over the preview? If so the wheel zooms it; anywhere else it scrolls the
  // settings. Photoshop reports the pointer while it moves over the preview, but says nothing when
  // it leaves (no "mouseleave") and little or nothing while it is over the settings. So leaving is
  // worked out: the pointer has gone if it was last seen at the very edge of the preview, or
  // heading for an edge fast enough to have crossed it.
  let overPreview = false, seenAt = null, seenBefore = null, leaveTimer = null;
  function stillOverPreview() {
    const big = views[0];
    if (!overPreview || !big || !seenAt) return false;
    const r = big.wrap.getBoundingClientRect(), p = seenAt, q = seenBefore;
    let x = p.x, y = p.y;
    if (q && p.t > q.t && p.t - q.t < 120) { const k = 150 / (p.t - q.t); x += (p.x - q.x) * k; y += (p.y - q.y) * k; } // where it would be 150 ms on
    return x > r.left + 4 && x < r.right - 4 && y > r.top + 4 && y < r.bottom - 4;
  }
  function leftPreview() {
    overPreview = false;
    if (hover && !drag) { hover = null; placeRing(); }
  }
  function wheelTurn(steps, x, y) {
    const big = views[0], at = { clientX: x, clientY: y };
    if (big && stillOverPreview()) { if (inRect(big.wrap, at)) big.zoomBy(Math.pow(1.15, steps), x, y); else big.zoomBy(Math.pow(1.15, steps)); }
    else {
      const sc = $('scroll');
      // Photoshop would let it run past either end
      sc.scrollTop = clampN(sc.scrollTop - steps * 56, 0, sc.scrollHeight > sc.clientHeight ? sc.scrollHeight - sc.clientHeight : 1e6);
      // Photoshop does not redraw the number boxes when the list is scrolled from a script. A
      // change to the layout makes it: a different one each time (two that cancel out within one
      // frame count as none), and back to normal when the wheel stops.
      nudge = (nudge % 6) + 1;
      sc.style.paddingBottom = 24 + nudge + 'px';
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { sc.style.paddingBottom = '24px'; }, 150);
    }
  }
  function readCatcher(via) {
    const c = $('wheelCatch');
    if (!c) return;
    const v = parseFloat(c.value), now = Date.now();
    if (v === catchLast || isNaN(v)) {
      // put the value back in the middle once the wheel has come to rest (not sooner: Photoshop goes on counting from its own copy)
      if (isNaN(v) || (v !== WHEEL_BASE && now - catchAt > 800)) { c.value = String(WHEEL_BASE); catchLast = WHEEL_BASE; }
      return;
    }
    const d = v - catchLast;
    catchLast = v; catchAt = now;
    if (wheelSeen < 8) { wheelSeen++; log('wheel (focus)', { via, moved: Math.round(d * 1000) / 1000, overPreview: stillOverPreview(), list: [$('scroll').scrollTop, $('scroll').scrollHeight, $('scroll').clientHeight], x: Math.round(pointer.x), y: Math.round(pointer.y), focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }); }
    if (isNaN(d) || now - keyAt < 500 || now - lastWheelAt < 80) return; // typed into, or already handled as a wheel event
    // one notch moves the value by a fixed amount, which differs between versions: take the smallest seen
    const m = Math.abs(d);
    if (!wheelUnit || m < wheelUnit * 0.9) wheelUnit = m;
    wheelTurn(clampN(Math.round(d / wheelUnit), -6, 6), pointer.x, pointer.y);
  }
  function startCatcher() {
    const c = $('wheelCatch');
    if (!USE_CATCH || !c || c._wired) return;
    c._wired = true;
    c.value = String(WHEEL_BASE); catchLast = WHEEL_BASE;
    c.addEventListener('input', () => readCatcher('input'));
    c.addEventListener('change', () => readCatcher('change'));
    c.addEventListener('keydown', (e) => { keyAt = Date.now(); if (e.key !== 'Escape' && e.key !== 'Tab' && e.preventDefault) e.preventDefault(); });
    const track = (over) => (e) => {
      const known = typeof e.clientX === 'number';
      if (known) { pointer.x = e.clientX; pointer.y = e.clientY; }
      if (over && known) {
        seenBefore = seenAt; seenAt = { x: e.clientX, y: e.clientY, t: Date.now() };
        // no word of it leaving will come, so look again once it has had time to
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => { if (overPreview && !drag && !stillOverPreview()) leftPreview(); }, 220);
      }
      if (over === overPreview) return;
      if (!over) return leftPreview();
      overPreview = true;
      holdFocus(true); // the pointer came onto the preview: the wheel is for zooming now
    };
    const wrap = views[0] && views[0].wrap;
    if (wrap) {
      ['mousemove', 'mouseenter'].forEach((type) => wrap.addEventListener(type, track(true)));
      wrap.addEventListener('mouseleave', track(false));
    }
    // these do hear the pointer, and a click is reported everywhere
    [$('bigBar'), $('leftFoot'), $('rightTop'), $('right')].forEach((node) => { if (node) ['mousemove', 'mouseenter'].forEach((type) => node.addEventListener(type, track(false))); });
    document.addEventListener('mousedown', (e) => { if (wrap && typeof e.clientX === 'number') track(inRect(wrap, e))(e); });
    // a setting that changes is being changed by the pointer, which is therefore not over the preview
    $('right').addEventListener('input', () => { if (overPreview && !drag) leftPreview(); });
    // after a click on a button, a slider or nothing in particular, take the focus back
    document.addEventListener('mouseup', () => setTimeout(() => holdFocus(!isTyping(document.activeElement)), 0));
    document.addEventListener('change', (e) => { if (e.target && e.target.tagName === 'SELECT') setTimeout(() => holdFocus(true), 40); });
    document.addEventListener('change', (e) => { if (e.target && e.target.tagName === 'INPUT' && (e.target.type === 'range' || e.target.type === 'checkbox')) setTimeout(() => holdFocus(false), 0); });
    // In case the box changes without telling anyone; and take the focus back whenever nothing
    // has it (a slider that was dragged does not say when it is let go).
    catchTimer = setInterval(() => {
      if (!studioOpen) return;
      readCatcher('poll');
      const a = document.activeElement;
      const name = a ? a.id || a.tagName + (a.type ? ':' + a.type : '') : 'nothing';
      if (name !== focusName) { focusName = name; if (focusSeen++ < FOCUS_LOG) log('focus is on', name); }
      // Take the focus back from anything that is not being typed in: a button that was pressed
      // keeps it otherwise, and the wheel goes to the document. A slider keeps it while it moves.
      if (a === c || isTyping(a)) return;
      if (a && a.tagName === 'INPUT' && a.type === 'range') {
        const now = Date.now();
        if (a !== sliderEl || a.value !== sliderVal) { sliderEl = a; sliderVal = a.value; sliderAt = now; return; }
        if (now - sliderAt < 450) return;
      }
      holdFocus(true);
    }, 70);
  }
  function onWheel(e, via) {
    if (wheelSeen < 8) { wheelSeen++; log('wheel', { via: via || 'document', type: e.type, target: e.target && (e.target.id || e.target.tagName), x: e.clientX, y: e.clientY, dy: e.deltaY, mode: e.deltaMode, wd: e.wheelDelta }); }
    // the same turn of the wheel can arrive by more than one route
    if (e._dsSeen) return;
    e._dsSeen = true;
    const now = Date.now();
    if (via && now - lastWheelAt < 4) return;
    lastWheelAt = now;
    const dy = typeof e.deltaY === 'number' && e.deltaY ? e.deltaY : -(e.wheelDelta || 0);
    if (USE_CATCH) { // go by where the pointer was last seen: the event is aimed at the focused field
      if (e.preventDefault) e.preventDefault();
      if (dy) wheelTurn(dy > 0 ? -1 : 1, typeof e.clientX === 'number' && e.clientX > 0 ? e.clientX : pointer.x, typeof e.clientY === 'number' && e.clientY > 0 ? e.clientY : pointer.y);
      return;
    }
    const right = $('right');
    const big = views[0];
    const overRight = inRect(right, e) || (typeof e.clientX !== 'number' && right.contains(e.target));
    if (!overRight && big && (inRect(big.wrap, e) || (typeof e.clientX !== 'number' && big.wrap.contains(e.target)))) {
      if (e.preventDefault) e.preventDefault();
      if (dy) big.zoomBy(dy > 0 ? 1 / 1.15 : 1.15, e.clientX, e.clientY);
      return;
    }
    if (!overRight) return;
    const target = $('scroll');
    const before = target.scrollTop;
    const delta = dy * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? target.clientHeight : 1);
    // let native scrolling run; only scroll by hand if it didn't
    setTimeout(() => { if (target.scrollTop === before && delta) target.scrollTop = before + delta; }, 30);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const pct = (min, max, step = 1) => ({ min, max, step, mul: 100 });
  const num = (min, max, step = 1) => ({ min, max, step, mul: 1 });
  const shownAngle = () => (fx.autoAngle && lastRef ? lastRef.angle : fx.angle);
  const SECTIONS = [
    { id: 'disp', title: 'Dispersion', fields: [
      { p: 'auto', t: 'check', label: 'Automatic', tip: 'Disperse from the start point automatically. Turn off to disperse only what you paint.' },
      { p: 'pattern', t: 'select', label: 'Starts from', options: D.PATTERNS, tip: 'One side: sweeps across the subject. A point: spreads out from the start point. All edges: eats in from every edge.' },
      { p: 'amount', t: 'range', label: 'Amount', r: pct(0, 100), tip: 'How much of the subject is eaten away' },
      { p: 'angle', t: 'range', label: 'Direction°', r: num(-180, 180), get: shownAngle, set: (v) => { fx.angle = v; fx.autoAngle = false; }, tip: 'Which way the pieces fly: 0 is right, -90 is up' },
      { p: 'roughness', t: 'range', label: 'Edge breakup', r: pct(0, 100), tip: 'How ragged the eaten edge is' },
      { p: 'chunk', t: 'range', label: 'Chunk size', r: pct(0, 100), tip: 'Size of the bites taken out of the edge' },
      { p: 'softness', t: 'range', label: 'Edge softness', r: pct(0, 100), tip: 'Feathering of the eaten edge' },
    ] },
    { id: 'tips', title: 'Brush tips', fields: [{ t: 'tips' }] },
    { id: 'part', title: 'Particles', fields: [
      { p: 'density', t: 'range', label: 'Density', r: pct(0, 100), tip: 'How much material flies off' },
      { p: 'size', t: 'range', label: 'Size', r: pct(0, 100) },
      { p: 'sizeVar', t: 'range', label: 'Size variety', r: pct(0, 100), tip: 'Mix of small and large pieces' },
      { p: 'spin', t: 'range', label: 'Tumble', r: pct(0, 100), tip: 'How much the pieces are turned. 0 keeps squares upright.' },
      { p: 'texture', t: 'range', label: 'Image detail', r: pct(0, 100), tip: 'Pieces carry the picture they were cut from, rather than one flat colour' },
    ] },
    { id: 'motion', title: 'Motion', fields: [
      { p: 'distance', t: 'range', label: 'Strength', r: pct(0, 100), tip: 'How far the pieces are thrown' },
      { p: 'spread', t: 'range', label: 'Spread', r: pct(0, 100), tip: 'How wide the pieces fan out' },
      { p: 'burst', t: 'range', label: 'Burst', r: pct(0, 100), tip: 'Pieces fly outwards from the subject instead of all one way' },
      { p: 'turbulence', t: 'range', label: 'Turbulence', r: pct(0, 100), tip: 'Swirls in the flow' },
      { p: 'turbScale', t: 'range', label: 'Swirl size', r: pct(0, 100) },
      { p: 'gravity', t: 'range', label: 'Rise / fall', r: pct(-100, 100), tip: 'Negative: pieces drift up. Positive: they fall.' },
      { p: 'trail', t: 'range', label: 'Trails', r: pct(0, 100), tip: 'Streaks behind each piece' },
    ] },
    { id: 'look', title: 'Look', fields: [
      { p: 'fade', t: 'range', label: 'Fade out', r: pct(0, 100), tip: 'Pieces fade as they travel' },
      { p: 'shrink', t: 'range', label: 'Shrink', r: pct(0, 100), tip: 'Pieces get smaller as they travel' },
      { p: 'opacity', t: 'range', label: 'Opacity', r: pct(0, 100) },
      { p: 'colorVar', t: 'range', label: 'Colour variety', r: pct(0, 100), tip: 'Lighter and darker pieces' },
      { p: 'seed', t: 'range', label: 'Seed', r: Object.assign(num(1, 999), { whole: true }), tip: 'Same settings, different random pieces' },
    ] },
  ];

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style') e.setAttribute('style', attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && e.appendChild(c));
    return e;
  }
  function fillSelect(sel, options, value) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    options.forEach(([v, l]) => {
      const o = el('option', { value: v, text: l });
      if (v === value) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    setSelect(sel, value);
  }
  function setSelect(sel, value) {
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === String(value)) { sel.selectedIndex = i; break; }
    }
    try { sel.value = String(value); } catch (e) { /* UXP quirk */ }
  }
  // What a <select> is set to. UXP is not consistent about where it reports this, so look in
  // every place and log what was found.
  function selValue(s, e) {
    const opt = s.options && s.options[s.selectedIndex];
    const found = { target: e && e.target ? e.target.value : undefined, value: s.value, index: s.selectedIndex, option: opt ? opt.value : undefined };
    if (e) log('select', s.id || '(inspector)', found);
    for (const v of [found.target, found.value, found.option]) if (v != null && v !== '') return String(v);
    return '';
  }
  const FILLS = [['generative', 'Generative Fill'], ['contentAware', 'Content-Aware Fill'], ['none', 'None (my own)']];
  const QUALITIES = [['600', 'Fast'], ['1000', 'Normal'], ['1600', 'Sharp'], ['2400', 'Max']];
  // UXP puts a dialog's <select>s back to their first option whenever the dialog is shown again,
  // so they are rebuilt from the settings before each show and set again just after.
  function syncSelects(rebuild) {
    if (rebuild) { fillSelect($('fillSel'), FILLS, ui.fill); fillSelect($('qualitySel'), QUALITIES, String(ui.quality)); fillSelect($('presetSel'), presetOptions(), ''); }
    else { setSelect($('fillSel'), ui.fill); setSelect($('qualitySel'), String(ui.quality)); }
  }
  const fmt = (v) => String(Math.round(v * 100) / 100);

  // A slider with a number box beside it.
  //
  // Fine mode (the Fine button) is for precision. A slider is only as precise as it is long, so in
  // fine mode it covers a tenth of the setting's range, around the value it holds, in steps a
  // tenth of the size. Let go near either end and it moves along, so the whole range can still
  // be reached. range.whole marks a setting that only takes whole numbers; fine mode leaves it be.
  const FINE_SPAN = 0.1, FINE_STEP = 0.1;
  const tidy = (v) => Math.round(v * 1e4) / 1e4;
  function rangeField(label, get, set, range, defVal, tip) {
    const { min, max, step, mul } = range;
    const lbl = el('span', { class: 'lbl', text: label, title: (tip ? tip + ' — ' : '') + 'double-click to reset' });
    const slider = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const box = el('input', { type: 'number', class: 'num', step: String(step) });
    const fine = () => !!ui.fine && !range.whole;
    let lo = min, hi = max, framed = '';
    // which part of the range the slider covers
    const frame = (d) => {
      const st = fine() ? step * FINE_STEP : step;
      if (fine()) {
        const span = (max - min) * FINE_SPAN;
        lo = tidy(clampN(Math.round((d - span / 2) / st) * st, min, max - span)); hi = tidy(lo + span);
      } else { lo = min; hi = max; }
      const key = lo + '|' + hi + '|' + st;
      if (key === framed) return;
      framed = key;
      [['min', lo], ['max', hi], ['step', st]].forEach(([k, v]) => { slider.setAttribute(k, String(v)); try { slider[k] = String(v); } catch (e) { /* attribute only */ } });
      box.setAttribute('step', String(st));
    };
    const sync = () => { const d = get() * mul; framed = ''; frame(d); slider.value = String(d); box.value = fmt(d); };
    sync();
    slider.addEventListener('input', () => { const d = parseFloat(slider.value); box.value = fmt(d); set(d / mul); });
    slider.addEventListener('change', () => {
      const d = parseFloat(slider.value);
      box.value = fmt(d); set(d / mul);
      // let go near an end of a fine slider: move it along, so that there is room to go on
      if (fine() && ((d - lo < (hi - lo) * 0.15 && lo > min) || (hi - d < (hi - lo) * 0.15 && hi < max))) { framed = ''; frame(d); slider.value = String(d); }
    });
    // the box applies as it changes (typing, the arrow keys, the wheel), and is tidied when it is left
    box.addEventListener('input', () => {
      const d = parseFloat(box.value);
      if (isNaN(d) || d < min || d > max) return;
      set(d / mul);
      if (d < lo || d > hi) { framed = ''; frame(d); }
      slider.value = String(d);
    });
    // Up and Down nudge the value by one step, ten with Shift (Photoshop's number boxes don't do it themselves)
    box.addEventListener('keydown', (e) => {
      const up = e.key === 'ArrowUp' || e.key === 'Up', down = e.key === 'ArrowDown' || e.key === 'Down';
      if (!up && !down) return;
      if (e.preventDefault) e.preventDefault();
      const st = (fine() ? step * FINE_STEP : step) * (e.shiftKey ? 10 : 1), cur = parseFloat(box.value);
      const d = tidy(clampN((isNaN(cur) ? get() * mul : cur) + (up ? st : -st), min, max));
      box.value = fmt(d); set(d / mul);
      if (d < lo || d > hi) { framed = ''; frame(d); }
      slider.value = String(d);
    });
    box.addEventListener('change', () => { const d = parseFloat(box.value); if (isNaN(d)) return sync(); set(clampN(d, min, max) / mul); sync(); });
    lbl.addEventListener('dblclick', () => { if (defVal != null) { set(defVal); sync(); } });
    const row = el('div', { class: 'field' }, [lbl, slider, box]);
    row._sync = sync;
    return row;
  }
  function setFine(on) {
    ui.fine = !!on;
    store.set(LS_UI, ui);
    $('btnFine').className = 'toggle' + (ui.fine ? ' on' : '');
    syncInspectorValues();
  }

  // ---------------------------------------------------------------------------
  // The settings column, built from the DSUI modules (ui-controls, ui-tips, ui-previews)
  // ---------------------------------------------------------------------------
  const C = () => window.DSUI.controls, P = () => window.DSUI.previews;
  const ACCENT = { disp: '#F0A040', tips: '#C46BD8', part: '#3FB5A3', motion: '#5CC4E8', look: '#D8C25A' };
  let tipsUI = null, livePreviews = [];
  // redraw the live pictures on the open tab (each skips the work when its own settings did not
  // change; the others catch up when their tab is opened)
  function syncPreviews() { livePreviews.forEach((p) => { if (p._tab !== ui.tab) return; try { p._sync(); } catch (e) { /* a picture is not worth an error */ } }); }

  // The groups of settings are tabs. Only the open one is laid out, which keeps scrolling and
  // every change of layout cheap: UXP lays out the whole column each time anything in it moves.
  const TABS = [
    { id: 'subject', label: 'Subject', icon: 'subject', color: '#4C9BFF', title: 'Subject, background, your presets and the preview quality' },
    { id: 'paint', label: 'Paint', icon: 'paint', color: '#4C9BFF', title: 'Paint where the subject disperses or stays' },
    { id: 'disp', label: 'Dispersion', icon: 'dispersion', color: ACCENT.disp, title: 'Where and how much of the subject breaks away' },
    { id: 'tips', label: 'Tips', icon: 'tips', color: ACCENT.tips, title: 'The brush tips the pieces are cut with' },
    { id: 'part', label: 'Particles', icon: 'particles', color: ACCENT.part, title: 'How many pieces, and how big' },
    { id: 'motion', label: 'Motion', icon: 'motion', color: ACCENT.motion, title: 'How the pieces fly' },
    { id: 'look', label: 'Look', icon: 'look', color: ACCENT.look, title: 'Fading, shrinking, colour and the random seed' },
  ];
  let tabSwitch = null;
  function showTab(id) {
    if (!TABS.some((t) => t.id === id)) id = 'subject';
    const changed = ui.tab !== id;
    ui.tab = id;
    if (changed) store.set(LS_UI, ui);
    TABS.forEach((t) => { const p = $('tab-' + t.id); if (p) p.style.display = t.id === id ? '' : 'none'; });
    if (tabSwitch) tabSwitch.setValue(id);
    if (changed) $('scroll').scrollTop = 0;
    syncPreviews();
  }
  function renderTabs() {
    const host = $('tabBar');
    while (host.firstChild) host.removeChild(host.firstChild);
    tabSwitch = C().tabs({ options: TABS.map((t) => ({ value: t.id, label: t.label, icon: t.icon, color: t.color, title: t.title })), get: () => ui.tab, set: (v) => showTab(v),
      onMeasured: (px) => { log('tab names need', { px: Math.round(px) }); setTimeout(() => layoutAll(true), 0); } }); // now the column can be sized for the names
    host.appendChild(tabSwitch);
  }

  function renderInspector() {
    const host = $('inspector');
    while (host.firstChild) host.removeChild(host.firstChild);
    livePreviews = [];
    const c = C(), pv = P();
    SECTIONS.forEach((sec) => {
      const body = el('div', { class: 'dsc-secBody' });
      const card = el('div', { class: 'dsc-section open tabCard', id: 'sec-' + sec.id }, [body]);
      const preview = pv && { part: pv.particles, motion: pv.motion, look: pv.look }[sec.id];
      if (preview) { const p = preview(() => fx); p._tab = sec.id; livePreviews.push(p); body.appendChild(p); }
      let tiles = null;
      sec.fields.forEach((fd) => {
        if (fd.t === 'tips') {
          const box = el('div', { class: 'tipsHost' });
          body.appendChild(box);
          tipsUI = window.DSUI.tips.mount(box, {
            getTips: () => fx.tips,
            setTips: (m) => { fx.tips = m; commit(); },
            tipList: () => D.tipList(),
            tipPreview: (id, n) => D.tipPreview(id, n),
            deleteCustomTip: (id) => deleteTip(id),
            overlayHost: $('right'),
            // Photoshop draws native controls above HTML laid over them: hide those under the sheet
            onLibrary: (open, sheet) => {
              const nodes = $('right').querySelectorAll('select, input, button');
              for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (sheet && sheet.contains(n)) continue;
                n.style.visibility = open ? 'hidden' : '';
              }
            },
          });
          return;
        }
        const get = fd.get || (() => fx[fd.p]);
        const set = (v) => { if (fd.set) fd.set(v); else fx[fd.p] = v; commit(); };
        if (fd.p === 'seed' && pv) {
          body.appendChild(pv.seedRow({ get: () => fx, set: (v) => { fx.seed = v; commit(); } }));
          return;
        }
        if (fd.p === 'angle') {
          body.appendChild(c.dial({ get: shownAngle, set: (v) => { fx.angle = v; fx.autoAngle = false; commit(); },
            isAuto: () => !!fx.autoAngle, onAuto: () => { fx.autoAngle = true; commit(); } }));
          return;
        }
        if (fd.t === 'range') {
          const h = c.HINTS[fd.p] || [];
          body.appendChild(c.slider(Object.assign({}, fd.r, { label: fd.label, get, set, def: D.DEFAULTS[fd.p], tip: fd.tip,
            lo: h[0], hi: h[1], accent: ACCENT[sec.id], bipolar: fd.r.min < 0, isFine: () => !!ui.fine })));
          if (fd.p === 'colorVar' && pv) { const strip = pv.colourStrip(() => fx); strip._tab = sec.id; livePreviews.push(strip); body.appendChild(strip); }
        } else if (fd.t === 'check') {
          body.appendChild(c.toggle({ label: fd.p === 'auto' ? 'Automatic dispersion' : fd.label, tip: fd.tip, get,
            hint: fd.p === 'auto' ? (on) => (on ? 'Disperses from the start point by itself.' : 'Off: only the regions you paint disperse.') : null,
            set: (v) => { set(v); if (tiles) tiles._sync(); } }));
        } else if (fd.t === 'select') {
          body.appendChild(el('div', { class: 'subHead', text: fd.label }));
          tiles = c.tiles({ options: fd.options.map(([value, label]) => ({ value, label })), get, set, disabled: () => !fx.auto });
          body.appendChild(tiles);
        }
      });
      host.appendChild(el('div', { class: 'tabPanel', id: 'tab-' + sec.id }, [card]));
    });
    showTab(ui.tab);
  }
  function deleteTip(id) {
    customTips = customTips.filter((t) => t.id !== id);
    store.set(LS_TIPS, customTips);
    applyCustomTips();
    delete fx.tips[id];
    fx = D.normalize(fx);
    if (tipsUI) tipsUI.refresh();
    commit();
  }
  // refresh only the values (after dragging on the preview, undo, a preset)
  function syncInspectorValues() {
    ['inspector', 'brushFields'].forEach((id) => {
      const rows = $(id).querySelectorAll('.field');
      for (let i = 0; i < rows.length; i++) if (rows[i]._sync) rows[i]._sync();
    });
    if (tipsUI) tipsUI.refresh();
    syncPreviews();
  }
  let toolSwitch = null, brushPic = null;
  function renderBrushFields() {
    const host = $('brushFields'), c = C();
    while (host.firstChild) host.removeChild(host.firstChild);
    const save = () => { store.set(LS_UI, ui); placeRing(); };
    const fine = () => !!ui.fine;
    toolSwitch = c.segmented({
      options: [
        { value: 'aim', label: 'Aim', icon: 'aim', color: '#4C9BFF', title: 'Drag the dot to move the start point; drag the arrow tip to set direction and strength' },
        { value: 'add', label: 'Disperse', icon: 'disperse', color: '#F0A040', title: 'Paint the parts that should disperse' },
        { value: 'protect', label: 'Protect', icon: 'protect', color: '#4FC08D', title: 'Paint the parts that must stay intact' },
        { value: 'erase', label: 'Erase', icon: 'erase', color: '#C8C8C8', title: 'Rub out paint' },
      ],
      get: () => (tool === 'box' ? '' : tool),
      set: (v) => setTool(v),
      extra: c.iconButton({ icon: 'trash', label: 'Clear', title: 'Remove all paint', onClick: () => { if (fx.strokes.length) { snapshot(); fx.strokes = []; commit(); } } }),
    });
    host.appendChild(toolSwitch);
    const preview = (brushPic = c.brushPreview({ get: () => ({ mode: tool === 'box' ? 'aim' : tool, size: ui.brush, hard: ui.hard, flow: ui.flow, blend: fx.blend }) }));
    const sl = (label, get, set, r, def, tip) => c.slider(Object.assign({}, r, { label, get, set, def, tip, accent: '#4C9BFF', isFine: fine }));
    const sliders = [
      sl('Size', () => ui.brush, (v) => { ui.brush = v; save(); preview._sync(); }, pct(1, 40), 0.08, 'Brush width, as a share of the picture'),
      sl('Edge', () => ui.hard, (v) => { ui.hard = v; save(); preview._sync(); }, pct(0, 100), 0.5, 'Hardness: 0 is a soft edge, 100 a hard one'),
      sl('Strength', () => ui.flow, (v) => { ui.flow = v; save(); preview._sync(); }, pct(5, 100), 1, 'How strongly a stroke paints. At 50 a Protect stroke holds back half of the dispersion, and a Disperse stroke lets only part of the subject go'),
    ];
    const h = c.HINTS.blend;
    const blend = c.slider(Object.assign({}, pct(0, 100), { label: 'Blend', get: () => fx.blend, set: (v) => { fx.blend = v; commit(); preview._sync(); }, def: D.DEFAULTS.blend,
      tip: 'How far all paint fades out past its edge. 0 stops the dispersion at the edge of the paint; higher lets it taper off, with fewer, smaller pieces that stay closer', lo: h[0], hi: h[1], accent: '#4C9BFF', isFine: fine }));
    host.appendChild(c.brushBlock({ preview, sliders, below: blend }));
  }

  const HINTS = {
    aim: 'Drag the dot to move where the dispersion starts · drag the arrow tip for direction and strength (Shift snaps to 15°) · drag elsewhere or right-drag to pan · wheel to zoom',
    add: 'Paint over the parts that should disperse · right-drag to pan · wheel to zoom',
    protect: 'Paint over the parts that must stay intact · right-drag to pan · wheel to zoom',
    erase: 'Rub out paint · right-drag to pan · wheel to zoom',
    box: 'Drag a box around the subject you want — the dialog closes for a moment while Photoshop selects it',
  };
  function setTool(t) {
    tool = t;
    $('btnSubjBox').className = 'toggle' + (tool === 'box' ? ' on' : '');
    if (toolSwitch) toolSwitch.setValue(tool === 'box' ? '' : tool);
    if (brushPic) brushPic._sync();
    $('hint').textContent = HINTS[tool];
    boxDrag = null;
    if (tool === 'aim' || tool === 'box') hover = null;
    placeRing();
    kick();
  }
  function setViewMode(m) {
    viewMode = viewMode === m ? 'result' : m;
    $('btnBefore').className = 'toggle' + (viewMode === 'before' ? ' on' : '');
    $('btnMask').className = 'toggle' + (viewMode === 'mask' ? ' on' : '');
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  function presetOptions() {
    const o = [['', '— Presets —']];
    PRESETS.forEach((p, i) => o.push(['b' + i, p.name]));
    userPresets.forEach((p, i) => o.push(['u' + i, '★ ' + p.name]));
    return o;
  }
  function loadPreset(key) {
    let p = null;
    if (key[0] === 'b') p = PRESETS[+key.slice(1)];
    else if (key[0] === 'u') p = userPresets[+key.slice(1)];
    if (!p) return;
    D.PRESET_KEYS.forEach((k) => { if (p.state[k] != null) fx[k] = k === 'tips' ? Object.assign({}, p.state[k]) : p.state[k]; });
    fx = D.normalize(fx);
    if (key[0] === 'u') $('presetName').value = p.name;
    renderInspector(); commit();
  }
  function savePreset() {
    const name = ($('presetName').value || '').trim() || 'My preset ' + (userPresets.length + 1);
    const state = {};
    D.PRESET_KEYS.forEach((k) => (state[k] = k === 'tips' ? Object.assign({}, fx.tips) : fx[k]));
    const i = userPresets.findIndex((p) => p.name === name);
    if (i >= 0) userPresets[i] = { name, state }; else userPresets.push({ name, state });
    store.set(LS_USER, userPresets);
    fillSelect($('presetSel'), presetOptions(), 'u' + (i >= 0 ? i : userPresets.length - 1));
    status('Saved preset “' + name + '”.');
  }
  function deletePreset() {
    const v = selValue($('presetSel'));
    if (!v || v[0] !== 'u') return status('Choose one of your ★ presets to delete it.');
    const p = userPresets.splice(+v.slice(1), 1)[0];
    store.set(LS_USER, userPresets);
    fillSelect($('presetSel'), presetOptions(), '');
    status('Deleted preset “' + p.name + '”.');
  }
  // settings for a subject that has not been dispersed before: the last look, aimed afresh
  function freshAim() { fx.strokes = []; fx.autoOrigin = true; fx.autoAngle = true; }

  // ---------------------------------------------------------------------------
  // Preview rendering
  // ---------------------------------------------------------------------------
  // The effect is rendered whenever a setting changes, at one of up to three sizes: the preview's
  // own, a half and a quarter (each takes about a quarter of the time of the one before).
  //  - Shown at about half size or smaller (a tall picture fitted to the view, say), the half-size
  //    render is the one that is used: on screen it looks the same.
  //  - While something is moving (a slider, a brush stroke, a handle on the preview), each frame is
  //    drawn at the largest of those sizes that keeps within DRAFT_MS, and the proper one follows
  //    when it stops. A render blocks the whole dialog, so a slow one makes everything else lag too.
  //  - The Mask view leaves the particles out: it doesn't show them.
  const DRAFT_MS = 40, SMALL_BELOW = 0.56;
  const FINE_DRAG = 0.2; // in fine mode a handle on the preview moves this share of the pointer's movement
  const levels = () => [ctx, ctxDraft, ctxTiny];
  const shownSmall = () => !!ctxDraft && !!views[0] && previewW > 0 && views[0].metrics().s <= SMALL_BELOW;
  let queued = false, rendering = false, needRender = false, forceFull = false, fullTimer = null;
  const lastMs = [0, 0, 0]; // how long the last render at each size took
  // how long a render at size lv is likely to take: the last one, or a quarter of the size above
  const estMs = (lv) => lastMs[lv] || (lv > 0 && lastMs[lv - 1] ? lastMs[lv - 1] / 4 : 0);
  // after a brush stroke or a handle drag: the proper render straight away
  function settle() { clearTimeout(fullTimer); fullTimer = null; forceFull = true; scheduleRender(); }
  let lastComp = null, lastScale = 1, lastDrawScale = 1; // the clean composite, which size it is, and its exact width relative to the preview
  let hover = null, drag = null, boxDrag = null, pendingBox = null;
  let perf = { n: 0, drafts: 0, render: 0, comp: 0, enc: 0, slow: 0, w: 0, h: 0 }, lastSig = '', soonTimer = null;
  function logPerf() {
    if (!perf.n) return;
    const f = perf.n - perf.drafts, r1 = (v, n) => (n ? Math.round((v / n) * 10) / 10 : 0);
    log('preview timing', { size: perf.w + 'x' + perf.h, frames: perf.n, drafts: perf.drafts, small: perf.small || 0, renderMs: r1(perf.render, perf.n), compositeMs: r1(perf.comp, perf.n), encodeMs: r1(perf.enc, perf.encN || 0), encodes: perf.encN || 0, slowestMs: perf.slow, lastMs: lastMs.slice(), engine: D.engine || 'js' });
  }
  function scheduleRender() { needRender = true; kick(); }
  // for changes that only move the guides: wait until they settle
  function kickSoon() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => {
      if (lastComp && lastScale !== (shownSmall() ? 0.5 : 1) && !fullTimer) needRender = true; // zoomed across the line: render at the other size
      kick();
    }, 140);
  }
  // While a stroke or a handle is being dragged, renders are spaced at least DRAG_GAP_MS apart,
  // so that the dialog can draw the brush outline (and take the next mouse moves) in between:
  // a render holds up everything else in the dialog until it is done.
  const DRAG_GAP_MS = 24;
  let renderEnd = 0;
  function kick() {
    if (queued) return;
    queued = true;
    const wait = drag && drag.mode !== 'pan' ? Math.max(0, renderEnd + DRAG_GAP_MS - Date.now()) : 0;
    setTimeout(doRender, wait);
  }
  async function doRender() {
    queued = false;
    if (!ctx) return;
    if (rendering) { kick(); return; }
    rendering = true;
    try {
      if (needRender) {
        needRender = false;
        const small = shownSmall(), base = small ? 1 : 0, L = levels();
        let lv = base;
        if (!forceFull) while (lv < 2 && L[lv + 1] && estMs(lv) > DRAFT_MS) lv++;
        const draft = lv > base;
        forceFull = false;
        const c = L[lv];
        const t0 = Date.now();
        const res = viewMode === 'before' ? null : D.render(c, fx, viewMode === 'mask' ? { noParticles: true } : undefined);
        const t1 = Date.now();
        lastComp = D.composite(c, res, { view: viewMode });
        perf.n++; perf.render += t1 - t0; perf.comp += Date.now() - t1; if (draft) perf.drafts++;
        if (Date.now() - t0 > perf.slow) perf.slow = Date.now() - t0;
        lastSig = '';
        lastScale = [1, 0.5, 0.25][lv];
        lastDrawScale = c.W / ctx.W;
        lastRef = res ? res.resolved.ref : D.resolve(c, fx).ref;
        clearTimeout(fullTimer); fullTimer = null;
        lastMs[lv] = Date.now() - t0;
        // the proper render once things stop moving (a brush stroke or a handle still held waits for the mouse to come up)
        const later = () => { if (drag) { fullTimer = setTimeout(later, 120); return; } fullTimer = null; forceFull = true; scheduleRender(); };
        if (draft) fullTimer = setTimeout(later, 240);
        if (small) perf.small = (perf.small || 0) + 1;
      }
      if (!lastComp) { rendering = false; return; }
      const o = overlay(), sig = o ? JSON.stringify(o) : '-';
      if (sig !== lastSig) {
        lastSig = sig;
        let img = lastComp;
        if (o) { img = { width: lastComp.width, height: lastComp.height, data: new Uint8ClampedArray(lastComp.data) }; D.drawOverlay(img, o); }
        const t2 = Date.now();
        previewUrl = await bridge.encode(img);
        perf.enc += Date.now() - t2; perf.encN = (perf.encN || 0) + 1;
        views.forEach((v) => v.show());
      }
    } catch (e) {
      status('Preview error: ' + (e.message || e), true);
      log('preview error', e);
    }
    rendering = false;
    renderEnd = Date.now();
  }
  // where the aim handle sits, in preview pixels
  function aimGeometry() {
    if (!lastRef) return null;
    const unit = lastRef.unitN * Math.max(previewW, previewH);
    const ox = lastRef.ox * previewW, oy = lastRef.oy * previewH, a = (lastRef.angle * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    // shorten the arrow if it would leave the picture, so its tip can always be grabbed
    const pad = Math.min(previewW, previewH) * 0.03;
    let arm = unit * (0.35 + 1.1 * fx.distance), clamped = false;
    const limit = (o, d, lo, hi) => (d > 1e-6 ? (hi - o) / d : d < -1e-6 ? (lo - o) / d : Infinity);
    const room = Math.max(unit * 0.15, Math.min(limit(ox, dx, pad, previewW - pad), limit(oy, dy, pad, previewH - pad)));
    if (arm > room) { arm = room; clamped = true; }
    return { ox, oy, tx: ox + dx * arm, ty: oy + dy * arm, unit, clamped };
  }
  function overlay() {
    const v = views[0];
    if (!v || !previewW) return null;
    const f = lastDrawScale, o = { k: f / (v.metrics().s || 1) };
    let any = false;
    if (ui.guides && viewMode !== 'before' && tool === 'aim' && fx.auto) {
      const g = aimGeometry();
      if (g) { o.aim = { ox: g.ox * f, oy: g.oy * f, tx: g.tx * f, ty: g.ty * f }; any = true; }
    }
    if (boxDrag) { o.box = { x0: boxDrag.x0 * f, y0: boxDrag.y0 * f, x1: boxDrag.x1 * f, y1: boxDrag.y1 * f }; any = true; }
    return any ? o : null;
  }

  // ---------------------------------------------------------------------------
  // Preview mouse interaction
  // ---------------------------------------------------------------------------
  function startPan(v, e) {
    if (v.cx == null) { v.cx = previewW / 2; v.cy = previewH / 2; }
    drag = { mode: 'pan', view: v, sx: e.clientX, sy: e.clientY, cx0: v.cx, cy0: v.cy };
  }
  function addPoint(stroke, p, force) {
    const n = stroke.pts.length, x = p.x / previewW, y = p.y / previewH;
    if (!force && n >= 2) {
      const dx = (x - stroke.pts[n - 2]) * previewW, dy = (y - stroke.pts[n - 1]) * previewH;
      if (Math.hypot(dx, dy) < Math.max(1, ui.brush * Math.max(previewW, previewH) * 0.06)) return false;
    }
    stroke.pts.push(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
    return true;
  }
  function onDown(v, e) {
    if (!session) return;
    e.preventDefault && e.preventDefault();
    if (e.button === 1 || e.button === 2) return startPan(v, e); // middle / right button always pans
    const p = v.point(e);
    if (!p) return startPan(v, e);
    if (tool === 'box') {
      boxDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      drag = { mode: 'box', view: v };
      return kick();
    }
    if (tool === 'add' || tool === 'protect' || tool === 'erase') {
      snapshot();
      const stroke = { mode: tool, size: ui.brush, hard: ui.hard, flow: ui.flow, pts: [] };
      addPoint(stroke, p, true);
      fx.strokes.push(stroke);
      drag = { mode: 'paint', view: v, stroke };
      hover = p;
      return scheduleRender();
    }
    const g = fx.auto && viewMode !== 'before' ? aimGeometry() : null;
    if (g) {
      const grab = 11 * p.k;
      // a shortened arrow no longer shows the strength, so dragging it only turns it
      // p0, and what the settings were then: in fine mode the handle moves a fifth as far as the pointer
      if (Math.hypot(p.x - g.tx, p.y - g.ty) < grab) { drag = { mode: 'tip', view: v, turnOnly: g.clamped, p0: p, a0: shownAngle(), d0: fx.distance }; return; }
      if (Math.hypot(p.x - g.ox, p.y - g.oy) < grab) { drag = { mode: 'origin', view: v, dx: g.ox - p.x, dy: g.oy - p.y, p0: p, ox0: g.ox, oy0: g.oy }; return; }
    }
    startPan(v, e);
  }
  function onMove(e) {
    const v = drag ? drag.view : views[0];
    if (!v || !session) return;
    if (!drag) {
      if (tool === 'add' || tool === 'protect' || tool === 'erase') {
        const pl = v.place, inside = pl && e.clientX >= pl.wrapLeft && e.clientX < pl.wrapLeft + pl.wrapW && e.clientY >= pl.wrapTop && e.clientY < pl.wrapTop + pl.wrapH;
        const p = inside ? v.point(e) : null;
        if (hoverSeen < 6) { hoverSeen++; log('hover', { x: e.clientX, y: e.clientY, inside: !!inside, wrap: pl ? [pl.wrapLeft, pl.wrapTop, pl.wrapW, pl.wrapH] : null }); }
        if (p || hover) { hover = p; scheduleRing(); }
      }
      return;
    }
    if (drag.mode === 'pan') {
      const s = v.metrics().s;
      v.cx = drag.cx0 - (e.clientX - drag.sx) / s;
      v.cy = drag.cy0 - (e.clientY - drag.sy) / s;
      v.layout();
      return;
    }
    const p = v.point(e);
    if (!p) return;
    if (drag.mode === 'box') { boxDrag.x1 = p.x; boxDrag.y1 = p.y; return kick(); }
    if (drag.mode === 'paint') {
      hover = p; placeRing();
      if (addPoint(drag.stroke, p)) scheduleRender();
      return;
    }
    if (drag.mode === 'origin') {
      fx.autoOrigin = false;
      const ox = ui.fine ? drag.ox0 + (p.x - drag.p0.x) * FINE_DRAG : p.x + drag.dx, oy = ui.fine ? drag.oy0 + (p.y - drag.p0.y) * FINE_DRAG : p.y + drag.dy;
      fx.originX = clampN(ox / previewW, -0.5, 1.5);
      fx.originY = clampN(oy / previewH, -0.5, 1.5);
      return scheduleRender();
    }
    if (drag.mode === 'tip') {
      const g = aimGeometry();
      if (!g) return;
      // while the start point is automatic it follows the direction, so aim from the subject's middle
      const fromX = fx.autoOrigin && lastRef ? lastRef.cx * previewW : g.ox, fromY = fx.autoOrigin && lastRef ? lastRef.cy * previewH : g.oy;
      const deg = (q) => (Math.atan2(q.y - fromY, q.x - fromX) * 180) / Math.PI;
      const reach = (q) => (Math.hypot(q.x - g.ox, q.y - g.oy) / g.unit - 0.35) / 1.1;
      let a = deg(p), far = reach(p);
      if (ui.fine) { // a fifth of the way the pointer has turned and travelled since it took hold
        a = drag.a0 + ((((a - deg(drag.p0)) % 360) + 540) % 360 - 180) * FINE_DRAG;
        a = ((a + 540) % 360) - 180;
        far = drag.d0 + (far - reach(drag.p0)) * FINE_DRAG;
      }
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      fx.angle = Math.round(a * (ui.fine ? 100 : 10)) / (ui.fine ? 100 : 10);
      fx.autoAngle = false;
      if (!drag.turnOnly) fx.distance = clampN(far, 0, 1);
      scheduleRender();
    }
  }
  function onUp() {
    if (!drag) return;
    const mode = drag.mode;
    drag = null;
    if (mode === 'pan') return;
    if (mode === 'box') {
      const b = boxDrag;
      boxDrag = null;
      if (b && Math.abs(b.x1 - b.x0) > previewW * 0.02 && Math.abs(b.y1 - b.y0) > previewH * 0.02) {
        pendingBox = {
          x0: clampN(Math.min(b.x0, b.x1) / previewW, 0, 1), y0: clampN(Math.min(b.y0, b.y1) / previewH, 0, 1),
          x1: clampN(Math.max(b.x0, b.x1) / previewW, 0, 1), y1: clampN(Math.max(b.y0, b.y1) / previewH, 0, 1),
        };
        return closeStudio('subject:box');
      }
      return kick();
    }
    syncInspectorValues();
    commit();
    settle();
  }

  // ---------------------------------------------------------------------------
  // Session: reading the document, showing the dialog, writing the result
  // ---------------------------------------------------------------------------
  // Photoshop won't read or write pixels while a modal dialog is open, so anything that touches
  // the document (picking the subject, building the layers, applying) closes the dialog, does the
  // work and opens it again.
  let studioOpen = false, busy = false;
  function closeStudio(reason) {
    if (!studioOpen) return;
    if (saveTimer) saveState();
    const dlg = $('studio');
    try { dlg.close(reason); } catch (e) { log('close error', e); }
    if (bridge._resolve) bridge._resolve(reason); // browser harness: don't rely on the async close event
  }
  function status(msg, err) {
    const s = $('status');
    if (s) { s.textContent = msg || ''; s.className = err ? 'err' : ''; }
    // with the dialog closed there's nowhere to show an error, so raise a Photoshop alert
    if (err && IS_UXP && !studioOpen) bridge.alert(msg);
  }
  function sessionNote() {
    if (!session) return '';
    if (session.note) return session.note;
    if (session.approx) return 'The background behind the subject is a rough guess for now. It is filled in properly when you press Build now, Apply or OK.';
    return 'Ready — ' + bridge.describe();
  }
  function updateLabels() {
    $('modeLbl').textContent = session ? (session.editing ? 'Editing effect' : 'New effect') : '';
    $('btnGenerate').disabled = !session || session.built;
    $('subjectNote').textContent = session && session.built
      ? 'The subject and background layers are in the document. Picking another subject replaces them.'
      : 'Tip: select something in Photoshop before opening this dialog to use it as the subject.';
  }
  async function openStudio(req) {
    if (studioOpen || busy) return;
    busy = true;
    req = req || { subject: 'init' };
    let s = null;
    try {
      s = await bridge.begin({ subject: req.subject, box: req.box, quality: +ui.quality, fill: ui.fill });
    } catch (e) {
      busy = false;
      log('begin failed', req, e);
      const msg = e.message || String(e);
      if (e.recoverable && session) {
        // the new subject couldn't be found: go back to the one we had
        if (IS_UXP) bridge.alert(msg);
        setTimeout(() => openStudio({ subject: 'keep', carry: msg }), 30);
      } else { session = null; ctx = ctxDraft = ctxTiny = null; status(msg, true); }
      return;
    }
    busy = false;
    if (req.subject === 'init') {
      const saved = s.key ? store.get(LS_FX + s.key, null) : null;
      if (saved) fx = D.normalize(saved); else freshAim();
      undoStack.length = redoStack.length = 0;
      lastSnapshot = JSON.stringify(fx);
      views.forEach((v) => { v.zoom = 1; v.cx = null; });
      setTool('aim');
    } else if (req.subject !== 'keep') { freshAim(); setTool('aim'); }
    session = s;
    if (req.carry) session.note = req.carry;
    ctx = D.prepare(s);
    const half = s.width * s.height > 250000 ? D.halve(s) : null;
    ctxDraft = half ? D.prepare(half) : null;
    ctxTiny = half && half.width * half.height > 100000 ? D.prepare(D.halve(half)) : null;
    previewW = s.width; previewH = s.height; docW = s.docW;
    lastMs[0] = lastMs[1] = lastMs[2] = 0; lastComp = null; hover = null; boxDrag = null;
    renderInspector(); renderBrushFields(); updateLabels();
    syncSelects(true);
    perf = { n: 0, drafts: 0, render: 0, comp: 0, enc: 0, slow: 0, w: s.width, h: s.height };
    hoverSeen = 0; wheelSeen = 0; focusSeen = 0; focusName = '';
    status(sessionNote(), !!req.carry);
    studioOpen = true;
    scheduleRender();
    setTimeout(() => { layoutAll(true); syncSelects(false); }, 60);
    setTimeout(() => { layoutAll(true); syncSelects(false); holdFocus(true); }, 300);
    if (USE_CATCH) {
      // A dialog that has just opened does not have the keyboard, and the wheel would go to the
      // document behind it. Focusing the dialog itself gets it; the wheel box can take over from there.
      const who = () => { const a = document.activeElement; return a ? a.id || a.tagName : null; };
      setTimeout(() => { try { $('studio').focus(); } catch (e) { log('focusing the dialog failed', e); } }, 350);
      setTimeout(() => log('focus after opening', who()), 1500);
    }
    let reason = null;
    try { reason = await bridge.showDialog($('studio')); } catch (e) { log('dialog error', e); }
    studioOpen = false;
    log('dialog closed', reason);
    logPerf();
    snapshot();
    const again = (r) => setTimeout(() => openStudio(r), 30);
    if (reason === 'ok') {
      const err = await runApply();
      if (!err) { await bridge.end(); session = null; } else again({ subject: 'keep', carry: err });
    } else if (reason === 'apply') {
      again({ subject: 'keep', carry: await runApply() });
    } else if (reason === 'generate') {
      let err = '';
      busy = true;
      try { await bridge.generate(ui.fill); } catch (e) { log('build failed', e); err = 'Could not build the layers: ' + (e.message || e); status(err, true); }
      busy = false;
      again({ subject: 'keep', carry: err });
    } else if (reason === 'quality') again({ subject: 'keep' });
    else if (reason === 'subject:auto') again({ subject: 'auto' });
    else if (reason === 'subject:layer') again({ subject: 'layer' });
    else if (reason === 'subject:box') again({ subject: 'box', box: pendingBox });
    else {
      try { await bridge.cancel(); } catch (e) { log('cancel failed', e); }
      session = null;
    }
  }
  // returns '' when it worked, or what went wrong
  async function runApply() {
    busy = true;
    const t0 = Date.now();
    try {
      // pin the full-size render to what the preview showed
      const key = await bridge.apply(fx, D.resolve(ctx, fx).ref, ui.fill);
      if (key) store.set(LS_FX + key, fx);
      log('applied in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's', { key });
      busy = false;
      return '';
    } catch (e) {
      busy = false;
      log('apply error', e);
      const msg = 'Apply failed: ' + (e.message || e);
      status(msg, true);
      return msg;
    }
  }
  // One click: find the subject, fill the background, disperse with the current look. No dialog.
  async function quickDisintegrate() {
    if (studioOpen || busy) return;
    busy = true;
    try {
      const q = D.normalize(fx);
      q.strokes = []; q.autoOrigin = true; q.autoAngle = true; q.auto = true;
      const key = await bridge.quick(q, ui.fill);
      if (key) store.set(LS_FX + key, q);
    } catch (e) {
      log('quick failed', e);
      status(e.message || String(e), true);
    }
    busy = false;
  }

  // Makes a brush tip out of whatever is selected in the document.
  async function newBrushTip() {
    if (studioOpen || busy) return;
    busy = true;
    try {
      if (customTips.length >= MAX_TIPS) throw new Error('You already have ' + MAX_TIPS + ' tips of your own. Delete one in the dialog (Brush tips \u203a My tips) first.');
      const tip = await bridge.captureTip();
      if (!tip) throw new Error('There is nothing there to make a brush tip from.');
      let num = customTips.length + 1;
      while (customTips.some((t) => t.label === 'My tip ' + num)) num++;
      customTips.push({ id: 'c' + Date.now().toString(36), label: 'My tip ' + num, n: tip.n, b64: toBase64(tip.data) });
      store.set(LS_TIPS, customTips);
      applyCustomTips();
      log('new brush tip', { n: tip.n, from: tip.from, count: customTips.length });
      const made = { selection: 'from the selection', alpha: 'from the layer\u2019s shape', dark: 'from the dark parts of the layer' }[tip.from] || '';
      bridge.alert('saved \u201cMy tip ' + num + '\u201d ' + made + '. Open the dialog and raise its slider under Brush tips \u203a My tips to use it.');
    } catch (e) {
      log('new brush tip failed', e);
      status(e.message || String(e), true);
    }
    busy = false;
  }

  // ---------------------------------------------------------------------------
  // Bridges
  // ---------------------------------------------------------------------------
  function makeUxpBridge() {
    const photoshop = require('photoshop');
    const { app, core, imaging, action, constants } = photoshop;
    const SRGB = 'sRGB IEC61966-2.1';
    const NAME = 'Disintegration', SUBJ = 'Subject', PART = 'Particles', FILL = 'Background fill';
    let profile = SRGB;
    // The effect being worked on: { docId, base (history state to return to on Cancel), activeId,
    // key (name tag of the layer group once it exists), mode, srcLayerId, fill, editing, bits, note }
    let sess = null;
    let lastDesc = '';

    function activeDoc() {
      const d = app.activeDocument;
      if (!d) throw new Error('No open document. Open an image first.');
      return d;
    }
    function checkDoc(d) {
      const mode = String(d.mode), bits = String(d.bitsPerChannel);
      log('doc', { id: d.id, title: d.title, w: d.width, h: d.height, mode, bits });
      if (/cmyk|gray|grey|lab|index|bitmap|duotone|multichannel/i.test(mode)) throw new Error('Document must be RGB (Image › Mode › RGB Color). Current: ' + mode);
      if (bits.indexOf('32') >= 0) throw new Error('32-bit documents are not supported. Convert to 8 or 16 bits/channel.');
      return bits.indexOf('16') >= 0 ? 16 : 8;
    }
    const modal = (name, fn) => core.executeAsModal(fn, { commandName: name });
    // batchPlay reports some failures as a result object instead of throwing
    async function play(desc, label) {
      const r = await action.batchPlay([Object.assign({ _options: { dialogOptions: 'dontDisplay' } }, desc)], {});
      const first = r && r[0];
      if (first && first._obj === 'error') throw new Error((label || desc._obj) + ': ' + (first.message || 'failed (' + first.result + ')'));
      return first;
    }
    const progress = (m, value, text) => { try { m && m.reportProgress && m.reportProgress({ value, commandName: 'Disintegration: ' + text }); } catch (e) { /* ignore */ } };

    // ---- history ----
    const histState = (d) => { try { return d.activeHistoryState; } catch (e) { return null; } };
    function revertTo(d, st) {
      if (!st) return false;
      try { d.activeHistoryState = st; return true; } catch (e) { log('history revert failed', e); return false; }
    }
    // runs fn as one history step; commit=false throws the step away afterwards
    async function oneStep(m, d, name, fn, commit) {
      let sid = null;
      try { sid = await m.hostControl.suspendHistory({ documentID: d.id, name }); } catch (e) { log('suspendHistory failed', e); }
      try { return await fn(); } finally {
        if (sid != null) { try { await m.hostControl.resumeHistory(sid, commit !== false); } catch (e) { log('resumeHistory failed', e); } }
      }
    }

    // ---- layers ----
    const isGroup = (l) => !!l && (l.kind === constants.LayerKind.GROUP || String(l.kind).toLowerCase() === 'group');
    function allLayers(list, out) {
      out = out || [];
      for (let i = 0; i < list.length; i++) { const l = list[i]; out.push(l); if (l.layers && l.layers.length) allLayers(l.layers, out); }
      return out;
    }
    const layerById = (d, id) => allLayers(d.layers).find((l) => l.id === id) || null;
    function describeGroup(g) {
      if (!isGroup(g)) return null;
      const m = /^Disintegration #(\w+)/.exec(g.name || '');
      if (!m) return null;
      const kids = g.layers || [];
      const subject = kids.find((k) => k.name === SUBJ);
      if (!subject) return null;
      return { group: g, key: m[1], subject, particles: kids.find((k) => k.name === PART) || null, fill: kids.find((k) => (k.name || '').indexOf(FILL) === 0) || null };
    }
    // the effect group with this name tag
    function locate(d, key) {
      const groups = allLayers(d.layers).filter(isGroup);
      for (let i = 0; i < groups.length; i++) { const g = describeGroup(groups[i]); if (g && g.key === key) return g; }
      return null;
    }
    // the effect group this layer is, or is inside
    function effectOf(layer) {
      for (let l = layer, n = 0; l && n < 20; l = l.parent, n++) { const g = describeGroup(l); if (g) return g; }
      return null;
    }
    const selectLayer = (id) => play({ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }, 'Select layer');
    const newLayer = async (d, name) => (d.createPixelLayer ? await d.createPixelLayer({ name }) : await d.createLayer({ name }));
    const deselect = () => play({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }, 'Deselect').catch((e) => log('deselect failed', e));
    async function hasSelection(d) {
      try {
        const r = await action.batchPlay([{ _obj: 'get', _target: [{ _property: 'selection' }, { _ref: 'document', _id: d.id }], _options: { dialogOptions: 'dontDisplay' } }], {});
        return !!(r && r[0] && r[0].selection);
      } catch (e) { return false; }
    }

    // ---- pixels ----
    // Copies what an imaging call returned into a buffer the size of the document (scaled to maxSide).
    async function unpack(res, W, H, maxSide, outComps) {
      const scale = maxSide ? Math.min(1, maxSide / Math.max(W, H)) : 1;
      const tw = Math.max(1, Math.round(W * scale)), th = Math.max(1, Math.round(H * scale));
      const id = res.imageData;
      const raw = await id.getData({ chunky: true });
      const comps = id.components, iw = id.width, ih = id.height;
      const div = raw instanceof Uint16Array ? 32768 / 255 : raw instanceof Float32Array ? 1 / 255 : 1;
      // sourceBounds are reported in the coordinates of the pyramid level that was read
      const lv = Math.pow(2, res.level || 0);
      const sb0 = res.sourceBounds || { left: 0, top: 0, right: W / lv, bottom: H / lv };
      const sb = { left: sb0.left * lv, top: sb0.top * lv, right: sb0.right * lv, bottom: sb0.bottom * lv };
      log('unpack', { iw, ih, comps, len: raw && raw.length, type: raw && raw.constructor && raw.constructor.name, sb: res.sourceBounds, level: res.level, to: [tw, th, outComps] });
      const out = outComps === 1 ? new Uint8Array(tw * th) : new Uint8ClampedArray(tw * th * 4);
      const rx0 = Math.round(sb.left * scale), ry0 = Math.round(sb.top * scale);
      const rx1 = Math.round(sb.right * scale), ry1 = Math.round(sb.bottom * scale);
      const rw = Math.max(1, rx1 - rx0), rh = Math.max(1, ry1 - ry0);
      const exact = rw === iw && rh === ih;
      for (let y = Math.max(0, ry0); y < Math.min(th, ry1); y++) {
        const sy = exact ? y - ry0 : Math.min(ih - 1, Math.floor(((y - ry0) * ih) / rh));
        for (let x = Math.max(0, rx0); x < Math.min(tw, rx1); x++) {
          const sx = exact ? x - rx0 : Math.min(iw - 1, Math.floor(((x - rx0) * iw) / rw));
          const si = (sy * iw + sx) * comps;
          if (outComps === 1) { out[y * tw + x] = raw[si] / div; continue; }
          const di = (y * tw + x) * 4;
          if (comps >= 3) { out[di] = raw[si] / div; out[di + 1] = raw[si + 1] / div; out[di + 2] = raw[si + 2] / div; out[di + 3] = comps === 4 ? raw[si + 3] / div : 255; }
          else { out[di] = out[di + 1] = out[di + 2] = raw[si] / div; out[di + 3] = comps === 2 ? raw[si + 1] / div : 255; }
        }
      }
      id.dispose();
      return { width: tw, height: th, data: out, docW: W, docH: H };
    }
    // RGBA of the whole picture (layerID omitted) or of one layer, without its mask
    async function readPixels(d, layerID, maxSide) {
      const W = d.width, H = d.height;
      const scale = maxSide ? Math.min(1, maxSide / Math.max(W, H)) : 1;
      const req = { documentID: d.id, colorSpace: 'RGB' };
      if (scale < 1) req.targetSize = { width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)) };
      if (layerID != null) req.layerID = layerID;
      log('getPixels', req);
      // Photoshop refuses an 8-bit read of some 16-bit documents ("Could not convert the image"),
      // so read those at 16 bits first; unpack() scales whatever comes back to 8 bits.
      const deep = String(d.bitsPerChannel).indexOf('16') >= 0;
      const sizes = deep ? [16, 8] : [8];
      const tries = [];
      sizes.forEach((n) => { tries.push({ colorProfile: SRGB, componentSize: n }, { componentSize: n }); });
      tries.push({});
      let res = null, lastErr = null;
      for (let i = 0; i < tries.length && !res; i++) {
        try {
          res = await imaging.getPixels(Object.assign({}, req, tries[i]));
          profile = tries[i].colorProfile || res.imageData.colorProfile || SRGB;
          if (i) log('getPixels worked with', tries[i]);
        } catch (e) { lastErr = e; log('getPixels attempt failed', tries[i], e); }
      }
      if (!res) {
        if (layerID == null) throw lastErr;
        log('layer has no pixels'); // an empty layer
        const tw = req.targetSize ? req.targetSize.width : W, th = req.targetSize ? req.targetSize.height : H;
        return { width: tw, height: th, data: new Uint8ClampedArray(tw * th * 4), docW: W, docH: H };
      }
      return unpack(res, W, H, maxSide, 4);
    }
    // the current selection as a mask the size of the document
    async function readSelection(d) {
      const res = await imaging.getSelection({ documentID: d.id });
      return unpack(res, d.width, d.height, 0, 1);
    }
    function shrinkMask(src, W, H, tw, th) {
      if (tw === W && th === H) return src;
      const out = new Uint8Array(tw * th), sum = new Float32Array(tw * th), cnt = new Float32Array(tw * th);
      for (let y = 0; y < H; y++) {
        const r = Math.min(th - 1, Math.floor((y * th) / H)) * tw;
        for (let x = 0; x < W; x++) { const i = r + Math.min(tw - 1, Math.floor((x * tw) / W)); sum[i] += src[y * W + x]; cnt[i]++; }
      }
      for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? sum[i] / cnt[i] : 0;
      return out;
    }
    async function grayData(buf, w, h) {
      return imaging.createImageDataFromBuffer(buf, { width: w, height: h, components: 1, chunky: false, colorSpace: 'Grayscale', colorProfile: 'Gray Gamma 2.2' });
    }
    async function putRGBA(d, layer, data, w, h, bits, left, top) {
      let buf;
      if (bits === 16) {
        buf = new Uint16Array(data.length);
        for (let i = 0; i < buf.length; i++) buf[i] = Math.round((data[i] * 32768) / 255);
      } else buf = new Uint8Array(data.buffer, data.byteOffset, data.length);
      const base = { width: w, height: h, components: 4, chunky: true, colorSpace: 'RGB', componentSize: bits };
      const attempts = [Object.assign({ colorProfile: profile }, base), base, Object.assign({ colorProfile: SRGB }, base)];
      let lastErr = null;
      for (const opt of attempts) {
        let id = null, done = false;
        try {
          id = await imaging.createImageDataFromBuffer(buf, opt);
          const req = { documentID: d.id, layerID: layer.id, imageData: id, replace: true };
          if (left || top) req.targetBounds = { left: left || 0, top: top || 0 };
          await imaging.putPixels(req);
          done = true;
        } catch (e) { lastErr = e; log('putPixels attempt failed', { profile: opt.colorProfile || '(none)' }, e); }
        if (id) id.dispose();
        if (done) return;
      }
      throw lastErr;
    }
    // writes only the part of an RGBA buffer that has anything in it
    async function putCropped(d, layer, data, W, H, bits) {
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        let hit = false;
        for (let x = 0, i = y * W * 4 + 3; x < W; x++, i += 4) if (data[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; hit = true; }
        if (hit) { if (y < y0) y0 = y; y1 = y; }
      }
      if (x1 < 0) return putRGBA(d, layer, new Uint8ClampedArray(4), 1, 1, bits, 0, 0);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w === W && h === H) return putRGBA(d, layer, data, W, H, bits, 0, 0);
      const crop = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) crop.set(data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + w) * 4), y * w * 4);
      return putRGBA(d, layer, crop, w, h, bits, x0, y0);
    }
    async function putMask(d, layer, mask, W, H, bits) {
      const tryPut = async () => {
        const bufs = [];
        if (bits === 16) { const b16 = new Uint16Array(mask.length); for (let i = 0; i < b16.length; i++) b16[i] = Math.round((mask[i] * 32768) / 255); bufs.push(b16); }
        bufs.push(mask);
        let lastErr = null;
        for (const buf of bufs) {
          let id = null, done = false;
          try {
            id = await grayData(buf, W, H);
            await imaging.putLayerMask({ documentID: d.id, layerID: layer.id, imageData: id, replace: true });
            done = true;
          } catch (e) { lastErr = e; log('putLayerMask attempt failed', { type: buf.constructor.name }, e); }
          if (id) id.dispose();
          if (done) return;
        }
        throw lastErr;
      };
      try { await tryPut(); } catch (e) {
        // the layer may need a mask to exist first
        log('adding a layer mask and retrying');
        await selectLayer(layer.id);
        await play({ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }, 'Add layer mask');
        await tryPut();
      }
    }

    // ---- picking the subject (leaves it as the active selection) ----
    async function objectSelect(d, box) {
      const W = d.width, H = d.height;
      const r = { left: Math.round(box.x0 * W), top: Math.round(box.y0 * H), right: Math.round(box.x1 * W), bottom: Math.round(box.y1 * H) };
      const px = (v) => ({ _unit: 'pixelsUnit', _value: v });
      const rect = { _obj: 'rectangle', top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) };
      const inBox = (x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      const measure = (sel) => { let inside = 0; for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) inside += sel[y * W + x]; return inside / 255 / Math.max(1, (r.right - r.left) * (r.bottom - r.top)); };
      // 1. the Object Selection tool's "find the object in this rectangle"
      try {
        await play({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: rect, deepSelect: true, objectSelectionMode: 0, magicLassoAutoEnhance: true, smartSubtract: true }, 'Object selection');
        if (await hasSelection(d)) {
          const cover = measure((await readSelection(d)).data);
          log('object selection covers', cover);
          if (cover > 0.01 && cover < 0.97) return; // a plain rectangle means Photoshop ignored the object part
        }
      } catch (e) { log('object selection failed', e); }
      // 2. fall back to Select Subject, kept only inside the box
      await play({ _obj: 'autoCutout', sampleAllLayers: true }, 'Select Subject');
      if (!(await hasSelection(d))) throw new Error('Photoshop found no subject in that box.');
      const sel = (await readSelection(d)).data;
      let any = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (inBox(x, y)) any += sel[y * W + x]; else sel[y * W + x] = 0; }
      if (any < 255 * 16) throw new Error('Photoshop found no subject in that box.');
      const id = await grayData(sel, W, H);
      try { await imaging.putSelection({ documentID: d.id, imageData: id, replace: true }); } finally { id.dispose(); }
    }
    // Photoshop's selection commands are unavailable while the active layer is hidden (or is a
    // hidden group's child), even though they sample every layer. Make a visible layer active.
    async function useVisibleLayer(d) {
      const act = d.activeLayers && d.activeLayers[0];
      const shown = (l) => { for (let x = l, n = 0; x && n < 20; x = x.parent, n++) if (!x.visible) return false; return true; };
      if (act && shown(act)) return;
      const all = allLayers(d.layers);
      const pick = all.find((l) => !isGroup(l) && shown(l)) || all.find(shown);
      if (!pick) throw new Error('Every layer is hidden. Show the picture, then try again.');
      log('active layer is hidden; selecting', { id: pick.id, name: pick.name });
      await selectLayer(pick.id);
    }
    async function pickSubject(d, mode, box) {
      if (mode === 'layer') {
        const l = layerById(d, sess.activeId);
        if (!l || isGroup(l) || l.isBackgroundLayer || effectOf(l)) throw new Error('“Use layer” needs an ordinary cut-out layer to be the active layer when you open the dialog.');
        sess.srcLayerId = l.id;
        return 'layer';
      }
      if (mode === 'init' && (await hasSelection(d))) return 'selection';
      await useVisibleLayer(d);
      if (mode === 'box') { await objectSelect(d, box); return 'box'; }
      try { await play({ _obj: 'autoCutout', sampleAllLayers: true }, 'Select Subject'); } catch (e) {
        log('Select Subject failed, trying once more', e);
        await new Promise((r) => setTimeout(r, 400));
        await play({ _obj: 'autoCutout', sampleAllLayers: true }, 'Select Subject');
      }
      if (!(await hasSelection(d))) throw new Error('Photoshop couldn’t find a subject. Select it yourself with any selection tool, then open Disintegration Studio again.');
      return 'auto';
    }

    // ---- preview buffers ----
    async function readHidden(m, d, layers, maxSide) {
      // the picture with these layers hidden, leaving no trace in the history
      return oneStep(m, d, 'Disintegration: sample', async () => {
        const was = layers.filter(Boolean).map((l) => [l, l.visible]);
        try {
          was.forEach(([l]) => { l.visible = false; });
          return await readPixels(d, null, maxSide);
        } finally { was.forEach(([l, v]) => { try { l.visible = v; } catch (e) { /* ignore */ } }); }
      }, false);
    }
    async function readPreview(m, d, maxSide) {
      const base = { docW: d.width, docH: d.height, editing: sess.editing, key: sess.key, note: sess.note || '' };
      sess.note = '';
      lastDesc = d.title + ' (' + d.width + '×' + d.height + ')';
      const cur = sess.key ? locate(d, sess.key) : null;
      if (cur) {
        const subj = await readPixels(d, cur.subject.id, maxSide);
        const plate = await readHidden(m, d, [cur.subject, cur.particles], maxSide);
        return Object.assign(base, { width: subj.width, height: subj.height, subject: subj.data, plate: plate.data, built: true, approx: false });
      }
      sess.key = null;
      if (sess.mode === 'layer') {
        const src = layerById(d, sess.srcLayerId);
        const subj = await readPixels(d, src.id, maxSide);
        const plate = await readHidden(m, d, [src], maxSide);
        return Object.assign(base, { width: subj.width, height: subj.height, subject: subj.data, plate: plate.data, built: false, approx: false });
      }
      const comp = await readPixels(d, null, maxSide);
      const sel = await readSelection(d);
      const small = shrinkMask(sel.data, sel.width, sel.height, comp.width, comp.height);
      let any = 0;
      for (let i = 0; i < small.length; i++) any += small[i];
      if (any < 255 * 4) throw new Error('The selection is empty.');
      const sp = D.split(comp.data, comp.width, comp.height, small);
      return Object.assign(base, sp, { built: false, approx: true });
    }

    // ---- building the layers: Background fill, Subject and Particles in one group ----
    function genFillDesc(d, mode, withVersion) {
      const desc = {
        _obj: 'syntheticFill',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        documentID: d.id, layerID: d.activeLayers[0].id, prompt: '', serviceID: 'clio',
        workflowType: { _enum: 'genWorkflow', _value: 'in_painting' },
        serviceOptionsList: { clio: { _obj: 'clio', gi_PROMPT: '', gi_MODE: mode, gi_SEED: -1, gi_NUM_STEPS: -1, gi_GUIDANCE: 6, gi_SIMILARITY: 0, gi_CROP: false, gi_DILATE: false, gi_CONTENT_PRESERVE: 0, gi_ENABLE_PROMPT_FILTER: true, dualCrop: true } },
      };
      if (withVersion) {
        desc.serviceVersion = 'clio3';
        desc.workflow_to_active_service_identifier_map = { in_painting: 'clio3', generate_background: 'clio3', out_painting: 'clio3', generate_similar: 'clio3', text_to_image: 'clio3', instruct_edit: 'clio3', generativeUpscale: 'clio_f16_async', gen_harmonize: 'clio3' };
      }
      return desc;
    }
    // Fills the hole behind the subject. The selection is the subject; comp is the flat picture.
    async function makeFill(d, comp, W, H, bits) {
      await selectLayer(d.layers[0].id);
      const pad = Math.max(3, Math.round(Math.max(W, H) * 0.006));
      try { await play({ _obj: 'expand', by: { _unit: 'pixelsUnit', _value: pad }, selectionModifyEffectAtCanvasBounds: false }, 'Expand selection'); } catch (e) { log('expand failed', e); }
      log('filling the background', { method: sess.fill, pad });
      if (sess.fill === 'generative') {
        const before = {};
        allLayers(d.layers).forEach((l) => { before[l.id] = true; });
        const tries = [['ginp', true], ['tinp', true], ['ginp', false]];
        for (let i = 0; i < tries.length; i++) {
          try {
            await play(genFillDesc(d, tries[i][0], tries[i][1]), 'Generative Fill');
            const made = allLayers(d.layers).filter((l) => !before[l.id]);
            if (!made.length) throw new Error('Generative Fill made no layer');
            try { made[0].name = FILL; } catch (e) { /* keep its name */ }
            log('generative fill ok', tries[i]);
            return made[0];
          } catch (e) { log('generative fill failed', tries[i], e); }
        }
        sess.note = 'Generative Fill wasn’t available, so the background was filled with Content-Aware Fill instead.';
      }
      // Content-Aware Fill: a copy of the picture, filled where the subject is, masked down to that patch
      const l = await newLayer(d, FILL);
      await putRGBA(d, l, comp, W, H, bits);
      await play({ _obj: 'fill', using: { _enum: 'fillContents', _value: 'contentAware' }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } }, 'Content-Aware Fill');
      try {
        await play({ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } }, 'Mask the fill');
      } catch (e) { log('masking the fill failed (the layer stays whole)', e); }
      return l;
    }
    async function build(m, d) {
      const W = d.width, H = d.height, bits = sess.bits;
      const key = Math.random().toString(36).slice(2, 6);
      let subj, fillLayer = null, srcLayer = null;
      progress(m, 0.05, 'reading the subject');
      if (sess.mode === 'layer') {
        srcLayer = layerById(d, sess.srcLayerId);
        if (!srcLayer) throw new Error('The cut-out layer is gone.');
        subj = (await readPixels(d, srcLayer.id, 0)).data;
      } else {
        const sel = (await readSelection(d)).data;
        const comp = (await readPixels(d, null, 0)).data;
        if (sess.fill !== 'none') { progress(m, 0.15, 'filling the background'); fillLayer = await makeFill(d, comp, W, H, bits); }
        for (let i = 0, j = 3; i < W * H; i++, j += 4) comp[j] = (comp[j] * sel[i] + 127) / 255;
        subj = comp;
      }
      progress(m, 0.3, 'making the layers');
      await oneStep(m, d, 'Disintegration: subject', async () => {
        await deselect();
        // the group goes on top of everything it was made from: the whole picture, or just the cut-out layer
        await selectLayer((srcLayer || fillLayer || d.layers[0]).id);
        const subject = await newLayer(d, SUBJ);
        await putCropped(d, subject, subj, W, H, bits);
        const particles = await newLayer(d, PART);
        const members = [fillLayer, subject, particles].filter(Boolean);
        const name = NAME + ' #' + key;
        let group = null;
        try { group = await d.createLayerGroup({ name, fromLayers: members }); } catch (e) { log('createLayerGroup(fromLayers) failed', e); }
        if (!group) {
          group = await d.createLayerGroup({ name });
          for (const l of members) l.move(group, constants.ElementPlacement.PLACEINSIDE);
        }
        try { if (group.name !== name) group.name = name; } catch (e) { /* ignore */ }
        if (!srcLayer) { try { if (d.layers[0] && d.layers[0].id !== group.id) group.move(d.layers[0], constants.ElementPlacement.PLACEBEFORE); } catch (e) { log('moving the group to the top failed', e); } }
        if (srcLayer) srcLayer.visible = false;
      });
      sess.key = key;
      const cur = locate(d, key);
      if (!cur) throw new Error('The effect layers could not be created.');
      return { cur, subj };
    }
    // Renders at full size and writes the Subject's mask and the Particles layer.
    async function write(m, d, fxState, ref) {
      const W = d.width, H = d.height, bits = sess.bits;
      const before = histState(d), hadKey = sess.key;
      try {
        let cur = sess.key ? locate(d, sess.key) : null, subj = null;
        if (!cur) { const b = await build(m, d); cur = b.cur; subj = b.subj; }
        await oneStep(m, d, 'Disintegration', async () => {
          if (!subj) subj = (await readPixels(d, cur.subject.id, 0)).data;
          progress(m, 0.45, 'rendering');
          const c = D.prepare({ width: W, height: H, subject: subj });
          const res = D.render(c, fxState, { ref });
          log('rendered', { w: W, h: H, particles: res.count });
          progress(m, 0.8, 'writing the layers');
          const mask = res.erode;
          for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
          await putMask(d, cur.subject, mask, W, H, bits);
          let pl = cur.particles;
          if (!pl) { // the user deleted it: make another above the subject
            await selectLayer(cur.subject.id);
            pl = await newLayer(d, PART);
          }
          await putCropped(d, pl, res.particles, W, H, bits);
          try { await selectLayer(cur.group.id); } catch (e) { log('selecting the group failed', e); }
        });
      } catch (e) {
        revertTo(d, before);
        sess.key = hadKey;
        throw e;
      }
      sess.editing = true;
      sess.base = histState(d); // Cancel after an Apply keeps what was applied
      return sess.key;
    }

    const bridge = {
      describe: () => lastDesc,
      async begin(opts) {
        const d = activeDoc();
        const bits = checkDoc(d);
        let out = null;
        await modal('Disintegration Studio', async (m) => {
          if (opts.subject === 'init' || !sess || sess.docId !== d.id) {
            const act = d.activeLayers && d.activeLayers[0];
            sess = { docId: d.id, base: histState(d), activeId: act ? act.id : null, key: null, mode: 'auto', srcLayerId: null, fill: opts.fill, editing: false, bits, note: '' };
            const g = effectOf(act);
            if (g) { sess.key = g.key; sess.editing = true; } else {
              try { sess.mode = await pickSubject(d, 'init'); } catch (e) { revertTo(d, sess.base); sess = null; throw e; }
            }
          } else if (opts.subject !== 'keep') {
            // a different subject: drop what was built for the old one and pick again
            const before = histState(d), prev = { key: sess.key, mode: sess.mode, srcLayerId: sess.srcLayerId, editing: sess.editing };
            try {
              const cur = sess.key ? locate(d, sess.key) : null;
              if (cur) {
                const src = sess.srcLayerId != null ? layerById(d, sess.srcLayerId) : null;
                if (src) src.visible = true;
                await cur.group.delete();
              }
              sess.key = null; sess.editing = false;
              sess.mode = await pickSubject(d, opts.subject, opts.box);
            } catch (e) {
              revertTo(d, before);
              Object.assign(sess, prev);
              e.recoverable = true;
              throw e;
            }
          }
          sess.fill = opts.fill; sess.bits = bits;
          out = await readPreview(m, d, opts.quality);
        });
        return out;
      },
      async generate(fill) {
        const d = activeDoc();
        if (fill) sess.fill = fill;
        await modal('Disintegration: build layers', async (m) => {
          const before = histState(d);
          try { if (!(sess.key && locate(d, sess.key))) await build(m, d); } catch (e) { revertTo(d, before); sess.key = null; throw e; }
        });
      },
      async apply(fxState, ref, fill) {
        const d = activeDoc();
        if (fill) sess.fill = fill;
        let key = null;
        await modal('Disintegration', async (m) => { key = await write(m, d, fxState, ref); });
        return key;
      },
      async quick(fxState, fill) {
        const d = activeDoc();
        const bits = checkDoc(d);
        let key = null;
        await modal('Quick Disintegrate', async (m) => {
          const act = d.activeLayers && d.activeLayers[0];
          sess = { docId: d.id, base: histState(d), activeId: act ? act.id : null, key: null, mode: 'auto', srcLayerId: null, fill, editing: false, bits, note: '' };
          try {
            sess.mode = await pickSubject(d, 'init');
            key = await write(m, d, fxState, null);
          } catch (e) { revertTo(d, sess.base); throw e; } finally { sess = null; }
        });
        return key;
      },
      // A brush tip from the document: the selection if there is one, otherwise the active layer
      // (its transparency, or its dark parts if it has none).
      async captureTip() {
        const d = activeDoc();
        let tip = null;
        await modal('Disintegration: new brush tip', async () => {
          if (await hasSelection(d)) {
            const sel = await readSelection(d);
            tip = D.tipFromMask(sel.data, sel.width, sel.height);
            if (tip) tip.from = 'selection';
            return;
          }
          const l = d.activeLayers && d.activeLayers[0];
          if (!l || isGroup(l)) throw new Error('Select the shape you want as a brush tip, or make the layer that holds your image the active layer.');
          const px = await readPixels(d, l.id, 0);
          tip = D.tipFromImage(px.data, px.width, px.height);
          if (!tip) throw new Error('That layer is empty or one flat colour, so there is no shape to make a brush tip from.');
        });
        return tip;
      },
      async cancel() {
        if (!sess) return;
        const s = sess;
        sess = null;
        const d = app.activeDocument;
        if (!d || d.id !== s.docId) return;
        await modal('Disintegration: cancel', async () => {
          if (revertTo(d, s.base)) return;
          // no history to go back to: at least remove what this session built
          const cur = s.key && !s.editing ? locate(d, s.key) : null;
          if (cur) { try { await cur.group.delete(); } catch (e) { log('removing the group failed', e); } }
        });
      },
      async end() { sess = null; },
      async encode(img) {
        const n = img.width * img.height, rgb = new Uint8Array(n * 3);
        const s = img.data;
        for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) { rgb[j] = s[i]; rgb[j + 1] = s[i + 1]; rgb[j + 2] = s[i + 2]; }
        let url = null;
        if (!bridge._noEncode) {
          try {
            const id = await imaging.createImageDataFromBuffer(rgb, { width: img.width, height: img.height, components: 3, chunky: true, colorSpace: 'RGB', colorProfile: SRGB });
            const b64 = await imaging.encodeImageData({ imageData: id, base64: true });
            id.dispose();
            url = 'data:image/jpeg;base64,' + (typeof b64 === 'string' ? b64 : toBase64(new Uint8Array(b64)));
          } catch (e) {
            log('encodeImageData failed, using PNG fallback', e);
            bridge._noEncode = true;
          }
        }
        if (!url) url = 'data:image/png;base64,' + toBase64(encodePng(rgb, img.width, img.height));
        return url;
      },
      alert(msg) {
        try { app.showAlert('Disintegration Studio: ' + msg); } catch (e) { log('alert failed', e); }
      },
      showDialog(dlg) {
        // UXP doesn't keep a modal dialog on screen, so pick a size that fits. Use the screen
        // size when UXP reports one; otherwise a conservative default that fits a 1080p screen
        // at 150% scaling. A size the user dragged to is remembered, still capped by the screen.
        let scrW = 0, scrH = 0;
        try {
          const s = window.screen;
          if (s) { scrW = s.availWidth || s.width || 0; scrH = s.availHeight || s.height || 0; }
        } catch (e) { /* not available */ }
        const known = scrW > 600 && scrH > 400;
        const maxW = known ? scrW - 40 : 4000, maxH = known ? scrH - 60 : 4000;
        let W = ui.dlgW2 || (known ? Math.min(1500, maxW) : 1200);
        let H = ui.dlgH2 || (known ? Math.min(900, maxH) : 640);
        W = Math.round(clampN(W, Math.min(760, maxW), maxW));
        H = Math.round(clampN(H, Math.min(460, maxH), maxH));
        log('dialog size', { W, H, screen: known ? [scrW, scrH] : 'unknown', saved: [ui.dlgW2, ui.dlgH2], dpr: window.devicePixelRatio });
        dlgReq = { w: W, h: H }; dlgBase = null;
        sizeColumns(W, H); // give the content its size first, so it can't stretch the dialog
        return dlg.uxpShowModal({ title: 'Disintegration Studio', resize: 'both', size: { width: W, height: H } });
      },
      init() {
        try {
          require('uxp').entrypoints.setup({
            commands: { openStudio: () => openStudio(), quickDisintegrate: () => quickDisintegrate(), newBrushTip: () => newBrushTip() },
          });
        } catch (e) { log('entrypoints.setup failed', e); }
      },
    };
    return bridge;
  }

  // The browser harness has no Photoshop to find a subject or fill a background. The demo scene
  // comes with its own subject and background; any other picture gets an oval "subject" (in the
  // box you drag, or in the middle) and the quick fill.
  function makeBrowserBridge() {
    let scene = null, pick = { mode: 'auto', box: null }, built = false;
    const work = document.createElement('canvas');
    function demoScene() {
      const W = 1600, H = 1000;
      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
      const plate = mk(), subject = mk();
      let g = plate.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#1b2f5e'); sky.addColorStop(0.45, '#c9788a'); sky.addColorStop(0.62, '#f3b56b'); sky.addColorStop(0.63, '#3d5a4c'); sky.addColorStop(1, '#16241d');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      g.fillStyle = '#ffe2a0'; g.beginPath(); g.arc(1180, 520, 90, 0, Math.PI * 2); g.fill();
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let layer = 0; layer < 3; layer++) { // skyline
        g.fillStyle = ['#56506e', '#3a3a55', '#23263a'][layer];
        for (let x = -20; x < W; ) {
          const w = 40 + rnd() * 90, h = 120 + rnd() * (180 + layer * 90);
          g.fillRect(x, 630 - h + layer * 12, w, h + 40);
          if (layer === 2) { g.fillStyle = '#ffd98a'; for (let wy = 630 - h + 30; wy < 620; wy += 26) for (let wx = x + 8; wx < x + w - 10; wx += 18) if (rnd() < 0.45) g.fillRect(wx, wy, 8, 12); g.fillStyle = '#23263a'; }
          x += w + 4 + rnd() * 20;
        }
      }
      for (let i = 0; i < 900; i++) { // ground texture
        g.fillStyle = 'rgba(' + [(60 + rnd() * 80) | 0, (90 + rnd() * 80) | 0, (60 + rnd() * 50) | 0].join(',') + ',0.5)';
        g.fillRect(rnd() * W, 640 + rnd() * 360, 4 + rnd() * 30, 2 + rnd() * 5);
      }
      g = subject.getContext('2d'); // a figure
      g.fillStyle = '#2b3350'; g.fillRect(560, 640, 62, 330); g.fillRect(640, 640, 62, 330);          // legs
      const top = g.createLinearGradient(520, 300, 740, 660);
      top.addColorStop(0, '#e24a4a'); top.addColorStop(1, '#8c1f3f');
      g.fillStyle = top; g.beginPath(); g.moveTo(540, 330); g.lineTo(722, 330); g.lineTo(748, 660); g.lineTo(514, 660); g.closePath(); g.fill(); // coat
      g.fillStyle = '#f4d35e'; for (let y = 380; y < 640; y += 60) g.fillRect(538, y, 190, 14);            // stripes
      g.fillStyle = '#c93b3b'; g.fillRect(470, 340, 60, 240); g.fillRect(732, 340, 60, 240);              // arms
      g.fillStyle = '#e8b796'; g.fillRect(474, 580, 52, 44); g.fillRect(736, 580, 52, 44);                // hands
      g.beginPath(); g.arc(631, 230, 84, 0, Math.PI * 2); g.fill();                                       // head
      g.fillStyle = '#4a2f23'; g.beginPath(); g.arc(631, 205, 88, Math.PI, Math.PI * 2); g.fill();         // hair
      g.fillStyle = '#1d1d1d'; g.fillRect(548, 960, 80, 28); g.fillRect(636, 960, 80, 28);                 // shoes
      return { W, H, name: 'demo', plate, subject, image: null };
    }
    async function loadUrl(url) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('Could not load ' + url));
        im.src = url;
      });
    }
    function pixels(sources, w, h) {
      work.width = w; work.height = h;
      const g = work.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, h);
      sources.forEach((s) => g.drawImage(s, 0, 0, w, h));
      return g.getImageData(0, 0, w, h).data;
    }
    function ovalMask(w, h, box) {
      const m = new Uint8Array(w * h);
      const cx = ((box.x0 + box.x1) / 2) * w, cy = ((box.y0 + box.y1) / 2) * h, rx = ((box.x1 - box.x0) / 2) * w, ry = ((box.y1 - box.y0) / 2) * h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
        m[y * w + x] = clampN((1 - d) * Math.min(rx, ry) * 0.5, 0, 1) * 255;
      }
      return m;
    }
    function buffers(maxSide) {
      const s = maxSide ? Math.min(1, maxSide / Math.max(scene.W, scene.H)) : 1;
      const w = Math.max(1, Math.round(scene.W * s)), h = Math.max(1, Math.round(scene.H * s));
      if (scene.plate && pick.mode !== 'box') return { width: w, height: h, plate: pixels([scene.plate], w, h), subject: pixels([scene.subject], w, h), approx: false };
      const flat = pixels(scene.plate ? [scene.plate, scene.subject] : [scene.image], w, h);
      const sp = D.split(flat, w, h, ovalMask(w, h, pick.box || { x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.95 }));
      sp.approx = !built;
      return sp;
    }
    const bridge = {
      describe: () => scene.name + ' (' + scene.W + '×' + scene.H + ')',
      async begin(opts) {
        if (!scene) throw new Error('No image loaded.');
        if (opts.subject === 'layer') { const e = new Error('“Use layer” needs Photoshop.'); e.recoverable = true; throw e; }
        if (opts.subject === 'init' || opts.subject === 'auto') { pick = { mode: 'auto', box: null }; built = false; }
        else if (opts.subject === 'box') { pick = { mode: 'box', box: opts.box }; built = false; }
        return Object.assign(buffers(opts.quality), { docW: scene.W, docH: scene.H, editing: false, built, key: null, note: '' });
      },
      async generate() { built = true; },
      async apply(fxState, ref) {
        const src = buffers(0);
        const c = D.prepare(src);
        const res = D.render(c, fxState, { ref });
        const out = D.composite(c, res);
        bridge.lastApply = { width: out.width, height: out.height, count: res.count };
        work.width = out.width; work.height = out.height;
        work.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
        built = true;
        if (/[?&]nodownload/.test(location.search)) return null;
        const a = document.createElement('a');
        a.download = 'disintegration-' + scene.name.replace(/\.[^.]+$/, '') + '.png';
        a.href = work.toDataURL('image/png');
        a.click();
        return null;
      },
      async quick(fxState) { return bridge.apply(fxState, null); },
      async captureTip() { throw new Error('Making a brush tip from the document needs Photoshop.'); },
      async cancel() { built = false; },
      async end() { /* nothing to tidy */ },
      async encode(img) {
        const c = bridge._enc || (bridge._enc = document.createElement('canvas'));
        c.width = img.width; c.height = img.height;
        c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
        return c.toDataURL('image/jpeg', 0.9);
      },
      async init() {
        $('browserBar').style.display = '';
        document.body.className = 'browser';
        $('fileInput').addEventListener('change', async (e) => {
          const f = e.target.files[0]; if (!f) return;
          const im = await loadUrl(URL.createObjectURL(f));
          scene = { W: im.naturalWidth, H: im.naturalHeight, name: f.name, plate: null, subject: null, image: im };
          if (studioOpen) closeStudio('subject:auto'); else openStudio();
        });
        const q = new URLSearchParams(location.search).get('img');
        try { if (q) { const im = await loadUrl(q); scene = { W: im.naturalWidth, H: im.naturalHeight, name: q.split('/').pop(), plate: null, subject: null, image: im }; } } catch (e) { status(e.message, true); }
        if (!scene) scene = demoScene();
        openStudio();
      },
      alert() { /* the browser harness keeps the dialog open; the status line is enough */ },
      showDialog(dlg) {
        // One listener for the dialog's life: a close event can arrive after the dialog has
        // already been shown again (close → reopen happens within a few milliseconds), and must
        // then be ignored rather than close the new one.
        if (!bridge._listening) {
          bridge._listening = true;
          dlg.addEventListener('close', () => { if (!dlg.open && bridge._resolve) bridge._resolve(dlg.returnValue || 'cancel'); });
        }
        return new Promise((resolve) => {
          const done = (r) => { if (bridge._resolve !== done) return; bridge._resolve = null; resolve(r); };
          bridge._resolve = done;
          dlg.returnValue = '';
          dlg.showModal();
        });
      },
    };
    return bridge;
  }

  const bridge = IS_UXP ? makeUxpBridge() : makeBrowserBridge();

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  function init() {
    syncSelects(true);
    $('guidesChk').checked = !!ui.guides;

    $('presetSel').addEventListener('change', (e) => { const v = selValue($('presetSel'), e); if (v) loadPreset(v); });
    $('btnAuto').addEventListener('click', () => { fx.auto = true; freshAimKeepPaint(); renderInspector(); commit(); });
    $('btnShuffle').addEventListener('click', () => { fx.seed = 1 + Math.floor(Math.random() * 998); syncInspectorValues(); commit(); });
    $('btnUndo').addEventListener('click', () => { snapshot(); if (undoStack.length) { redoStack.push(lastSnapshot); restore(undoStack.pop()); } });
    $('btnFine').addEventListener('click', () => setFine(!ui.fine));
    $('btnFine').className = 'toggle' + (ui.fine ? ' on' : '');
    $('btnRedo').addEventListener('click', () => { if (redoStack.length) { undoStack.push(lastSnapshot); restore(redoStack.pop()); } });
    $('qualitySel').addEventListener('change', (e) => { const v = selValue($('qualitySel'), e); if (!v || v === String(ui.quality)) return; ui.quality = v; store.set(LS_UI, ui); closeStudio('quality'); });
    $('fillSel').addEventListener('change', (e) => { const v = selValue($('fillSel'), e); if (v) { ui.fill = v; store.set(LS_UI, ui); } });
    $('guidesChk').addEventListener('change', () => { ui.guides = !!$('guidesChk').checked; store.set(LS_UI, ui); kick(); });
    $('btnSubjAuto').addEventListener('click', () => closeStudio('subject:auto'));
    $('btnSubjLayer').addEventListener('click', () => closeStudio('subject:layer'));
    $('btnSubjBox').addEventListener('click', () => setTool(tool === 'box' ? 'aim' : 'box'));
    $('btnGenerate').addEventListener('click', () => closeStudio('generate'));
    $('btnSavePreset').addEventListener('click', savePreset);
    $('btnDelPreset').addEventListener('click', deletePreset);
    $('btnApply').addEventListener('click', () => closeStudio('apply'));
    $('btnOK').addEventListener('click', () => closeStudio('ok'));
    $('btnCancel').addEventListener('click', () => closeStudio('cancel'));
    // Escape with the brush tip library open closes the library, not the whole dialog (Photoshop
    // turns Escape into the dialog's cancel event before the page sees the key)
    $('studio').addEventListener('cancel', (e) => {
      if (tipsUI && tipsUI.isLibraryOpen && tipsUI.isLibraryOpen()) {
        if (e.preventDefault) e.preventDefault();
        tipsUI.closeLibrary();
      }
    });
    $('btnBefore').addEventListener('click', () => setViewMode('before'));
    $('btnMask').addEventListener('click', () => setViewMode('mask'));

    makeView('big');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    startCatcher();
    document.addEventListener('wheel', (e) => onWheel(e), { passive: false });
    document.addEventListener('mousewheel', (e) => onWheel(e, 'mousewheel'), { passive: false });
    setInterval(() => layoutAll(false), 400);
    window.addEventListener('resize', () => layoutAll(true));
    setTimeout(() => layoutAll(true), 50);
    log('Disintegration Studio started', { uxp: IS_UXP, runtime: runtimeFeatures() });
    showVersion();
    // which engine renders (WebAssembly once it has loaded; JavaScript before that, or after a failure)
    if (D.wasmReady) {
      D.engineLog = (m) => log('engine', m);
      D.wasmReady.then(() => log('engine ready', D.engine, D.engineInfo ? D.engineInfo() : null));
    }
    renderTabs();
    renderInspector();
    renderBrushFields();
    setTool('aim');
    try { bridge.init(); } catch (e) { log('init error', e); status('Init error: ' + (e.message || e), true); }
  }
  // The version that is running, from the plugin's own manifest, shown in the preview's toolbar.
  let pluginVersion = '';
  async function showVersion() {
    let v = '';
    try {
      if (IS_UXP) {
        const u = require('uxp');
        v = (u.versions && u.versions.plugin) || '';
        if (!v) {
          const folder = await u.storage.localFileSystem.getPluginFolder();
          v = JSON.parse(await (await folder.getEntry('manifest.json')).read()).version || '';
        }
      } else {
        v = (await (await fetch('manifest.json')).json()).version || '';
      }
    } catch (e) { log('version unknown', e); }
    pluginVersion = v;
    $('verLbl').textContent = v ? 'v' + v : '';
    log('version', v || 'unknown');
  }
  // What the host's JavaScript offers that could take work off the main thread or onto the GPU.
  // (For the log: it decides what a faster engine could be built on.)
  function runtimeFeatures() {
    const f = {};
    const has = (name, fn) => { try { f[name] = fn(); } catch (e) { f[name] = 'error: ' + (e.message || e); } };
    has('wasm', () => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function');
    has('worker', () => typeof Worker);
    has('sharedArrayBuffer', () => typeof SharedArrayBuffer);
    has('offscreenCanvas', () => typeof OffscreenCanvas);
    has('gpu', () => typeof navigator !== 'undefined' && !!navigator.gpu);
    has('canvas2d', () => { const c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); });
    has('webgl', () => { const c = document.createElement('canvas'); return !!(c.getContext && (c.getContext('webgl2') || c.getContext('webgl'))); });
    has('hardwareConcurrency', () => (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined));
    has('uxpVersion', () => (IS_UXP ? require('uxp').versions.uxp : undefined));
    has('host', () => (IS_UXP ? require('uxp').host.version : undefined));
    return f;
  }
  // "Auto": aim again, but keep anything painted
  function freshAimKeepPaint() { fx.autoOrigin = true; fx.autoAngle = true; }

  init();
  window.__disintegration = {
    get fx() { return fx; }, get session() { return session; }, get ref() { return lastRef; }, get renderMs() { return lastMs[0]; }, get timing() { return { lastMs: lastMs.slice(), lastScale, perf }; },
    get bridge() { return bridge; }, loadPreset, setTool, openStudio, quickDisintegrate, newBrushTip,
    // for trying custom tips without Photoshop: mask is w×h coverage (0…255)
    addTip(mask, w, h) { const tip = mask.length === w * h * 4 ? D.tipFromImage(mask, w, h) : D.tipFromMask(mask, w, h); if (!tip) return null; const t = { id: 'c' + Date.now().toString(36), label: 'My tip ' + (customTips.length + 1), n: tip.n, b64: toBase64(tip.data) }; customTips.push(t); store.set(LS_TIPS, customTips); applyCustomTips(); renderInspector(); return t.id; },
  };
})();
