/* Disintegration Studio — settings controls.
 *
 * The cards, sliders, switches and pickers of the settings column, as plain DOM. Everything is
 * on window.DSUI.controls; each factory returns an element, and anything that shows a value has
 * el._sync() to re-read it (main.js calls it on `.field` rows after preview drags, undo and
 * preset loads, so every value row carries the class `field`).
 *
 * UXP notes: there is no <canvas>, so every picture is a PNG drawn with DSUI.raster; UXP draws
 * every <button> as a wide pill, so the controls are <div>/<span>s with tabindex and key
 * handlers; dragging is mousedown on the element then mousemove/mouseup on document; layout is
 * flexbox and position:absolute only, and rotation is shown by redrawing the picture.
 *
 * Needs js/ui-raster.js first.
 */
(function () {
  'use strict';
  const DSUI = (window.DSUI = window.DSUI || {});
  const R = () => DSUI.raster;

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
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
  const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
  const tidy = (v) => Math.round(v * 1e4) / 1e4;
  const fmt = (v) => String(Math.round(v * 100) / 100);
  const call = (f, d) => (typeof f === 'function' ? f() : f == null ? d : f);
  const isActivate = (e) => e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 13 || e.keyCode === 32;
  // make a div behave like a button: click, Enter and Space
  function pressable(node, fn) {
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', (e) => fn(e));
    node.addEventListener('keydown', (e) => { if (isActivate(e)) { if (e.preventDefault) e.preventDefault(); fn(e); } });
    return node;
  }
  function setImg(img, url, w, h) {
    if (img._url !== url) { img.src = url; img._url = url; }
    if (w != null) { img.style.width = w + 'px'; img.style.height = h + 'px'; }
  }
  function image(url, w, h, cls) {
    const im = el('img', { class: cls || '', alt: '', draggable: 'false' });
    setImg(im, url, w, h);
    return im;
  }
  function rgba(hex, a) { const c = R().parseColor(hex); return [c[0], c[1], c[2], a]; }

  // ---------------------------------------------------------------------------
  // colours
  // ---------------------------------------------------------------------------
  const COLORS = {
    panel: '#262626', panel2: '#2B2B2B', card: '#2F2F2F', border: '#3B3B3B', well: '#1B1B1B',
    text: '#E6E6E6', muted: '#A3A3A3', hint: '#9E9E9E', primary: '#1F6FD6', select: '#4C9BFF',
    paint: '#4C9BFF', dispersion: '#F0A040', tips: '#C46BD8', particles: '#3FB5A3', motion: '#5CC4E8', look: '#D8C25A',
    aim: '#4C9BFF', add: '#F0A040', protect: '#4FC08D', erase: '#C8C8C8',
  };

  // ---------------------------------------------------------------------------
  // icons, drawn on a 16×16 logical grid and scaled to `size`; cached by name/size/colour
  // ---------------------------------------------------------------------------
  const iconCache = {};
  const ICONS = {
    paint(s, c) { // brush: handle, ferrule, tip
      s.line(13.5, 2.5, 8, 8, 2.2, c);
      s.poly([[7.2, 6.8], [9.2, 8.8], [7.5, 10.5], [5.5, 8.5]], c);
      s.poly([[5.2, 8.8], [7.2, 10.8], [5, 13.5], [2, 14], [2.5, 11]], c);
    },
    dispersion(s, c) { // a block breaking into scattered dots
      s.rect(1.5, 4, 5, 8, c, 1);
      [[8.5, 5, 1.3], [9, 9, 1.1], [11.5, 6.8, 1], [12, 11, 0.9], [14.2, 8.5, 0.8], [13.5, 4, 0.7]].forEach(([x, y, r]) => s.circle(x, y, r, c));
    },
    tips(s, c) { // three shards
      s.poly([[1.5, 9], [5.5, 2.5], [7, 8.5]], c);
      s.poly([[7.5, 3], [13.5, 1.5], [11.5, 7]], c);
      s.poly([[4.5, 14.5], [8.5, 9.5], [14.5, 12.5], [9.5, 15]], c);
    },
    particles(s, c) {
      [[3, 4, 1.6], [8, 3, 1.1], [12.5, 5, 1.7], [5, 9, 1.2], [10, 9.5, 1.5], [3.5, 13, 1], [8.5, 13.5, 1.3], [13.5, 12.5, 0.9]].forEach(([x, y, r]) => s.circle(x, y, r, c));
    },
    motion(s, c) { // arrow with speed lines
      s.line(5, 8, 12.5, 8, 2, c);
      s.poly([[10.5, 3.8], [15, 8], [10.5, 12.2]], c);
      s.line(1.5, 5, 4, 5, 1.4, c);
      s.line(1, 8, 3, 8, 1.4, c);
      s.line(1.5, 11, 4, 11, 1.4, c);
    },
    look(s, c) { // eye
      const top = [], bot = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16, x = 1 + 14 * t, y = 5.2 * Math.sin(Math.PI * t); top.push([x, 8 - y]); bot.push([x, 8 + y]); }
      s.path(top, 1.5, c); s.path(bot, 1.5, c);
      s.circle(8, 8, 2.8, c);
      s.circle(8, 8, 1.1, [27, 27, 27, 1]);
    },
    aim(s, c) { // crosshair
      s.ring(8, 8, 5, 1.5, c);
      s.line(8, 0.8, 8, 4.5, 1.5, c); s.line(8, 11.5, 8, 15.2, 1.5, c);
      s.line(0.8, 8, 4.5, 8, 1.5, c); s.line(11.5, 8, 15.2, 8, 1.5, c);
      s.circle(8, 8, 1.3, c);
    },
    disperse(s, c) { // a soft blob scattering to the right
      s.circle(5, 8, 3.8, c);
      [[10, 5.5, 1.3], [10.5, 10, 1.2], [13, 7.5, 1], [13.5, 12, 0.8], [14.5, 4, 0.7], [12, 2.5, 0.6]].forEach(([x, y, r]) => s.circle(x, y, r, c));
    },
    protect(s, c) { // shield
      const pts = [[8, 1.2], [14, 3.4], [13.4, 8.8], [8, 14.8], [2.6, 8.8], [2, 3.4]];
      s.poly(pts, c);
      s.poly([[8, 3.6], [11.8, 5], [11.4, 8.4], [8, 12.2]], [0, 0, 0, 0.28]);
    },
    erase(s, c) { // eraser: a tilted block with a lighter end
      s.poly([[6.5, 3], [14, 10.5], [10.5, 14], [3, 6.5]], c);
      s.poly([[3, 6.5], [6.5, 3], [9, 5.5], [5.5, 9]], [0, 0, 0, 0.35]);
      s.line(9, 15, 15, 15, 1.2, c);
    },
    trash(s, c) {
      s.rect(2.5, 3, 11, 1.6, c, 0.5);
      s.rect(6, 1.2, 4, 2, c, 0.6);
      s.poly([[3.6, 5.4], [12.4, 5.4], [11.5, 15], [4.5, 15]], c);
      s.line(6.5, 7.5, 6.7, 13, 1, [0, 0, 0, 0.45]); s.line(9.5, 7.5, 9.3, 13, 1, [0, 0, 0, 0.45]);
    },
    subject(s, c) { // head and shoulders inside selection corners
      s.circle(8, 6.2, 2.6, c);
      s.poly([[3.6, 14], [4.4, 11.2], [6.4, 9.8], [9.6, 9.8], [11.6, 11.2], [12.4, 14]], c);
      [[1, 1, 1, 4.5, 4.5, 1], [15, 1, 15, 4.5, 11.5, 1], [1, 15, 1, 11.5, 4.5, 15], [15, 15, 15, 11.5, 11.5, 15]].forEach(([x0, y0, x1, y1, x2, y2]) => s.path([[x1, y1], [x0, y0], [x2, y2]], 1.3, c));
    },
    chevronDown(s, c) { s.path([[4, 6], [8, 10], [12, 6]], 1.8, c); },
    chevronRight(s, c) { s.path([[6, 4], [10, 8], [6, 12]], 1.8, c); },
  };
  // an arrow pointing at `deg` (0 = right, 90 = down)
  function drawArrow(s, c, deg) {
    const a = (deg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const P = (t, n) => [8 + ux * t + px * n, 8 + uy * t + py * n];
    s.line(P(-5.5, 0)[0], P(-5.5, 0)[1], P(2, 0)[0], P(2, 0)[1], 1.8, c);
    s.poly([P(6.2, 0), P(0.8, 4.2), P(0.8, -4.2)], c);
  }
  // name: a key of ICONS, or 'arrow:<deg>'
  function iconUrl(name, size, color) {
    size = size || 16;
    const key = name + '|' + size + '|' + color;
    if (iconCache[key]) return iconCache[key];
    const s = R().create(size, size, 2), k = size / 16;
    // draw on the 16-grid by wrapping the surface
    const g = {
      line: (a, b, c2, d, w, col) => s.line(a * k, b * k, c2 * k, d * k, w * k, col),
      path: (pts, w, col) => s.path(pts.map(([x, y]) => [x * k, y * k]), w * k, col),
      poly: (pts, col) => s.poly(pts.map(([x, y]) => [x * k, y * k]), col),
      circle: (x, y, r, col) => s.circle(x * k, y * k, r * k, col),
      ring: (x, y, r, w, col) => s.ring(x * k, y * k, r * k, w * k, col),
      rect: (x, y, w, h, col, rad) => s.rect(x * k, y * k, w * k, h * k, col, (rad || 0) * k),
    };
    if (name.indexOf('arrow:') === 0) drawArrow(g, color, parseFloat(name.slice(6)));
    else (ICONS[name] || ICONS.particles)(g, color);
    return (iconCache[key] = s.url());
  }
  function icon(name, size, color, cls) { return image(iconUrl(name, size, color), size || 16, size || 16, cls || 'dsc-icon'); }

  // ---------------------------------------------------------------------------
  // 1. section card
  // ---------------------------------------------------------------------------
  const SECTION_ICON = { paint: 'paint', disp: 'dispersion', dispersion: 'dispersion', tips: 'tips', part: 'particles', particles: 'particles', motion: 'motion', look: 'look' };
  function section(o) {
    o = o || {};
    const accent = o.accent || COLORS.select;
    let open = o.open !== false;
    const chev = image('', 12, 12, 'dsc-chev');
    const head = el('div', { class: 'dsc-secHead', role: 'button' }, [
      icon(SECTION_ICON[o.icon] || o.icon || 'particles', 14, accent, 'dsc-secIcon'),
      el('span', { class: 'dsc-secTitle', text: o.title || '' }),
      el('span', { class: 'dsc-spacer' }),
      chev,
    ]);
    const body = el('div', { class: 'dsc-secBody' });
    const card = el('div', { class: 'dsc-section', id: o.id ? 'sec-' + o.id : null }, [head, body]);
    const show = () => {
      body.style.display = open ? '' : 'none';
      card.className = 'dsc-section' + (open ? ' open' : '');
      setImg(chev, iconUrl(open ? 'chevronDown' : 'chevronRight', 12, COLORS.muted), 12, 12);
    };
    pressable(head, () => { open = !open; show(); if (o.onToggle) o.onToggle(open); });
    show();
    card._setOpen = (v) => { open = !!v; show(); };
    return { el: card, body, head, setOpen: card._setOpen, isOpen: () => open };
  }

  // ---------------------------------------------------------------------------
  // 2. slider (replaces main.js rangeField; same value semantics)
  // ---------------------------------------------------------------------------
  // Fine mode is for precision. A slider is only as precise as it is long, so in fine mode it
  // covers a tenth of the setting's range, around the value it holds, in steps a tenth of the
  // size. Let go near either end and it moves along, so the whole range can still be reached.
  // `whole` marks a setting that only takes whole numbers; fine mode leaves it be.
  const FINE_SPAN = 0.1, FINE_STEP = 0.1;
  function slider(o) {
    const { get, set } = o;
    const min = o.min != null ? o.min : 0, max = o.max != null ? o.max : 100, step = o.step || 1, mul = o.mul || 1;
    const accent = o.accent || COLORS.select;
    const lbl = el('span', { class: 'dsc-lbl', text: o.label || '', title: (o.tip ? o.tip + ' — ' : '') + 'double-click to reset' });
    const range = el('input', { type: 'range', class: 'dsc-range', min: String(min), max: String(max), step: String(step) });
    const box = el('input', { type: 'number', class: 'dsc-num', step: String(step), min: String(min), max: String(max) });
    // the accent strip under the native slider: where the value sits in the whole range
    const fill = el('div', { class: 'dsc-fill', style: 'background-color:' + accent });
    const win = el('div', { class: 'dsc-fineWin', style: 'display:none' });
    const strip = el('div', { class: 'dsc-strip' }, [win, fill]);
    let tick = null;
    if (o.bipolar) { tick = el('div', { class: 'dsc-tick' }); strip.appendChild(tick); }
    const fine = () => !!(o.isFine && o.isFine()) && !o.whole;
    let lo = min, hi = max, framed = '';
    const pctOf = (d) => clampN(((d - min) / (max - min || 1)) * 100, 0, 100);
    const paint = (d) => {
      const p = pctOf(d);
      if (o.bipolar) {
        const c = pctOf(clampN(0, min, max));
        fill.style.left = Math.min(p, c) + '%'; fill.style.width = Math.abs(p - c) + '%';
        tick.style.left = c + '%';
      } else { fill.style.left = '0%'; fill.style.width = p + '%'; }
      if (fine()) { win.style.display = ''; win.style.left = pctOf(lo) + '%'; win.style.width = (pctOf(hi) - pctOf(lo)) + '%'; } else win.style.display = 'none';
    };
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
      [['min', lo], ['max', hi], ['step', st]].forEach(([k, v]) => { range.setAttribute(k, String(v)); try { range[k] = String(v); } catch (e) { /* attribute only */ } });
      box.setAttribute('step', String(st));
    };
    const sync = () => { const d = get() * mul; framed = ''; frame(d); range.value = String(d); box.value = fmt(d); paint(d); };
    sync();
    range.addEventListener('input', () => { const d = parseFloat(range.value); box.value = fmt(d); set(d / mul); paint(d); });
    range.addEventListener('change', () => {
      const d = parseFloat(range.value);
      box.value = fmt(d); set(d / mul);
      // let go near an end of a fine slider: move it along, so that there is room to go on
      if (fine() && ((d - lo < (hi - lo) * 0.15 && lo > min) || (hi - d < (hi - lo) * 0.15 && hi < max))) { framed = ''; frame(d); range.value = String(d); }
      paint(d);
    });
    // the box applies as it changes (typing, the arrow keys, the wheel), and is tidied when it is left
    box.addEventListener('input', () => {
      const d = parseFloat(box.value);
      if (isNaN(d) || d < min || d > max) return;
      set(d / mul);
      if (d < lo || d > hi) { framed = ''; frame(d); }
      range.value = String(d); paint(d);
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
      range.value = String(d); paint(d);
    });
    box.addEventListener('change', () => { const d = parseFloat(box.value); if (isNaN(d)) return sync(); set(clampN(d, min, max) / mul); sync(); });
    lbl.addEventListener('dblclick', () => { if (o.def != null) { set(o.def); sync(); } });

    const kids = [
      el('div', { class: 'dsc-sRow' }, [lbl, el('span', { class: 'dsc-spacer' }), box]),
      el('div', { class: 'dsc-track' }, [range, strip]),
    ];
    if (o.lo || o.hi) kids.push(el('div', { class: 'dsc-ends' }, [el('span', { text: o.lo || '' }), el('span', { class: 'dsc-spacer' }), el('span', { text: o.hi || '' })]));
    const row = el('div', { class: 'field dsc-slider' + (o.bipolar ? ' bipolar' : '') }, kids);
    row._sync = sync;
    row._range = range; row._box = box; row._label = lbl;
    return row;
  }

  // ---------------------------------------------------------------------------
  // 3. toggle switch
  // ---------------------------------------------------------------------------
  function toggle(o) {
    const knob = el('div', { class: 'dsc-knob' });
    const pill = el('div', { class: 'dsc-switch' }, [knob]);
    const title = el('div', { class: 'dsc-tTitle', text: o.label || '' });
    const hint = el('div', { class: 'dsc-tHint' });
    const row = el('div', { class: 'field dsc-toggle', role: 'switch', title: o.tip || null }, [
      el('div', { class: 'dsc-tText' }, [title, hint]), pill,
    ]);
    const sync = () => {
      const on = !!o.get();
      pill.className = 'dsc-switch' + (on ? ' on' : '');
      knob.style.left = (on ? 20 : 2) + 'px';
      const h = typeof o.hint === 'function' ? o.hint(on) : o.hint;
      hint.textContent = h || '';
      hint.style.display = h ? '' : 'none';
      row.setAttribute('aria-checked', on ? 'true' : 'false');
    };
    pressable(row, () => { o.set(!o.get()); sync(); });
    sync();
    row._sync = sync;
    return row;
  }

  // ---------------------------------------------------------------------------
  // 4. segmented tool switch, and a small icon button for its trailing slot
  // ---------------------------------------------------------------------------
  function segmented(o) {
    const opts = o.options || [];
    let cur = o.get ? o.get() : opts.length ? opts[0].value : null;
    const cells = opts.map((op) => {
      const color = op.color || COLORS.select;
      const im = image('', 18, 18, 'dsc-segIcon');
      const bar = el('div', { class: 'dsc-segBar', style: 'background-color:' + color });
      const cell = el('div', { class: 'dsc-seg', title: op.title || null }, [im, el('div', { class: 'dsc-segLbl', text: op.label || '' }), bar]);
      cell._paint = (sel) => {
        cell.className = 'dsc-seg' + (sel ? ' on' : '');
        bar.style.display = sel ? '' : 'none';
        if (op.icon) setImg(im, iconUrl(op.icon, 18, sel ? color : COLORS.muted), 18, 18); else im.style.display = 'none';
      };
      pressable(cell, () => { setValue(op.value); if (o.set) o.set(op.value); });
      return cell;
    });
    const kids = [el('div', { class: 'dsc-segCells' }, cells)];
    if (o.extra) kids.push(el('div', { class: 'dsc-segExtra' }, [o.extra]));
    const row = el('div', { class: 'field dsc-segmented' }, kids);
    function setValue(v) { cur = v; cells.forEach((c, i) => c._paint(opts[i].value === v)); }
    const sync = () => setValue(o.get ? o.get() : cur);
    setValue(cur);
    row._sync = sync;
    row.setValue = setValue;
    row.getValue = () => cur;
    return row;
  }
  // ---------------------------------------------------------------------------
  // 4b. tab container headers: a row of tabs, each an icon and a name, the open one joined to the
  // panel below it (the panel is the element that follows; give it the .dsc-tabPanel colours).
  // When the names don't all fit, the tabs that aren't open show only their icon (the name is in
  // the tooltip). Call row._fit() after the width changes.
  // ---------------------------------------------------------------------------
  function tabs(o) {
    const opts = o.options || [];
    let cur = o.get ? o.get() : opts.length ? opts[0].value : null, compact = false;
    const cells = opts.map((op) => {
      const color = op.color || COLORS.select;
      const im = image('', 14, 14, 'dsc-tabIcon');
      const lbl = el('span', { class: 'dsc-tabLbl', text: op.label || '' });
      const top = el('div', { class: 'dsc-tabTop', style: 'background-color:' + color });
      const cell = el('div', { class: 'dsc-tab', title: (op.label || '') + (op.title ? ' — ' + op.title : '') }, [top, im, lbl]);
      cell._paint = (sel) => {
        cell.className = 'dsc-tab' + (sel ? ' on' : '');
        top.style.display = sel ? '' : 'none';
        lbl.style.display = sel || !compact ? '' : 'none';
        im.style.marginRight = sel || !compact ? '' : '0px';
        setImg(im, iconUrl(op.icon, 14, sel ? color : COLORS.muted), 14, 14);
      };
      pressable(cell, () => { setValue(op.value); if (o.set) o.set(op.value); });
      return cell;
    });
    const row = el('div', { class: 'dsc-tabs' }, [el('div', { class: 'dsc-tabGap' })].concat(cells, [el('div', { class: 'dsc-tabFill' })]));
    function setValue(v) { cur = v; cells.forEach((c, i) => c._paint(opts[i].value === v)); }
    // All the names if they fit, otherwise only the open tab's. The width they need is measured
    // once, while every name is still showing: Photoshop doesn't lay the row out again until the
    // script returns, so measuring straight after showing or hiding names reads the old layout.
    let full = 0;
    function fit(width) { // width: the room there is, if the caller knows it (the row may not be laid out at it yet)
      const avail = width || row.getBoundingClientRect().width;
      if (!avail) return;
      if (!full) {
        // (A dialog that isn't on screen yet reports nothing, or nonsense: every tab is at least
        // its icon, padding and border wide, so a narrower one means the row isn't laid out.)
        let used = 12, laidOut = true;
        cells.forEach((c) => { const w = c.getBoundingClientRect().width; if (w < 30) laidOut = false; used += w + 2; });
        if (!laidOut) return;
        full = used;
        if (o.onMeasured) o.onMeasured(full);
      }
      const want = full > avail;
      if (want === compact) return;
      compact = want;
      cells.forEach((c, i) => c._paint(opts[i].value === cur));
    }
    setValue(cur);
    row._sync = () => setValue(o.get ? o.get() : cur);
    row._fit = fit;
    row._need = () => full; // the width every name needs (0 until it has been measured)
    row.setValue = setValue;
    row.getValue = () => cur;
    return row;
  }
  function iconButton(o) {
    const kids = [];
    if (o.icon) kids.push(icon(o.icon, 14, o.color || COLORS.muted, 'dsc-ibIcon'));
    if (o.label) kids.push(el('span', { class: 'dsc-ibLbl', text: o.label }));
    const b = el('div', { class: 'dsc-iconBtn' + (o.label ? '' : ' bare'), title: o.title || null }, kids);
    pressable(b, (e) => { if (b._disabled) return; if (o.onClick) o.onClick(e); });
    b.setDisabled = (v) => { b._disabled = !!v; b.style.opacity = v ? '0.4' : ''; };
    return b;
  }

  // ---------------------------------------------------------------------------
  // 5. picture tiles ("Starts from")
  // ---------------------------------------------------------------------------
  const TW = 92, TH = 46; // tile picture, logical px
  function dashedRing(s, cx, cy, r, width, c, n) {
    n = n || Math.max(8, Math.round((2 * Math.PI * r) / 5));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 0.5) / n) * 2 * Math.PI;
      s.line(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, width, c);
    }
  }
  function dashedLine(s, x0, y0, x1, y1, w, c, dash, gap) {
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    for (let t = 0; t < L; t += dash + gap) { const t1 = Math.min(L, t + dash); s.line(x0 + ux * t, y0 + uy * t, x0 + ux * t1, y0 + uy * t1, w, c); }
  }
  function arrowHead(s, x, y, deg, size, c) {
    const a = (deg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    s.poly([[x + ux * size, y + uy * size], [x - uy * size * 0.7, y + ux * size * 0.7], [x + uy * size * 0.7, y - ux * size * 0.7]], c);
  }
  const PICTURES = {
    sweep(s, on) {
      const orange = on ? COLORS.dispersion : '#B07A3C', grey = on ? '#6A6A6A' : '#555';
      s.rect(34, 9, 40, 28, grey, 3);
      [[30, 12, 1.4], [27, 20, 1.1], [31, 30, 1.2], [24, 27, 0.9], [22, 15, 0.8]].forEach(([x, y, r]) => s.circle(x, y, r, rgba(orange, 0.7)));
      s.line(6, 23, 30, 23, 2.4, orange);
      arrowHead(s, 33, 23, 0, 6, orange);
    },
    point(s, on) {
      const orange = on ? COLORS.dispersion : '#B07A3C', grey = on ? '#6A6A6A' : '#555';
      s.rect(24, 4, 44, 38, rgba(grey, 0.55), 3);
      dashedRing(s, 46, 23, 17, 1.3, rgba(orange, 0.55));
      dashedRing(s, 46, 23, 10, 1.3, rgba(orange, 0.85));
      s.circle(46, 23, 3.4, orange);
    },
    edges(s, on) {
      const orange = on ? COLORS.dispersion : '#B07A3C', grey = on ? '#8A8A8A' : '#666';
      const x0 = 28, y0 = 8, x1 = 64, y1 = 38;
      dashedLine(s, x0, y0, x1, y0, 1.3, grey, 3, 2.5); dashedLine(s, x1, y0, x1, y1, 1.3, grey, 3, 2.5);
      dashedLine(s, x1, y1, x0, y1, 1.3, grey, 3, 2.5); dashedLine(s, x0, y1, x0, y0, 1.3, grey, 3, 2.5);
      s.line(16, 23, 26, 23, 1.8, orange); arrowHead(s, 27, 23, 0, 4, orange);
      s.line(76, 23, 66, 23, 1.8, orange); arrowHead(s, 65, 23, 180, 4, orange);
      s.line(46, 0.5, 46, 10, 1.8, orange); arrowHead(s, 46, 12, 90, 4, orange);
      s.line(46, 45.5, 46, 36, 1.8, orange); arrowHead(s, 46, 34, -90, 4, orange);
    },
  };
  const picCache = {};
  function pictureUrl(name, on) {
    const key = name + (on ? '1' : '0');
    if (picCache[key]) return picCache[key];
    const s = R().create(TW, TH, 2);
    (PICTURES[name] || PICTURES.sweep)(s, on);
    return (picCache[key] = s.url());
  }
  function tiles(o) {
    const opts = o.options || [];
    const tilesEl = opts.map((op) => {
      const im = image('', TW, TH, 'dsc-tilePic');
      const t = el('div', { class: 'dsc-tile', title: op.title || null }, [im, el('div', { class: 'dsc-tileLbl', text: op.label || '' })]);
      t._paint = (sel) => { t.className = 'dsc-tile' + (sel ? ' on' : ''); setImg(im, pictureUrl(op.picture || op.value, sel), TW, TH); };
      pressable(t, () => { if (row._off) return; o.set(op.value); sync(); });
      return t;
    });
    const row = el('div', { class: 'field dsc-tiles' }, tilesEl);
    function sync() {
      const v = o.get();
      tilesEl.forEach((t, i) => t._paint(opts[i].value === v));
      row._off = !!(o.disabled && o.disabled());
      row.style.opacity = row._off ? '0.4' : '';
      row.className = 'field dsc-tiles' + (row._off ? ' off' : '');
    }
    sync();
    row._sync = sync;
    return row;
  }

  // ---------------------------------------------------------------------------
  // 6. direction dial
  // ---------------------------------------------------------------------------
  const DIAL = 120, DC = DIAL / 2;
  let dialBase = null;
  function dialBaseUrl() {
    if (dialBase) return dialBase;
    const s = R().create(DIAL, DIAL, 2);
    s.circle(DC, DC, 58, '#3B3B3B');
    s.circle(DC, DC, 57, '#1B1B1B');
    s.circle(DC, DC, 40, '#202020');
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI, long = i % 6 === 0, r0 = long ? 45 : 50, r1 = 54;
      s.line(DC + Math.cos(a) * r0, DC + Math.sin(a) * r0, DC + Math.cos(a) * r1, DC + Math.sin(a) * r1, long ? 1.8 : 1.1, long ? '#8A8A8A' : '#5A5A5A');
    }
    return (dialBase = s.url());
  }
  // the needle layer, transparent around it; a small LRU cache, since each picture is ~300 KB of base64
  const needleCache = new Map();
  function needleUrl(deg) {
    const key = Math.round(deg);
    if (needleCache.has(key)) { const u = needleCache.get(key); needleCache.delete(key); needleCache.set(key, u); return u; }
    const s = R().create(DIAL, DIAL, 2), orange = COLORS.dispersion;
    const a = (key * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const P = (t, n) => [DC + ux * t + px * n, DC + uy * t + py * n];
    // particles trailing off the tip, fanning a little
    [[22, 5, 1.1, 0.35], [27, -6, 1.3, 0.45], [31, 3.5, 1.5, 0.55], [35, -2.5, 1.2, 0.7], [38, 7, 1, 0.45], [42, -5, 1.4, 0.6], [46, 2, 1.1, 0.8], [44, 9, 0.8, 0.4]]
      .forEach(([t, n, r, al]) => { const [x, y] = P(t, n); s.circle(x, y, r, rgba(orange, al)); });
    const tail = P(-10, 0), tip = P(30, 0);
    s.line(tail[0], tail[1], tip[0], tip[1], 2.6, orange);
    s.poly([P(41, 0), P(29, 6), P(29, -6)], orange);
    s.circle(DC, DC, 4.5, orange);
    s.circle(DC, DC, 2, '#1B1B1B');
    const u = s.url();
    needleCache.set(key, u);
    if (needleCache.size > 40) needleCache.delete(needleCache.keys().next().value);
    return u;
  }
  const QUICK = [['up', -90], ['up-right', -45], ['right', 0], ['down-right', 45], ['down', 90], ['down-left', 135], ['left', 180], ['up-left', -135]];
  const normDeg = (d) => { d = ((((d + 180) % 360) + 360) % 360) - 180; return d === -180 ? 180 : d; };
  function dial(o) {
    const base = image(dialBaseUrl(), DIAL, DIAL, 'dsc-dialBase');
    const needle = image('', DIAL, DIAL, 'dsc-dialNeedle');
    const face = el('div', { class: 'dsc-dial', title: 'Drag to set the direction · Shift snaps to 15°' }, [base, needle]);
    const box = el('input', { type: 'number', class: 'dsc-num dsc-degBox', min: '-180', max: '180', step: '1' });
    const auto = el('span', { class: 'dsc-chip', text: 'Auto', title: 'Point the pieces away from the start point automatically' });
    pressable(auto, () => { if (o.onAuto) o.onAuto(); sync(); });
    const quick = QUICK.map(([name, deg]) => {
      const im = image('', 14, 14, 'dsc-qIcon');
      const c = el('div', { class: 'dsc-q', title: name.replace('-', ' ') + ' (' + deg + '°)' }, [im]);
      c._paint = (sel) => { c.className = 'dsc-q' + (sel ? ' on' : ''); setImg(im, iconUrl('arrow:' + deg, 14, sel ? '#FFFFFF' : COLORS.muted), 14, 14); };
      pressable(c, () => apply(deg));
      return c;
    });
    const side = el('div', { class: 'dsc-dialSide' }, [
      el('div', { class: 'dsc-degRow' }, [box, el('span', { class: 'dsc-deg', text: '°' }), el('span', { class: 'dsc-spacer' }), auto]),
      el('div', { class: 'dsc-qRow' }, quick.slice(0, 4)),
      el('div', { class: 'dsc-qRow' }, quick.slice(4)),
    ]);
    const row = el('div', { class: 'field dsc-dialRow' }, [face, side]);

    let shown = null, pending = null, timer = null;
    // redraw the needle only when the rounded angle changes; during a drag at most every ~30 ms
    const draw = (deg, now) => {
      const k = Math.round(normDeg(deg));
      if (k === shown) return;
      if (now) { if (timer) { clearTimeout(timer); timer = null; } shown = k; setImg(needle, needleUrl(k), DIAL, DIAL); return; }
      pending = k;
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (pending !== shown) { shown = pending; setImg(needle, needleUrl(pending), DIAL, DIAL); } }, 30);
    };
    function paint(d, now) {
      draw(d, now);
      const k = Math.round(normDeg(d));
      quick.forEach((c, i) => c._paint(normDeg(QUICK[i][1]) === k));
      auto.className = 'dsc-chip' + (o.isAuto && o.isAuto() ? ' on' : '');
    }
    function apply(d, live) {
      d = normDeg(Math.round(d));
      o.set(d);
      box.value = String(d);
      paint(d, !live);
    }
    function sync() { const d = Number(o.get()) || 0; box.value = fmt(d); paint(d, true); }

    // dragging
    const angleAt = (e, snap) => {
      const r = face.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
      if (x * x + y * y < 4) return null;
      let d = (Math.atan2(y, x) * 180) / Math.PI;
      d = snap ? Math.round(d / 15) * 15 : Math.round(d);
      return normDeg(d);
    };
    let dragging = false, last = null;
    const move = (e) => { if (!dragging) return; const d = angleAt(e, e.shiftKey); if (d != null && d !== last) { last = d; apply(d, true); } };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      if (last != null) paint(last, true);
    };
    face.addEventListener('mousedown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.preventDefault) e.preventDefault();
      dragging = true; last = null;
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      move(e);
    });

    // the number box: applies as typed; Up/Down nudge by 1, 10 with Shift
    box.addEventListener('input', () => { const d = parseFloat(box.value); if (isNaN(d) || d < -180 || d > 180) return; o.set(Math.round(d)); paint(d, true); });
    box.addEventListener('keydown', (e) => {
      const isUp = e.key === 'ArrowUp' || e.key === 'Up', isDown = e.key === 'ArrowDown' || e.key === 'Down';
      if (!isUp && !isDown) return;
      if (e.preventDefault) e.preventDefault();
      const cur = parseFloat(box.value), st = e.shiftKey ? 10 : 1;
      apply(clampN((isNaN(cur) ? Number(o.get()) || 0 : cur) + (isUp ? st : -st), -180, 180));
    });
    box.addEventListener('change', () => { const d = parseFloat(box.value); if (isNaN(d)) return sync(); apply(clampN(d, -180, 180)); });

    sync();
    row._sync = sync;
    return row;
  }

  // ---------------------------------------------------------------------------
  // 7. brush preview and the block that lays it beside the brush sliders
  // ---------------------------------------------------------------------------
  const BP = 112, BC = BP / 2;
  const MODE_COLOR = { aim: COLORS.aim, add: COLORS.add, protect: COLORS.protect, erase: COLORS.erase };
  function brushPreview(o) {
    const im = image('', BP, BP, 'dsc-bpImg');
    const well = el('div', { class: 'dsc-bpWell' }, [im]);
    const cap = el('div', { class: 'dsc-bpCap', text: 'Solid: edge · dashed: fade starts · dotted: blend' });
    const box = el('div', { class: 'field dsc-brushPreview' }, [well, cap]);
    let key = '';
    function sync() {
      const b = o.get() || {};
      const size = clampN(+b.size || 0.08, 0.01, 0.4), hard = clampN(b.hard == null ? 0.5 : +b.hard, 0, 1);
      const flow = clampN(b.flow == null ? 1 : +b.flow, 0.05, 1), blend = clampN(+b.blend || 0, 0, 1);
      const mode = MODE_COLOR[b.mode] ? b.mode : 'add';
      const k = [mode, size.toFixed(3), hard.toFixed(2), flow.toFixed(2), blend.toFixed(2)].join('|');
      if (k === key) return;
      key = k;
      const s = R().create(BP, BP, 2), col = MODE_COLOR[mode];
      // a faint grid so the soft edge reads against something
      for (let g = 14; g < BP; g += 14) { s.line(g, 2, g, BP - 2, 0.6, 'rgba(255,255,255,0.04)'); s.line(2, g, BP - 2, g, 0.6, 'rgba(255,255,255,0.04)'); }
      const r = 5 + ((size - 0.01) / 0.39) * 33; // radius 5..38
      s.circle(BC, BC, r, rgba(col, 0.2 + 0.8 * flow), 1 - hard * 0.92);
      // the same rings as the outline on the preview: edge, where the fade starts, blend reach
      const core = r * hard, reach = Math.min(53, core + 44 * blend);
      const halo = (rad, a) => s.ring(BC, BC, rad, 2.4, 'rgba(0,0,0,' + a + ')');
      if (blend > 0.005 && reach > r + 1.5) { halo(reach, 0.3); dashedRing(s, BC, BC, reach, 1, 'rgba(255,255,255,0.7)', Math.max(10, Math.round((2 * Math.PI * reach) / 3))); }
      if (hard < 0.97 && core > 2.5 && r - core > 1.5) { halo(core, 0.3); dashedRing(s, BC, BC, core, 1, 'rgba(255,255,255,0.8)'); }
      halo(r, 0.55); s.ring(BC, BC, r, 1, 'rgba(255,255,255,0.95)');
      setImg(im, s.url(), BP, BP);
      box.className = 'field dsc-brushPreview mode-' + mode;
    }
    sync();
    box._sync = sync;
    return box;
  }
  // preview on the left, sliders stacked on the right; `below` (optional) spans the full width.
  // The block re-reads the preview whenever an input inside it changes, so main.js need not.
  function brushBlock(o) {
    const sliders = el('div', { class: 'dsc-bbSliders' }, o.sliders || []);
    const top = el('div', { class: 'dsc-bbTop' }, [o.preview, sliders]);
    const kids = [top];
    if (o.below) [].concat(o.below).forEach((b) => kids.push(b));
    const block = el('div', { class: 'dsc-brushBlock' }, kids);
    let t = null;
    const later = () => { if (t) return; t = setTimeout(() => { t = null; if (o.preview && o.preview._sync) o.preview._sync(); }, 0); };
    ['input', 'change', 'keydown', 'dblclick'].forEach((ev) => block.addEventListener(ev, later));
    return block;
  }

  // ---------------------------------------------------------------------------
  // copy for the slider end hints, keyed by fx property: [left, right]
  // ---------------------------------------------------------------------------
  const HINTS = {
    amount: ['A nibble', 'All of it'],
    roughness: ['Clean front', 'Ragged, deep'],
    chunk: ['Fine nibbles', 'Big bays'],
    softness: ['Crisp bites', 'Dust and smoke'],
    blend: ['Sharp cut-off', 'Long fade'],
    density: ['Sparse', 'Packed'],
    size: ['Thousands of specks', 'Dozens of chunks'],
    sizeVar: ['All alike', 'Wildly mixed'],
    spin: ['Upright', 'Spinning'],
    texture: ['Flat colour', 'Carries the picture'],
    distance: ['Drift', 'Blast'],
    spread: ['Tight beam', 'Wide fan'],
    burst: ['Steady', 'Explosive start'],
    turbulence: ['Straight', 'Wild'],
    turbScale: ['Tight eddies', 'Big curls'],
    gravity: ['Rises', 'Falls (negative = rise)'],
    trail: ['None', 'Long streaks'],
    fade: ['Stays solid', 'Fades away'],
    shrink: ['Keeps size', 'Shrinks to nothing'],
    opacity: ['Ghostly', 'Solid'],
    colorVar: ['True colour', 'Varied'],
  };

  DSUI.controls = {
    section, slider, toggle, segmented, tabs, iconButton, tiles, dial, brushPreview, brushBlock,
    HINTS, COLORS, icon, iconUrl, el,
  };
})();
