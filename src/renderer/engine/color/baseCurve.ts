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

/**
 * Base curve for "Adobe Color (local)" mode (stage base-2, fix ②,
 * docs/research/lr-base-gap.md). MEASURED NECESSITY (not assumed): the
 * brief's own double-application-trap analysis originally assumed Adobe
 * Standard's Look table (ValScale entries) + its `ToneCurvePV2012` supplied
 * enough tone to make the seeded base curve redundant (⇒ flatten it, same as
 * a tone-carrying DCP). A real 5-scene render-and-compare (acrlook mode,
 * amount 100, toneCurve FLATTENED to identity, EV 0.5) refuted that: pooled
 * mean Δluma (LR−sb) was **+0.97 stops** — WORSE than the pre-stage-base-2
 * shipped default's +0.09 (A7C2_BASE_CURVE under the OLD builtin lattice) —
 * because `ToneCurvePV2012`'s own XMP points ((0,0) (22,16) (40,35) (127,127)
 * (224,230) (240,246) (255,255)) are a MILD S-curve close to identity, not
 * LR's real default brightening (which Adobe's PV2012 engine applies as an
 * internal, undocumented, per-scene-adaptive base tone map — see the
 * research doc's round-3 finding — not something any DNG/XMP field exposes).
 * So flattening was WRONG for this mode; a base curve is still needed.
 *
 * Refit method: percentile-match (CTRL_Q quantiles, equal per-scene weight —
 * the same method fit-base-curve.mjs's round-3 uses, simplified: no subject-
 * area weighting) between silverbox's acrlook-mode render (amount 100,
 * EV 0.5, identity toneCurve) and each of the 5 lr-base-gap.md scenes' LR
 * base JPEG, in the SAME 0..255 sRGB-ENCODED point space toneCurve.ts's
 * PCHIP evaluator uses. Re-measured with this curve seeded: pooled mean
 * Δluma **−0.03 stops** (essentially flat, vs the flattened attempt's
 * +0.97 and the OLD default's +0.09) — see the stage base-2 report for the
 * full per-scene table. A COARSER fit than A7C2_BASE_CURVE's single-scene
 * origin (5 scenes, no subject weighting) — a future round following
 * fit-base-curve.mjs's full method (subject-area weighting, more scenes) is
 * the natural next refinement, same posture A7C2_BASE_CURVE's own doc
 * comment already carries for its successor.
 */
export const ACRLOOK_BASE_CURVE: CurvePoints = [
  [0, 0],
  [7, 8],
  [16, 21],
  [26, 38],
  [46, 78],
  [71, 111],
  [109, 165],
  [255, 255],
];
