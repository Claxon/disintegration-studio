/* Disintegration Studio — the brush tip mix.
 *
 *   const tips = DSUI.tips.mount(host, api);   // renders into host
 *   tips.refresh();                            // after undo, a preset load or a tip deletion
 *
 * api = {
 *   getTips()            → fx.tips, a map { tipId: weight } (only proportions matter)
 *   setTips(map)         → stores a NEW map (shares as fractions summing to about 1) and commits
 *   tipList()            → [{ id, label, kind: 'natural' | 'geometric' | 'custom' }]
 *   tipPreview(id, n)    → n×n Uint8Array coverage 0..255
 *   deleteCustomTip(id)  → permanently deletes a tip of the user's own
 *   overlayHost          → element the library sheet is laid over (should be position: relative)
 *   describe(id)         → optional one-line description
 * }
 *
 * UXP has no canvas, so every picture is a PNG data URL from DSUI.raster. Controls are divs and
 * spans (UXP draws <button> as a wide pill), dragging uses mouse events on the document, and the
 * layout is flexbox and absolute positioning only.
 *
 * The share arithmetic is pure and exported as DSUI.tips._math for tests.
 */
(function () {
  'use strict';
  const DSUI = (window.DSUI = window.DSUI || {});

  const PALETTE = ['#4C9BFF', '#F0A040', '#3FB5A3', '#C46BD8', '#E0675A', '#9BC250', '#5CC4E8', '#D8C25A'];
  const MIN = 0.01;            // smallest share a drag or the fine-tune slider leaves a tip
  const LABEL_AT = 0.13;       // a band at least this wide shows its thumbnail and percentage
  const DARK = '#141414', LIGHT = '#E8E8E8';
  const DESCRIPTIONS = {
    chip: 'Irregular flat-sided fragments, like chipped stone or paint.',
    flake: 'Rough-edged, torn-looking pieces.',
    crumb: 'Small rounded lumps.',
    splat: 'A spiky blot with droplets around it.',
    grit: 'A cluster of small grains.',
    ash: 'Ragged flakes with holes in them, slightly soft.',
    sliver: 'Long thin splinters.',
    drybrush: 'Streaky dabs, as from a nearly dry brush.',
    petal: 'Teardrop shapes.',
    smoke: 'Large soft puffs.',
    dust: 'Small soft dots.',
    shard: 'Triangles.',
    square: 'Squares. With Tumble at 0 they stay upright, for a pixel look.',
    dot: 'Circles.',
    custom: 'Made from your own selection or layer.',
  };
  const NEW_TIP_HOW = 'select a shape in Photoshop and choose Plugins › Disintegration Studio › New Brush Tip from Selection or Layer.';
  const NOTE = 'Every tip comes in several variations, so no two pieces look alike. To make your own, ' + NEW_TIP_HOW;
  const CATS = [['all', 'All'], ['natural', 'Natural'], ['geometric', 'Geometric'], ['custom', 'My tips']];

  // ---- share arithmetic (pure) ----------------------------------------------
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // the tips in use, in the map's own order; `known` (optional) is a set-like object of valid ids
  function activeIds(map, known) {
    const out = [];
    if (!map || typeof map !== 'object') return out;
    for (const id in map) if (+map[id] > 0 && (!known || known[id])) out.push(id);
    return out;
  }
  // each tip's share of the total, as fractions that sum to 1
  function sharesOf(map, ids) {
    const w = ids.map((id) => Math.max(0, +(map && map[id]) || 0)), t = sum(w);
    return t > 0 ? w.map((x) => x / t) : even(ids.length);
  }
  function even(n) { const out = []; for (let i = 0; i < n; i++) out.push(1 / n); return out; }
  // move the boundary between tips i and i+1 to `pos` (a fraction of the whole bar); only those two change
  function drag(shares, i, pos) {
    const s = shares.slice();
    if (i < 0 || i >= s.length - 1) return s;
    const pair = s[i] + s[i + 1];
    if (pair < 2 * MIN) return s;
    const start = sum(s.slice(0, i));
    s[i] = clamp(pos - start, MIN, pair - MIN);
    s[i + 1] = pair - s[i];
    return s;
  }
  // set tip i's share to v (0..1); the others are rescaled in proportion so the total stays 1,
  // and none is left below MIN
  function setShare(shares, i, v) {
    const n = shares.length;
    if (n <= 1) return n ? [1] : [];
    v = clamp(+v || 0, MIN, 1 - MIN * (n - 1));
    const out = shares.slice(), fixed = {};
    out[i] = v;
    for (let pass = 0; pass < n; pass++) {
      let rest = 1 - v, free = 0;
      for (let j = 0; j < n; j++) if (j !== i) { if (fixed[j]) rest -= MIN; else free += shares[j]; }
      let clampedNew = false;
      for (let j = 0; j < n; j++) {
        if (j === i || fixed[j]) continue;
        const cnt = n - 1 - Object.keys(fixed).length;
        out[j] = free > 0 ? (shares[j] / free) * rest : rest / cnt;
        if (out[j] < MIN) { fixed[j] = true; out[j] = MIN; clampedNew = true; }
      }
      for (const j in fixed) out[j] = MIN;
      if (!clampedNew) break;
    }
    return out;
  }
  // take tip i out; the rest keep their relative proportions
  function remove(shares, i) {
    const s = shares.filter((_, j) => j !== i), t = sum(s);
    return t > 0 ? s.map((x) => x / t) : even(s.length);
  }
  // append k new tips, each with 1/(n+k); the existing ones are scaled by 1 - k/(n+k)
  function add(shares, k) {
    const n = shares.length, tot = n + k;
    if (k <= 0) return shares.slice();
    const t = sum(shares), keep = 1 - k / tot;
    const out = shares.map((x) => (t > 0 ? (x / t) * keep : 1 / tot));
    for (let j = 0; j < k; j++) out.push(1 / tot);
    return out;
  }
  // whole percentages that add up to 100 (largest remainder); a tip in use never shows 0%
  function percents(shares) {
    const n = shares.length;
    if (!n) return [];
    const t = sum(shares) || 1, raw = shares.map((x) => (x / t) * 100), out = raw.map(Math.floor);
    let left = 100 - sum(out);
    const order = raw.map((x, j) => [x - Math.floor(x), j]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k][1]]++;
    for (let j = 0; j < n; j++) {
      if (out[j] > 0 || shares[j] <= 0) continue;
      let big = 0;
      for (let q = 1; q < n; q++) if (out[q] > out[big]) big = q;
      if (out[big] > 1) { out[big]--; out[j] = 1; }
    }
    return out;
  }
  function toMap(ids, shares) {
    const m = {};
    ids.forEach((id, j) => { m[id] = Math.max(0.0001, Math.round(shares[j] * 10000) / 10000); });
    return m;
  }
  const math = { MIN, activeIds, sharesOf, even, drag, setShare, remove, add, percents, toMap };

  // ---- DOM helpers ------------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function hasCls(n, c) { return (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };
  // a div or span that acts as a button: click, Enter or Space
  function ctl(n, fn, title) {
    n.setAttribute('tabindex', '0');
    if (title) n.setAttribute('title', title);
    n.addEventListener('click', (e) => { stop(e); if (!hasCls(n, 'dst-disabled')) fn(e); });
    n.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.preventDefault) e.preventDefault();
      stop(e);
      if (!hasCls(n, 'dst-disabled')) fn(e);
    });
    return n;
  }

  // ---- state that outlives a re-mount ---------------------------------------
  const state = { sel: null, libOpen: false, libSel: [], q: '', cat: 'all', confirmDel: null };
  let current = null;

  function mount(host, api) {
    if (current) current.destroy();
    current = instance(host, api);
    // isLibraryOpen / closeLibrary let the host route Escape: Photoshop closes the whole dialog on
    // Escape before the page sees the key, so the host stops that and closes the sheet instead
    return { refresh: current.refresh, isLibraryOpen: current.isLibraryOpen, closeLibrary: current.closeLibrary };
  }

  function instance(host, api) {
    let list = [], byId = {}, sig = '';
    let ids = [], shares = [];
    const thumbs = {}, previews = {};
    const root = el('div', 'dst-tips');
    host.appendChild(root);
    let refs = null;                 // the parts update() changes in place
    let lib = null;                  // the open library sheet's parts
    let alive = true;

    // -- data --
    function readList() {
      list = (api.tipList && api.tipList()) || [];
      const s = list.map((t) => t.id + ':' + t.label).join('|');
      if (s !== sig) { sig = s; for (const k in thumbs) delete thumbs[k]; for (const k in previews) delete previews[k]; }
      byId = {};
      list.forEach((t) => { byId[t.id] = t; });
    }
    function readTips() {
      const map = (api.getTips && api.getTips()) || {};
      ids = activeIds(map, byId);
      shares = sharesOf(map, ids);
      if (state.sel && ids.indexOf(state.sel) < 0) state.sel = null;
    }
    function write(newIds, newShares) {
      ids = newIds; shares = newShares;
      api.setTips(toMap(ids, shares));
    }
    const colorOf = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
    const labelOf = (id) => (byId[id] ? byId[id].label : id);
    function describe(id) {
      let d;
      try { d = api.describe ? api.describe(id) : undefined; } catch (e) { d = undefined; }
      if (d) return d;
      if (DESCRIPTIONS[id] && (!byId[id] || byId[id].kind !== 'custom')) return DESCRIPTIONS[id];
      return byId[id] && byId[id].kind === 'custom' ? DESCRIPTIONS.custom : '';
    }
    function thumbUrl(id, size, color) {
      const key = id + '|' + size + '|' + color;
      if (thumbs[key]) return thumbs[key];
      const n = Math.round(size * 2), pk = id + '|' + n;
      const data = previews[pk] || (previews[pk] = api.tipPreview(id, n));
      const s = DSUI.raster.create(size, size, 2);
      s.mask(data, n, 0, 0, size, color);
      return (thumbs[key] = s.url());
    }
    function thumbImg(id, size, color, cls) {
      const im = el('img', cls || 'dst-thumb');
      im.src = thumbUrl(id, size, color);
      im.alt = '';
      im.setAttribute('draggable', 'false');
      im.style.width = size + 'px'; im.style.height = size + 'px';
      return im;
    }

    // -- the panel --
    function select(id) {
      if (state.sel === id) return;
      state.sel = id;
      build();
    }
    function removeAt(i) {
      if (ids.length <= 1) return;           // the mix is never left empty
      const id = ids[i];
      const nIds = ids.filter((_, j) => j !== i);
      if (state.sel === id) state.sel = null;
      write(nIds, remove(shares, i));
      build();
    }
    function evenOut() {
      if (!ids.length) return;
      write(ids.slice(), even(ids.length));
      update();
    }

    function build() {
      if (!alive) return;
      clear(root);
      const n = ids.length;
      refs = { bands: [], handles: [], cardPct: [], fine: null };

      // header
      const head = el('div', 'dst-head');
      head.appendChild(el('div', 'dst-head-lbl', 'The mix: each tip’s share of the pieces'));
      const right = el('div', 'dst-head-right');
      right.appendChild(el('span', 'dst-count', n === 1 ? '1 tip' : n + ' tips'));
      right.appendChild(ctl(el('div', 'dst-btn' + (n < 2 ? ' dst-disabled' : ''), 'Even out'), evenOut, 'Give every tip the same share'));
      right.appendChild(ctl(el('div', 'dst-btn dst-primary', '+ Add'), openLib, 'Add tips from the library'));
      head.appendChild(right);
      root.appendChild(head);

      if (!n) {
        const empty = el('div', 'dst-empty');
        empty.appendChild(el('div', null, 'No tips in the mix… Add one to choose the shapes of the pieces.'));
        root.appendChild(empty);
      } else {
        // the mix bar
        const bar = el('div', 'dst-bar');
        refs.bar = bar;
        ids.forEach((id, i) => {
          const col = colorOf(i);
          const band = el('div', 'dst-band' + (i === 0 ? ' dst-first' : '') + (i === n - 1 ? ' dst-last' : ''));
          band.style.backgroundColor = col;
          const inner = el('div', 'dst-band-in');
          inner.appendChild(thumbImg(id, 18, DARK, 'dst-band-img'));
          const pct = el('div', 'dst-band-pct');
          inner.appendChild(pct);
          band.appendChild(inner);
          if (state.sel === id) band.appendChild(el('div', 'dst-band-sel'));
          ctl(band, () => select(id), labelOf(id));
          bar.appendChild(band);
          refs.bands.push({ el: band, inner, pct });
        });
        for (let i = 0; i < n - 1; i++) {
          const h = el('div', 'dst-handle');
          h.appendChild(el('div', 'dst-grip'));
          h.setAttribute('tabindex', '0');
          h.setAttribute('title', 'Drag to move share between ' + labelOf(ids[i]) + ' and ' + labelOf(ids[i + 1]));
          h.addEventListener('mousedown', (e) => startDrag(i, e));
          h.addEventListener('click', stop);
          h.addEventListener('keydown', (e) => {
            const l = e.key === 'ArrowLeft' || e.key === 'Left', r = e.key === 'ArrowRight' || e.key === 'Right';
            if (!l && !r) return;
            if (e.preventDefault) e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) / 100, pos = sum(shares.slice(0, i + 1)) + (r ? step : -step);
            write(ids, drag(shares, i, pos));
            update();
          });
          bar.appendChild(h);
          refs.handles.push(h);
        }
        root.appendChild(bar);

        // fine-tune row
        const si = ids.indexOf(state.sel);
        if (si >= 0) {
          const row = el('div', 'dst-fine');
          const sq = el('div', 'dst-swatch');
          sq.style.backgroundColor = colorOf(si);
          row.appendChild(sq);
          row.appendChild(el('div', 'dst-fine-name', labelOf(state.sel)));
          const single = n < 2;
          const minus = ctl(el('div', 'dst-step' + (single ? ' dst-disabled' : ''), '−'), () => nudge(-1), 'Less of this tip');
          const range = el('input', 'dst-range');
          range.setAttribute('type', 'range');
          range.setAttribute('min', '1'); range.setAttribute('max', '99'); range.setAttribute('step', '1');
          if (single) range.setAttribute('disabled', 'disabled');
          const plus = ctl(el('div', 'dst-step' + (single ? ' dst-disabled' : ''), '+'), () => nudge(1), 'More of this tip');
          const pct = el('div', 'dst-fine-pct');
          const onRange = () => {
            const v = parseFloat(range.value);
            if (isNaN(v) || ids.length < 2) return;
            const j = ids.indexOf(state.sel);
            write(ids, setShare(shares, j, v / 100));
            update(true);
          };
          range.addEventListener('input', onRange);
          range.addEventListener('change', () => { onRange(); update(); });
          row.appendChild(minus); row.appendChild(range); row.appendChild(plus); row.appendChild(pct);
          root.appendChild(row);
          refs.fine = { range, pct };
        } else {
          root.appendChild(el('div', 'dst-hint', 'Click a tip to fine-tune its share.'));
        }
      }

      // gallery
      const gal = el('div', 'dst-gallery');
      ids.forEach((id, i) => {
        const col = colorOf(i);
        const card = el('div', 'dst-card' + (i % 3 ? ' dst-gap' : '') + (state.sel === id ? ' dst-on' : ''));
        if (state.sel === id) card.style.borderColor = col;
        const stripe = el('div', 'dst-stripe');
        stripe.style.backgroundColor = col;
        card.appendChild(stripe);
        const well = el('div', 'dst-well');
        well.appendChild(thumbImg(id, 50, LIGHT));
        card.appendChild(well);
        const foot = el('div', 'dst-card-foot');
        foot.appendChild(el('div', 'dst-card-name', labelOf(id)));
        const pct = el('div', 'dst-card-pct');
        pct.style.color = col;
        foot.appendChild(pct);
        card.appendChild(foot);
        if (state.sel === id) { const o = el('div', 'dst-card-sel'); o.style.borderColor = col; card.appendChild(o); }
        if (n > 1) card.appendChild(ctl(el('div', 'dst-x', '×'), () => removeAt(ids.indexOf(id)), 'Take ' + labelOf(id) + ' out of the mix'));
        ctl(card, () => select(id), labelOf(id));
        gal.appendChild(card);
        refs.cardPct.push(pct);
      });
      const addCard = el('div', 'dst-card dst-add' + (n % 3 ? ' dst-gap' : ''));
      addCard.appendChild(el('div', 'dst-add-lbl', '+ Add tip'));
      ctl(addCard, openLib, 'Add tips from the library');
      gal.appendChild(addCard);
      root.appendChild(gal);

      root.appendChild(el('div', 'dst-note', NOTE));
      update();
    }

    function nudge(d) {
      const j = ids.indexOf(state.sel);
      if (j < 0 || ids.length < 2) return;
      const p = Math.round(shares[j] * 100) + d;
      write(ids, setShare(shares, j, p / 100));
      update();
    }

    // widths, positions and numbers, without rebuilding (keepRange: leave the slider where the user has it)
    function update(keepRange) {
      if (!refs) return;
      const p = percents(shares);
      let cum = 0;
      refs.bands.forEach((b, i) => {
        const w = i === refs.bands.length - 1 ? Math.max(0, 1 - cum) : shares[i];
        b.el.style.left = (cum * 100).toFixed(3) + '%';
        b.el.style.width = (w * 100).toFixed(3) + '%';
        b.inner.style.display = shares[i] >= LABEL_AT ? '' : 'none';
        b.pct.textContent = p[i] + '%';
        cum += shares[i];
        if (refs.handles[i]) refs.handles[i].style.left = (cum * 100).toFixed(3) + '%';
      });
      refs.cardPct.forEach((c, i) => { c.textContent = p[i] + '%'; });
      if (refs.fine) {
        const j = ids.indexOf(state.sel);
        if (j >= 0) {
          refs.fine.pct.textContent = (ids.length < 2 ? 100 : p[j]) + '%';
          if (!keepRange) refs.fine.range.value = String(ids.length < 2 ? 99 : clamp(Math.round(shares[j] * 100), 1, 99));
        }
      }
    }

    function startDrag(i, e) {
      if (e.button != null && e.button !== 0) return;
      if (e.preventDefault) e.preventDefault();
      stop(e);
      const bar = refs.bar;
      const r = bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
      const W = (r && r.width) || bar.offsetWidth || 300;
      const x0 = e.clientX, start = sum(shares.slice(0, i + 1));
      let last = '';
      const move = (ev) => {
        if (typeof ev.clientX !== 'number') return;
        const next = drag(shares, i, start + (ev.clientX - x0) / W), key = next[i].toFixed(4);
        if (key === last) return;
        last = key;
        write(ids, next);
        update();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        endDrag = null;
      };
      endDrag = up;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    let endDrag = null;

    // -- the library sheet --
    const overlayHost = api.overlayHost || document.body;
    function onKey(e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (e.preventDefault) e.preventDefault();
      stop(e);
      closeLib();
    }
    function openLib() {
      state.libOpen = true;
      if (lib) { renderLib(); return; }
      const ov = el('div', 'dst-overlay');
      const dim = el('div', 'dst-dim');
      dim.addEventListener('click', closeLib);
      ov.appendChild(dim);
      const sheet = el('div', 'dst-sheet');
      sheet.addEventListener('click', stop);
      ov.appendChild(sheet);

      const head = el('div', 'dst-sheet-head');
      head.appendChild(el('div', 'dst-sheet-title', 'Brush tip library'));
      head.appendChild(ctl(el('div', 'dst-close', '×'), closeLib, 'Close'));
      sheet.appendChild(head);

      const search = el('input', 'dst-search');
      search.setAttribute('type', 'text');
      search.setAttribute('placeholder', 'Search tips');
      search.value = state.q;
      search.addEventListener('input', () => { state.q = search.value || ''; renderGrid(); });
      search.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Esc') onKey(e); });
      sheet.appendChild(search);

      const chips = el('div', 'dst-chips');
      sheet.appendChild(chips);
      const scroll = el('div', 'dst-lib-scroll');
      const grid = el('div', 'dst-lib-grid');
      scroll.appendChild(grid);
      sheet.appendChild(scroll);

      const foot = el('div', 'dst-sheet-foot');
      const note = el('div', 'dst-foot-note');
      foot.appendChild(note);
      foot.appendChild(ctl(el('div', 'dst-btn', 'Cancel'), closeLib));
      const addBtn = ctl(el('div', 'dst-btn dst-primary'), addPicked);
      foot.appendChild(addBtn);
      sheet.appendChild(foot);

      overlayHost.appendChild(ov);
      document.addEventListener('keydown', onKey, true);
      lib = { ov, search, chips, grid, scroll, note, addBtn };
      renderLib();
      // Photoshop draws native controls (dropdowns especially) above any HTML laid over them,
      // so the host hides the ones under the sheet while it is open
      if (api.onLibrary) api.onLibrary(true, ov);
    }
    function closeLib() {
      state.libOpen = false;
      state.libSel = [];
      state.confirmDel = null;
      dropLib();
    }
    function dropLib() {
      if (!lib) return;
      document.removeEventListener('keydown', onKey, true);
      if (lib.ov.parentNode) lib.ov.parentNode.removeChild(lib.ov);
      lib = null;
      if (api.onLibrary) api.onLibrary(false);
    }
    function renderLib() {
      if (!lib) return;
      clear(lib.chips);
      CATS.forEach(([id, title]) => {
        lib.chips.appendChild(ctl(el('div', 'dst-chip' + (state.cat === id ? ' dst-chip-on' : ''), title), () => { state.cat = id; renderLib(); }));
      });
      renderGrid();
    }
    function visibleTips() {
      const q = state.q.trim().toLowerCase();
      return list.filter((t) => {
        if (state.cat !== 'all' && t.kind !== state.cat) return false;
        if (!q) return true;
        return (t.label + ' ' + t.id + ' ' + describe(t.id)).toLowerCase().indexOf(q) >= 0;
      });
    }
    function renderGrid() {
      if (!lib) return;
      // drop picks that are no longer possible
      state.libSel = state.libSel.filter((id) => byId[id] && ids.indexOf(id) < 0);
      clear(lib.grid);
      const shown = visibleTips();
      const q = state.q.trim();
      let k = 0;
      shown.forEach((t) => {
        const inMix = ids.indexOf(t.id) >= 0, picked = state.libSel.indexOf(t.id) >= 0;
        const card = el('div', 'dst-lcard' + (k % 2 ? ' dst-gap2' : '') + (inMix ? ' dst-inmix' : '') + (picked ? ' dst-picked' : ''));
        k++;
        const well = el('div', 'dst-lwell');
        // drawn darker rather than faded: Photoshop ignores opacity on these
        well.appendChild(thumbImg(t.id, 84, inMix ? '#5A5A5A' : LIGHT));
        if (inMix) well.appendChild(el('div', 'dst-badge', 'In the mix'));
        if (picked) well.appendChild(el('div', 'dst-check', '✓'));
        if (t.kind === 'custom') {
          if (state.confirmDel === t.id) {
            const c = el('div', 'dst-confirm');
            c.appendChild(el('span', 'dst-confirm-q', 'Delete?'));
            c.appendChild(ctl(el('span', 'dst-confirm-yes', 'Yes'), () => deleteTip(t.id), 'Delete this tip for good'));
            c.appendChild(ctl(el('span', 'dst-confirm-no', 'No'), () => { state.confirmDel = null; renderGrid(); }));
            c.addEventListener('click', stop);
            well.appendChild(c);
          } else {
            well.appendChild(ctl(el('span', 'dst-del', 'Delete'), () => { state.confirmDel = t.id; renderGrid(); }, 'Delete this tip of your own (cannot be undone)'));
          }
        }
        card.appendChild(well);
        card.appendChild(el('div', 'dst-lname', t.label));
        card.appendChild(el('div', 'dst-ldesc', describe(t.id)));
        if (!inMix) {
          ctl(card, () => {
            const at = state.libSel.indexOf(t.id);
            if (at >= 0) state.libSel.splice(at, 1); else state.libSel.push(t.id);
            renderGrid();
          }, picked ? 'Unpick' : 'Pick');
        }
        lib.grid.appendChild(card);
      });
      if (!shown.length && q) {
        lib.grid.appendChild(el('div', 'dst-nomatch', 'No tips match “' + q + '”.'));
      }
      if ((state.cat === 'all' || state.cat === 'custom') && !q) {
        const info = el('div', 'dst-lcard dst-make' + (k % 2 ? ' dst-gap2' : ''));
        info.appendChild(el('div', 'dst-make-title', 'Make your own'));
        info.appendChild(el('div', 'dst-make-text', 'To make a tip of your own, ' + NEW_TIP_HOW));
        lib.grid.appendChild(info);
      }
      const m = state.libSel.length;
      lib.note.textContent = m ? 'New tips start with an even share.' : 'Pick one or more tips.';
      lib.addBtn.textContent = 'Add ' + (m || '') + (m ? ' ' : '') + (m === 1 ? 'tip' : 'tips');
      lib.addBtn.className = 'dst-btn dst-primary' + (m ? '' : ' dst-disabled');
    }
    function addPicked() {
      const pick = state.libSel.filter((id) => byId[id] && ids.indexOf(id) < 0);
      if (!pick.length) return;
      write(ids.concat(pick), add(shares, pick.length));
      state.sel = pick[0];
      closeLib();
      build();
    }
    function deleteTip(id) {
      state.confirmDel = null;
      state.libSel = state.libSel.filter((x) => x !== id);
      if (state.sel === id) state.sel = null;
      api.deleteCustomTip(id);
      // main.js may have mounted a fresh panel meanwhile; refresh whichever is current
      if (current) current.refresh();
    }

    function refresh() {
      if (!alive) return;
      readList();
      readTips();
      build();
      if (state.libOpen) { if (lib) renderLib(); else openLib(); }
    }
    function destroy() {
      alive = false;
      if (endDrag) endDrag();
      dropLib();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    readList();
    readTips();
    build();
    if (state.libOpen) openLib();
    return { refresh, destroy, isLibraryOpen: () => !!lib, closeLibrary: closeLib };
  }

  DSUI.tips = { mount, _math: math, PALETTE, DESCRIPTIONS };
})();
