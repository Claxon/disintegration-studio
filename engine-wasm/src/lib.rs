//! Disintegration Studio: the hot core of the engine in `disintegration-core.js`, compiled to
//! WebAssembly. It covers what `render()` does after the grid fields (`erodePass`, `pieces` with
//! the sampler, the stamps and the brush tips, `finishErosion`) and `composite()`.
//!
//! It must give exactly the bytes the JavaScript gives. So:
//! - every number is an f64 and every expression is evaluated in the JavaScript's order;
//! - `Math.imul`, `>>>` and `| 0` are wrapping i32 / u32 arithmetic;
//! - a store into a `Uint8Array` truncates (and wraps), one into a `Uint8ClampedArray` clamps and
//!   rounds half to even (`to_u8` / `to_u8c`);
//! - `Math.sin`, `Math.cos`, `Math.pow` and `Math.atan2` are imported from the host, since V8's
//!   versions differ in the last bit from Rust's (and from one V8 build to another);
//!   `Math.hypot` is V8's own algorithm, written out below.
//!
//! Where it is faster than the JavaScript beyond being compiled, it is by shortcuts that skip work
//! whose result is known (each is marked "a shortcut the JavaScript doesn't take" and argues why
//! the answer is the same): grid quads of the erosion pass far from the front, the noise's lattice
//! hashes, far droplets, points well clear of a tip's outline, the runs of stamp rows that can
//! pass the stamp's test, and plain pixels of the composite.
//!
//! The JavaScript glue is `disintegration-studio/js/engine-wasm.js`; it works out the parameter
//! blocks with the engine's own functions and lays out the memory. Any change to the ported
//! JavaScript has to be made here as well: `test/engine-test.js` compares the two.
#![allow(static_mut_refs)]
#![allow(clippy::too_many_arguments)]

use core::cell::Cell;
use core::slice;

// ---------------------------------------------------------------------------------------------
// Host maths and memory
// ---------------------------------------------------------------------------------------------
extern "C" {
    fn math_sin(x: f64) -> f64;
    fn math_cos(x: f64) -> f64;
    fn math_pow(x: f64, y: f64) -> f64;
    fn math_atan2(y: f64, x: f64) -> f64;
}
#[inline(always)]
fn sin(x: f64) -> f64 { unsafe { math_sin(x) } }
#[inline(always)]
fn cos(x: f64) -> f64 { unsafe { math_cos(x) } }
#[inline(always)]
fn pow(x: f64, y: f64) -> f64 { unsafe { math_pow(x, y) } }
#[inline(always)]
fn atan2(y: f64, x: f64) -> f64 { unsafe { math_atan2(y, x) } }

/// n bytes (8-aligned) for the glue's buffers; null when the memory can't grow that far.
#[no_mangle]
pub unsafe extern "C" fn alloc(n: usize) -> *mut u8 {
    match std::alloc::Layout::from_size_align(n.max(8), 8) { Ok(l) => std::alloc::alloc(l), Err(_) => core::ptr::null_mut() }
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    if !p.is_null() { std::alloc::dealloc(p, std::alloc::Layout::from_size_align_unchecked(n.max(8), 8)); }
}

// ---------------------------------------------------------------------------------------------
// JavaScript semantics
// ---------------------------------------------------------------------------------------------
const TAU: f64 = core::f64::consts::PI * 2.0;
const TIP_K: usize = 96;
const FRONT: f64 = 1.5;
const FAINT: f64 = 0.04;
const SMALL: f64 = 3.0;

/// `v | 0` (ToInt32) for the magnitudes that occur (below 2^63); NaN gives 0 as in JavaScript.
#[inline(always)]
fn to_i32(v: f64) -> i32 { (v as i64) as i32 }
/// a store into a Uint8Array: truncate, then wrap
#[inline(always)]
fn to_u8(v: f64) -> u8 { if v.is_finite() { (v as i64) as u8 } else { 0 } }
/// a store into a Uint8ClampedArray: round half to even, clamp (NaN gives 0)
#[inline(always)]
fn to_u8c(v: f64) -> u8 { v.round_ties_even() as u8 } // `as` saturates: below 0 and NaN give 0, past 255 gives 255
#[inline(always)]
fn clamp(v: f64, a: f64, b: f64) -> f64 { if v < a { a } else if v > b { b } else { v } }
#[inline(always)]
fn lerp(a: f64, b: f64, t: f64) -> f64 { a + (b - a) * t }
#[inline(always)]
fn sstep(a: f64, b: f64, x: f64) -> f64 { let t = clamp((x - a) / (b - a), 0.0, 1.0); t * t * (3.0 - 2.0 * t) }
#[inline(always)]
fn jmax(a: f64, b: f64) -> f64 { if b > a { b } else { a } }
#[inline(always)]
fn jmin(a: f64, b: f64) -> f64 { if b < a { b } else { a } }
/// V8's Math.hypot for two finite numbers: scaled by the larger, the squares added with Kahan's compensation
#[inline(always)]
fn hypot(x: f64, y: f64) -> f64 {
    let ax = x.abs();
    let ay = y.abs();
    if x.is_nan() || y.is_nan() {
        return if ax == f64::INFINITY || ay == f64::INFINITY { f64::INFINITY } else { f64::NAN };
    }
    let mut max = 0.0;
    if ax > max { max = ax; }
    if ay > max { max = ay; }
    if max == f64::INFINITY { return f64::INFINITY; }
    if max == 0.0 { return 0.0; }
    let n = ax / max;
    let summand = n * n - 0.0;
    let pre = 0.0 + summand;
    let comp = (pre - 0.0) - summand;
    let sum = pre;
    let n = ay / max;
    let summand = n * n - comp;
    let sum = sum + summand;
    sum.sqrt() * max
}

// ---------------------------------------------------------------------------------------------
// Hashing and noise (hash2, rnd, vnoise, fbm)
// ---------------------------------------------------------------------------------------------
#[inline(always)]
fn hash2(ix: i32, iy: i32, seed: i32) -> f64 {
    let mut h = ix.wrapping_mul(374761393).wrapping_add(iy.wrapping_mul(668265263)).wrapping_add(seed.wrapping_mul(1274126177));
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    h ^= ((h as u32) >> 16) as i32;
    (h as u32) as f64 / 4294967296.0
}
#[inline(always)]
fn rnd(i: i32, k: i32, seed: i32) -> f64 {
    let mut h = i.wrapping_add(1).wrapping_mul(0x9e3779b1u32 as i32)
        ^ k.wrapping_add(1).wrapping_mul(0x85ebca6bu32 as i32)
        ^ seed.wrapping_add(1).wrapping_mul(0xc2b2ae35u32 as i32);
    h = (h ^ ((h as u32) >> 15) as i32).wrapping_mul(0x2c1b3c6d);
    h = (h ^ ((h as u32) >> 12) as i32).wrapping_mul(0x297a2d39);
    h ^= ((h as u32) >> 15) as i32;
    (h as u32) as f64 / 4294967296.0
}
/// The four lattice hashes a vnoise call read last. The next call from the same place usually
/// falls in the same cell (along a row of pixels, or a particle's path) and reuses them: a
/// shortcut the JavaScript doesn't take, with the same answers.
struct NCache { key: Cell<(f64, f64, i32)>, h: Cell<[f64; 4]> }
impl NCache {
    const fn new() -> NCache { NCache { key: Cell::new((f64::NAN, f64::NAN, 0)), h: Cell::new([0.0; 4]) } }
}
#[inline(always)]
fn vnoise(c: &NCache, x: f64, y: f64, seed: i32) -> f64 {
    let fx0 = x.floor();
    let fy0 = y.floor();
    let [a, b, cc, d] = if c.key.get() == (fx0, fy0, seed) { c.h.get() } else {
        let ix = to_i32(fx0);
        let iy = to_i32(fy0);
        let ix1 = to_i32(fx0 + 1.0);
        let iy1 = to_i32(fy0 + 1.0);
        let h = [hash2(ix, iy, seed), hash2(ix1, iy, seed), hash2(ix, iy1, seed), hash2(ix1, iy1, seed)];
        c.key.set((fx0, fy0, seed));
        c.h.set(h);
        h
    };
    let mut fx = x - fx0;
    let mut fy = y - fy0;
    fx = fx * fx * (3.0 - 2.0 * fx);
    fy = fy * fy * (3.0 - 2.0 * fy);
    a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy
}
#[inline(always)]
fn fbm(c: &[NCache; 4], x: f64, y: f64, seed: i32) -> f64 {
    let mut n = vnoise(&c[0], x, y, seed) * 0.5 + vnoise(&c[1], x * 2.13 + 7.1, y * 2.13 - 3.7, seed.wrapping_add(1)) * 0.27
        + vnoise(&c[2], x * 4.61 - 1.3, y * 4.61 + 9.2, seed.wrapping_add(2)) * 0.15
        + vnoise(&c[3], x * 9.7 + 4.4, y * 9.7 + 2.9, seed.wrapping_add(3)) * 0.08;
    n = (n - 0.5) * 1.9 + 0.5;
    if n < 0.0 { 0.0 } else if n > 1.0 { 1.0 } else { n }
}

// ---------------------------------------------------------------------------------------------
// The parameter block (f64), filled in by engine-wasm.js. Keep the two in step.
// ---------------------------------------------------------------------------------------------
mod p {
    pub const W: usize = 0;
    pub const H: usize = 1;
    pub const GW: usize = 2;
    pub const GH: usize = 3;
    // samplerParams
    pub const AUTO: usize = 4;
    pub const R: usize = 5;
    pub const BAND: usize = 6;
    pub const SOFT: usize = 7;
    pub const THETA: usize = 8;
    pub const LOW: usize = 9;
    pub const DP: usize = 10;
    pub const RP: usize = 11;
    pub const NK: usize = 12;
    pub const SEED: usize = 13;
    pub const SXG: usize = 14;
    pub const SYG: usize = 15;
    pub const GXMAX: usize = 16;
    pub const GYMAX: usize = 17;
    pub const DEEP: usize = 18;
    // ctx.bbox (erodePass)
    pub const CX0: usize = 19;
    pub const CY0: usize = 20;
    pub const CX1: usize = 21;
    pub const CY1: usize = 22;
    // rs.bbox and pieceParams
    pub const BX0: usize = 23;
    pub const BY0: usize = 24;
    pub const BW: usize = 25;
    pub const BH: usize = 26;
    pub const BASE: usize = 27;
    pub const MINSIZE: usize = 28;
    pub const M: usize = 29;
    pub const PSEED: usize = 30;
    pub const A0: usize = 31;
    pub const BCX: usize = 32;
    pub const BCY: usize = 33;
    pub const DMAX: usize = 34;
    pub const TK: usize = 35;
    pub const TURB: usize = 36;
    pub const STEPS: usize = 37;
    pub const TRAILN: usize = 38;
    pub const KEEPDEEP: usize = 39;
    pub const FE: usize = 40;
    // the settings pieces() reads itself
    pub const SIZEVAR: usize = 41;
    pub const SPIN: usize = 42;
    pub const TEXTURE: usize = 43;
    pub const SPREAD: usize = 44;
    pub const BURST: usize = 45;
    pub const GRAVITY: usize = 46;
    pub const SHRINK: usize = 47;
    pub const OPACITY: usize = 48;
    pub const FADE: usize = 49;
    pub const COLORVAR: usize = 50;
    // the tip mix: how many entries (upTo, first tip, number of variants) and the weights' total
    pub const MIXN: usize = 51;
    pub const TOTAL: usize = 52;
    pub const LEN: usize = 53;
}

// ---------------------------------------------------------------------------------------------
// The sampler (makeSampler)
// ---------------------------------------------------------------------------------------------
struct Sampler<'a> {
    auto: bool, r: f64, band: f64, soft: f64, theta: f64, low: f64, dp: f64, rp: f64, nk: f64, seed: i32,
    sxg: f64, syg: f64, gx_max: f64, gy_max: f64, deep: f64, gw: usize,
    t: &'a [f32], add: Option<&'a [f32]>, keep: Option<&'a [f32]>,
    nc: [NCache; 4],
}
impl<'a> Sampler<'a> {
    unsafe fn new(q: &[f64], t: *const f32, add: *const f32, keep: *const f32) -> Sampler<'a> {
        let gn = q[p::GW] as usize * q[p::GH] as usize;
        let f = |ptr: *const f32| if ptr.is_null() { None } else { Some(slice::from_raw_parts(ptr, gn)) };
        let auto = q[p::AUTO] != 0.0 && !t.is_null();
        Sampler {
            auto, r: q[p::R], band: q[p::BAND], soft: q[p::SOFT], theta: q[p::THETA], low: q[p::LOW], dp: q[p::DP], rp: q[p::RP],
            nk: q[p::NK], seed: to_i32(q[p::SEED]), sxg: q[p::SXG], syg: q[p::SYG], gx_max: q[p::GXMAX], gy_max: q[p::GYMAX],
            deep: q[p::DEEP], gw: q[p::GW] as usize,
            t: if auto { slice::from_raw_parts(t, gn) } else { &[] }, add: f(add), keep: f(keep),
            nc: [NCache::new(), NCache::new(), NCache::new(), NCache::new()],
        }
    }
    /// the progress, add and keep fields at a point: (t, l, g)
    #[inline(always)]
    fn fields(&self, x: f64, y: f64) -> (f64, f64, f64) {
        let mut gxf = x * self.sxg - 0.5;
        let mut gyf = y * self.syg - 0.5;
        gxf = if gxf < 0.0 { 0.0 } else if gxf > self.gx_max { self.gx_max } else { gxf };
        gyf = if gyf < 0.0 { 0.0 } else if gyf > self.gy_max { self.gy_max } else { gyf };
        let gx0 = gxf as usize;
        let gy0 = gyf as usize;
        let fx = gxf - gx0 as f64;
        let fy = gyf - gy0 as f64;
        let i0 = gy0 * self.gw + gx0;
        let i1 = i0 + self.gw;
        let w00 = (1.0 - fx) * (1.0 - fy);
        let w10 = fx * (1.0 - fy);
        let w01 = (1.0 - fx) * fy;
        let w11 = fx * fy;
        let bil = |f: &[f32]| unsafe {
            *f.get_unchecked(i0) as f64 * w00 + *f.get_unchecked(i0 + 1) as f64 * w10 + *f.get_unchecked(i1) as f64 * w01 + *f.get_unchecked(i1 + 1) as f64 * w11
        };
        let t = if self.auto { bil(self.t) } else { 0.0 };
        let l = match self.add { Some(f) => bil(f), None => 0.0 };
        let g = match self.keep { Some(f) => bil(f), None => 0.0 };
        (t, l, g)
    }
    #[inline(always)]
    fn ragged(v: f64) -> f64 { if v >= 1.0 { 0.0 } else if v > 0.75 { (1.0 - v) * 4.0 } else if v < 0.25 { v * 4.0 } else { 1.0 } }
    #[inline(always)]
    fn solid(&self, depth: f64) -> f64 {
        let s = self.soft;
        if depth >= FRONT + s { 1.0 } else if depth <= FRONT - s { 0.0 } else { sstep(FRONT - s, FRONT + s, depth) }
    }
    /// at(): (depth, age, calm)
    #[inline(always)]
    fn at(&self, x: f64, y: f64) -> (f64, f64, f64) {
        let (t, l, g) = self.fields(x, y);
        self.at_fields(x, y, t, l, g)
    }
    fn at_fields(&self, x: f64, y: f64, t: f64, l: f64, g: f64) -> (f64, f64, f64) {
        let a = if g > 0.004 { 1.0 - g } else { 1.0 };
        if a < FAINT { return (-1.0, 0.0, 1.0); }
        let may_auto = self.auto && t + self.r > self.theta;
        let may_paint = l > FAINT;
        if !may_auto && !may_paint { return (-1.0, 0.0, 1.0); }
        if may_auto && a == 1.0 && t - self.theta > self.deep { return ((t - self.theta - self.r) / self.band, 1.0, 1.0); }
        let n2 = fbm(&self.nc, x * self.nk, y * self.nk, self.seed) * 2.0 - 1.0;
        let mut depth = -1.0;
        let mut ag = 0.0;
        let mut calm = 1.0;
        if may_auto {
            let v = t + self.r * n2 - self.theta;
            if v > 0.0 { depth = v / self.band; ag = clamp(v / 0.45, 0.0, 1.0); }
        }
        if may_paint {
            let v = (l + self.rp * n2 * Self::ragged(l) - self.low) * self.dp;
            if v > 0.0 {
                ag = jmax(ag, 0.3 + 0.35 * (n2 + 1.0));
                if v > depth { calm = lerp(sstep(self.low, 0.9, l), 1.0, clamp(depth, 0.0, 1.0)); depth = v; }
            }
        }
        if a < 1.0 {
            let cap = (a + self.rp * n2 * Self::ragged(a) - self.low) * self.dp;
            if cap <= 0.0 { return (-1.0, 0.0, 1.0); }
            if cap < depth { depth = cap; }
            calm = jmin(calm, sstep(self.low, 0.9, a));
        }
        (depth, ag, calm)
    }
    fn gone(&self, x: f64, y: f64) -> f64 {
        let (t, l, g) = self.fields(x, y);
        if l > FAINT || g > 0.004 {
            let a = if g > 0.004 { 1.0 - g } else { 1.0 };
            if a < FAINT { return 0.0; }
            let mut hi = -1.0;
            let mut lo = -1.0;
            if self.auto && t + self.r > self.theta { hi = (t + self.r - self.theta) / self.band; lo = (t - self.r - self.theta) / self.band; }
            if l > FAINT {
                let rg = self.rp * Self::ragged(l);
                hi = jmax(hi, (l + rg - self.low) * self.dp);
                lo = jmax(lo, (l - rg - self.low) * self.dp);
            }
            if a < 1.0 {
                let rg = self.rp * Self::ragged(a);
                let c_hi = (a + rg - self.low) * self.dp;
                if c_hi <= 0.0 { return 0.0; }
                hi = jmin(hi, c_hi);
                lo = jmin(lo, (a - rg - self.low) * self.dp);
            }
            if hi <= FRONT - self.soft { return 0.0; }
            if lo >= FRONT + self.soft { return 1.0; }
            return self.solid(self.at_fields(x, y, t, l, g).0);
        }
        if !self.auto { return 0.0; }
        let v = t - self.theta;
        let gone_lo = (FRONT - self.soft) * self.band;
        let gone_hi = (FRONT + self.soft) * self.band;
        if v + self.r <= gone_lo { return 0.0; }
        if v - self.r >= gone_hi { return 1.0; }
        self.solid((v + self.r * (fbm(&self.nc, x * self.nk, y * self.nk, self.seed) * 2.0 - 1.0)) / self.band)
    }
    #[inline(always)]
    fn protect(&self, x: f64, y: f64) -> f64 {
        let g = self.fields(x, y).2;
        if g > 0.86 { 1.0 - sstep(0.86, 0.98, g) } else { 1.0 }
    }
}

// ---------------------------------------------------------------------------------------------
// Brush tips: the variants are built in JavaScript (tipVariants, tipTable) and copied in here
// ---------------------------------------------------------------------------------------------
struct Grain { t: f64, fu: f64, fw: f64, seed: i32 }
struct Table { f: Vec<f32>, e: Vec<f32>, n: usize, n1: f64, mu: f64, mw: f64, su: f64, sw: f64 }
struct Tip {
    bmp: Option<Vec<u8>>, n: usize, k: f64,
    prof: Vec<f32>, sats: Vec<f64>, grain: Option<Grain>, tab: Option<Table>,
    soft: f64, scale: f64, feather: f64, ext: f64, eu: f64, ew: f64, sx: f64, isx: f64,
    rmin: f64, rmax: f64, // the outline's smallest and largest radius
}
static mut TIPS: Vec<Tip> = Vec::new();

mod th {
    pub const KIND: usize = 0; // 0 a formula, 1 a bitmap
    pub const SOFT: usize = 1;
    pub const SCALE: usize = 2;
    pub const FEATHER: usize = 3;
    pub const EXT: usize = 4;
    pub const EU: usize = 5;
    pub const EW: usize = 6;
    pub const SX: usize = 7;
    pub const ISX: usize = 8;
    pub const NSATS: usize = 9; // numbers in sats (3 per droplet)
    pub const GRAIN: usize = 10;
    pub const GT: usize = 11;
    pub const GFU: usize = 12;
    pub const GFW: usize = 13;
    pub const GSEED: usize = 14;
    pub const TAB: usize = 15;
    pub const MU: usize = 16;
    pub const MW: usize = 17;
    pub const SU: usize = 18;
    pub const SW: usize = 19;
    pub const TN: usize = 20;
    pub const BN: usize = 21; // bitmap side
    pub const BK: usize = 22; // bitmap scale
    pub const LEN: usize = 23;
}

/// Adds a tip variant; returns its index. hdr: th::LEN numbers. prof: TIP_K floats.
/// sats: hdr[NSATS] numbers. f, e: the outline table (TN² floats each). bmp: BN² bytes.
#[no_mangle]
pub unsafe extern "C" fn tip_add(hdr: *const f64, prof: *const f32, sats: *const f64, f: *const f32, e: *const f32, bmp: *const u8) -> i32 {
    let h = slice::from_raw_parts(hdr, th::LEN);
    let tip = if h[th::KIND] == 1.0 {
        let n = h[th::BN] as usize;
        Tip {
            bmp: Some(slice::from_raw_parts(bmp, n * n).to_vec()), n, k: h[th::BK],
            prof: Vec::new(), sats: Vec::new(), grain: None, tab: None,
            soft: h[th::SOFT], scale: h[th::SCALE], feather: h[th::FEATHER], ext: h[th::EXT], eu: h[th::EU], ew: h[th::EW], sx: 1.0, isx: 1.0,
            rmin: 0.0, rmax: 0.0,
        }
    } else {
        let ns = h[th::NSATS] as usize;
        let tab = if h[th::TAB] != 0.0 {
            let n = h[th::TN] as usize;
            Some(Table {
                f: slice::from_raw_parts(f, n * n).to_vec(), e: slice::from_raw_parts(e, n * n).to_vec(), n, n1: (n - 1) as f64,
                mu: h[th::MU], mw: h[th::MW], su: h[th::SU], sw: h[th::SW],
            })
        } else { None };
        Tip {
            bmp: None, n: 0, k: 0.0,
            prof: slice::from_raw_parts(prof, TIP_K).to_vec(),
            sats: if ns > 0 { slice::from_raw_parts(sats, ns).to_vec() } else { Vec::new() },
            grain: if h[th::GRAIN] != 0.0 { Some(Grain { t: h[th::GT], fu: h[th::GFU], fw: h[th::GFW], seed: to_i32(h[th::GSEED]) }) } else { None },
            tab,
            soft: h[th::SOFT], scale: h[th::SCALE], feather: h[th::FEATHER], ext: h[th::EXT], eu: h[th::EU], ew: h[th::EW], sx: h[th::SX], isx: h[th::ISX],
            rmin: (0..TIP_K).map(|k| *prof.add(k) as f64).fold(f64::INFINITY, jmin),
            rmax: (0..TIP_K).map(|k| *prof.add(k) as f64).fold(0.0, jmax),
        }
    };
    TIPS.push(tip);
    (TIPS.len() - 1) as i32
}
/// Forgets every tip variant.
#[no_mangle]
pub unsafe extern "C" fn tips_clear() { TIPS = Vec::new(); }

/// What tipAlpha works out from its `inv` and `fe` for every pixel; the same for a whole stamp.
struct Edge { inv: f64, wpx: f64, half: f64, reach: f64, nc: NCache }
impl Edge {
    #[inline(always)]
    fn new(v: &Tip, inv: f64, fe: f64) -> Edge {
        let wpx = 1.0 + (fe + v.feather) * inv; // edge width in pixels
        let half = (1.0 + (fe + v.feather) * inv) / (2.0 * inv); // how far either side of the outline the edge reaches
        // a droplet further than its radius plus this can't cover the point at all (see tip_alpha_exact)
        let reach = 0.5 * wpx / inv;
        Edge { inv, wpx, half, reach, nc: NCache::new() }
    }
}

/// tipAlpha: coverage (0…1) of a tip at (u, w), in tip units
#[inline(always)]
fn tip_alpha(v: &Tip, u: f64, w: f64, e: &Edge) -> f64 {
    if let Some(b) = &v.bmp {
        let n = v.n as f64;
        let fx = (u / v.k + 1.0) * 0.5 * n - 0.5;
        let fy = (w / v.k + 1.0) * 0.5 * n - 0.5;
        if fx <= -1.0 || fy <= -1.0 || fx >= n || fy >= n { return 0.0; }
        let x0 = fx.floor();
        let y0 = fy.floor();
        let tx = fx - x0;
        let ty = fy - y0;
        let (xi, yi, ni) = (x0 as i64, y0 as i64, v.n as i64);
        let g = |x: i64, y: i64| if x < 0 || y < 0 || x >= ni || y >= ni { 0.0 } else { b[(y * ni + x) as usize] as f64 };
        return lerp(lerp(g(xi, yi), g(xi + 1, yi), tx), lerp(g(xi, yi + 1), g(xi + 1, yi + 1), tx), ty) / 255.0;
    }
    let t = match &v.tab { Some(t) => t, None => return tip_alpha_exact(v, u, w, e) };
    let gx = (u + t.mu) * t.su;
    let gy = (w + t.mw) * t.sw;
    if gx < 0.0 || gy < 0.0 || gx >= t.n1 || gy >= t.n1 { return 0.0; }
    let x0 = gx as usize;
    let y0 = gy as usize;
    let tx = gx - x0 as f64;
    let ty = gy - y0 as f64;
    let i = y0 * t.n + x0;
    let (f00, f10, f01, f11) = unsafe {
        (*t.f.get_unchecked(i) as f64, *t.f.get_unchecked(i + 1) as f64, *t.f.get_unchecked(i + t.n) as f64, *t.f.get_unchecked(i + t.n + 1) as f64)
    };
    let top = f00 + (f10 - f00) * tx;
    let bot = f01 + (f11 - f01) * tx;
    let val = top + (bot - top) * ty;
    let mut a;
    if v.soft != 0.0 {
        a = val / v.soft;
        a = if a <= 0.0 { 0.0 } else if a >= 1.0 { 1.0 } else { a * a * (3.0 - 2.0 * a) };
    } else {
        let half = e.half;
        let err = unsafe { *t.e.get_unchecked(i) } as f64;
        if val - err >= half { a = 1.0; } else if val + err <= -half { return 0.0; } else { return tip_alpha_exact(v, u, w, e); }
    }
    if a > 0.0 {
        if let Some(g) = &v.grain { a *= sstep(g.t - 0.1, g.t + 0.1, vnoise(&e.nc, u * g.fu + 17.3, w * g.fw + 5.1, g.seed)); }
    }
    a
}
fn tip_alpha_exact(v: &Tip, u: f64, w: f64, e: &Edge) -> f64 {
    let x = u * v.isx;
    let y = w * v.sx;
    let rho = (x * x + y * y).sqrt();
    // A shortcut the JavaScript doesn't take: well outside the outline (or well inside it), the
    // outline's own coverage is 0 (or 1) whatever its radius in this direction, so atan2 can wait.
    // (The radius read below lies between the smallest and the largest; the margins of 1e-7 are
    // far beyond the rounding.)
    let sure = if v.soft != 0.0 {
        if rho > v.rmax * (1.0 + 1e-7) { 0 } else if v.soft < 1.0 && rho < v.rmin * (1.0 - v.soft) * (1.0 - 1e-7) { 1 } else { 2 }
    } else if rho > (v.rmax + e.reach) * (1.0 + 1e-7) { 0 } else if rho < (v.rmin - e.reach) * (1.0 - 1e-7) { 1 } else { 2 };
    if sure == 1 {
        let mut a = 1.0; // and no droplet can raise it
        if let Some(g) = &v.grain { a *= sstep(g.t - 0.1, g.t + 0.1, vnoise(&e.nc, u * g.fu + 17.3, w * g.fw + 5.1, g.seed)); }
        return a;
    }
    let a = if sure == 0 { 0.0 } else { tip_outline(v, x, y, rho, e) };
    tip_droplets(v, u, w, e, a)
}
/// tipAlphaExact's coverage of the outline alone
#[inline(always)]
fn tip_outline(v: &Tip, x: f64, y: f64, rho: f64, e: &Edge) -> f64 {
    let inv = e.inv;
    let mut ang = atan2(y, x);
    if ang < 0.0 { ang += TAU; }
    let f = ang * (TIP_K as f64 / TAU);
    let k0 = to_i32(f) as usize;
    let p0 = v.prof[k0 % TIP_K] as f64;
    let r = p0 + (v.prof[(k0 + 1) % TIP_K] as f64 - p0) * (f - k0 as f64);
    let wpx = e.wpx;
    let mut a;
    if v.soft != 0.0 {
        a = (1.0 - rho / r) / v.soft;
        a = if a <= 0.0 { 0.0 } else if a >= 1.0 { 1.0 } else { a * a * (3.0 - 2.0 * a) };
    } else {
        a = ((r - rho) * inv) / wpx + 0.5;
        a = if a <= 0.0 { 0.0 } else if a >= 1.0 { 1.0 } else { a };
    }
    a
}
/// tipAlphaExact's droplets, and the grain, on top of the outline's coverage a0
#[inline(always)]
fn tip_droplets(v: &Tip, u: f64, w: f64, e: &Edge, a0: f64) -> f64 {
    let (inv, wpx) = (e.inv, e.wpx);
    let mut a = a0;
    // The droplets. Two shortcuts the JavaScript doesn't take, neither of which can change the
    // answer: once a is 1 no droplet can raise it, and a droplet further away than its radius plus
    // e.reach gives a negative coverage, which can't raise a (never below 0) either. (The margin of
    // 1e-6 is far beyond the rounding of either side.)
    let s = &v.sats;
    let mut i = 0;
    while i + 2 < s.len() && a < 1.0 {
        let (s0, s1, s2) = (s[i], s[i + 1], s[i + 2]);
        i += 3;
        let d2 = (u - s0) * (u - s0) + (w - s1) * (w - s1);
        let lim = s2 + e.reach;
        if d2 > lim * lim * (1.0 + 1e-6) { continue; }
        let d = d2.sqrt();
        let as_ = ((s2 - d) * inv) / wpx + 0.5;
        if as_ > a { a = if as_ > 1.0 { 1.0 } else { as_ }; }
    }
    if a > 0.0 {
        if let Some(g) = &v.grain { a *= sstep(g.t - 0.1, g.t + 0.1, vnoise(&e.nc, u * g.fu + 17.3, w * g.fw + 5.1, g.seed)); }
    }
    a
}

// ---------------------------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------------------------
/// the pixel range a stamp of this reach covers, clipped to the picture (None if it misses)
#[inline(always)]
fn stamp_box(cx: f64, cy: f64, reach: f64, w: usize, h: usize) -> Option<(usize, usize, usize, usize)> {
    let x0 = jmax(0.0, (cx - reach).floor());
    let x1 = jmin(w as f64 - 1.0, (cx + reach).ceil());
    let y0 = jmax(0.0, (cy - reach).floor());
    let y1 = jmin(h as f64 - 1.0, (cy + reach).ceil());
    if x0 > x1 || y0 > y1 { return None; }
    Some((x0 as usize, x1 as usize, y0 as usize, y1 as usize))
}

// Shortcuts the JavaScript doesn't take: of each row of a stamp's box, only the run of pixels
// that can pass the stamp's own test for a pixel is visited. The run is widened by a pixel or
// two so that rounding can't matter, and the test is still made for every pixel in it, so the
// same pixels are drawn with the same values.

/// The run of a row (dy from the centre) within a disc test d² < lim², widened by a pixel.
#[inline(always)]
fn disc_run(dy: f64, lim: f64, cx: f64, x0: usize, x1: usize) -> Option<(usize, usize)> {
    let l = lim + 1.0;
    let q = l * l - dy * dy;
    if !(q > 0.0) { return None; }
    let half = q.sqrt();
    clip_run((cx - 0.5 - half).floor(), (cx - 0.5 + half).ceil(), x0, x1)
}
/// The run of a row within the box test |u| <= eu, |w| <= ew of a turned stamp (u = dx c + dy s,
/// w = -dx s + dy c, dx = x + 0.5 - cx), widened by two pixels.
#[inline(always)]
fn slab_run(dy: f64, c: f64, s: f64, eu: f64, ew: f64, cx: f64, x0: usize, x1: usize) -> Option<(usize, usize)> {
    let mut lo = f64::NEG_INFINITY;
    let mut hi = f64::INFINITY;
    if c.abs() > 1e-9 {
        let (a, b) = ((-eu - dy * s) / c, (eu - dy * s) / c);
        lo = jmax(lo, jmin(a, b));
        hi = jmin(hi, jmax(a, b));
    }
    if s.abs() > 1e-9 {
        let (a, b) = ((dy * c - ew) / s, (dy * c + ew) / s);
        lo = jmax(lo, jmin(a, b));
        hi = jmin(hi, jmax(a, b));
    }
    clip_run((lo + cx - 0.5 - 2.0).floor(), (hi + cx - 0.5 + 2.0).ceil(), x0, x1)
}
#[inline(always)]
fn clip_run(a: f64, b: f64, x0: usize, x1: usize) -> Option<(usize, usize)> {
    let a = jmax(a, x0 as f64);
    let b = jmin(b, x1 as f64);
    if !(a <= b) { return None; }
    Some((a as usize, b as usize))
}

/// stampHole: bites a tip-shaped hole out of the erosion map
#[inline(never)]
fn stamp_hole(erode: &mut [u8], w: usize, h: usize, v: &Tip, cx: f64, cy: f64, hh: f64, rot: f64, fe: f64) {
    let reach = hh * (v.ext + fe) + 1.5;
    let (x0, x1, y0, y1) = match stamp_box(cx, cy, reach, w, h) { Some(b) => b, None => return };
    if erode[y0 * w + x0] > 250 && erode[y0 * w + x1] > 250 && erode[y1 * w + x0] > 250 && erode[y1 * w + x1] > 250
        && erode[((y0 + y1) >> 1) * w + ((x0 + x1) >> 1)] > 250 { return; }
    if reach < 1.6 { // a speck: one pixel
        let e = jmin(255.0, 255.0 * hh * hh * 1.8);
        if cx >= 0.0 && cy >= 0.0 && cx < w as f64 && cy < h as f64 {
            let i = to_i32(cy) as usize * w + to_i32(cx) as usize;
            if e > erode[i] as f64 { erode[i] = to_u8(e); }
        }
        return;
    }
    if hh * v.ext < SMALL { // a disc of the same area (or a soft dot)
        let r = if v.soft != 0.0 { hh * v.ext } else { hh * 0.75 };
        let lim = if v.soft != 0.0 { r } else { r + 0.5 }; // beyond it a pixel is skipped
        for y in y0..=y1 {
            let (xa, xb) = match disc_run(y as f64 + 0.5 - cy, lim, cx, x0, x1) { Some(r) => r, None => continue };
            for x in xa..=xb {
                let d2 = (x as f64 + 0.5 - cx) * (x as f64 + 0.5 - cx) + (y as f64 + 0.5 - cy) * (y as f64 + 0.5 - cy);
                let mut a;
                if v.soft != 0.0 {
                    if d2 >= r * r { continue; }
                    a = 1.0 - d2 / (r * r);
                    a *= a;
                } else {
                    a = r - d2.sqrt() + 0.5;
                    if a <= 0.0 { continue; }
                    if a > 1.0 { a = 1.0; }
                }
                let i = y * w + x;
                if a * 255.0 > erode[i] as f64 { erode[i] = to_u8(a * 255.0); }
            }
        }
        return;
    }
    let c = cos(rot) / hh;
    let s = sin(rot) / hh;
    let edge = Edge::new(v, hh, fe);
    let eu = v.eu + fe + 1.5 / hh;
    let ew = v.ew + fe + 1.5 / hh;
    for y in y0..=y1 {
        let dy = y as f64 + 0.5 - cy;
        let (xa, xb) = match slab_run(dy, c, s, eu, ew, cx, x0, x1) { Some(r) => r, None => continue };
        let row = &mut erode[y * w..y * w + w];
        for x in xa..=xb {
            let e0 = unsafe { *row.get_unchecked(x) }; // x1 < w
            if e0 == 255 { continue; }
            let dx = x as f64 + 0.5 - cx;
            let u = dx * c + dy * s;
            let ww = -dx * s + dy * c;
            if u > eu || u < -eu || ww > ew || ww < -ew { continue; }
            let a = tip_alpha(v, u, ww, &edge) * 255.0;
            if a > e0 as f64 { unsafe { *row.get_unchecked_mut(x) = a as u8; } } // e0 < a <= 255
        }
    }
}

/// Straight-alpha "over" of one pixel, as stampPiece does it into a Uint8ClampedArray.
#[inline(always)]
fn over(buf: &mut [u8], i: usize, r: f64, g: f64, b: f64, sa: f64) {
    debug_assert!(i + 3 < buf.len());
    unsafe {
        let p = buf.as_mut_ptr().add(i);
        let da = *p.add(3) as f64 / 255.0;
        let oa = sa + da * (1.0 - sa);
        let ks = sa / oa;
        let kd = 1.0 - ks;
        *p = to_u8c(r * ks + *p as f64 * kd);
        *p.add(1) = to_u8c(g * ks + *p.add(1) as f64 * kd);
        *p.add(2) = to_u8c(b * ks + *p.add(2) as f64 * kd);
        *p.add(3) = to_u8c(oa * 255.0);
    }
}

struct Canvas<'a> { buf: &'a mut [u8], w: usize, h: usize, s: &'a [u8], tex: f64, br: f64 }

/// stampPiece: draws a piece. (px, py), hd, rd: where it is now, its half-size and its turn.
/// (sx, sy), hs, rsrc: where it was cut from. trig: cos / sin of rd and rsrc, worked out the first
/// time they are needed and kept for the other stamps of the trail (JavaScript works them out
/// for every stamp, with the same result).
#[inline(never)]
fn stamp_piece(t: &mut Canvas, v: &Tip, px: f64, py: f64, hd: f64, rd: f64, sx: f64, sy: f64, hs: f64, rsrc: f64, trig: &mut Option<[f64; 4]>, r: f64, g: f64, b: f64, alpha: f64) {
    let (w, h) = (t.w, t.h);
    let tex = t.tex;
    let br = t.br;
    let reach = hd * v.ext + 1.5;
    let (x0, x1, y0, y1) = match stamp_box(px, py, reach, w, h) { Some(b) => b, None => return };
    if reach < 1.6 { // a speck: one pixel
        let ix = to_i32(px);
        let iy = to_i32(py);
        if ix < 0 || iy < 0 || ix as usize >= w || iy as usize >= h { return; }
        let i = (iy as usize * w + ix as usize) * 4;
        let sa = alpha * jmin(1.0, hd * hd * 1.8);
        let da = t.buf[i + 3] as f64 / 255.0;
        let oa = sa + da * (1.0 - sa);
        if oa <= 0.0 { return; }
        over(t.buf, i, r, g, b, sa);
        return;
    }
    if hd * v.ext < SMALL { // too small for its outline or its picture to show
        let rr = if v.soft != 0.0 { hd * v.ext } else { hd * 0.75 };
        let lim = if v.soft != 0.0 { rr } else { rr + 0.5 }; // beyond it a pixel is skipped
        for y in y0..=y1 {
            let (xa, xb) = match disc_run(y as f64 + 0.5 - py, lim, px, x0, x1) { Some(r) => r, None => continue };
            for x in xa..=xb {
                let d2 = (x as f64 + 0.5 - px) * (x as f64 + 0.5 - px) + (y as f64 + 0.5 - py) * (y as f64 + 0.5 - py);
                let mut cov;
                if v.soft != 0.0 {
                    if d2 >= rr * rr { continue; }
                    cov = 1.0 - d2 / (rr * rr);
                    cov *= cov;
                } else {
                    cov = rr - d2.sqrt() + 0.5;
                    if cov <= 0.0 { continue; }
                    if cov > 1.0 { cov = 1.0; }
                }
                over(t.buf, (y * w + x) * 4, r, g, b, alpha * cov);
            }
        }
        return;
    }
    let tg = *trig.get_or_insert_with(|| [cos(rd), sin(rd), cos(rsrc), sin(rsrc)]);
    let c = tg[0] / hd;
    let s = tg[1] / hd;
    let eu = v.eu + 1.5 / hd;
    let ew = v.ew + 1.5 / hd;
    let cs = tg[2] * hs;
    let ss = tg[3] * hs;
    let src = t.s;
    let edge = Edge::new(v, hd, 0.0);
    for y in y0..=y1 {
        let dy = y as f64 + 0.5 - py;
        let (xa, xb) = match slab_run(dy, c, s, eu, ew, px, x0, x1) { Some(r) => r, None => continue };
        for x in xa..=xb {
            let dx = x as f64 + 0.5 - px;
            let u = dx * c + dy * s;
            let ww = -dx * s + dy * c;
            if u > eu || u < -eu || ww > ew || ww < -ew { continue; }
            let cov = tip_alpha(v, u, ww, &edge);
            if cov <= 0.0 { continue; }
            let (mut cr, mut cg, mut cb) = (r, g, b);
            if tex > 0.0 {
                let tx = to_i32(sx + u * cs - ww * ss);
                let ty = to_i32(sy + u * ss + ww * cs);
                if tx >= 0 && (tx as usize) < w && ty >= 0 && (ty as usize) < h {
                    let ti = (ty as usize * w + tx as usize) * 4;
                    let px4 = unsafe { src.get_unchecked(ti..ti + 4) };
                    if px4[3] > 60 {
                        cr += (px4[0] as f64 * br - cr) * tex;
                        cg += (px4[1] as f64 * br - cg) * tex;
                        cb += (px4[2] as f64 * br - cb) * tex;
                    }
                }
            }
            over(t.buf, (y * w + x) * 4, cr, cg, cb, alpha * cov);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The passes. Every one takes the same parameter block and fields; the fields that are absent
// are null pointers.
// ---------------------------------------------------------------------------------------------
/// erodePass: the solid part of the erosion. erode must be cleared by the caller.
#[no_mangle]
pub unsafe extern "C" fn erode_pass(pb: *const f64, subject: *const u8, erode: *mut u8, t: *const f32, add: *const f32, keep: *const f32) {
    let q = slice::from_raw_parts(pb, p::LEN);
    let (w, h) = (q[p::W] as usize, q[p::H] as usize);
    let n = w * h;
    let sub = slice::from_raw_parts(subject, n * 4);
    let er = slice::from_raw_parts_mut(erode, n);
    let smp = Sampler::new(q, t, add, keep);
    let (x0, y0, x1, y1) = (q[p::CX0] as usize, q[p::CY0] as usize, q[p::CX1] as usize, q[p::CY1] as usize);
    if x1 <= x0 || y1 <= y0 { return; }
    // A shortcut the JavaScript doesn't take. Between four grid points the fields are a weighted
    // mean of the four, so if none of them is near the front, nothing in between is either: such
    // a quad is wholly untouched (0) or wholly gone (1), as gone() would find pixel by pixel. The
    // margins of 1e-9 are far beyond the rounding of the mean.
    let (gw, gh) = (smp.gw, q[p::GH] as usize);
    let gone_lo = (FRONT - smp.soft) * smp.band;
    let gone_hi = (FRONT + smp.soft) * smp.band;
    let max4 = |f: &[f32], i: usize| jmax(jmax(f[i] as f64, f[i + 1] as f64), jmax(f[i + gw] as f64, f[i + gw + 1] as f64));
    let min4 = |f: &[f32], i: usize| jmin(jmin(f[i] as f64, f[i + 1] as f64), jmin(f[i + gw] as f64, f[i + gw + 1] as f64));
    let classify = |i: usize| -> u8 {
        if let Some(a) = smp.add { if max4(a, i) >= FAINT - 1e-9 { return 2; } }
        if let Some(k) = smp.keep { if max4(k, i) >= 0.004 - 1e-9 { return 2; } }
        if !smp.auto { 0 }
        else if max4(smp.t, i) - smp.theta + smp.r <= gone_lo - 1e-9 { 0 }
        else if min4(smp.t, i) - smp.theta - smp.r >= gone_hi + 1e-9 { 1 }
        else { 2 }
    };
    let mut class = vec![3u8; gw * gh]; // 3: not looked at yet
    // the quad of each column and row, as fields() finds it
    let col: Vec<usize> = (x0..x1).map(|x| {
        let g = (x as f64 + 0.5) * smp.sxg - 0.5;
        (if g < 0.0 { 0.0 } else if g > smp.gx_max { smp.gx_max } else { g }) as usize
    }).collect();
    for y in y0..y1 {
        let g = (y as f64 + 0.5) * smp.syg - 0.5;
        let gr = (if g < 0.0 { 0.0 } else if g > smp.gy_max { smp.gy_max } else { g }) as usize * gw;
        for x in x0..x1 {
            let i = y * w + x;
            if sub[i * 4 + 3] == 0 { continue; }
            let qi = gr + col[x - x0];
            let mut k = class[qi];
            if k == 3 { k = classify(qi); class[qi] = k; }
            match k {
                0 => {}
                1 => er[i] = 255, // gone() = 1: 1 * 255 + 0.5
                _ => {
                    let e = smp.gone(x as f64 + 0.5, y as f64 + 0.5);
                    if e > 0.004 { er[i] = to_u8(e * 255.0 + 0.5); }
                }
            }
        }
    }
}

/// finishErosion: keeps protected paint intact; returns the removed area in pixels.
#[no_mangle]
pub unsafe extern "C" fn finish(pb: *const f64, subject: *const u8, erode: *mut u8, t: *const f32, add: *const f32, keep: *const f32) -> f64 {
    let q = slice::from_raw_parts(pb, p::LEN);
    let (w, h) = (q[p::W] as usize, q[p::H] as usize);
    let n = w * h;
    let sub = slice::from_raw_parts(subject, n * 4);
    let er = slice::from_raw_parts_mut(erode, n);
    let smp = Sampler::new(q, t, add, keep);
    let has_protect = smp.keep.is_some();
    let mut sum = 0.0f64;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if er[i] == 0 { continue; }
            if has_protect { er[i] = to_u8(er[i] as f64 * smp.protect(x as f64 + 0.5, y as f64 + 0.5)); }
            sum += er[i] as f64 * sub[i * 4 + 3] as f64;
        }
    }
    sum / 65025.0
}

/// pieces: scatters the candidate pieces; each that has left bites its hole out of erode and, if
/// particles is not null, is drawn there. mix: MIXN × (upTo, first tip, number of variants).
/// stats receives (drawn, holes, matched).
#[no_mangle]
pub unsafe extern "C" fn pieces(pb: *const f64, subject: *const u8, erode: *mut u8, particles: *mut u8,
    t: *const f32, add: *const f32, keep: *const f32, mixp: *const f64, stats: *mut f64) {
    let q = slice::from_raw_parts(pb, p::LEN);
    let st = slice::from_raw_parts_mut(stats, 3);
    st[0] = 0.0; st[1] = 0.0; st[2] = 0.0;
    let (w, h) = (q[p::W] as usize, q[p::H] as usize);
    let n = w * h;
    let (bw, bh) = (q[p::BW], q[p::BH]);
    if bw <= 0.0 || bh <= 0.0 { return; }
    let sub = slice::from_raw_parts(subject, n * 4);
    let er = slice::from_raw_parts_mut(erode, n);
    let smp = Sampler::new(q, t, add, keep);
    let tips = &TIPS;
    let nmix = q[p::MIXN] as usize;
    let mixs = slice::from_raw_parts(mixp, nmix * 3);
    let total = q[p::TOTAL];
    let (bx0, by0) = (q[p::BX0], q[p::BY0]);
    let (base, min_size, m_count, seed) = (q[p::BASE], q[p::MINSIZE], q[p::M] as i64, to_i32(q[p::PSEED]));
    let (a0, bcx, bcy, dmax, tk, turb) = (q[p::A0], q[p::BCX], q[p::BCY], q[p::DMAX], q[p::TK], q[p::TURB]);
    let steps = q[p::STEPS] as i32;
    let trail_n = q[p::TRAILN] as i32;
    let (keep_deep, fe) = (q[p::KEEPDEEP], q[p::FE]);
    let (size_var, spin, spread, burst, gravity, shrink, opacity, fade, color_var) =
        (q[p::SIZEVAR], q[p::SPIN], q[p::SPREAD], q[p::BURST], q[p::GRAVITY], q[p::SHRINK], q[p::OPACITY], q[p::FADE], q[p::COLORVAR]);
    let has_out = !particles.is_null();
    let mut canvas = Canvas {
        buf: if has_out { slice::from_raw_parts_mut(particles, n * 4) } else { &mut [] },
        w, h, s: sub, tex: q[p::TEXTURE], br: 1.0,
    };
    let (wf, hf) = (w as f64, h as f64);
    let (mut drawn, mut holes, mut matched) = (0.0, 0.0, 0.0);
    let tc = [NCache::new(), NCache::new(), NCache::new(), NCache::new()];
    let mut i: i32 = 0;
    while (i as i64) < m_count {
        let ii = i;
        i += 1;
        let sx = bx0 + rnd(ii, 0, seed) * bw;
        let sy = by0 + rnd(ii, 1, seed) * bh;
        let xi = to_i32(sx);
        let yi = to_i32(sy);
        if xi < 0 || yi < 0 || xi as usize >= w || yi as usize >= h { continue; }
        let pi = yi as usize * w + xi as usize;
        let sa = sub[pi * 4 + 3];
        if sa < 16 { continue; }
        // has this piece left yet?
        let (depth, aged, calm) = smp.at(sx, sy);
        if depth <= rnd(ii, 2, seed) { continue; }
        // its tip, size and turn
        let pick = rnd(ii, 8, seed) * total;
        let mut m = 0;
        while m < nmix - 1 && pick >= mixs[m * 3] { m += 1; }
        let first = mixs[m * 3 + 1] as usize;
        let count = mixs[m * 3 + 2] as usize;
        let tip = &tips[first + ((rnd(ii, 13, seed) * count as f64).floor() as usize) % count];
        let mut sz = base * lerp(1.0, 0.18 + 2.6 * pow(rnd(ii, 6, seed), 3.0), size_var);
        if calm < 1.0 { sz *= 0.4 + 0.6 * calm; }
        if sz < min_size { sz = min_size; }
        let hs = (sz / 2.0) * tip.scale;
        let rsrc = rnd(ii, 9, seed) * TAU * spin;
        let in_band = depth < FRONT + smp.soft;
        if depth < FRONT + 1.6 {
            stamp_hole(er, w, h, tip, sx, sy, hs, rsrc, fe);
        }
        if in_band { holes += 1.0; }
        if !has_out { continue; }
        let keepf = lerp(1.0, keep_deep, sstep(FRONT + 0.2, FRONT + 1.4, depth));
        if rnd(ii, 14, seed) >= keepf { continue; }

        // how far, and which way
        let mut tf = (0.15 + 0.85 * pow(aged, 0.8)) * (0.22 + 0.78 * pow(rnd(ii, 3, seed), 1.2));
        if calm < 1.0 { tf *= 0.1 + 0.9 * calm; }
        let dist = dmax * tf;
        let ang = a0 + (rnd(ii, 4, seed) + rnd(ii, 5, seed) - 1.0) * spread * 1.9;
        let mut vx = cos(ang);
        let mut vy = sin(ang);
        if burst > 0.0 {
            let ox = sx - bcx;
            let oy = sy - bcy;
            let ol = hypot(ox, oy);
            if ol > 1e-3 {
                vx = lerp(vx, ox / ol, burst);
                vy = lerp(vy, oy / ol, burst);
                let vl = hypot(vx, vy);
                if vl > 1e-3 { vx /= vl; vy /= vl; } else { vx = cos(ang); vy = sin(ang); }
            }
        }
        let (mut x, mut y, mut hx, mut hy) = (sx, sy, vx, vy);
        let step = dist / steps as f64;
        for k in 0..steps {
            let mut mx = vx;
            let mut my = vy;
            if turb > 0.0 {
                let qx = x * tk;
                let qy = y * tk;
                let ee = 0.35;
                mx += ((vnoise(&tc[0], qx, qy + ee, seed) - vnoise(&tc[1], qx, qy - ee, seed)) / (2.0 * ee)) * turb;
                my -= ((vnoise(&tc[2], qx + ee, qy, seed) - vnoise(&tc[3], qx - ee, qy, seed)) / (2.0 * ee)) * turb;
            }
            my += gravity * 1.6 * ((k as f64 + 0.5) / steps as f64);
            x += mx * step;
            y += my * step;
            hx = mx;
            hy = my;
        }
        let hd = hs * (1.0 - shrink * 0.8 * tf);
        let alpha = opacity * (1.0 - fade * pow(tf, 0.8)) * (sa as f64 / 255.0);
        if alpha < 0.02 { continue; }
        let reach = hd * tip.ext + 2.0;
        if x < -reach || y < -reach || x > wf + reach || y > hf + reach { continue; }
        let rd = rsrc + (rnd(ii, 15, seed) - 0.5) * TAU * spin * jmin(1.0, tf * 2.5);

        // colour: the subject around where the piece came from
        let qq = jmax(1.0, sz * 0.3);
        let (mut cr, mut cg, mut cb, mut cn) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                let tx = to_i32(sx + dx as f64 * qq);
                let ty = to_i32(sy + dy as f64 * qq);
                if tx < 0 || ty < 0 || tx as usize >= w || ty as usize >= h { continue; }
                let ti = (ty as usize * w + tx as usize) * 4;
                let ta = sub[ti + 3] as f64;
                if ta < 60.0 { continue; }
                cr += sub[ti] as f64 * ta;
                cg += sub[ti + 1] as f64 * ta;
                cb += sub[ti + 2] as f64 * ta;
                cn += ta;
            }
        }
        if cn == 0.0 { let ti = pi * 4; cr = sub[ti] as f64; cg = sub[ti + 1] as f64; cb = sub[ti + 2] as f64; cn = 1.0; }
        let br = 1.0 + (rnd(ii, 7, seed) - 0.5) * 1.4 * color_var;
        cr = clamp((cr / cn) * br, 0.0, 255.0);
        cg = clamp((cg / cn) * br, 0.0, 255.0);
        cb = clamp((cb / cn) * br, 0.0, 255.0);
        canvas.br = br;

        let mut hl = hypot(hx, hy);
        if !(hl != 0.0) { hl = 1.0; } // `|| 1`: 0 and NaN
        let ux = hx / hl;
        let uy = hy / hl;
        let mut trig: Option<[f64; 4]> = None;
        let mut tr = trail_n;
        while tr >= 0 {
            let al = if tr != 0 { alpha * 0.7 * pow(1.0 - tr as f64 / (trail_n + 1) as f64, 1.5) } else { alpha };
            if al >= 0.01 {
                stamp_piece(&mut canvas, tip, x - ux * hd * 1.7 * tr as f64, y - uy * hd * 1.7 * tr as f64, hd, rd, sx, sy, hs, rsrc, &mut trig, cr, cg, cb, al);
            }
            tr -= 1;
        }
        drawn += 1.0;
        if in_band { matched += 1.0; }
    }
    st[0] = drawn; st[1] = holes; st[2] = matched;
}

// ---------------------------------------------------------------------------------------------
// composite: the preview picture
// ---------------------------------------------------------------------------------------------
/// cp: W, H, gw, gh, view (0 result, 1 before, 2 mask). plate, erode, particles and keep may be
/// null (keep: the protect level on the grid, for the mask view). out: W×H×4.
#[no_mangle]
pub unsafe extern "C" fn composite(cp: *const f64, subject: *const u8, plate: *const u8, erode: *const u8, particles: *const u8, keep: *const f32, out: *mut u8) {
    let c = slice::from_raw_parts(cp, 5);
    let (w, h, gw, gh) = (c[0] as usize, c[1] as usize, c[2] as usize, c[3] as usize);
    let view = c[4] as i32;
    let q = if view == 0 { particles } else { core::ptr::null() };
    let k = if view == 2 { keep } else { core::ptr::null() };
    let a = Comp { w, h, gw, gh, s: subject, b: plate, e: erode, q, k, o: out };
    // one loop for each case, with the questions that are the same for every pixel answered once
    match (view, !plate.is_null(), !q.is_null(), !k.is_null()) {
        (0, true, true, _) => comp::<0, true, true, false>(&a),
        (0, true, false, _) => comp::<0, true, false, false>(&a),
        (0, false, true, _) => comp::<0, false, true, false>(&a),
        (0, false, false, _) => comp::<0, false, false, false>(&a),
        (2, true, _, true) => comp::<2, true, false, true>(&a),
        (2, true, _, false) => comp::<2, true, false, false>(&a),
        (2, false, _, true) => comp::<2, false, false, true>(&a),
        (2, false, _, false) => comp::<2, false, false, false>(&a),
        (_, true, _, _) => comp::<1, true, false, false>(&a),
        (_, false, _, _) => comp::<1, false, false, false>(&a),
    }
}
struct Comp { w: usize, h: usize, gw: usize, gh: usize, s: *const u8, b: *const u8, e: *const u8, q: *const u8, k: *const f32, o: *mut u8 }
#[inline(always)]
unsafe fn comp<const V: i32, const B: bool, const Q: bool, const P: bool>(a: &Comp) {
    let (w, h, gw, gh) = (a.w, a.h, a.gw, a.gh);
    // the grid column of each x, as composite works it out
    let gxs: Vec<usize> = if P { (0..w).map(|x| jmin(gw as f64 - 1.0, ((x * gw) as f64 / w as f64).floor()) as usize).collect() } else { Vec::new() };
    // Most pixels are plain: the plate, the subject over it with nothing removed, or nothing
    // removed from it at all; the same goes for an opaque particle or none. Those are copied as
    // whole numbers (which is what the arithmetic gives for them: x + (y - x) * 1 is y, and
    // x + (y - x) * 0 is x); the rest are worked out as composite does.
    let mut i = 0usize;
    for y in 0..h {
        let gr = jmin(gh as f64 - 1.0, ((y * gh) as f64 / h as f64).floor()) as usize * gw;
        for x in 0..w {
            let j = i * 4;
            let (br, bg, bb): (u8, u8, u8) = if B { (*a.b.add(j), *a.b.add(j + 1), *a.b.add(j + 2)) } else {
                let v = if ((x >> 3) + (y >> 3)) & 1 != 0 { 96 } else { 72 };
                (v, v, v)
            };
            let sa0 = *a.s.add(j + 3);
            let e0 = if V != 1 { *a.e.add(i) } else { 0 };
            // the plate and the subject: whole numbers (ir, ig, ib) or worked out (fr, fg, fb)
            let mut whole = true;
            let (mut ir, mut ig, mut ib) = (br, bg, bb);
            let (mut fr, mut fg, mut fb) = (0.0f64, 0.0f64, 0.0f64);
            if sa0 == 0 || (V == 0 && e0 == 255) {
                // nothing of the subject here
            } else if V != 2 && sa0 == 255 && e0 == 0 {
                ir = *a.s.add(j); ig = *a.s.add(j + 1); ib = *a.s.add(j + 2);
            } else {
                whole = false;
                let (mut r, mut g, mut bl) = (br as f64, bg as f64, bb as f64);
                let mut sa = sa0 as f64;
                let (mut sr, mut sg, mut sb) = (*a.s.add(j) as f64, *a.s.add(j + 1) as f64, *a.s.add(j + 2) as f64);
                if V == 0 { sa = (sa * (255.0 - e0 as f64)) / 255.0; }
                else if V == 2 {
                    let ee = (e0 as f64 / 255.0) * 0.7;
                    sr += (255.0 - sr) * ee;
                    sg += (40.0 - sg) * ee;
                    sb += (60.0 - sb) * ee;
                    if P {
                        let pv = *a.k.add(gr + *gxs.get_unchecked(x)) as f64;
                        if pv > 0.0 {
                            let k = pv * 0.55;
                            sr += (40.0 - sr) * k;
                            sg += (220.0 - sg) * k;
                            sb += (120.0 - sb) * k;
                        }
                    }
                }
                let k = sa / 255.0;
                r += (sr - r) * k;
                g += (sg - g) * k;
                bl += (sb - bl) * k;
                fr = r; fg = g; fb = bl;
            }
            if Q {
                let qa = *a.q.add(j + 3);
                if qa == 255 {
                    whole = true;
                    ir = *a.q.add(j); ig = *a.q.add(j + 1); ib = *a.q.add(j + 2);
                } else if qa != 0 {
                    if whole { fr = ir as f64; fg = ig as f64; fb = ib as f64; whole = false; }
                    let k = qa as f64 / 255.0;
                    fr += (*a.q.add(j) as f64 - fr) * k;
                    fg += (*a.q.add(j + 1) as f64 - fg) * k;
                    fb += (*a.q.add(j + 2) as f64 - fb) * k;
                }
            }
            if whole {
                *a.o.add(j) = ir; *a.o.add(j + 1) = ig; *a.o.add(j + 2) = ib;
            } else {
                *a.o.add(j) = to_u8c(fr); *a.o.add(j + 1) = to_u8c(fg); *a.o.add(j + 2) = to_u8c(fb);
            }
            *a.o.add(j + 3) = 255;
            i += 1;
        }
    }
}
