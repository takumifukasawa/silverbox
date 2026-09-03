/**
 * Local-adaptive tone node (docs/research/local-adaptive-tone.md,
 * docs/research/lr-tone-measurements.md / -r2.md / -r2.md's round-3
 * addendum): a Fast Local Laplacian Filter (Aubry/Paris/Hasinoff/Kautz/
 * Durand 2014, MIT-licensed algorithm — implemented from the published
 * papers, no GPL/GPL-adjacent source read or copied) operating on
 * WORKING_LUMA log2 luminance only, restoring color by the RATIO method
 * (research doc §1.2 'lum'): process log2(luma), then scale the ORIGINAL
 * rgb by 2^(processedLog - originalLog) so hue/chroma ratios are preserved
 * exactly (Ir/Ii, Ig/Ii, Ib/Ii unchanged).
 *
 * Doc-shape module only (params/sanitizer/CPU pyramid reference used by unit
 * tests), same split as denoiseNode.ts/lutNode.ts — the actual GPU pyramid
 * (many small fragment passes over r32float textures at shrinking
 * resolutions) lives in graphRenderer.ts, since it needs per-level render
 * targets the generic 'passes' one-texture-per-step pipeline can't express.
 *
 * SPATIAL CLASS, NO CPU MIRROR (same exemption as Detail/fx-spatial in
 * developNode.ts, and 'external'/'denoise'/'image' steps in graphDoc.ts): a
 * Laplacian pyramid's coefficients depend on the WHOLE image, not a
 * per-pixel neighborhood a JS reference could feasibly mirror. buildPlan
 * emits PlanStep 'localtone' with no `cpu` field; cpuEvalPlan/
 * stepHasCpuMirror/stripNoCpuMirrorSteps treat it exactly like 'external'/
 * 'denoise' (see graphDoc.ts).
 *
 * STAGE 1 SCOPE (docs/research/local-adaptive-tone.md §7's route (b)):
 * per-pixel/local remap only. Eric Chan's measured global scene-statistics
 * range auto-expansion ("mechanism B" / E6) stays OUT OF SCOPE — round-3's
 * own finding (see STAGE 1c below) is that a pure local operator already
 * retro-predicts E1 without it.
 *
 * STAGE 1b (superseded by 1c below — kept for history): keyed the tail
 * compression β to the discretization level gammaJ (bright gammaJ ->
 * shadows, dark gammaJ -> highlights, INVERTED vs the naive mapping),
 * SYMMETRIC in offset at every level (both tails compressed together).
 * Reproduced E1's sign structure only partially and never cleared E4.
 *
 * STAGE 1c (this revision — docs/research/lr-tone-measurements-r2.md's
 * "round-3 addendum"): round-3 measured LR's patch-vs-surround response
 * DIRECTLY as a function of signed log2 offset and found NO dead zone —
 * response onsets smoothly around 0.5-1.5 stops and grows quasi-linearly
 * well past stage-1b's σr=4 "identity zone", which the addendum shows was
 * only ever an E4 overshoot/halo knee, not a tone-response threshold. Two
 * structural changes from stage 1b, both confirmed by a from-scratch CPU
 * Fast-LLF simulator (this repo's own math; see the implementer report for
 * the sim harness and full sweep — not committed here, ephemeral tuning
 * scratch):
 *
 * 1. SIGN-GATED, not symmetric: shadows now compresses ONLY the d<0 tail
 *    (offset below the level's own gammaJ reference), highlights ONLY the
 *    d>0 tail — the OTHER side is exact identity at that level. This is
 *    what stage 1's own original (and rejected) sign-of-offset design
 *    tried; the fix vs stage 1's cross-talk failure is combining it with
 *    stage-1b's INVERTED LEVEL-KEYING (kept — see levelAmounts below) so
 *    shadows still engages at bright gammaJ / highlights at dark gammaJ,
 *    per this module's earlier mechanistic finding (a small patch's
 *    tent-weighted reconstruction draws coarse-level weight toward the
 *    SURROUND's own value, so "shadows lifts a dark patch on a bright
 *    surround" needs bright gammaJ to carry the shadows term).
 * 2. BOUNDED (multiplicative slope), not additive: remapLog2's tail is a
 *    SLOPE reduction (`onset + floorSlope*(ad-onset)`, floorSlope in
 *    [LOCALTONE_TONE_FLOOR, 1]) exactly like stage 1b's beta-tail shape —
 *    NOT `d - amount*C(ad)` for an unbounded, growing-with-offset C (the
 *    sim's first attempt at this literally overshot PAST gamma itself by
 *    multiple stops for large offsets — see the report). The bounded form
 *    can only ever compress a tail toward a flat asymptote at `onset`
 *    stops from gamma, never past it.
 *
 * A THIRD, separate mechanism was needed once (1)+(2) were sim-verified
 * against round-3's offset curves: a per-PYRAMID-LEVEL-INDEX halo
 * suppression (levelDamp below), independent of gammaJ/log2-offset space
 * entirely. The sim showed that even a perfectly bounded, sign-gated
 * remap still injects a large (~1+ stop), K-independent overshoot right at
 * a hard edge, because the shared multi-scale Laplacian pyramid's COARSE
 * levels give a small isolated patch (r3's own probe geometry) and a
 * large-area hard edge (E4's) very different effective gain — full pyramid
 * depth is exactly what lr-tone-measurements-r2.md's Q1 finding says real
 * LR does NOT do for its near-edge response ("a narrow ~4-6px local
 * kernel", not smoothly-decaying multi-scale support). levelDamp fades the
 * remap's contribution toward the UNTOUCHED input's own Laplacian pyramid
 * (not toward zero — this preserves the tent weights' partition-of-unity
 * reconstruction exactly) as the pyramid level index grows, so only the
 * finest few levels carry real local response — this is the "separate
 * halo-suppression term" the brief flagged as a fallback for σr once it
 * became clear round-3's tone-response onset and σr's E4 halo knee are
 * different constants, not the same one; σr keeps its established
 * user-facing meaning (a stops-scale "how far the local effect reaches")
 * by now parameterizing levelDamp's own reach instead of the tone curve's
 * shape — see levelDamp's own doc comment.
 */

export const LOCALTONE_KIND = 'localtone';

export interface LocalToneParams {
  /** 0..100. Lifts pixels whose log2-luma sits BELOW their local (per-pyramid-level) coarse reference — i.e. pixels that read as "locally dark" relative to their surround (E1: patch=18% gray lifts MORE on a BRIGHT background, since the coarse reference there is bright and the patch reads as a relative shadow; round-3: response onsets smoothly ~0.5-1.5 stops of offset below the reference, no dead zone). 0 = no effect. */
  shadows: number;
  /** -100..0. Crushes pixels whose log2-luma sits ABOVE their local coarse reference — pixels reading as "locally bright" (E1: patch crushes hardest on a DARK background). Negative-only (LR's own Highlights sign convention: negative = recover/darken); 0 = no effect. */
  highlights: number;
  /** 0..100. RESERVED for stage 2 (band-limited micro-contrast on the near-reference detail zone) — carried through params/sidecar/UI but INERT (no shader reads it) in stage 1, per the brief. */
  clarity: number;
  /**
   * Stops (log2). STAGE 1c: no longer the tone curve's own onset/knee (that
   * dead-zone formulation was round-3's key negative finding — see the
   * module doc comment) — sigmaR now scales levelDamp's HALO-SUPPRESSION
   * reach: how many of the shared Laplacian pyramid's coarse levels are
   * allowed to carry local-tone response before it's faded back to the
   * untouched input (round-2 Q1's "narrow local kernel, not full-pyramid
   * support" finding). Larger sigmaR -> the effect reaches coarser
   * (larger-radius) pyramid levels -> stronger but more halo-prone; smaller
   * -> tighter to genuinely fine detail. See levelDamp below.
   *
   * LR-CALIBRATION CONSTANT (docs/research/lr-tone-measurements-r2.md, Q2):
   * the E4 overshoot-ratio knee (round-2, 21px-boxcar-smoothed, {contrast,
   * s16} sweep) still locates **σr = 4.0 stops, bracket [3.5, 4.2]**
   * (25%-RSS piecewise-linear breakpoint fit) — round-3 clarified WHAT that
   * knee governs (halo reach, not tone onset), not that the number itself
   * was wrong.
   */
  sigmaR: number;
  /** 0..1 master mix vs identity, like the LUT node's amount / blend's uniform.x. 0 = IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through). */
  amount: number;
}

export function defaultLocalToneParams(): LocalToneParams {
  return { shadows: 0, highlights: 0, clarity: 0, sigmaR: LOCALTONE_SIGMA_R_DEFAULT, amount: 1 };
}

/** LR-CALIBRATION CONSTANT — see LocalToneParams.sigmaR's doc comment. */
export const LOCALTONE_SIGMA_R_DEFAULT = 4.0;

/**
 * amount<=0 (bit-exact pass-through) OR shadows===0 && highlights===0 (the
 * pyramid would still run but reduce to a near-identity — see the module doc
 * comment's numerical-identity note) both count as IDENTITY, so a freshly
 * added node (shadows=0, highlights=0, amount=1 default) never emits a pass
 * — the engine invariant "default params ⇒ pass NOT emitted ⇒ bit-exact
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
    // Floor > 0 avoids a degenerate zero-width detail zone; ceiling is a
    // generous headroom over the calibrated bracket, not itself calibrated.
    sigmaR: clamp(num(src.sigmaR, base.sigmaR), 0.5, 10),
    amount: clamp(num(src.amount, base.amount), 0, 1),
  };
}

// --- Shared discretization/algorithm constants (GPU shader + CPU reference) -

/**
 * K discretization levels (Fast LLF's "sample the luminance range at K fixed
 * references, tent-interpolate per pixel/per level" trick — research doc
 * §1.3/§4.4 item 3). STAGE 1c: raised from 8-16-ish (stage 1/1b's 12) to 24
 * — an ENGINEERING change (quality/perf tradeoff, not LR-calibrated) forced
 * by round-3's own curve shape: the CPU Fast-LLF simulator built to fit the
 * new onset+slope tone curve showed a visible non-monotonic RIPPLE in the
 * offset-response curve at K=12 (the curve has more second-derivative
 * curvature near its onset than stage 1b's wide, gentle sigmaR=4 knee did,
 * so the same K under-samples it — the paper's own "sample at the
 * function's bandwidth" caveat) that smoothed out and became monotonic by
 * K=24 (confirmed in sim: K=12/20/30 all tried, ripple gone by ~24). Doubles
 * the per-discretization-level pass count (buildLocalTonePasses), a real
 * perf cost — see the implementer report's perf spot-check.
 */
export const LOCALTONE_K_LEVELS = 24;

/**
 * Fixed log2-luma discretization span (stops) the K references sample across
 * — NOT dynamically fit to each image's actual histogram (that adaptive
 * range-fitting is exactly Eric Chan's "mechanism B" / E6's global-statistics
 * layer, explicitly out of stage-1 scope). Generous fixed bounds covering
 * RAW scene-referred linear data from the noise floor to several stops of
 * highlight headroom.
 */
export const LOCALTONE_LOG2_LO = -20;
export const LOCALTONE_LOG2_HI = 4;

/** log2(luma) floor to avoid log2(0) — matches LOCALTONE_LOG2_LO (2^-20). */
export const LOCALTONE_LUMA_EPS = 2 ** LOCALTONE_LOG2_LO;

/** exp2(processedLog - originalLog) ratio clamp — a numerical-safety guard against runaway HDR ratios near-black, NOT an LR-calibrated constant. */
export const LOCALTONE_RATIO_CLAMP_MAX = 16;

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * ROUND-3-FIT CONSTANTS (docs/research/lr-tone-measurements-r2.md's "round-3
 * addendum"): the per-level tail's onset (stops of |d| before compression
 * starts) and FLOOR slope (the most-compressed asymptotic slope, at
 * shadows=100/highlights=-100). These are PER-LEVEL/PER-DISCRETIZATION-STEP
 * constants, fit via a from-scratch CPU Fast-LLF simulator (not committed —
 * ephemeral tuning scratch, see the implementer report) against round-3's
 * END-TO-END patch-response curves — the sim showed the mapping from
 * per-level onset/slope to the ACCUMULATED, multi-scale response is NOT
 * 1:1 (tent-interpolation across K levels and levelDamp's own damping both
 * dilute per-level magnitude), so these are NOT the same numbers as
 * round-3's measured onset/slope (~1.0 stops / 0.30 per stop for Shadows,
 * ~0.8 stops / 0.55 per stop for Highlights) — they're LARGER (see the
 * implementer report's honest characterization): the from-scratch sim,
 * cross-checked against the REAL production functions (not just a toy
 * simulator), found a HARD structural conflict once a small (~round-3-
 * sized) onset was tried — an onset small enough to give round-3's
 * offsets 1.5-3.5 any real magnitude ALSO opens a wrong-signed leakage
 * channel at E1's far, unrelated backgrounds (measured on the real
 * 1024px geometry: onset=0.15 → E1 bg=0.5% Shadows delta swings to
 * roughly -1 to -2 stops, wrong sign and an order of magnitude past the
 * tolerance, growing WORSE, not better, with more level-damping headroom
 * or a gentler floor). 1.5/0.75 is the best-characterized compromise
 * found in the time available: it keeps the E1 far-background leakage in
 * the same ballpark stage 1b's own (also-imperfect, but bounded) design
 * showed, at the cost of only partially reproducing round-3's magnitude
 * (shows the right SHAPE — monotonic growth with offset — at a fraction
 * of the measured amplitude). See the implementer report for the full
 * sweep table and the honest characterization of what remains unreached.
 */
export const LOCALTONE_TONE_ONSET = 1.5;
/** floorSlope at full slider strength (shadows=100 / highlights=-100) — matches stage 1b's own LOCALTONE_BETA_FLOOR value; a more aggressive (smaller) floor was swept and measurably WORSENS the E1 far-background leakage described above without proportionally helping round-3's magnitude. */
export const LOCALTONE_TONE_FLOOR = 0.75;
/** Smoothstep window width, as a fraction of `onset`, for the C1-continuous blend from the identity line to the tail line — same technique as stage 1b's LOCALTONE_KNEE_SOFTEN_FRAC, just renamed/rescaled since the knee now sits at the (much smaller) onset, not sigmaR. ENGINEERING choice, not LR-calibrated. */
export const LOCALTONE_TONE_ONSET_SOFTEN_FRAC = 0.3;

/**
 * One-sided tail curve: identity below `onset`, slope `floorSlope` beyond
 * it (softened, C1-continuous blend at the onset knee — same shape as
 * stage 1b's remapLog2 tail, just parameterized by a small onset instead
 * of sigmaR). floorSlope=1 is exact identity; floorSlope=0 fully saturates
 * (a flat cap at `onset`, so the SHIFT `ad-toneTail(ad,...)` still grows
 * with ad — the tail asymptotes in OUTPUT value, not in how far it moves
 * the input). Returns the output |offset| (not a delta).
 */
export function toneTail(ad: number, onset: number, floorSlope: number, onsetSoftenFrac: number = LOCALTONE_TONE_ONSET_SOFTEN_FRAC): number {
  const w = onsetSoftenFrac * onset;
  const t = smoothstepJs(onset - w, onset + w, ad);
  const idOut = ad;
  const tailOut = onset + floorSlope * (ad - onset);
  return idOut + (tailOut - idOut) * t;
}

/**
 * Per-level remap curve — STAGE 1c redesign (see the module doc comment's
 * item 1+2): SIGN-GATED (not symmetric) and BOUNDED (multiplicative slope,
 * not additive). d<0 (x below gamma) only ever compresses via `sAmt`
 * (shadows' level weight); d>=0 only ever compresses via `hAmt`
 * (highlights'). This is the CPU twin of graphRenderer.ts's
 * LOCALTONE_REMAP_SHADER — kept numerically identical (same constants,
 * same operation order) even though this spatial op has no per-pixel CPU
 * MIRROR requirement (the shared shape is what localToneNode.test.ts's
 * unit tests exercise). `sAmt`/`hAmt` (both 0..1) are computed CPU-side per
 * discretization level by levelAmounts — remapLog2 itself is agnostic to
 * WHICH level it's being called for.
 */
export function remapLog2(x: number, gamma: number, sAmt: number, hAmt: number): number {
  const d = x - gamma;
  const ad = Math.abs(d);
  if (d < 0) {
    const floorSlope = 1 - sAmt * (1 - LOCALTONE_TONE_FLOOR);
    return gamma - toneTail(ad, LOCALTONE_TONE_ONSET, floorSlope);
  }
  const floorSlope = 1 - hAmt * (1 - LOCALTONE_TONE_FLOOR);
  return gamma + toneTail(ad, LOCALTONE_TONE_ONSET, floorSlope);
}

/**
 * LR-CALIBRATION-ADJACENT CONSTANT (STAGE 1b, KEPT in 1c — round-3's own
 * curve retro-predicts E1 using this same inverted level-keying, so the
 * brief's "keep unless the sim says otherwise" held): the log2-luma value
 * levelAmounts' smooth shadows<->highlights transition is CENTERED on —
 * "18% gray", the same self-colored reference E1's own headline table
 * zeroes out at (patch==background==18% -> exactly 0.000 stops for both
 * sliders).
 */
export const LOCALTONE_LEVEL_MID_LOG2 = Math.log2(0.18);

/** ENGINEERING CONSTANT (STAGE 1b, KEPT in 1c, NOT LR-calibrated): width, in stops, of the smooth shadows<->highlights blend across LOCALTONE_LEVEL_MID_LOG2 — see levelAmounts. Unchanged from stage 1b (24 stops, spanning the full working range) — the sim's stage-1c tuning focused on the tone curve and levelDamp, and re-sweeping this jointly was out of scope; see the implementer report. */
export const LOCALTONE_LEVEL_TRANSITION_STOPS = 24;

/**
 * levelAmounts: the discretization level gammaJ's OWN shadows/highlights
 * ENGAGEMENT WEIGHTS (STAGE 1c rename of stage 1b's betaForLevel — same
 * inverted level-keying, kept per the module doc comment: bright gammaJ ->
 * shadows engages (sAmt), dark gammaJ -> highlights engages (hAmt),
 * smoothly tent-blended across LOCALTONE_LEVEL_MID_LOG2). Mechanistic
 * reason (confirmed in stage 1b's own sim, still holds): for a small patch
 * embedded in a large background, the Fast-LLF tent-weighted
 * reconstruction at COARSE pyramid levels (where the patch/background
 * Laplacian edge energy actually concentrates) draws its gammaJ weight
 * from the SURROUND's own value, not the patch's — so a BRIGHT surround
 * pulls reconstruction weight toward BRIGHT gammaJ levels, meaning Shadows
 * (which should lift a patch reading "locally dark against a bright
 * surround," LR's own strongest E1 signal) needs the BRIGHT gammaJ levels
 * to carry its weight. Unlike stage 1b's betaForLevel (one shared,
 * symmetric beta per level), this returns TWO independent weights — see
 * remapLog2's sign-gating above, which uses sAmt only for d<0 and hAmt
 * only for d>=0 at the SAME level (both can be simultaneously nonzero in
 * the transition band, each acting on its own side).
 */
export function levelAmounts(gammaJ: number, shadows: number, highlights: number): { sAmt: number; hAmt: number } {
  const half = LOCALTONE_LEVEL_TRANSITION_STOPS / 2;
  const w = smoothstepJs(LOCALTONE_LEVEL_MID_LOG2 - half, LOCALTONE_LEVEL_MID_LOG2 + half, gammaJ); // 1 = deep bright (shadows), 0 = deep dark (highlights)
  return { sAmt: (shadows / 100) * w, hAmt: (Math.abs(highlights) / 100) * (1 - w) };
}

/**
 * STAGE 1c NEW MECHANISM — halo suppression by PYRAMID LEVEL INDEX (0 =
 * finest), independent of gammaJ/log2-offset space entirely (see the
 * module doc comment's third item). Fine levels (< LOCALTONE_HALO_DAMP_START_LEVEL)
 * get full strength; the multiplier fades to 0 by
 * `LOCALTONE_HALO_DAMP_START_LEVEL + sigmaR * LOCALTONE_HALO_LEVELS_PER_SIGMA_R`,
 * so σr now controls how many COARSE levels the local-tone response is
 * allowed to reach (round-2 Q1's "narrow local kernel", not full-pyramid
 * support) rather than the tone curve's own onset — see LocalToneParams.sigmaR's
 * doc comment. Applied by BLENDING the remapped level's Laplacian
 * contribution toward the UNTOUCHED input's own Laplacian at that level
 * (graphRenderer.ts's accumulate passes), not toward zero, so the tent
 * weights' partition-of-unity property is preserved exactly — a fully
 * damped level reconstructs the ORIGINAL input exactly, not a black/zero
 * level (verified in the CPU sim: identity holds exactly at every damping
 * setting). ENGINEERING CONSTANTS (start level, levels-per-sigmaR — both
 * CPU-sim-tuned against round-3's curves AND the E4 hard-edge overshoot
 * together, not independently LR-calibrated): a from-scratch sim showed a
 * genuine, K-independent, ~1+ stop overshoot survives right at a hard edge
 * even with a perfectly bounded, sign-gated remapLog2 — this is the SAME
 * root cause round-2 Q1 flagged for real LR (full multi-scale support vs.
 * LR's own narrow ~4-6px kernel) — and damping the coarse levels is what
 * brings the FAR-FIELD plateaus back to flat/near-zero (verified in sim);
 * the near-edge overshoot itself did not clear the brief's <0.1 ratio bar
 * at any swept setting.
 *
 * HONEST CHARACTERIZATION (found on the REAL production functions, not
 * just the toy simulator — see the implementer report): the useful window
 * between "damped enough to matter" and "damped enough to reintroduce E1's
 * far-background leakage" turned out to be extremely NARROW and unstable
 * (level-index deltas well under 1 flip the sign at E1's dark
 * backgrounds), not the clean, gradual dial the sim's earlier, smaller
 * synthetic tests suggested. Given the remaining time, LOCALTONE_TONE_ONSET/
 * FLOOR above were retuned to be safe WITHOUT relying on damping at all,
 * and these two constants are set to keep levelDamp effectively INERT at
 * the default sigmaR (dampEnd = 2 + 4*5 = 22, past any real image's level
 * count ~11) — the mechanism (and its wiring through
 * graphRenderer.ts's accumulate passes) is real and exercised by the unit
 * tests, but is not presently load-bearing for the shipped default. A
 * smaller sigmaR still engages it (dampEnd shrinks proportionally), so the
 * user-facing slider remains meaningful, just unexplored territory this
 * revision didn't have time to responsibly tune.
 */
export const LOCALTONE_HALO_DAMP_START_LEVEL = 2;
/** See LOCALTONE_HALO_DAMP_START_LEVEL's doc comment. */
export const LOCALTONE_HALO_LEVELS_PER_SIGMA_R = 5.0;

/** levelDamp: the [0,1] multiplier levelAmounts' Laplacian contribution is scaled by at pyramid level `levelIndex`, for a given `sigmaR` — see LOCALTONE_HALO_DAMP_START_LEVEL's doc comment. */
export function levelDamp(levelIndex: number, sigmaR: number): number {
  const end = LOCALTONE_HALO_DAMP_START_LEVEL + sigmaR * LOCALTONE_HALO_LEVELS_PER_SIGMA_R;
  return 1 - smoothstepJs(LOCALTONE_HALO_DAMP_START_LEVEL, end, levelIndex);
}

/** Tent (triangle) interpolation weight for discretization reference `gammaJ`, spacing `step` — the Fast LLF blend weight (research doc §1.3). Zero outside [gammaJ-step, gammaJ+step]; weights across consecutive references sum to exactly 1 for any g inside [LOCALTONE_LOG2_LO, LOCALTONE_LOG2_HI]. */
export function tentWeight(g: number, gammaJ: number, step: number): number {
  return Math.max(0, 1 - Math.abs(g - gammaJ) / step);
}

/** The K discretization reference values gamma_0..gamma_{K-1}, evenly spaced across [LOCALTONE_LOG2_LO, LOCALTONE_LOG2_HI]. */
export function discretizationLevels(k: number = LOCALTONE_K_LEVELS): number[] {
  const step = (LOCALTONE_LOG2_HI - LOCALTONE_LOG2_LO) / (k - 1);
  return Array.from({ length: k }, (_, j) => LOCALTONE_LOG2_LO + j * step);
}

// --- CPU pyramid reference (unit tests only — collapse(build(x)) ≈ x mandate,
// docs/research/local-adaptive-tone.md §4.3) -----------------------------
//
// This is a tiny, deliberately non-optimized reference of the SAME
// Burt-Adelson 5-tap kernel graphRenderer.ts's REDUCE_SHADER/
// EXPAND-and-combine shader use, operating on a flat Float32Array + (w,h) —
// used ONLY by localToneNode.test.ts to prove the reduce/expand pyramid
// construction itself round-trips within the doc's mandated 1e-3 tolerance.
// This is NOT a per-pixel CPU mirror of the GPU node (see the module doc
// comment's "spatial class, no CPU mirror" section) — the node has no
// buildPlan `cpu` callback at all.

/** Burt-Adelson 5-tap kernel (research doc §1.2/§4.3: "ピラミッドは Burt–Adelson 5×5 カーネル"), normalized to sum 1. */
export const PYRAMID_KERNEL_5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export interface GrayImage {
  data: Float32Array;
  w: number;
  h: number;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** REDUCE: 5x5 (separable-equivalent, applied as a 2D outer product for a single non-separable pass — see graphRenderer.ts's REDUCE_SHADER doc comment for why) blur + decimate by 2, clamp-to-edge. Matches the GPU kernel exactly. */
export function reduceGray(src: GrayImage): GrayImage {
  const dw = Math.max(1, Math.ceil(src.w / 2));
  const dh = Math.max(1, Math.ceil(src.h / 2));
  const out = new Float32Array(dw * dh);
  for (let oy = 0; oy < dh; oy++) {
    for (let ox = 0; ox < dw; ox++) {
      let sum = 0;
      const cx = ox * 2;
      const cy = oy * 2;
      for (let dy = -2; dy <= 2; dy++) {
        const sy = clampi(cy + dy, 0, src.h - 1);
        const ky = PYRAMID_KERNEL_5[dy + 2]!;
        for (let dx = -2; dx <= 2; dx++) {
          const sx = clampi(cx + dx, 0, src.w - 1);
          sum += PYRAMID_KERNEL_5[dx + 2]! * ky * src.data[sy * src.w + sx]!;
        }
      }
      out[oy * dw + ox] = sum;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** EXPAND: upsample `coarse` to exactly (dstW, dstH) via the interpolating Burt-Adelson filter (same kernel as reduceGray, energy-normalized x4) — matches graphRenderer.ts's expand-and-combine shader's expand() term exactly. */
export function expandGray(coarse: GrayImage, dstW: number, dstH: number): GrayImage {
  const out = new Float32Array(dstW * dstH);
  for (let oy = 0; oy < dstH; oy++) {
    for (let ox = 0; ox < dstW; ox++) {
      let sum = 0;
      for (let m = -2; m <= 2; m++) {
        const oxm = ox - m;
        if ((oxm & 1) !== 0) continue;
        const cxr = oxm / 2;
        const cx = clampi(cxr, 0, coarse.w - 1);
        const km = PYRAMID_KERNEL_5[m + 2]!;
        for (let n = -2; n <= 2; n++) {
          const oyn = oy - n;
          if ((oyn & 1) !== 0) continue;
          const cyr = oyn / 2;
          const cy = clampi(cyr, 0, coarse.h - 1);
          sum += km * PYRAMID_KERNEL_5[n + 2]! * coarse.data[cy * coarse.w + cx]!;
        }
      }
      out[oy * dstW + ox] = 4 * sum;
    }
  }
  return { data: out, w: dstW, h: dstH };
}

/** Full-depth level-dims sequence, halving (ceil) until 1x1 — same formula graphRenderer.ts's pyramid setup uses (research doc §4.4 item 4: "H/S用途ではピラミッドを最上位まで構築する"). */
export function pyramidLevelDims(w: number, h: number): { w: number; h: number }[] {
  const levels: { w: number; h: number }[] = [{ w, h }];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    if (prev.w <= 1 && prev.h <= 1) break;
    levels.push({ w: Math.max(1, Math.ceil(prev.w / 2)), h: Math.max(1, Math.ceil(prev.h / 2)) });
  }
  return levels;
}

/** Build a full-depth Gaussian pyramid (level 0 = `img` itself). */
export function buildGaussianPyramid(img: GrayImage): GrayImage[] {
  const levels: GrayImage[] = [img];
  let cur = img;
  while (cur.w > 1 || cur.h > 1) {
    cur = reduceGray(cur);
    levels.push(cur);
  }
  return levels;
}

/** Build the matching Laplacian pyramid: L[l] = G[l] - expand(G[l+1]) for l < top, L[top] = G[top] (standard Burt-Adelson convention — the residual/DC level needs no further transform). */
export function buildLaplacianPyramid(gaussian: GrayImage[]): GrayImage[] {
  const n = gaussian.length;
  const laplacian: GrayImage[] = [];
  for (let l = 0; l < n - 1; l++) {
    const fine = gaussian[l]!;
    const expanded = expandGray(gaussian[l + 1]!, fine.w, fine.h);
    const data = new Float32Array(fine.w * fine.h);
    for (let i = 0; i < data.length; i++) data[i] = fine.data[i]! - expanded.data[i]!;
    laplacian.push({ data, w: fine.w, h: fine.h });
  }
  laplacian.push(gaussian[n - 1]!);
  return laplacian;
}

/** Reconstruct the full-res image from a Laplacian pyramid: recon[top] = L[top], recon[l] = L[l] + expand(recon[l+1]). collapseLaplacianPyramid(buildLaplacianPyramid(buildGaussianPyramid(x))) ≈ x is the doc-mandated unit test (§4.3). */
export function collapseLaplacianPyramid(laplacian: GrayImage[]): GrayImage {
  let recon = laplacian[laplacian.length - 1]!;
  for (let l = laplacian.length - 2; l >= 0; l--) {
    const lvl = laplacian[l]!;
    const expanded = expandGray(recon, lvl.w, lvl.h);
    const data = new Float32Array(lvl.w * lvl.h);
    for (let i = 0; i < data.length; i++) data[i] = lvl.data[i]! + expanded.data[i]!;
    recon = { data, w: lvl.w, h: lvl.h };
  }
  return recon;
}
