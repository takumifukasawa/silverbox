/**
 * Auto tone (docs/brief-bank/auto-tone.md) — the pure percentile-anchored
 * solve behind the toolbar's 「自動トーン」 button. A one-click STARTING
 * POINT for the basic-tone sliders, derived transparently from the open
 * photo's own luma histogram (LR's "Auto" in spirit, no black box): every
 * threshold below is a NAMED constant, LR-calibrated (see the v2 note).
 *
 * Reuses the SAME percentile-machinery family as engine/color/baseCurve.ts's
 * fit (scripts/fit-base-curve.mjs's quantile()/distribution() shape) rather
 * than re-deriving it, and the engine's own WORKING_LUMA weights
 * (workingSpace.ts) — never a separate luma definition.
 *
 * Method (5 steps, docs/brief-bank/auto-tone.md):
 *  1. neutralLumaSample() — the CURRENT render's luma population, POST the
 *     fitted camera-color profile (if active), PRE basic-tone (WB stays
 *     applied: it's a separate preset family — see appStore.ts's
 *     familyForDevelopKey — already "locked in" by the time this runs, and
 *     none of the moves below touch it).
 *  2-5. solveAutoTone() — exposure, contrast, black/white points, and
 *     highlights/shadows, all read from ONE sorted snapshot of that
 *     population.
 *
 * v2 ALLOCATION MODEL (this file's current design — replaces the v1
 * "EV-primary, crush-gated recovery" solve after a user hand-test rejected
 * it as "飛びすぎ": a night scene hit the +5 EV clamp and washed to cyan
 * daylight). Calibrated against a measured LR Classic 15.2.1 Adobe-Auto
 * reference — 5 real ARW scenes spanning night→day, XMP-exported values —
 * see autoTone.test.ts's LR_AUTO_REFERENCE for the fit table (target vs
 * achieved) and scripts/verify-autotone.mjs for the invariant checks. LR's
 * own allocation, read off that table: EV moves BARELY (+0.08…+0.68 across
 * night→day — it is NOT re-centering the image on mid-gray), the tonal LIFT
 * is carried by Shadows (+38…+68), Highlights are ALWAYS cut hard
 * (−59…−82, protective by default, not gated on visible crushing), Contrast
 * is a small near-constant nudge (+5…+7), and Whites/Blacks are fine anchors
 * (Whites either sign, Blacks mildly negative). This file mirrors that
 * allocation:
 *  - EV is now driven by the SHADOW-REGION percentile (p10), not the median
 *    — "how deep does the shadow mass already sit" rather than "recenter
 *    the frame's overall brightness" — and clamped to a MUCH tighter range
 *    than the ev slider's own ±100 stops (AUTO_TONE_EV_MIN/MAX), so it can
 *    never again become the primary lift.
 *  - Shadows is the primary lift: a BASE floor (LR lifts shadows on every
 *    fit scene, never gates to zero) plus a term scaled by how dark p10
 *    already sits.
 *  - Highlights is always a substantial negative pull, with a smaller
 *    highlight-mass term (p90) layered on top of a strong base — LR's own
 *    -59..-82 band is fairly tight/scene-independent, not a crush-gated
 *    recovery like v1.
 *  - Whites/Blacks keep v1's percentile-anchor shape (recalibrated
 *    constants) — the noisiest of the six in the 5-scene fit (see the test
 *    file's fit-quality note), which is why LR calls Whites "either sign".
 *  - Contrast is a flat named constant (not solved) — deliberately, per the
 *    file's well-posedness note below: driving the curve too is the
 *    degeneracy the look-extraction note warns about.
 *
 * v1-INHERITED SIMPLIFICATION (still true): steps 3-5 read percentiles
 * scaled by the step-2 EV gain only — they do NOT compose sequentially
 * through the tone pass's own contrast→highlights→shadows→whites→blacks
 * order (developNode.ts's cpuDevelopTone). A one-shot "starting point"
 * doesn't need to invert the shader exactly; the engine's own tone-pass
 * formulas independently bound each slider's reach (blacks ≤±0.018 linear,
 * whites ≤±0.9 stops — see cpuDevelopTone), which is what keeps the result
 * a NUDGE rather than a hard clip, regardless of the (also bounded) slider
 * values this solve picks.
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import { applyProfileCpu } from './profileFit';
import { srgbEncode } from './srgb';
import { WORKING_LUMA } from './workingSpace';
import { isIdentityProfile, type ProfileParams } from '../graph/developNode';

// --- step 1: sampling --------------------------------------------------------

/**
 * Stride-subsample cap — keeps the button responsive on a full-res preview.
 * Same "capped target pixel count" shape as fit-base-curve.mjs's
 * openAndSample (perf choice, not a feel constant — no LR-calibration tag).
 */
export const AUTO_TONE_SAMPLE_TARGET = 400_000;

/**
 * Step 1: the neutral starting image's luma population — post-profile,
 * pre-basic-tone (see file header). Returns a SORTED Float64Array (default
 * TypedArray numeric sort, same convention fit-base-curve.mjs's
 * distribution() relies on) ready for autoToneQuantile().
 */
export function neutralLumaSample(
  image: PreparedImage,
  profile: ProfileParams,
  /** Resolved builtin/DCP residual lattice; null (or profile inactive) = skip the profile step. */
  profileLattice: readonly number[] | null,
  wbGains: readonly [number, number, number]
): Float64Array {
  const { data, width, height } = image;
  const total = width * height;
  if (total === 0) return new Float64Array(0);
  const stride = Math.max(1, Math.floor(total / AUTO_TONE_SAMPLE_TARGET));
  const profileActive = !isIdentityProfile(profile) && profileLattice !== null;
  const out = new Float64Array(Math.ceil(total / stride));
  const [wr, wg, wb] = WORKING_LUMA;
  let count = 0;
  for (let i = 0; i < total; i += stride) {
    let r = data[i * 4]!;
    let g = data[i * 4 + 1]!;
    let b = data[i * 4 + 2]!;
    if (profileActive) {
      const res = applyProfileCpu(profileLattice!, [r, g, b], profile.amount);
      r = res[0];
      g = res[1];
      b = res[2];
    }
    r *= wbGains[0];
    g *= wbGains[1];
    b *= wbGains[2];
    out[count++] = Math.max(0, wr * r + wg * g + wb * b);
  }
  const trimmed = count === out.length ? out : out.subarray(0, count);
  trimmed.sort();
  return trimmed;
}

/** q-quantile (0..1) of a pre-sorted Float64Array, linear interpolation — mirrors scripts/fit-base-curve.mjs's quantile() (same tool family, not re-derived). */
export function autoToneQuantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const loVal = sorted[lo]!;
  return loVal + (sorted[hi]! - loVal) * (idx - lo);
}

// --- steps 2-5: the solve ------------------------------------------------------

export interface AutoToneBasicPatch {
  ev: number;
  contrast: number;
  blacks: number;
  whites: number;
  highlights: number;
  shadows: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// --- step 2: exposure — a SMALL, shadow-region-relative nudge, never the
// primary lift (see file header's v2 note). Driven by p10 (the shadow-mass
// percentile the Shadows step below also reads) rather than the median: LR's
// own fit shows EV tracking "how deep does the shadow mass already sit", not
// "recenter the frame's overall brightness" — a bright-but-backlit scene
// (dusk silhouette) still gets a big EV nudge because its SHADOWS are deep,
// even though its median is mid-range.
export const AUTO_TONE_P10_PERCENTILE = 0.1;
/** Linear-luma pivot: p10 at this value ⇒ zero EV nudge. LR-CALIBRATION CANDIDATE (5-scene fit, autoTone.test.ts). */
export const AUTO_TONE_EV_SHADOW_TARGET_LINEAR = 0.0077;
/** Stops-per-octave scale on the p10 deficit — kept small so EV stays a nudge. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_EV_GAIN = 0.22;
/** Tight EV clamp — deliberately far short of the ev slider's own ±100-stop range (basic.ev's DEVELOP_BASIC_DEFS bound): EV must never again become the primary lift. LR-CALIBRATION CANDIDATE (max observed in the 5-scene fit: +0.68). */
export const AUTO_TONE_EV_MIN = -0.75;
export const AUTO_TONE_EV_MAX = 0.75;

// --- step 3: contrast — LR's fit shows a small, near-constant punch
// (+5..+7 across all 5 scenes) rather than anything histogram-derived; kept
// a flat constant deliberately (see file header's well-posedness note: a
// one-shot starting point solving the curve too is the degeneracy the
// look-extraction note warns about).
/** LR-CALIBRATION CANDIDATE (5-scene fit average: +6). */
export const AUTO_TONE_CONTRAST = 6;

// --- step 4: highlights/shadows — the REALLOCATED core of v2. Shadows is
// now the primary lift (a floor plus a mass-scaled term, never gated to
// zero); Highlights is always a strong negative pull (a high floor plus a
// smaller mass-scaled term) — LR's Auto protects highlights on every fit
// scene, not just visibly crushed ones.
export const AUTO_TONE_P90_PERCENTILE = 0.9;

/** Encoded p10 pivot: shadow-mass term saturates (⇒ 1) at/below 0, reaches 0 at this value. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_SHADOW_MASS_ENCODED = 0.17;
/** Shadows floor, applied even when the shadow mass term is fully zero. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_SHADOW_BASE = 12;
/** Shadows gain on the mass term (base + gain = the deepest-shadow ceiling, ~74). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_SHADOW_GAIN = 62;

/** Encoded p90 pivot: highlight-mass term saturates (⇒ 1) at/above this value. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_HIGHLIGHT_MASS_ENCODED = 0.55;
/** Highlights floor (magnitude) — LR cuts highlights hard on every fit scene, never gated on visible clipping. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_HIGHLIGHT_BASE = 65;
/** Highlights gain on the mass term (base + gain = the deepest-cut ceiling, ~77). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_HIGHLIGHT_GAIN = 12;

// --- step 5: black/white points — fine anchors off the extreme percentiles
// (v1's shape, recalibrated constants). The noisiest pair in the 5-scene fit
// — LR itself treats Whites as "either sign" (see file header).
export const AUTO_TONE_BLACK_PERCENTILE = 0.005; // p0.5
export const AUTO_TONE_WHITE_PERCENTILE = 0.995; // p99.5

/** Encoded p0.5 pivot for the black-point mass term (saturates ⇒ 1 at/above this value — an ELEVATED black point gets crushed back down for contrast). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_BLACK_MASS_ENCODED = 0.018;
/** Blacks floor (magnitude), applied even at a true near-zero black point. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_BLACK_BASE = 5;
/**
 * Blacks gain on the mass term — kept SMALL deliberately: an image with an
 * elevated (not-fully-fit-set) black point saturates this mass term to 1
 * (see AUTO_TONE_BLACK_MASS_ENCODED), and blacks is an ADDITIVE linear
 * offset (cpuDevelopTone), not a mass-relative one — a too-large ceiling
 * here measurably raises literal-black clip on an ordinary photo outside
 * the 5-scene fit set (verify-autotone.mjs's shadow-clip-budget check
 * caught this during calibration; the LR fit table tolerates a smaller
 * ceiling than a pure per-scene regression would pick — see the const's
 * "safety over exact fit" trade-off note in the test file). LR-CALIBRATION
 * CANDIDATE.
 */
export const AUTO_TONE_BLACK_GAIN = 10;

/** Encoded p99.5 pivot: whites is 0 exactly here, signed either side. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_WHITE_PIVOT_ENCODED = 0.65;
/** Slider units per unit of encoded p99.5 deviation from the pivot. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_WHITE_GAIN = 55;

/**
 * Steps 2–5 of the solve (see file header for the full method + the v2
 * allocation-model note). `sortedLinearLuma` is neutralLumaSample()'s
 * output.
 */
export function solveAutoTone(sortedLinearLuma: Float64Array): AutoToneBasicPatch {
  if (sortedLinearLuma.length === 0) {
    return { ev: 0, contrast: 0, blacks: 0, whites: 0, highlights: 0, shadows: 0 };
  }

  // Step 2: exposure — small, shadow-region-relative nudge (see const docs
  // above). Solved first so steps 4/5 read percentiles already EV-shifted,
  // same "one gain shared by the rest of the solve" shape v1 used.
  const p10Raw = Math.max(1e-6, autoToneQuantile(sortedLinearLuma, AUTO_TONE_P10_PERCENTILE));
  const ev = clamp(AUTO_TONE_EV_GAIN * Math.log2(AUTO_TONE_EV_SHADOW_TARGET_LINEAR / p10Raw), AUTO_TONE_EV_MIN, AUTO_TONE_EV_MAX);
  const gain = Math.pow(2, ev);

  // Step 3: contrast — flat constant, not solved (see file header).
  const contrast = AUTO_TONE_CONTRAST;

  // Post-EV percentiles shared by steps 4/5.
  const p0_5 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_BLACK_PERCENTILE) * gain;
  const p10 = p10Raw * gain;
  const p90 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_P90_PERCENTILE) * gain;
  const p99_5 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_WHITE_PERCENTILE) * gain;
  const ys0_5 = srgbEncode(clamp(p0_5, 0, 1));
  const ys10 = srgbEncode(clamp(p10, 0, 1));
  const ys90 = srgbEncode(clamp(p90, 0, 1));
  const ys99_5 = srgbEncode(clamp(p99_5, 0, 1));

  // Step 4: highlights/shadows — Shadows the primary lift (floor + mass
  // term, never gated to zero); Highlights always a strong negative pull
  // (high floor + smaller mass term). See file header's v2 note.
  const shadowMass = clamp(1 - ys10 / AUTO_TONE_SHADOW_MASS_ENCODED, 0, 1);
  const shadows = clamp(AUTO_TONE_SHADOW_BASE + shadowMass * AUTO_TONE_SHADOW_GAIN, 0, 100);
  const highlightMass = clamp(ys90 / AUTO_TONE_HIGHLIGHT_MASS_ENCODED, 0, 1);
  const highlights = -clamp(AUTO_TONE_HIGHLIGHT_BASE + highlightMass * AUTO_TONE_HIGHLIGHT_GAIN, 0, 100);

  // Step 5: black/white points — fine anchors off the extreme percentiles.
  const blackMass = clamp(ys0_5 / AUTO_TONE_BLACK_MASS_ENCODED, 0, 1);
  const blacks = -clamp(AUTO_TONE_BLACK_BASE + blackMass * AUTO_TONE_BLACK_GAIN, 0, 100);
  const whites = clamp(AUTO_TONE_WHITE_GAIN * (ys99_5 - AUTO_TONE_WHITE_PIVOT_ENCODED), -100, 100);

  return { ev, contrast, blacks, whites, highlights, shadows };
}
