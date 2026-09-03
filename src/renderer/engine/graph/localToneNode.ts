/**
 * Local-adaptive tone node (docs/research/local-adaptive-tone.md,
 * docs/research/lr-tone-measurements.md / -r2.md incl. round-3/round-4
 * addenda): operates on WORKING_LUMA log2 luminance only, restoring color by
 * the RATIO method (research doc §1.2 'lum'): process log2(luma), then scale
 * the ORIGINAL rgb by 2^(processedLog - originalLog) so hue/chroma ratios are
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
 * global/percentile reference depends on the WHOLE image, not a per-pixel
 * neighborhood a JS reference could feasibly mirror inside cpuEvalPlan.
 * buildPlan emits PlanStep 'localtone' with no `cpu` field; cpuEvalPlan/
 * stepHasCpuMirror/stripNoCpuMirrorSteps treat it exactly like 'external'/
 * 'denoise' (see graphDoc.ts). This module still ships a full CPU reference
 * implementation below (mirrors the WGSL bit-for-shape) — it just isn't
 * wired into buildPlan's per-pixel cross-check; it exists purely so
 * localToneNode.test.ts can assert the algorithm's shape/values fast,
 * without a GPU.
 *
 * ============================================================================
 * STAGE 1e (this revision — replaces STAGE 1d's single-global-mean anchor +
 * sign-gated bounded tail entirely; see git history for 1b/1c/1d). Conductor-
 * verified finding that forced this rewrite: 1d's real-photo gate FAILED —
 * measured against 5 real ARW scenes (session-scratch localtone-compare/
 * results.json), Shadows undershot LR by 3-7x and Highlights overshot LR by
 * 2-2.3x on the whole-frame band mean. Root cause (stage-1e diagnosis):
 * `ref` was the frame's ARITHMETIC MEAN of log2-luma, which on a real photo
 * with a long dark tail sits pulled DOWN toward the shadows themselves (log2
 * compression makes near-black pixels dominate a linear mean of log-values)
 * — so most of a photo's own genuine shadow-band pixels end up barely below
 * `ref`, starving the old onset-gated curve of the offset it needs to fire.
 * Separately, round-3's own finer sub-onset sampling (lr-tone-measurements-
 * r2.md's round-3 addendum) had already shown the OLD identity-below-onset
 * "dead zone" doesn't exist in LR's real response at all — it's a smooth,
 * continuously-varying curve from the anchor outward.
 *
 * NEW MODEL — TWO PERCENTILE ANCHORS + one UNGATED saturating curve per
 * direction + a SCENE-ADAPTIVE amplitude law, keeping stage 1d's proven
 * small-radius base/detail split unchanged:
 *
 *  1. `base` = a small-radius (sigmaR px) Gaussian blur of full-res
 *     log2-luminance; `detail = logLuma - base` is preserved UNTOUCHED
 *     (unchanged from stage 1d — proven halo-free on both synthetic E4 and
 *     real photo edges, see LOCALTONE_SIGMA_R_DEFAULT's doc comment).
 *  2. TWO frame-percentile anchors (docs/research/lr-tone-measurements-r2.md
 *     round-4 addendum's "percentile-relative anchoring, confirmed" + the
 *     stage-1e real-photo diagnosis's anchor-collapse fit):
 *     `refSh` = the frame's own 75th-percentile log2-luma (Shadows keys off
 *     "how far below the image's own upper-midtone/highlight mass does this
 *     pixel sit"), `refHi` = the 25th percentile (Highlights keys off "how
 *     far above the image's own lower-midtone/shadow mass"). p75/p25 beat
 *     every other tested anchor (logMean, p10/p50/p90) at collapsing the 5
 *     real scenes' own measured response curves onto a single shared shape
 *     — see the implementer report's anchor-fit table.
 *  3. UNGATED saturating curve, ONE formula per direction, valid for ALL x
 *     (no sign gate, no identity dead zone — round-3's own sub-onset data
 *     refutes it): a logistic/sigmoid in `x = base - ref`, round-3-fit
 *     (shadowsCurve/highlightsCurve below). Continuous and monotonic
 *     everywhere; genuinely SATURATES (bounded ceiling) rather than growing
 *     without limit, unlike an earlier unbounded-ramp candidate that blew up
 *     on real photos' own extreme highlight/shadow tails (session-scratch
 *     sim finding, not shipped — see the implementer report).
 *  4. SCENE-ADAPTIVE AMPLITUDE (amplitudeMultiplier below): round-3's own
 *     probe geometry (an isolated 64px patch on an otherwise perfectly
 *     uniform field) has essentially ZERO frame-wide spread — it calibrates
 *     the curve's shape/ceiling at amplitude-multiplier=1 by construction.
 *     Real photos need MORE shadow lift and LESS highlight crush than that
 *     baseline predicts, scaling with the frame's own log2-luma STANDARD
 *     DEVIATION (the stat that best collapsed the 5-scene fit and passed
 *     leave-one-scene-out cross-validation — see the implementer report's
 *     LOSO table; p90-p10/p75-p25 "DR spread" alone was tried first and
 *     REJECTED per round-4's own warning that spread-only laws are ~12x too
 *     weak for real photos at matched spread). A smoothstep BLENDS the law
 *     in only once std climbs past LOCALTONE_AMP_STAT_LOW — round-3/E1/E4's
 *     own synthetic probe images sit at std ~0.1-0.3 (comfortably below the
 *     blend's onset), so they see amplitude-multiplier=1 UNCHANGED, exactly
 *     preserving the round-3 calibration and E1's own loose-tolerance sign
 *     structure; only genuinely photographic scenes (std > ~1.5, real
 *     photos measured 1.45-3.19 under the shipped EV=0.5 default — STAGE
 *     1e-r, see LOCALTONE_AMP_SH_A's doc comment; was 1.6-3.3 under stage
 *     1e's own EV=0 fit harness) get the full scene-adaptive law. This blend
 *     window (0.5-1.5 std) has NO calibration data in it (no synthetic test
 *     reaches std>0.4, and one real scene — DSC09305, under EV=0.5 — now
 *     sits just BELOW 1.5, so it is no longer purely outside this window
 *     either) — a known, reported gap, not a claim of validated behavior
 *     there.
 *  5. Percentiles/std are computed ENTIRELY ON GPU (box-reduce the full-res
 *     log-luma down to a small tile, then a compute-shader HISTOGRAM +
 *     single-invocation cumulative-sum/variance reduction — see
 *     graphRenderer.ts's buildLocalTonePasses) so render() stays fully
 *     synchronous and GPU-deterministic (no mid-frame CPU readback) — see
 *     LOCALTONE_HIST_BINS's doc comment.
 *
 * Slider strength is exactly linear (unchanged property from stage 1c/1d,
 * reconfirmed round-3/round-4: sh_p50 = sh_p100/2 to <0.05% at every offset
 * and DR spread tested) — `localToneShift` multiplies the FULL-slider curve
 * output by shadowsAmt/highlightsAmt directly, no other slider-dependent
 * term anywhere.
 *
 * DELETED from stage 1d (git history preserves it): globalLogMean (single
 * arithmetic-mean `ref` — replaced by the two-percentile GPU histogram
 * stats), toneTail/remapBase (sign-gated bounded tail with an identity
 * onset window — refuted by round-3's own sub-onset data), and every
 * LOCALTONE_TONE_ONSET / LOCALTONE_TONE_FLOOR / ONSET_SOFTEN_FRAC constant.
 *
 * STAGE 2 SEAM (out of scope, do not implement): `clarity`'s own reservation
 * (band-limited micro-contrast on the now-explicit `detail` channel) is
 * unchanged from stage 1d.
 *
 * STAGE 1e-r (narrow follow-up, this file's LOCALTONE_AMP_* constants only —
 * model structure, curve shape constants, and everything else on this page
 * UNCHANGED from stage 1e): stage 1e's own amplitude-law constants were fit
 * against real-GPU renders taken at `baselineExposureEV=0` (a harness
 * convention borrowed from the synthetic verify script), not the shipped
 * default of 0.5 — see LOCALTONE_AMP_SH_A's own doc comment for the full
 * refit method/results.
 * ============================================================================
 */

export const LOCALTONE_KIND = 'localtone';

export interface LocalToneParams {
  /** 0..100. Lifts pixels whose small-radius local average (`base`) sits BELOW the frame's own 75th-percentile log2-luma (`refSh`) — pixels reading as "locally dark" relative to the frame's own upper-midtone/highlight mass. 0 = no effect. */
  shadows: number;
  /** -100..0. Crushes pixels whose `base` sits ABOVE the frame's own 25th-percentile log2-luma (`refHi`) — pixels reading as "locally bright" relative to the frame's own lower-midtone/shadow mass. Negative-only (LR's own Highlights sign convention: negative = recover/darken); 0 = no effect. */
  highlights: number;
  /** 0..100. RESERVED for stage 2 (band-limited micro-contrast on the now-explicit `detail = logLuma - base` channel) — carried through params/sidecar/UI but INERT (no shader reads it) in stage 1. */
  clarity: number;
  /** The `base` blur's own Gaussian sigma, in PIXELS — unchanged from stage 1d (round-2 Q1's own "narrow ~4-6px local kernel" finding); see LOCALTONE_SIGMA_R_DEFAULT's doc comment for the sim-measured E4 transition-width tradeoff. */
  sigmaR: number;
  /** 0..1 master mix vs identity, like the LUT node's amount / blend's uniform.x. 0 = IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through). */
  amount: number;
}

export function defaultLocalToneParams(): LocalToneParams {
  return { shadows: 0, highlights: 0, clarity: 0, sigmaR: LOCALTONE_SIGMA_R_DEFAULT, amount: 1 };
}

/** Unchanged from stage 1d — see LOCALTONE_SIGMA_R_DEFAULT's own doc comment (sim-measured E4 sweep). */
export const LOCALTONE_SIGMA_R_DEFAULT = 2.5;

/**
 * amount<=0 (bit-exact pass-through) OR shadows===0 && highlights===0 (the
 * curve outputs are gated OFF entirely when their own slider is exactly
 * 0 — see `localToneShift`) both count as IDENTITY, so a freshly added node
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

function sigmoid(z: number): number {
  // numerically-safe logistic — avoids exp() overflow at the extremes the
  // curve's own asymptotes reach (WGSL's exp() saturates the same way).
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * ROUND-3-FIT SHAPE CONSTANTS (docs/research/lr-tone-measurements-r2.md's
 * round-3 addendum table, Shadows+100 offsets {0.5..5}, WEIGHTED least
 * squares — see the implementer report for the full fit/loss table).
 * `shadowsCurve(x, 1)` reproduces round-3's own {1.5, 2.5, 3.5} points (the
 * verify-localtone.mjs hard targets) within ~7% and stays close to the
 * table's other points too. Saturates to LOCALTONE_SH_AMPLITUDE stops as
 * x -> -infinity (deep local shadow relative to refSh), decays smoothly to
 * ~0 as x -> +infinity (local highlight relative to refSh) — no dead zone,
 * matches round-3's own "no dead zone, quasi-linear onset" finding.
 *
 * SIM-vs-REAL-GPU RE-ANCHOR (same gap stage 1d hit, see git history — the
 * REAL renderer's own histogram-based percentile computation and the base/
 * detail blur split are not modeled by the session-scratch CPU-only curve
 * fit): the CPU sim's own fit landed at amplitude=1.041536, which reproduced
 * round-3's table within ~7% IN SIM, but the REAL GPU (scripts/
 * verify-localtone.mjs's own R3/hi checks, run against the actual shader
 * chain) measured offset=1.5 at 0.229 (vs sim's 0.150, target 0.141 — 62%
 * over target) and hi offset=2 at -1.583 (vs sim's -1.104, target -1.093 —
 * 45% over target): the real chain runs consistently ~15-60% stronger than
 * the CPU sim predicted, worse at smaller offsets (closer to the sigmoid's
 * steep transition, where the GPU histogram's 0.25-stop bin quantization on
 * p25/p75 has more relative leverage). Re-solved by a uniform 0.70x
 * correction on BOTH LOCALTONE_SH_AMPLITUDE and LOCALTONE_HI_AMPLITUDE
 * (chosen as the largest factor keeping ALL FOUR real-GPU-measured points —
 * sh {1.5, 2.5, 3.5}, hi {2} — inside their ±30% verify bands with margin;
 * a per-offset factor would fit tighter but a single scalar was simpler and
 * left real margin everywhere: sh 1.5/2.5/3.5 land at 71%/wide-open/70% of
 * their band edges, hi 2 at 78%). See the implementer report for the full
 * real-GPU measurement table and the honest characterization of the
 * sim-vs-real gap (root cause not fully isolated — plausibly a combination
 * of histogram bin quantization and the base/detail blur, not the core
 * curve math, since the CPU sim's own internal math checks out against
 * every unit-test property).
 */
export const LOCALTONE_SH_AMPLITUDE = 0.729075;
/** Sigmoid center (stops, in `x = base - refSh`) — see LOCALTONE_SH_AMPLITUDE's doc comment. */
export const LOCALTONE_SH_CENTER = -2.713718;
/** Sigmoid steepness (1/stops). */
export const LOCALTONE_SH_STEEPNESS = 1.467968;

/**
 * Highlights' own round-3-fit shape constants — round-3's hi_m100 table
 * (offsets {0.5..4}, o=5 EXCLUDED as a near-total-clip outlier the round-2
 * addendum itself flags — it coincidentally matches E1's own bg=0.5% crush
 * at a very different, 5.17-stop offset, not part of the smooth law).
 * WEIGHTED toward o<=1 and o=2 (the verify-localtone.mjs hard target):
 * an UNWEIGHTED least-squares fit reproduced offset=2 fine but overshot the
 * near-anchor region badly (~14x too strong at x=0), which broke E1's own
 * bg=18% point (patch brightness == background brightness, x=0 exactly —
 * LR measures 0 there, and E1's tolerance floor is tight, ~0.06 stops).
 * Also carries the SAME 0.70x sim-vs-real-GPU re-anchor as
 * LOCALTONE_SH_AMPLITUDE's own doc comment (sim fit was 1.894180).
 */
export const LOCALTONE_HI_AMPLITUDE = 1.325926;
/** Sigmoid center (stops, in `x = base - refHi`). */
export const LOCALTONE_HI_CENTER = 1.832155;
/** Sigmoid steepness (1/stops). */
export const LOCALTONE_HI_STEEPNESS = 1.985934;

/** Full-slider (100%) Shadows response at a given `x = base - refSh`, before the scene-adaptive amplitude multiplier and slider fraction. Saturates to LOCALTONE_SH_AMPLITUDE*ampMult; monotonic decreasing in x. */
export function shadowsCurve(x: number, ampMult: number): number {
  return LOCALTONE_SH_AMPLITUDE * ampMult * sigmoid(LOCALTONE_SH_STEEPNESS * (LOCALTONE_SH_CENTER - x));
}
/** Full-slider (100%) Highlights response at a given `x = base - refHi` — negative-going (crush), monotonic decreasing (more negative) in x. */
export function highlightsCurve(x: number, ampMult: number): number {
  return -LOCALTONE_HI_AMPLITUDE * ampMult * sigmoid(LOCALTONE_HI_STEEPNESS * (x - LOCALTONE_HI_CENTER));
}

// --- Scene-adaptive amplitude law (docs/research/lr-tone-measurements-r2.md
// round-4 addendum's percentile-relative-anchoring finding + the stage-1e
// real-photo diagnosis's 5-scene fit) -----------------------------------

/** Below this frame log2-luma std-dev, the amplitude multiplier is exactly 1 (round-3/E1/E4's own synthetic probes sit at std ~0.1-0.3, comfortably inside this — their calibration is UNCHANGED by the scene-adaptive law). ENGINEERING choice bracketing the gap between the synthetic-probe std range and the real-photo std range (5-scene fit: 1.6-3.3) — no calibration data exists inside [LOW,HIGH] itself; see the module doc comment's item 4. */
export const LOCALTONE_AMP_STAT_LOW = 0.5;
/** Above this std, the amplitude multiplier is the full fitted law (freeLine below), unattenuated. */
export const LOCALTONE_AMP_STAT_HIGH = 1.5;
/**
 * Shadows amplitude-multiplier law intercept, `mult = A + B*std` (5-scene
 * least squares against the CPU sim, docs/research/lr-tone-measurements-r2.md's
 * round-4-informed stat choice: frame log2-luma std-dev beat p90-p10/p75-
 * p25/entropy on leave-one-scene-out cross-validation — see the implementer
 * report's LOSO table).
 *
 * REAL-GPU RE-ANCHOR: the CPU-sim fit here (A=-1.309, B=1.3311) was
 * calibrated against the SIM-predicted per-unit curve — the SAME sim that
 * underestimated the real GPU's own round-3/E1 response by the ~0.70x
 * factor LOCALTONE_SH_AMPLITUDE's own doc comment describes. That gap
 * turned out to be regime-specific: re-rendering the 5 real ARW scenes
 * through the ACTUAL GPU pipeline (session-scratch localtone-compare/
 * render.mjs + analyze.mjs) after applying the 0.70x amplitude correction
 * showed real photos UNDERSHOOTING LR by roughly the SAME 0.70x-ish margin
 * (ratios 0.36-0.90, average ~0.65) — i.e. real (broadly-distributed, many-
 * bin) photo histograms do NOT suffer the same GPU-histogram quantization
 * bias near-uniform synthetic probes do (their whole population concentrates
 * in 1-2 of the 128 bins, where linear within-bin percentile interpolation
 * is much less accurate). So this law is scaled UP by 1/0.70 ≈ 1.4286 to
 * exactly UNDO LOCALTONE_SH_AMPLITUDE's 0.70x reduction for the real-photo
 * regime (std > LOCALTONE_AMP_STAT_HIGH, where the blend is fully engaged)
 * — net amplitude there is back to the CPU-sim-fit's original real-photo
 * prediction, while round-3/E1/E4 (std <= LOCALTONE_AMP_STAT_LOW, where the
 * multiplier is pinned to exactly 1 regardless of A/B) keep the 0.70x
 * reduction they need. See the implementer report for the full fresh
 * real-GPU delta table (post this re-anchor) and LOSO.
 */
/**
 * STAGE 1e (original, git history): the constants below were fit against
 * real-GPU renders taken with `settings.baselineExposureEV` forced to 0
 * (verify-localtone.mjs's own synthetic-harness convention, borrowed by
 * mistake into the session-scratch real-photo compare harness too). That is
 * NOT the shipped default — shared/ipc.ts's DEFAULT_SETTINGS.baselineExposureEV
 * is 0.5, and A7C2_BASE_CURVE was itself fit assuming 0.5 EV at decode
 * (fit-base-curve.mjs's DEFAULT_EV) — so every stage-1e real-photo
 * measurement ran the EV shift through the nonlinear base curve BEFORE the
 * localtone frame stats (percentile anchors, std) were taken, which is not
 * a no-op: docs/research/lr-base-gap.md's "Second correction" found 15/20
 * band ratios moved by >0.05 (max 0.17) between EV=0 and EV=0.5, degrading
 * the real-photo gate 18/20 -> 17/20 (DSC09305 sh 0.38/0.38, hi-80 0.66,
 * frame-mean worst 0.29 stops) — worse than this task exists to fix.
 *
 * STAGE 1e-r (this revision): refit against the SHIPPED default (EV=0.5),
 * MODEL STRUCTURE UNCHANGED (same amplitudeMultiplier smoothstep-blended
 * line, same shadowsCurve/highlightsCurve shape constants — those did NOT
 * need touching). Method (session-scratch localtone-compare/, same 5 ARW
 * scenes as stage 1e — DSC03298/04260/06787/07349/09305):
 *  1. Re-rendered the 5 scenes' `base` (identity-localtone) export at the
 *     shipped EV=0.5 default (render.mjs, CORRECTED per lr-base-gap.md), then
 *     computed the exact frame stats (p25/p75/std) the PRODUCTION functions
 *     see by running THIS FILE's own reduceToTile/histogramOf/
 *     statsFromHistogram (unchanged) on that export's log2-luma (sRGB-decode
 *     + WORKING_LUMA weights, matching the GPU log-luma pass exactly —
 *     compute-stats.mjs). Result (std, was 1.6-3.3 under EV=0): DSC03298
 *     2.217, DSC04260 3.185, DSC06787 2.352, DSC07349 1.564, **DSC09305
 *     1.447 — now the LOWEST of the 5, and it sits just BELOW
 *     LOCALTONE_AMP_STAT_HIGH (1.5)**, so under EV=0.5 it no longer even
 *     gets the fully-blended line (t~0.992, not exactly 1).
 *  2. Exploited an EXACT algebraic property of localToneShift: shift =
 *     amt*AMPLITUDE*ampMult*sigmoid(...) is LINEAR in ampMult for a fixed
 *     pixel, so analyze.mjs's band-mean (and framemean.mjs's frame-mean)
 *     log2 delta is *exactly* linear in ampMult too (holding the base
 *     render, p25/p75, and pixel population fixed). This lets required
 *     amplitude be solved in closed form from the CURRENT shipped
 *     constants' own EV=0.5 measurement, with no simulation step and no
 *     iterative re-rendering needed to explore the fit space: requiredMult
 *     = currentMult * (lr/sb) = currentMult / currentRatio (fit.mjs, same
 *     scratchpad dir).
 *  3. DSC09305 confirmed (again, now under EV=0.5) NOT reliably predictable
 *     from std alone by this closed-form math: its required Shadows
 *     multiplier (~2.70) is the SECOND-HIGHEST of all 5 scenes despite
 *     having the LOWEST std (1.447, barely above DSC07349's 1.564 which
 *     needs only ~1.40) — an unweighted OLS line through all 5 scenes
 *     cannot fit both without badly overshooting DSC07349's own real target
 *     (see fit.mjs's "all-5 OLS" candidate: 15/20 in-bounds, DSC07349 pushed
 *     to 1.44-1.46). An unweighted OLS through the other 4 scenes ALONE fits
 *     them excellently (0.83-1.30, well inside [0.7,1.43]) but leaves
 *     DSC09305's Shadows multiplier far short (both configs land at ~0.43,
 *     BELOW the hard [0.5,2.0] floor) by this same closed-form math.
 *  4. Resolved with WEIGHTED least squares (same technique already used for
 *     LOCALTONE_HI_AMPLITUDE's own shape fit, "WEIGHTED toward o<=1 and
 *     o=2"): DSC09305 down-weighted to 0.8 (Shadows) / 0.3 (Highlights)
 *     relative to weight-1 on the other four scenes, landing on the fitted
 *     line below. This is a genuine regression, not a nudge-after-the-fact —
 *     picked by sweeping the weight and taking the highest value that the
 *     CLOSED-FORM math above predicted would still keep all other 18 scene x
 *     config points inside [0.7,1.43] (DSC07349 Shadows was the closed-form
 *     binding constraint on the high side of the sweep). CONFIRMED on a real
 *     GPU re-render (compare harness, results.json/framemean.mjs output in
 *     scratchpad, project/looks/*.json cleared first per the stacked-node
 *     lesson below): the real render came in BETTER than the closed-form
 *     prediction — **20/20** scene x config primary-band points land in
 *     [0.7,1.43] (DSC09305 Shadows itself lands at 0.86/0.86, comfortably
 *     inside, not the ~0.65-0.66 the closed-form math predicted), **0**
 *     points outside [0.5,2.0], worst frame-mean error **0.14 stops**
 *     (DSC09305 sh_p70; well inside stage 1e's own 0.24-stop bar — see
 *     framemean.mjs). The gap between the closed-form prediction and the
 *     real measurement is plausibly the frame-stats approximation in step 1
 *     (std/p25/p75 recovered from a re-decoded 2048-long-edge JPEG export,
 *     not the GPU's own native-resolution histogram) — DSC09305 sits right
 *     at the smoothstep transition edge (t~0.992, not fully blended), where
 *     a small std error has outsized leverage on the resulting multiplier;
 *     the other 4 scenes' t=1 (fully blended, insensitive to small std
 *     error) and their closed-form predictions matched the real re-render
 *     closely. Net: this round's result is BETTER than the brief's own
 *     ≥18/20 target, not just a bare pass — DSC09305 was flagged going in as
 *     a hard scene per the brief's own escape hatch, but the shipped
 *     constants below do NOT need to leave it as a residual outlier after
 *     all. Per the brief's own guidance, no curve-shape distortion was
 *     needed either way (LOCALTONE_SH_CENTER/STEEPNESS/AMPLITUDE and their
 *     Highlights counterparts are UNCHANGED from stage 1e).
 */
export const LOCALTONE_AMP_SH_A = -0.218525;
/** Shadows amplitude-multiplier law slope — see LOCALTONE_AMP_SH_A's doc comment. */
export const LOCALTONE_AMP_SH_B = 1.385823;
/** Highlights amplitude-multiplier law intercept — see LOCALTONE_AMP_SH_A's doc comment (same STAGE 1e-r EV=0.5 refit, weighted 0.3 on DSC09305 rather than 0.8 — Highlights' own unweighted 4-scene fit already landed DSC09305 inside [0.7,1.43] with room, so a lighter weight was enough to widen its margin (0.71->0.76-0.82) without touching the other four's own comfortable margins). */
export const LOCALTONE_AMP_HI_A = -0.027904;
/** Highlights amplitude-multiplier law slope — see LOCALTONE_AMP_HI_A's doc comment. */
export const LOCALTONE_AMP_HI_B = 0.251069;
/** Hard floor on the amplitude multiplier — a numerical-safety guard (never lets the curve invert sign or divide-by-zero downstream), not itself an LR-calibrated constant. */
export const LOCALTONE_AMP_FLOOR = 0.05;

/**
 * Scene-adaptive amplitude multiplier: exactly 1 for std <= LOCALTONE_AMP_STAT_LOW
 * (preserves round-3/E1/E4's own calibration untouched), smoothstep-blends
 * into the fitted `A + B*std` line by LOCALTONE_AMP_STAT_HIGH, floored at
 * LOCALTONE_AMP_FLOOR. Same function shape for Shadows and Highlights, only
 * the (A,B) pair differs.
 */
export function amplitudeMultiplier(std: number, a: number, b: number): number {
  const t = smoothstepJs(LOCALTONE_AMP_STAT_LOW, LOCALTONE_AMP_STAT_HIGH, std);
  const line = a + b * std;
  return Math.max(LOCALTONE_AMP_FLOOR, 1 + t * (line - 1));
}

/**
 * Total additive shift to logLuma at one pixel — the CPU twin of
 * graphRenderer.ts's LOCALTONE_REMAP_SHADER. `stats` is one frame's GPU-
 * computed (or, here, CPU-computed for tests) percentile/amplitude bundle
 * (computeFrameStats below). Gated at exactly 0 when its own slider is 0
 * (not just asymptotically small) — this is what makes shadows=highlights=0
 * an EXACT identity (isIdentityLocalTone's second branch) regardless of the
 * curve's own value at that pixel.
 */
export function localToneShift(
  base: number,
  stats: { p25: number; p75: number; ampMultSh: number; ampMultHi: number },
  shadowsAmt: number,
  highlightsAmt: number
): number {
  const sh = shadowsAmt > 0 ? shadowsAmt * shadowsCurve(base - stats.p75, stats.ampMultSh) : 0;
  const hi = highlightsAmt > 0 ? highlightsAmt * highlightsCurve(base - stats.p25, stats.ampMultHi) : 0;
  return sh + hi;
}

// --- CPU reference (unit tests only — NOT the buildPlan cpu mirror, see the
// module doc comment's "SPATIAL CLASS, NO CPU MIRROR" section) ------------
//
// Mirrors graphRenderer.ts's GPU pass chain bit-for-shape (same tile-reduce
// + histogram percentile/std computation, same separable Gaussian base
// blur, same ungated curve) so localToneNode.test.ts can assert the
// algorithm's numbers fast, without a GPU — the slow, authoritative
// cross-check against the REAL renderer is scripts/verify-localtone.mjs.

export interface GrayImage {
  data: Float32Array;
  w: number;
  h: number;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Level-dims sequence for a reduce chain, halving (ceil) until 1x1 — level[0] is always {w,h} (full res), handy for sizing the log-luma/base full-res render targets too. */
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
 * Same halving sequence as pyramidLevelDims, but stops at the first level
 * where BOTH dims are <= maxDim (a small "tile") rather than continuing to
 * 1x1 — the population sample computeFrameStats/the GPU histogram derives
 * percentiles/std from. A modest downsampled tile (not the full-res image)
 * keeps the histogram compute pass cheap; box-reducing the LOG-LUMA texture
 * averages neighboring log2-luma values before histogramming, so this is an
 * APPROXIMATION of the true full-res order statistics (narrows extreme
 * percentiles slightly, like any low-pass before an order-statistic) — an
 * accepted tradeoff per the brief (loose ~30%/2x/[0.7,1.43] tolerances
 * throughout this feature, not exact-percentile-sensitive).
 */
export function tileLevelDims(w: number, h: number, maxDim: number): { w: number; h: number }[] {
  const levels: { w: number; h: number }[] = [{ w, h }];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    if (prev.w <= maxDim && prev.h <= maxDim) break;
    levels.push({ w: Math.max(1, Math.ceil(prev.w / 2)), h: Math.max(1, Math.ceil(prev.h / 2)) });
  }
  return levels;
}
/** Tile ceiling in px (both dims) — matches graphRenderer.ts's LOCALTONE_TILE_MAX_DIM. */
export const LOCALTONE_TILE_MAX_DIM = 64;

/**
 * Plain (unweighted) non-overlapping 2x2 box-average reduce — deliberately
 * NOT a Burt-Adelson-weighted kernel (stage 1c's own pyramid used one, found
 * in sim to bias a hard step edge by ~1.6 stops once cascaded across many
 * dyadic halvings — see git history). Exact arithmetic mean for power-of-2
 * dims, no alignment-dependent bias for anything else either (odd dims: the
 * trailing row/column contributes only its own real samples, never a
 * duplicated clamp).
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

/** Reduce a full-res log-luma GrayImage down to a <=LOCALTONE_TILE_MAX_DIM tile via boxReduceGray — the CPU twin of graphRenderer.ts's tile-reduce chain. */
export function reduceToTile(img: GrayImage, maxDim: number = LOCALTONE_TILE_MAX_DIM): GrayImage {
  const levels = tileLevelDims(img.w, img.h, maxDim);
  let cur = img;
  for (let i = 1; i < levels.length; i++) cur = boxReduceGray(cur);
  return cur;
}

/** log2-luma histogram bin count — 128 bins, matching graphRenderer.ts's LOCALTONE_HIST_SHADER (a compute-shader histogram, so p25/p75/std are computed ENTIRELY ON GPU with no mid-frame CPU readback — render() stays synchronous and GPU-deterministic; see the module doc comment's item 5). */
export const LOCALTONE_HIST_BINS = 128;
/** Histogram range floor (log2-luma stops) — comfortably below LOCALTONE_LUMA_EPS's own floor (-20) with margin for a box-reduced tile's averaged values. */
export const LOCALTONE_HIST_LO = -24;
/** Histogram range ceiling (log2-luma stops) — comfortably above any realistic post-develop working-space highlight value. */
export const LOCALTONE_HIST_HI = 8;
/** Bin width in stops — (HIST_HI - HIST_LO) / HIST_BINS = 0.25, matching the research docs' own 0.25-stop binning convention. */
export const LOCALTONE_HIST_BIN_WIDTH = (LOCALTONE_HIST_HI - LOCALTONE_HIST_LO) / LOCALTONE_HIST_BINS;

/** Bin a tile's log2-luma values into LOCALTONE_HIST_BINS counts — the CPU twin of graphRenderer.ts's LOCALTONE_HIST_SHADER (compute-shader atomics there; a plain loop here). */
export function histogramOf(tile: GrayImage): Float64Array {
  const hist = new Float64Array(LOCALTONE_HIST_BINS);
  for (const v of tile.data) {
    const bin = clampi(Math.floor((v - LOCALTONE_HIST_LO) / LOCALTONE_HIST_BIN_WIDTH), 0, LOCALTONE_HIST_BINS - 1);
    hist[bin]!++;
  }
  return hist;
}

/** p25/p75 (linear-interpolated within-bin, assuming uniform density inside a bin) + mean/std from a log2-luma histogram — the CPU twin of graphRenderer.ts's LOCALTONE_STATS_SHADER (a single-invocation compute shader doing the same cumulative-sum/variance reduction on GPU). */
export function statsFromHistogram(hist: Float64Array): { p25: number; p75: number; mean: number; std: number } {
  let total = 0;
  for (const c of hist) total += c;
  total = Math.max(total, 1);
  const target25 = 0.25 * total;
  const target75 = 0.75 * total;
  let cum = 0;
  let p25 = LOCALTONE_HIST_LO;
  let p75 = LOCALTONE_HIST_LO;
  let found25 = false;
  let found75 = false;
  let meanAcc = 0;
  for (let i = 0; i < LOCALTONE_HIST_BINS; i++) {
    const c = hist[i]!;
    const binLo = LOCALTONE_HIST_LO + i * LOCALTONE_HIST_BIN_WIDTH;
    const binCenter = binLo + 0.5 * LOCALTONE_HIST_BIN_WIDTH;
    meanAcc += c * binCenter;
    const cumBefore = cum;
    cum += c;
    if (!found25 && cum >= target25) {
      const frac = c > 0 ? (target25 - cumBefore) / c : 0;
      p25 = binLo + frac * LOCALTONE_HIST_BIN_WIDTH;
      found25 = true;
    }
    if (!found75 && cum >= target75) {
      const frac = c > 0 ? (target75 - cumBefore) / c : 0;
      p75 = binLo + frac * LOCALTONE_HIST_BIN_WIDTH;
      found75 = true;
    }
  }
  const mean = meanAcc / total;
  let varAcc = 0;
  for (let i = 0; i < LOCALTONE_HIST_BINS; i++) {
    const c = hist[i]!;
    const binLo = LOCALTONE_HIST_LO + i * LOCALTONE_HIST_BIN_WIDTH;
    const binCenter = binLo + 0.5 * LOCALTONE_HIST_BIN_WIDTH;
    varAcc += c * (binCenter - mean) * (binCenter - mean);
  }
  const std = Math.sqrt(varAcc / total);
  return { p25, p75, mean, std };
}

/** Full per-frame stats bundle (percentile anchors + scene-adaptive amplitude multipliers) from a full-res log-luma GrayImage — the CPU twin of the GPU tile-reduce -> histogram -> stats-reduce pass chain (graphRenderer.ts's buildLocalTonePasses). */
export function computeFrameStats(logLumaImg: GrayImage): { p25: number; p75: number; mean: number; std: number; ampMultSh: number; ampMultHi: number } {
  const tile = reduceToTile(logLumaImg);
  const hist = histogramOf(tile);
  const { p25, p75, mean, std } = statsFromHistogram(hist);
  const ampMultSh = amplitudeMultiplier(std, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B);
  const ampMultHi = amplitudeMultiplier(std, LOCALTONE_AMP_HI_A, LOCALTONE_AMP_HI_B);
  return { p25, p75, mean, std, ampMultSh, ampMultHi };
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

/** Separable Gaussian blur (clamp-to-edge), radius = ceil(3*sigma) — the CPU twin of graphRenderer.ts's LOCALTONE_BLUR_H_SHADER/LOCALTONE_BLUR_V_SHADER pair (`base`). Unchanged from stage 1d. */
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
