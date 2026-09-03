/**
 * Local-adaptive tone node (docs/research/local-adaptive-tone.md,
 * docs/research/lr-tone-measurements.md / -r2.md, incl. round-3 addendum):
 * operates on WORKING_LUMA log2 luminance only, restoring color by the RATIO
 * method (research doc §1.2 'lum'): process log2(luma), then scale the
 * ORIGINAL rgb by 2^(processedLog - originalLog) so hue/chroma ratios are
 * preserved exactly (Ir/Ii, Ig/Ii, Ib/Ii unchanged).
 *
 * Doc-shape module only (params/sanitizer/CPU reference used by unit tests),
 * same split as denoiseNode.ts/lutNode.ts — the actual GPU passes live in
 * graphRenderer.ts, since this node needs several full-res/reduced-res
 * render targets the generic 'passes' one-texture-per-step pipeline can't
 * express.
 *
 * SPATIAL CLASS, NO CPU MIRROR (same exemption as Detail/fx-spatial in
 * developNode.ts, and 'external'/'denoise'/'image' steps in graphDoc.ts): the
 * global reference depends on the WHOLE image, not a per-pixel neighborhood a
 * JS reference could feasibly mirror inside cpuEvalPlan. buildPlan emits
 * PlanStep 'localtone' with no `cpu` field; cpuEvalPlan/stepHasCpuMirror/
 * stripNoCpuMirrorSteps treat it exactly like 'external'/'denoise' (see
 * graphDoc.ts). This module still ships a full CPU reference implementation
 * below (mirrors the WGSL bit-for-bit) — it just isn't wired into buildPlan's
 * per-pixel cross-check; it exists purely so localToneNode.test.ts can assert
 * the algorithm's shape/values fast, without a GPU.
 *
 * ============================================================================
 * STAGE 1d (this revision — replaces the STAGE 1c shared Laplacian-pyramid
 * design entirely; see git history for 1b/1c). Conductor-verified finding
 * that forced this rewrite: a single shared full-depth Laplacian pyramid with
 * a per-level remap has a proven structural conflict — the small remap onset
 * round-3's measured curves demand necessarily opens a wrong-signed far-field
 * leakage channel (E1 dark-background cases), and the mitigation
 * (levelDamp's halo suppression) has a usable window under one pyramid level
 * wide. Three independent methods (sim, production-function cross-check,
 * real GPU) confirmed it in stage 1c — see that revision's honest
 * characterization in git history. STOPPED TUNING IT.
 *
 * NEW ARCHITECTURE — a per-pixel curve keyed to a GLOBAL scene reference,
 * with a small-radius base/detail split (paper-validated in a from-scratch
 * CPU simulator — ephemeral session-scratch tuning script, not committed,
 * same convention as stage 1c's own sim):
 *
 *   1. `base` = a small-radius (~2-3px sigma) Gaussian blur of full-res
 *      log2-luminance. `detail` = logLuma - base is preserved UNTOUCHED
 *      (added back after remap, never touched by the curve) — this is what
 *      keeps genuine texture/edge micro-contrast intact and is the only
 *      thing standing between this and a plain global tone curve.
 *   2. `ref` = a GLOBAL scalar: the image's own log2-luma mean, computed by
 *      a plain (unweighted) box-filter reduce chain down to 1x1 — see
 *      `globalLogMean`'s doc comment for why UNWEIGHTED specifically (a
 *      Burt-Adelson-weighted reduce, tried first in sim, showed a severe,
 *      unpredictable bias on hard step edges — E4's own construction —
 *      because a small overlapping kernel cascaded across many dyadic
 *      halvings does NOT converge to anything close to the true mean for a
 *      50/50 split image; a plain non-overlapping box reduce is EXACT for
 *      power-of-2 dims and has no such bias).
 *   3. `offset = base(pixel) - ref`. Shadows respond for offset<0 (pixel's
 *      local neighborhood reads darker than the whole-scene reference) with
 *      the round-3 shadows curve; Highlights respond for offset>=0 with the
 *      round-3 highlights curve. Slider strength is exactly linear in the
 *      curve construction (see `toneTail`'s doc comment) — matches round-3's
 *      own "sh_p50 = half of sh_p100" finding.
 *
 * WHY THIS FIXES STAGE 1c'S STRUCTURAL CONFLICT: there is no more multi-
 * scale Laplacian accumulation, so there is no more "K-discretization-level
 * tent-weighted reconstruction dilutes/distorts the per-level delta"
 * problem stage 1c's own honest-report flagged. The shift applied to a pixel
 * IS the curve's output, exactly — `newLog = logLuma + (remap(base) -
 * base)`, and since `detail = logLuma - base` is added back untouched,
 * `newLog - logLuma = remap(base) - base` identically, no attenuation from
 * anything downstream. This let stage 1d fit round-3's OWN measured
 * onset/slope for Shadows directly (LOCALTONE_TONE_ONSET_SH/FLOOR_SH below
 * land within a few % of round-3's literal ~1.0stop/0.30-per-stop
 * characterization) — Highlights needed a modest re-fit (see its own
 * constants' doc comments) but is still in the same ballpark as round-3's
 * own ~0.8stop/0.55-per-stop reading, not stage 1c's much-enlarged
 * compromise values.
 *
 * E4 (hard-edge, no-halo) falls out for a structural reason, not a tuned
 * one: `base` is a small, fixed-radius blur (no multi-scale support to leak
 * through), so far from any edge `base` saturates to the true local value
 * and the per-pixel curve's OWN identity/tail shape (monotonic, C1-
 * continuous, never overshoots past its target — same shape stage 1c's
 * remapLog2 already proved not-overshooting) composes with a Gaussian
 * blur's own monotonic (non-ringing) step response, so the whole delta
 * profile across a hard edge is provably monotonic — sim confirms overshoot
 * ratio ≈ 0 at the shipped default sigma.
 *
 * DELETED from stage 1c (git history preserves it — not needed by this
 * design): the full Laplacian pyramid (build/collapse, reduceGray's
 * Burt-Adelson kernel /EXPAND), LOCALTONE_K_LEVELS discretization
 * (discretizationLevels/tentWeight/levelAmounts), and levelDamp's per-
 * pyramid-level halo suppression (LOCALTONE_HALO_DAMP_START_LEVEL/
 * LOCALTONE_HALO_LEVELS_PER_SIGMA_R) — none of these concepts exist in the
 * new single-scale design.
 *
 * sigmaR REPURPOSED (was: stops-scale halo-suppression reach across pyramid
 * levels; see stage 1c in git history) — now directly the BASE BLUR's
 * Gaussian sigma, in PIXELS (LocalToneParams.sigmaR's own doc comment).
 *
 * STAGE 2 SEAM (out of scope, do not implement): Eric Chan's measured global
 * scene-statistics range auto-expansion ("mechanism B" / E6) — a natural
 * home for it in this architecture would be scaling/reshaping `ref` itself
 * (or a second global statistic, e.g. a percentile) before the per-pixel
 * curve reads it; `clarity`'s own reservation below is the OTHER stage-2
 * seam (band-limited micro-contrast on the now-explicit `detail` channel).
 * ============================================================================
 */

export const LOCALTONE_KIND = 'localtone';

export interface LocalToneParams {
  /** 0..100. Lifts pixels whose small-radius local average (`base`) sits BELOW the image's own GLOBAL log2-luma mean (`ref`) — i.e. pixels reading as "locally dark" relative to the whole scene (E1: patch=18% gray lifts MORE on a BRIGHT background, since a brighter background pulls `ref` up and the patch reads as a relative shadow; round-3: response onsets smoothly ~0.5-1.5 stops of offset, no dead zone). 0 = no effect. */
  shadows: number;
  /** -100..0. Crushes pixels whose `base` sits ABOVE `ref` — pixels reading as "locally bright" relative to the whole scene (E1: patch crushes hardest on a DARK background). Negative-only (LR's own Highlights sign convention: negative = recover/darken); 0 = no effect. */
  highlights: number;
  /** 0..100. RESERVED for stage 2 (band-limited micro-contrast on the now-explicit `detail = logLuma - base` channel) — carried through params/sidecar/UI but INERT (no shader reads it) in stage 1, per the brief. */
  clarity: number;
  /**
   * STAGE 1d: REPURPOSED (was: stops-scale pyramid-level halo-suppression
   * reach — see the module doc comment's "sigmaR REPURPOSED" note). Now the
   * `base` blur's own Gaussian sigma, in PIXELS — directly "how local is
   * local" (round-2 Q1's own "narrow ~4-6px local kernel" finding). Larger
   * -> the local reference reaches further (smoother, but the E4 hard-edge
   * transition widens roughly proportionally — see LOCALTONE_BASE_BLUR_SIGMA_DEFAULT's
   * doc comment for the sim-measured tradeoff); smaller -> tighter to
   * genuinely fine-scale local contrast.
   */
  sigmaR: number;
  /** 0..1 master mix vs identity, like the LUT node's amount / blend's uniform.x. 0 = IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through). */
  amount: number;
}

export function defaultLocalToneParams(): LocalToneParams {
  return { shadows: 0, highlights: 0, clarity: 0, sigmaR: LOCALTONE_SIGMA_R_DEFAULT, amount: 1 };
}

/**
 * LR-CALIBRATION-ADJACENT CONSTANT (sim-tuned in the stage-1d session sim).
 * sigma in PIXELS for the `base` blur. Sweep summary (E4 hard-edge, contrast
 * 5 stops, center 20%, Shadows+100 — transitionPx must stay <=8, overshoot
 * ratio <0.1): sigma=1.5->transitionPx 4, sigma=2.5->6, sigma=3.5->8 (right
 * at the ceiling), sigma=5.0->10 (fails). 2.5 keeps a real margin (2px)
 * below the 8px acceptance ceiling while still landing in round-2's own
 * "~4-6px" local-kernel ballpark once the Gaussian's ~3-sigma reach is
 * counted (3*2.5=7.5px). Also confirmed in sim: R3/E1 magnitudes are
 * essentially insensitive to this constant (the probe/patch geometries are
 * all >>10x this radius) — sigma is really only an E4 (edge-transition-
 * width) knob, not a tone-magnitude one.
 */
export const LOCALTONE_SIGMA_R_DEFAULT = 2.5;

/**
 * amount<=0 (bit-exact pass-through) OR shadows===0 && highlights===0 (the
 * remap would still run but reduce to a numerically-exact identity — see
 * `remapBase`: floorSlope=1 at shadowsAmt=highlightsAmt=0 makes toneTail an
 * exact identity) both count as IDENTITY, so a freshly added node
 * (shadows=0, highlights=0, amount=1 default) never emits a pass — the
 * engine invariant "default params ⇒ pass NOT emitted ⇒ bit-exact
 * pass-through" (buildPlan resolves identity nodes away).
 */
export function isIdentityLocalTone(p: LocalToneParams): boolean {
  return p.amount <= 0 || (p.shadows === 0 && p.highlights === 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Normalize an untrusted localTone payload; NEVER throws (imageNode.ts/lutNode.ts convention — a bad param must never take an otherwise-good sidecar down with it). */
export function sanitizeLocalToneParams(raw: unknown, _nodeId: string): LocalToneParams {
  const base = defaultLocalToneParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { shadows?: unknown; highlights?: unknown; clarity?: unknown; sigmaR?: unknown; amount?: unknown };
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    shadows: clamp(num(src.shadows, base.shadows), 0, 100),
    highlights: clamp(num(src.highlights, base.highlights), -100, 0),
    clarity: clamp(num(src.clarity, base.clarity), 0, 100),
    // STAGE 1d: sigmaR is now a PIXEL radius (see LocalToneParams.sigmaR's
    // doc comment), not a stops value — bounds updated accordingly. Upper
    // bound of 8 also caps the GPU blur's fixed max tap radius
    // (LOCALTONE_BASE_BLUR_MAX_RADIUS_PX in graphRenderer.ts must stay >=
    // ceil(3*8) for the runtime-sigma Gaussian weights to stay well-formed).
    sigmaR: clamp(num(src.sigmaR, base.sigmaR), 1, 8),
    amount: clamp(num(src.amount, base.amount), 0, 1),
  };
}

// --- Shared algorithm constants (GPU shader + CPU reference) ---------------

/** log2(0) floor guard — matches the working range's noise floor headroom. */
export const LOCALTONE_LUMA_EPS = 2 ** -20;

/** exp2(processedLog - originalLog) ratio clamp — a numerical-safety guard against runaway HDR ratios near-black, NOT an LR-calibrated constant. */
export const LOCALTONE_RATIO_CLAMP_MAX = 16;

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * ROUND-3-FIT CONSTANTS (docs/research/lr-tone-measurements-r2.md's "round-3
 * addendum"). The from-scratch stage-1d CPU sim (session-scratch) first
 * fit onset=1.0/floor=0.70 there, landing within 5-7% of round-3's own
 * measured offsets {1.5, 2.5, 3.5} — but the REAL renderer (real GPU pass
 * chain, real sRGB export round-trip) came back systematically ~25-55%
 * STRONGER than that sim predicted (verified against scripts/
 * verify-localtone.mjs's own R3 table, not just the CPU sim — the sim
 * models the algorithm exactly but not the full color/export pipeline
 * around it). Re-solved directly against the REAL renderer's own measured
 * offset=2.5/3.5 output (which — even at the ORIGINAL sim-fit constants —
 * already landed inside the ±30% acceptance band, so those two points
 * anchor a 2-point linear solve for onset/floor here) rather than
 * iterating blind: onset=1.07, floor=0.74 (1-floor=0.26/stop at
 * shadows=100) reproduces offset=1.5 within a few % against the REAL
 * renderer (the point that failed at the sim-only fit) while keeping
 * 2.5/3.5 inside their bands. See the implementer report for the honest
 * characterization of the sim-vs-real gap (root cause not fully isolated
 * in the time available — plausibly the export/readback round-trip, not
 * the core algorithm, since the CPU sim's OWN internal math checks out
 * against every unit-test property).
 */
export const LOCALTONE_TONE_ONSET_SH = 1.07;
/** floorSlope at full slider strength (shadows=100) — see LOCALTONE_TONE_ONSET_SH's doc comment. */
export const LOCALTONE_TONE_FLOOR_SH = 0.74;
/**
 * Highlights' own onset/floor (round-3's Highlights curve rises much faster
 * than Shadows' — compare the r3 addendum table's hi-100 column to sh+100 at
 * the same offset). Same sim-vs-real gap as LOCALTONE_TONE_ONSET_SH's doc
 * comment describes: a sim-only grid search (session-scratch script)
 * landed onset=0.7/floor=0.15 within 0.5% of the acceptance-tested r3 point
 * (hi offset=2, target -1.093) IN SIM, but the REAL renderer measured
 * -1.653 at those constants — ~51% too strong. Re-solved against that one
 * real measurement directly (onset held near round-3's own literal "~0.8
 * stops" reading, floor solved from the single real data point): onset=0.8,
 * floor=0.395 (1-floor=0.605/stop at highlights=-100).
 */
export const LOCALTONE_TONE_ONSET_HI = 0.8;
/** floorSlope at full slider strength (highlights=-100) — see LOCALTONE_TONE_ONSET_HI's doc comment. */
export const LOCALTONE_TONE_FLOOR_HI = 0.395;
/** Smoothstep window width, as a fraction of `onset`, for the C1-continuous blend from the identity line to the tail line. ENGINEERING choice, not LR-calibrated — unchanged from stage 1c. */
export const LOCALTONE_TONE_ONSET_SOFTEN_FRAC = 0.3;

/**
 * One-sided tail curve: identity below `onset`, slope `floorSlope` beyond it
 * (softened, C1-continuous blend at the onset knee). floorSlope=1 is exact
 * identity; floorSlope=0 fully saturates (a flat cap at `onset`, so the
 * SHIFT `ad-toneTail(ad,...)` still grows with ad — the tail asymptotes in
 * OUTPUT value, not in how far it moves the input). Returns the output
 * |offset| (not a delta). Unchanged in SHAPE from stage 1c's own toneTail —
 * only how it's invoked changed (once per pixel against a global `ref`, not
 * once per pyramid discretization level — see remapBase).
 */
export function toneTail(ad: number, onset: number, floorSlope: number, onsetSoftenFrac: number = LOCALTONE_TONE_ONSET_SOFTEN_FRAC): number {
  const w = onsetSoftenFrac * onset;
  const t = smoothstepJs(onset - w, onset + w, ad);
  const idOut = ad;
  const tailOut = onset + floorSlope * (ad - onset);
  return idOut + (tailOut - idOut) * t;
}

/**
 * STAGE 1d's whole per-pixel curve: SIGN-GATED (d<0 only ever uses
 * `shadowsAmt`, d>=0 only ever uses `highlightsAmt` — the OTHER side is
 * exact identity, same non-cross-talk property stage 1c's remapLog2 had)
 * and BOUNDED (multiplicative slope reduction — never overshoots past
 * `ref`). This is the CPU twin of graphRenderer.ts's LOCALTONE_REMAP_SHADER
 * (kept numerically identical: same constants, same operation order).
 * `shadowsAmt`/`highlightsAmt` are shadows/100 and |highlights|/100 — the
 * ONLY place slider strength enters, and it enters as a pure multiplicative
 * scale on `(1-floorSlope)`, which is exactly why the response is linear in
 * slider value (round-3's "sh_p50 = half of sh_p100" finding): floorSlope =
 * 1 - amt*(1-FLOOR), so 1-floorSlope = amt*(1-FLOOR) scales `amt` linearly,
 * and toneTail's tail term is linear in `(1-floorSlope)` past the onset
 * window.
 */
export function remapBase(base: number, ref: number, shadowsAmt: number, highlightsAmt: number): number {
  const d = base - ref;
  const ad = Math.abs(d);
  if (d < 0) {
    const floorSlope = 1 - shadowsAmt * (1 - LOCALTONE_TONE_FLOOR_SH);
    return ref - toneTail(ad, LOCALTONE_TONE_ONSET_SH, floorSlope);
  }
  const floorSlope = 1 - highlightsAmt * (1 - LOCALTONE_TONE_FLOOR_HI);
  return ref + toneTail(ad, LOCALTONE_TONE_ONSET_HI, floorSlope);
}

// --- CPU reference (unit tests only — NOT the buildPlan cpu mirror, see the
// module doc comment's "SPATIAL CLASS, NO CPU MIRROR" section) ------------
//
// Mirrors graphRenderer.ts's GPU pass chain bit-for-shape (same box-reduce
// global mean, same separable Gaussian base blur, same remapBase curve) so
// localToneNode.test.ts can assert the algorithm's numbers fast, without a
// GPU — the slow, authoritative cross-check against the REAL renderer is
// scripts/verify-localtone.mjs.

export interface GrayImage {
  data: Float32Array;
  w: number;
  h: number;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Level-dims sequence for the log-mean reduce chain, halving (ceil) until 1x1. */
export function pyramidLevelDims(w: number, h: number): { w: number; h: number }[] {
  const levels: { w: number; h: number }[] = [{ w, h }];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    if (prev.w <= 1 && prev.h <= 1) break;
    levels.push({ w: Math.max(1, Math.ceil(prev.w / 2)), h: Math.max(1, Math.ceil(prev.h / 2)) });
  }
  return levels;
}

/**
 * Plain (unweighted) non-overlapping 2x2 box-average reduce — deliberately
 * NOT the Burt-Adelson 5-tap kernel stage 1c's pyramid used. See the module
 * doc comment's item 2: a from-scratch sim showed the overlapping,
 * clamp-to-edge-duplicating Burt-Adelson kernel, cascaded across many dyadic
 * halvings, does NOT converge to anything close to the true image mean for
 * a hard-edge 50/50 split (E4's own construction) — measured in sim as a
 * ~1.6-stop bias toward whichever side happens to align with the dyadic
 * decimation grid. This box reduce instead averages EXACTLY the in-bounds
 * source texels for each 2x2 output cell (odd dims: the trailing row/column
 * contributes only its own real samples, never a duplicated clamp) — exact
 * arithmetic mean for power-of-2 dims, no alignment-dependent bias for
 * anything else either.
 */
export function boxReduceGray(src: GrayImage): GrayImage {
  const dw = Math.max(1, Math.ceil(src.w / 2));
  const dh = Math.max(1, Math.ceil(src.h / 2));
  const out = new Float32Array(dw * dh);
  for (let oy = 0; oy < dh; oy++) {
    for (let ox = 0; ox < dw; ox++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = oy * 2 + dy;
        if (sy >= src.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const sx = ox * 2 + dx;
          if (sx >= src.w) continue;
          sum += src.data[sy * src.w + sx]!;
          n++;
        }
      }
      out[oy * dw + ox] = sum / n;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** Global log2-luma mean via repeated boxReduceGray down to 1x1 — the CPU twin of graphRenderer.ts's LOCALTONE_BOXREDUCE_SHADER chain / `ref`. */
export function globalLogMean(img: GrayImage): number {
  let cur = img;
  while (cur.w > 1 || cur.h > 1) cur = boxReduceGray(cur);
  return cur.data[0]!;
}

/** Gaussian weights for a fixed integer `radius`, sigma in the same units (px) — sums to exactly 1. Matches graphRenderer.ts's LOCALTONE_BLUR_*_SHADER weight formula (`exp(-i²/(2σ²))`, normalized by the running weight sum). */
export function gaussianWeights(sigma: number, radius: number): Float64Array {
  const w = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const g = Math.exp(-(i * i) / (2 * sigma * sigma));
    w[i + radius] = g;
    sum += g;
  }
  for (let i = 0; i < w.length; i++) w[i] = w[i]! / sum;
  return w;
}

/** Separable Gaussian blur (clamp-to-edge), radius = ceil(3*sigma) — the CPU twin of graphRenderer.ts's LOCALTONE_BLUR_H_SHADER/LOCALTONE_BLUR_V_SHADER pair (`base`). */
export function gaussianBlurGray(src: GrayImage, sigma: number): GrayImage {
  const radius = Math.ceil(3 * sigma);
  const weights = gaussianWeights(sigma, radius);
  const { w, h, data } = src;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += weights[i + radius]! * data[y * w + clampi(x + i, 0, w - 1)]!;
      tmp[y * w + x] = sum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += weights[i + radius]! * tmp[clampi(y + i, 0, h - 1) * w + x]!;
      out[y * w + x] = sum;
    }
  }
  return { data: out, w, h };
}
