/**
 * Auto tone (docs/brief-bank/auto-tone.md) — the pure percentile-anchored
 * solve behind the toolbar's 「自動トーン」 button. A one-click STARTING
 * POINT for the basic-tone sliders, derived transparently from the open
 * photo's own luma histogram (LR's "Auto" in spirit, no black box): every
 * threshold below is a NAMED constant, flagged for a side-by-side LR-Auto
 * calibration session (DESIGN.md principle 5) — v1 ships defensible
 * defaults, the calibration tightens them.
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
 *     none of the four moves below touch it).
 *  2+3+4. solveAutoTone() — black/white points, exposure, highlights/
 *     shadows, all read from ONE sorted snapshot of that population.
 *  5. Contrast/curve: deliberately NOT solved (brief: "keep MINIMAL... the
 *     four moves above are the honest core" — driving the curve too is the
 *     well-posedness degeneracy the look-extraction note warns about).
 *
 * v1 SIMPLIFICATION (flagged, not silently claimed exact): steps 2/4 read
 * percentiles scaled by the step-3 EV gain only — they do NOT compose
 * sequentially through the tone pass's own contrast→highlights→shadows→
 * whites→blacks order (developNode.ts's cpuDevelopTone). A one-shot
 * "starting point" doesn't need to invert the shader exactly; the engine's
 * own tone-pass formulas independently bound each slider's reach (blacks
 * ≤±0.018 linear, whites ≤±0.9 stops — see cpuDevelopTone), which is what
 * keeps the result a NUDGE rather than a hard clip, regardless of the
 * (also bounded) slider values this solve picks.
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import { applyProfileCpu } from './profileFit';
import { srgbDecode, srgbEncode } from './srgb';
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

// --- steps 2-4: the solve -----------------------------------------------------

export interface AutoToneBasicPatch {
  ev: number;
  blacks: number;
  whites: number;
  highlights: number;
  shadows: number;
}

/** Step 3 (exposure): which percentile anchors the midtone, and where it targets. */
export const AUTO_TONE_MEDIAN_PERCENTILE = 0.5;
/** sRGB-encoded 0..1 — near mid-grey in the working space. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_MIDTONE_TARGET_ENCODED = 0.45;
/** Matches the basic.ev slider's own range (InspectorPanel.tsx DEVELOP_BASIC_DEFS). */
export const AUTO_TONE_EV_MIN = -5;
export const AUTO_TONE_EV_MAX = 5;

/** Step 2 (black/white points): which percentiles anchor each end. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_BLACK_PERCENTILE = 0.005; // p0.5
export const AUTO_TONE_WHITE_PERCENTILE = 0.995; // p99.5
/** Linear-working-space targets — deliberately NOT 0/1 (never hard-clip; nudge toward the anchor). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_BLACK_TARGET_LINEAR = 0.01;
export const AUTO_TONE_WHITE_TARGET_LINEAR = 0.92;
/** How aggressively a measured deficit maps to slider units (full ±100 at this much linear delta / these many stops). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_BLACK_SLIDER_SPAN_LINEAR = 0.05;
export const AUTO_TONE_WHITE_SLIDER_SPAN_STOPS = 1.0;

/** Step 4 (highlights/shadows): which percentiles gauge the crushed shape. LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_P90_PERCENTILE = 0.9;
export const AUTO_TONE_P10_PERCENTILE = 0.1;
/** Encoded-luma thresholds beyond which p90/p10 count as "crushed" (0 = no headroom, 1 = fully crushed). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_HIGHLIGHT_CRUSH_THRESHOLD = 0.85;
export const AUTO_TONE_SHADOW_CRUSH_THRESHOLD = 0.15;
/** Slider units applied at FULL crush (bounded recovery, never the full ±100 range). LR-CALIBRATION CANDIDATE. */
export const AUTO_TONE_HIGHLIGHT_RECOVERY_MAX = 60;
export const AUTO_TONE_SHADOW_RECOVERY_MAX = 60;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Steps 2–4 of the solve (see file header for the full method + the v1
 * simplification note). `sortedLinearLuma` is neutralLumaSample()'s output.
 */
export function solveAutoTone(sortedLinearLuma: Float64Array): AutoToneBasicPatch {
  if (sortedLinearLuma.length === 0) {
    return { ev: 0, blacks: 0, whites: 0, highlights: 0, shadows: 0 };
  }

  // Step 3: exposure — median luma lands at the midtone target. Dominant
  // DOF, solved first so steps 2/4 read percentiles already exposure-shifted.
  const medianLinear = Math.max(1e-6, autoToneQuantile(sortedLinearLuma, AUTO_TONE_MEDIAN_PERCENTILE));
  const targetLinear = srgbDecode(AUTO_TONE_MIDTONE_TARGET_ENCODED);
  const ev = clamp(Math.log2(targetLinear / medianLinear), AUTO_TONE_EV_MIN, AUTO_TONE_EV_MAX);
  const gain = Math.pow(2, ev);

  // Step 2: black/white points — nudge the (post-exposure) extreme
  // percentiles toward near-black/near-white anchors.
  const p0_5 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_BLACK_PERCENTILE) * gain;
  const p99_5 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_WHITE_PERCENTILE) * gain;
  const blacks = clamp(((AUTO_TONE_BLACK_TARGET_LINEAR - p0_5) / AUTO_TONE_BLACK_SLIDER_SPAN_LINEAR) * 100, -100, 100);
  const whiteStops = Math.log2(AUTO_TONE_WHITE_TARGET_LINEAR / Math.max(1e-6, p99_5));
  const whites = clamp((whiteStops / AUTO_TONE_WHITE_SLIDER_SPAN_STOPS) * 100, -100, 100);

  // Step 4: highlights/shadows — bounded recovery, only where the shape is
  // actually crushed against an end (zero for a well-exposed midtone-anchored
  // scene, keeping this step minimal by construction on most photos).
  const p90 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_P90_PERCENTILE) * gain;
  const p10 = autoToneQuantile(sortedLinearLuma, AUTO_TONE_P10_PERCENTILE) * gain;
  const ys90 = srgbEncode(clamp(p90, 0, 1));
  const ys10 = srgbEncode(clamp(p10, 0, 1));
  const highlightCrush = clamp(
    (ys90 - AUTO_TONE_HIGHLIGHT_CRUSH_THRESHOLD) / (1 - AUTO_TONE_HIGHLIGHT_CRUSH_THRESHOLD),
    0,
    1
  );
  const shadowCrush = clamp((AUTO_TONE_SHADOW_CRUSH_THRESHOLD - ys10) / AUTO_TONE_SHADOW_CRUSH_THRESHOLD, 0, 1);
  const highlights = -clamp(highlightCrush * AUTO_TONE_HIGHLIGHT_RECOVERY_MAX, 0, 100);
  const shadows = clamp(shadowCrush * AUTO_TONE_SHADOW_RECOVERY_MAX, 0, 100);

  return { ev, blacks, whites, highlights, shadows };
}
