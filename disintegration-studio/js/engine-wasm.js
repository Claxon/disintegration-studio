/* Disintegration Studio — the WebAssembly engine.
 * The hot part of a render (the erosion pass, the pieces with their stamps and brush tips, and
 * finishing the erosion) and the preview composite, compiled from Rust (engine-wasm/). It gives
 * exactly the bytes the JavaScript engine gives, about twice as fast.
 *
 * Load after disintegration-core.js and engine-wasm-bin.js (which holds the module as base64).
 * It replaces Disintegration.render and Disintegration.composite with versions that use the
 * module once it is ready and the JavaScript engine until then, when the module is missing, and
 * for good after any error in it (reported once to Disintegration.engineLog, if set).
 *   Disintegration.engine         'wasm' or 'js': which engine renders now
 *   Disintegration.useWasm(false) the JavaScript engine only (true: back to the module)
 *   Disintegration.wasmReady      a promise of the engine's name once loading has settled
 *   Disintegration.engineInfo()   { status, instantiateMs, memory, tipVariants, outOfMemory, error }
 *   Disintegration.engineLog      set to a function(message) to hear of failures (and readiness)
 */
(function (root) {
  'use strict';
  const D = root.Disintegration;
  if (!D || !D._core || D._wasm) return;
  const C = D._core, jsRender = C.render, jsComposite = C.composite;

  // Base64 without atob, which UXP may not have.
  function fromBase64(s) {
    const map = new Uint8Array(128);
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < 64; i++) map[abc.charCodeAt(i)] = i;
    s = s.replace(/[^A-Za-z0-9+/]/g, '');
    const n = s.length, out = new Uint8Array(Math.floor((n * 3) / 4));
    let j = 0;
    for (let i = 0; i < n; i += 4) {
      const a = map[s.charCodeAt(i)], b = map[s.charCodeAt(i + 1)], c = i + 2 < n ? map[s.charCodeAt(i + 2)] : 0, d = i + 3 < n ? map[s.charCodeAt(i + 3)] : 0;
      const v = (a << 18) | (b << 12) | (c << 6) | d;
      out[j++] = v >> 16;
      if (i + 2 < n) out[j++] = (v >> 8) & 255;
      if (i + 3 < n) out[j++] = v & 255;
    }
    return j === out.length ? out : out.subarray(0, j);
  }

  // ---- the module ----------------------------------------------------------------------------
  // status: 'off' (no module), 'loading', 'ready', 'failed'
  const M = { status: 'off', want: true, module: null, X: null, bufs: {}, tips: new WeakMap(), tipCount: 0, lastSub: null, ms: 0, error: null, oom: 0 };
  const MEMORY_CAP = 128 * 1024 * 1024; // past this, the instance is dropped after the call (its memory can't shrink)
  const TIP_CAP = 600; // tip variants kept in the module before it forgets them all
  const imports = () => ({ env: { math_sin: Math.sin, math_cos: Math.cos, math_pow: Math.pow, math_atan2: Math.atan2 } });
  // D.engineLog(message), if the host sets it, hears when the module is ready and when it fails;
  // without it a failure goes to the console.
  const say = (msg, failure) => {
    try {
      if (D.engineLog) D.engineLog(msg);
      else if (failure && typeof console !== 'undefined') console.warn(msg);
    } catch (e) { /* no log */ }
  };
  let settle = null;
  D.wasmReady = new Promise((res) => { settle = res; });

  function attach(inst, t0) {
    M.X = inst.exports; M.bufs = {}; M.tips = new WeakMap(); M.tipCount = 0; M.lastSub = null;
    M.status = 'ready';
    if (!M.ms) { M.ms = Math.max(1, Date.now() - t0); say('engine: WebAssembly ready (' + M.ms + ' ms)'); } // (said once, not after each trim)
    settle(D.engine);
  }
  function fail(e, where) {
    M.status = 'failed'; M.X = null; M.error = e;
    say('engine: WebAssembly ' + where + ' failed, using JavaScript: ' + (e && e.message ? e.message : e), true);
    settle(D.engine);
  }
  // A new instance, at once if the host allows it (UXP and Node do; a browser does not for modules
  // over 4 KB on its main thread), else in the background.
  function instantiate() {
    const t0 = Date.now();
    M.X = null;
    M.status = 'loading';
    try {
      if (!M.module) M.module = new WebAssembly.Module(fromBase64(root.DISINTEGRATION_WASM));
      attach(new WebAssembly.Instance(M.module, imports()), t0);
      return;
    } catch (e) { /* try the asynchronous way */ }
    const p = M.module ? WebAssembly.instantiate(M.module, imports()).then((inst) => ({ instance: inst, module: M.module }))
      : WebAssembly.instantiate(fromBase64(root.DISINTEGRATION_WASM), imports());
    p.then((r) => { M.module = r.module; if (M.status === 'loading') attach(r.instance, t0); }, (e) => fail(e, 'loading'));
  }
  // After a large render the instance holds on to a lot of memory: let it go and start a fresh one.
  function trim() {
    if (M.X && M.X.memory.buffer.byteLength > MEMORY_CAP) instantiate();
  }

  // A buffer in the module's memory of at least `bytes` bytes, kept for the next call. When the
  // memory can't grow that far (a very large document), that call is done in JavaScript and the
  // module starts afresh, without its buffers, for the next one.
  const OOM = new Error('out of memory');
  function buf(name, bytes) {
    const b = M.bufs[name];
    if (b && b.size >= bytes) return b.ptr;
    if (b) M.X.dealloc(b.ptr, b.size);
    if (name === 'sub') M.lastSub = null;
    const size = Math.max(64, bytes);
    const ptr = M.X.alloc(size);
    if (!ptr) throw OOM;
    M.bufs[name] = { ptr, size };
    return ptr;
  }
  // (Views are made after all the buffers of a call are in place: growing the memory detaches them.)
  const u8 = (ptr, n) => new Uint8Array(M.X.memory.buffer, ptr, n);
  const f32 = (ptr, n) => new Float32Array(M.X.memory.buffer, ptr, n);
  const f64 = (ptr, n) => new Float64Array(M.X.memory.buffer, ptr, n);

  // ---- brush tips ----------------------------------------------------------------------------
  // The variants of a tip, copied into the module the first time they are used: { first, count }.
  // A bitmap whose values aren't whole bytes can't be copied exactly: null (render in JavaScript).
  const TH = 23; // numbers in a tip's header (th::LEN in lib.rs)
  function tipVariantsIn(vs) {
    let got = M.tips.get(vs);
    if (got) return got;
    for (const v of vs) if (v.bmp && !(v.bmp instanceof Uint8Array || v.bmp instanceof Uint8ClampedArray)) {
      for (let i = 0; i < v.bmp.length; i++) if (v.bmp[i] !== (v.bmp[i] & 255)) return null;
    }
    let first = -1;
    for (const v of vs) {
      const tab = v.bmp ? null : v.tab || C.tipTable(v), hasTab = !!(tab && tab.F), N = hasTab ? tab.N : 0;
      const ns = v.sats ? v.sats.length : 0, bn = v.bmp ? v.n : 0;
      const pH = buf('tipH', TH * 8), pP = buf('tipP', C.TIP_K * 4), pS = buf('tipS', ns * 8), pF = buf('tipF', N * N * 4), pE = buf('tipE', N * N * 4), pB = buf('tipB', bn * bn);
      const g = v.grain;
      f64(pH, TH).set([
        v.bmp ? 1 : 0, v.soft || 0, v.scale, v.feather || 0, v.ext, v.eu, v.ew, v.sx || 1, v.isx || 1, ns,
        g ? 1 : 0, g ? g.t : 0, g ? g.fu : 0, g ? g.fw : 0, g ? g.seed : 0,
        hasTab ? 1 : 0, hasTab ? tab.mu : 0, hasTab ? tab.mw : 0, hasTab ? tab.su : 0, hasTab ? tab.sw : 0, N,
        bn, v.bmp ? v.k : 0,
      ]);
      if (!v.bmp) f32(pP, C.TIP_K).set(v.prof);
      if (ns) f64(pS, ns).set(v.sats);
      if (hasTab) { f32(pF, N * N).set(tab.F); f32(pE, N * N).set(tab.E); }
      if (bn) u8(pB, bn * bn).set(v.bmp);
      const k = M.X.tip_add(pH, pP, pS, pF, pE, pB);
      if (first < 0) first = k;
      M.tipCount++;
    }
    got = { first, count: vs.length };
    M.tips.set(vs, got);
    return got;
  }

  // ---- render --------------------------------------------------------------------------------
  // The parameter block: the order of `mod p` in lib.rs.
  const PLEN = 53;
  let failNext = false; // for the tests: the next render fails
  function renderWasm(ctx, st, opts) {
    opts = opts || {};
    if (failNext) { failNext = false; throw new Error('a test failure'); }
    if (ctx.empty) return jsRender(ctx, st, opts);
    const W = ctx.W, H = ctx.H, n = W * H, gn = ctx.gw * ctx.gh;
    const rs = C.resolve(ctx, st, opts.ref);
    const { T, L } = C.renderFields(ctx, st, rs);
    const sp = C.samplerParams(ctx, st, rs, T), pp = C.pieceParams(ctx, st, rs);
    const ADD = L ? L.add : null, KEEP = L ? L.keep : null;
    // the tips, in the module
    if (M.tipCount > TIP_CAP) { M.X.tips_clear(); M.tips = new WeakMap(); M.tipCount = 0; }
    const { mix, total } = C.tipMix(st), mixIn = [];
    for (const e of mix) {
      const t = tipVariantsIn(e.vs);
      if (!t) return null;
      mixIn.push(e.upTo, t.first, t.count);
    }
    // the buffers
    const pP = buf('params', PLEN * 8), pM = buf('mix', mixIn.length * 8), pStats = buf('stats', 3 * 8);
    const pSub = buf('sub', n * 4), pEr = buf('erode', n), pOut = opts.noParticles ? 0 : buf('parts', n * 4);
    const pT = sp.auto ? buf('T', gn * 4) : 0, pA = ADD ? buf('add', gn * 4) : 0, pK = KEEP ? buf('keep', gn * 4) : 0;
    const cb = ctx.bbox, b = rs.bbox;
    f64(pP, PLEN).set([
      W, H, ctx.gw, ctx.gh,
      sp.auto ? 1 : 0, sp.R, sp.band, sp.soft, sp.theta, sp.LOW, sp.DP, sp.Rp, sp.nk, sp.seed, sp.sxg, sp.syg, sp.gxMax, sp.gyMax, sp.deep,
      cb.x0, cb.y0, cb.x1, cb.y1,
      b.x0, b.y0, pp.bw, pp.bh, pp.baseSize, pp.minSize, pp.M, pp.seed, pp.a0, pp.bcx, pp.bcy, pp.Dmax, pp.tk, pp.turb, pp.STEPS, pp.trailN, pp.keepDeep, pp.fe,
      st.sizeVar, st.spin, st.texture, st.spread, st.burst, st.gravity, st.shrink, st.opacity, st.fade, st.colorVar,
      mix.length, total,
    ]);
    f64(pM, mixIn.length).set(mixIn);
    u8(pSub, n * 4).set(ctx.subject);
    M.lastSub = ctx.subject;
    u8(pEr, n).fill(0);
    if (pOut) u8(pOut, n * 4).fill(0);
    if (pT) f32(pT, gn).set(T);
    if (pA) f32(pA, gn).set(ADD);
    if (pK) f32(pK, gn).set(KEEP);
    // the passes
    const tm = opts.timing, t0 = tm ? Date.now() : 0;
    M.X.erode_pass(pP, pSub, pEr, pT, pA, pK);
    const t1 = tm ? Date.now() : 0;
    M.X.pieces(pP, pSub, pEr, pOut, pT, pA, pK, pM, pStats);
    const t2 = tm ? Date.now() : 0;
    const area = M.X.finish(pP, pSub, pEr, pT, pA, pK);
    if (tm) { tm.erode = t1 - t0; tm.pieces = t2 - t1; tm.finish = Date.now() - t2; tm.engine = 'wasm'; }
    const stats = f64(pStats, 3);
    const out = {
      width: W, height: H, erode: u8(pEr, n).slice(), particles: pOut ? new Uint8ClampedArray(M.X.memory.buffer, pOut, n * 4).slice() : null,
      resolved: rs, count: stats[0], holes: stats[1], matched: stats[2], erodedArea: area,
    };
    return out;
  }

  // ---- composite -----------------------------------------------------------------------------
  function compositeWasm(ctx, res, opts) {
    opts = opts || {};
    const W = ctx.W, H = ctx.H, n = W * H, gn = ctx.gw * ctx.gh;
    const view = res ? opts.view || 'result' : 'before', v = view === 'result' ? 0 : view === 'mask' ? 2 : 1;
    const E = v !== 1 ? res.erode : null, Q = v === 0 ? res.particles : null, B = ctx.plate;
    const P = v === 2 && ctx.cache.levels ? ctx.cache.levels.keep : null;
    const pC = buf('cparams', 5 * 8), pSub = buf('sub', n * 4), pB = B ? buf('plate', n * 4) : 0;
    const pE = E ? buf('erode', n) : 0, pQ = Q ? buf('parts', n * 4) : 0, pK = P ? buf('keep', gn * 4) : 0, pOut = buf('comp', n * 4);
    f64(pC, 5).set([W, H, ctx.gw, ctx.gh, v]);
    if (M.lastSub !== ctx.subject) { u8(pSub, n * 4).set(ctx.subject); M.lastSub = ctx.subject; }
    if (pB) u8(pB, n * 4).set(B);
    if (pE) u8(pE, n).set(E);
    if (pQ) u8(pQ, n * 4).set(Q);
    if (pK) f32(pK, gn).set(P);
    M.X.composite(pC, pSub, pB, pE, pQ, pK, pOut);
    return { width: W, height: H, data: new Uint8ClampedArray(M.X.memory.buffer, pOut, n * 4).slice() };
  }

  // ---- the switch ----------------------------------------------------------------------------
  const live = () => M.status === 'ready' && M.want && !!M.X;
  const failed = (e, where) => { if (e === OOM) { M.oom++; instantiate(); } else fail(e, where); };
  D.render = function (ctx, st, opts) {
    if (live()) {
      try { const r = renderWasm(ctx, st, opts); trim(); if (r) return r; } catch (e) { failed(e, 'render'); }
    }
    return jsRender(ctx, st, opts);
  };
  D.composite = function (ctx, res, opts) {
    if (live()) {
      try { const r = compositeWasm(ctx, res, opts); trim(); return r; } catch (e) { failed(e, 'composite'); }
    }
    return jsComposite(ctx, res, opts);
  };
  Object.defineProperty(D, 'engine', { get: () => (live() ? 'wasm' : 'js'), enumerable: true, configurable: true });
  D.useWasm = function (on) {
    M.want = on !== false;
    if (M.want && M.status === 'failed' && root.DISINTEGRATION_WASM) { D.wasmReady = new Promise((res) => { settle = res; }); instantiate(); }
    return D.engine;
  };
  // for the tests and benchmarks: the WebAssembly paths with no fallback, and what the module holds
  // (also D.engineInfo(), for a host's log: status, instantiateMs, memory, tipVariants, error)
  D._wasm = {
    render: (ctx, st, opts) => { if (!M.X) throw new Error('WebAssembly engine not ready: ' + M.status); return renderWasm(ctx, st, opts); },
    composite: (ctx, res, opts) => { if (!M.X) throw new Error('WebAssembly engine not ready: ' + M.status); return compositeWasm(ctx, res, opts); },
    info: () => ({ status: M.status, want: M.want, instantiateMs: M.ms, memory: M.X ? M.X.memory.buffer.byteLength : 0, tipVariants: M.tipCount, outOfMemory: M.oom, error: M.error ? String(M.error) : null }),
    failNext: () => { failNext = true; },
  };
  D.engineInfo = D._wasm.info;

  if (typeof WebAssembly === 'object' && root.DISINTEGRATION_WASM) instantiate();
  else settle('js');
})(typeof window !== 'undefined' ? window : globalThis);
