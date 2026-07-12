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
 * camera JPEG's encoded luma) in the tone editor's 0..255 point space, so the
 * existing PCHIP evaluator (toneCurve.ts) reproduces the measured transfer
 * exactly. Refit with `npm run fit:basecurve <arw> <jpg>`; the LR calibration
 * session (see the Lightroom-reference memory note) may later replace them.
 */
import type { CurvePoints } from '../graph/developNode';

/**
 * Fitted from DSC02993.ARW vs LIGHTROOM CLASSIC's default rendering of it
 * (Adobe Color, no edits, quality-100 sRGB export) at baselineExposureEV
 * 0.5 — the 2026-07-12 LR calibration session's user decision: match LR,
 * not the in-camera JPEG (the previous fit; LR lifts the upper-mids
 * further, e.g. 116→180 vs the camera's →163). PCHIP RMS 1.12 / 255 over
 * the dense transfer. Refit command:
 *   npm run fit:basecurve /path/to.ARW /path/to/reference.jpg
 * (the reference JPEG can be a camera JPEG or any exported rendering —
 * whatever the default look should match.)
 */
export const A7C2_BASE_CURVE: CurvePoints = [
  [0, 0],
  [21, 27],
  [29, 43],
  [38, 58],
  [55, 82],
  [72, 110],
  [93, 145],
  [116, 180],
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
