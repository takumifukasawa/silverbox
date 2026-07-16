/**
 * Default BASE CURVE for fresh RAW opens (COLOR.md "default rendering").
 *
 * A neutral scene-referred RAW decode carries no display intent, so a fresh
 * ARW renders darker than the camera's own JPEG. Silverbox matches Lightroom's
 * 2-stage default look: a LINEAR baseline exposure (settings.baselineExposureEV,
 * applied at decode) PLUS a display TONE CURVE fitted from the camera JPEG.
 * This module is that second stage — the fitted curve, seeded as VISIBLE,
 * editable, deletable points into the Develop node's toneCurve.rgb on a fresh
 * ARW open (appStore.openImageByPath). It is NOT hidden decode magic: the
 * points show up in the tone-curve editor and Reset removes them.
 *
 * The points are percentile-matched pairs (our neutral encoded luma → the
 * reference's encoded luma) in the tone editor's 0..255 point space, so the
 * existing PCHIP evaluator (toneCurve.ts) reproduces the measured transfer
 * exactly. Refit with `npm run fit:basecurve` (round-3 default: a joint
 * multi-scene fit, see fit-base-curve.mjs) or `node scripts/fit-base-curve.mjs
 * <arw> <jpg> [...]` for a specific scene set; the LR calibration session
 * (see the Lightroom-reference memory note) may later replace them.
 */
import type { CurvePoints } from '../graph/developNode';

/**
 * Fitted JOINTLY across 14 scenes vs LIGHTROOM CLASSIC's default rendering
 * (Adobe Color, no edits, quality-100/95 sRGB exports) at baselineExposureEV
 * 0.5: the 3 round-1/2 calibration pairs (DSC02993 ISO-5000 indoor, DSC07349
 * Italy sunset, DSC03298 Italy architecture/blue-hour) PLUS 11 green-heavy
 * ref-green pairs added in round 3 (docs/brief-bank/lr-calibration-session.md;
 * the round-1 curve was fit to DSC02993 ALONE and rendered the Italy scenes
 * noticeably darker than LR — pooled |Δp50| across these 14 scenes was
 * 9.3/255 with the single-scene curve, 3.0/255 with this one). Each scene
 * contributes ONE percentile-matched control-point estimate per anchor
 * (equal PER-SCENE weight — one big or extreme scene can't dominate — see
 * fit-base-curve.mjs's multi-scene aggregation); pooled RMS 6.39/255 over the
 * dense per-scene transfers (the single-scene fit's RMS was ~1.1/255, but
 * only for the one scene it was fit to — not a like-for-like number). Refit:
 *   npm run fit:basecurve                          # round-3 default (14 scenes)
 *   node scripts/fit-base-curve.mjs <arw> <jpg>     # single scene
 *   node scripts/fit-base-curve.mjs <arw1> <jpg1> <arw2> <jpg2> ...  # custom joint set
 */
export const A7C2_BASE_CURVE: CurvePoints = [
  [0, 0],
  [13, 18],
  [21, 32],
  [33, 53],
  [46, 77],
  [61, 103],
  [85, 139],
  [125, 186],
  [255, 255],
];

/**
 * Per-camera base-curve lookup, keyed by the EXACT model string
 * PreparedImage.capture.cameraModel reports (libraw's normalized id). One
 * entry today; add a fitted curve per body as they are measured.
 */
export const BASE_CURVE_BY_MODEL: Record<string, CurvePoints> = {
  'ILCE-7CM2': A7C2_BASE_CURVE,
};

/**
 * Fallback for any RAW without a model-specific entry: one curve is a better
 * default than none. It is the Sony a7C II curve — a reasonable starting point
 * for other bodies until each is measured (and, like any base curve, fully
 * editable/removable by the user).
 */
export const DEFAULT_BASE_CURVE: CurvePoints = A7C2_BASE_CURVE;

/** The base curve to seed for a RAW whose camera model is `model` (or null). */
export function baseCurveForModel(model: string | null | undefined): CurvePoints {
  return (model && BASE_CURVE_BY_MODEL[model]) || DEFAULT_BASE_CURVE;
}
