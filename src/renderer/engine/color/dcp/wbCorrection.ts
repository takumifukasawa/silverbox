/**
 * Stage base-2, fix ① — dual-illuminant color-matrix interpolation.
 *
 * Confirmed bug (docs/research/lr-base-gap.md, round-2 attribution):
 * libraw's `cam_xyz` is exactly Adobe's ColorMatrix2 (D65) to float32
 * precision, used UNCONDITIONALLY by the decoder — but Adobe mired-
 * interpolates ColorMatrix1 (StdA, tungsten) ↔ ColorMatrix2 (D65) by the
 * shot's own CCT (measured weights: DSC03298 @4100K → 0.541 toward D65,
 * DSC06787/DSC09305 @5137K → 0.792, DSC07349 @5250K → 0.813). At a CCT far
 * from D65 (DSC03298's 4100K bridge shot), forcing weight 1.0 is a real
 * matrix error — the confirmed cause of that scene's color cast.
 *
 * The bug is baked into the DECODE ITSELF (libraw's own `useCameraWb` +
 * `outputColor` conversion, run inside the wasm decode call before any JS
 * ever sees a pixel — see librawDecoder.ts's OPEN_SETTINGS) — no
 * downstream per-channel gain (whiteBalance.ts's `gains()`, which is
 * IDENTITY by construction at the model's own as-shot temp/tint) can undo a
 * full 3×3 matrix error; a diagonal gain can only rescale channels, not
 * correct the hue rotation a wrong ColorMatrix produces. So the fix here is
 * a genuine 3×3 CORRECTIVE TRANSFORM, not a WB-slider-math tweak.
 *
 * DESIGN NOTE (a real bug caught and fixed during this pass, kept here as a
 * warning for the next person): the FIRST implementation tried to literally
 * "undo the decoder's own conversion" (via `cameraFromWorkingMatrix`, which
 * inverts libraw's OWN `camXyz`/`rgb_cam` — a matrix in LIBRAW's convention,
 * XYZ(D65) → camera DIRECTLY, no PCS step) and then reproject through the
 * mired-interpolated ColorMatrix — but ColorMatrix1/2 are defined by the DNG
 * spec against XYZ relative to the PCS white point (D50), NOT D65 directly.
 * Skipping the required D50↔D65 Bradford adaptation on that reprojection
 * step produced a badly wrong matrix (measured: DSC03298's near-neutral R/G
 * ratio blew out to 5.6× — WORSE than the original bug, not a fix). Mixing
 * libraw's convention (direct D65) with the DNG spec's convention (D50 PCS)
 * for the SAME matrix pair is the trap; the fix below never mixes them — it
 * computes the correction ENTIRELY inside the DNG-spec-correct D50 PCS route
 * for BOTH the interpolated matrix and its own D65 anchor, and takes the
 * RATIO between them:
 *
 *   F(t) = XYZ_D65_TO_REC2020 · BRADFORD_D50_TO_D65 · invert(lerp(ColorMatrix1, ColorMatrix2, t))   [camera-native → our Rec.2020 working space, DNG-spec-correct]
 *   correction = F(fraction) · F(1)⁻¹
 *
 * `F(1)` (pure ColorMatrix2, i.e. exactly D65 — the illuminant the shot's
 * own decode implicitly assumed) is composed with its OWN inverse first, so
 * the correction is EXACTLY the identity matrix whenever `fraction === 1`
 * (a shot right at ColorMatrix2's illuminant) BY CONSTRUCTION — no numeric
 * dependence on `camXyz`/`ColorMatrix2` actually agreeing bit-for-bit (they
 * don't need to; the ratio cancels any consistent systematic offset between
 * libraw's convention and the DNG-spec route). At `fraction < 1` this
 * applies exactly the RELATIVE color shift the mired interpolation implies,
 * to the decoded (already camXyz/D65-converted) working-space pixel
 * directly — no camera-native reconstruction, no `rgb_cam`, needed at all.
 *
 * Composed into ONE 3×3 matrix (`computeWbColorMatrixCorrection`), baked
 * into the SAME N³ residual-lattice shape the builtin profile fit already
 * uses (see wbCorrectedProfile.ts) so this needs no new WGSL/CPU pass —
 * trilinear interpolation reproduces an AFFINE function (a plain matrix
 * multiply) EXACTLY at every grid node, so composing it into the existing
 * profile lattice costs nothing in accuracy.
 *
 * Scope/exclusivity: this correction only feeds the BUILTIN profile source.
 * When profile.source is 'dcp' or 'acrlook', those pipelines already do a
 * FULL, DNG-spec-correct camera-native reconstruction + illuminant-
 * interpolated reprojection themselves (dcp/pipeline.ts's `renderDcpPixel`,
 * via ForwardMatrix when present), so applying this correction there too
 * would double-transform the pixel. See graphDoc.ts's DEVELOP_KIND branch,
 * which enforces this exclusivity structurally (the ternary only reaches
 * this correction in the 'builtin' arm).
 *
 * Graceful fallback (no local Adobe Standard DCP found, or it has only one
 * calibration illuminant, or the shot's estimated CCT already sits at
 * ColorMatrix2's own illuminant so `fraction === 1`): `null` — today's
 * behavior exactly.
 */
import { cameraFromWorkingMatrix, illuminantFraction, lerpMat3Flat } from './pipeline';
import {
  BRADFORD_D50_TO_D65,
  invertMat3 as invertMat3Dcp,
  mulMat3Mat3,
  XYZ_D65_TO_REC2020,
  type Mat3 as Mat3Dcp,
} from './matrices';
import { estimateFromUv, invertMat3 as invertMat3Wb, mulMat3Vec3 as mulMat3Vec3Wb, xyzToUv, type Mat3 as Mat3Wb } from '../whiteBalance';
import type { ParsedDcp } from './parser';

/** dcp/matrices.ts's readonly-tuple Mat3 → whiteBalance.ts's mutable number[][] Mat3 (the two modules' own local aliases for the same 3×3 shape — this is the one place they need to interoperate, for the CCT ESTIMATE ONLY — see `estimateTempThrough`). */
function toWbMat3(m: Mat3Dcp): Mat3Wb {
  return [[...m[0]], [...m[1]], [...m[2]]];
}

/**
 * CCT estimate of a camera-native neutral, through a given `camXyz`-
 * convention matrix (libraw's direct-D65 convention — see whiteBalance.ts's
 * own `WbModel.camXyz` doc comment) — the SAME inverse model
 * `createWbModel` runs internally, reused here (not re-derived) to keep the
 * iteration below in exact lockstep with the model the app already trusts.
 * Deliberately NOT used for the correction matrix itself (see this file's
 * doc comment on the D50-vs-D65 convention trap) — only for estimating
 * WHICH temperature to interpolate at, where libraw's own convention is
 * exactly what the rest of the app's CCT estimate already uses.
 */
function estimateTempThrough(camXyzConvention: Mat3Dcp, neutral: [number, number, number]): number {
  const inv = invertMat3Wb(toWbMat3(camXyzConvention));
  if (!inv) return 6500; // degenerate matrix — arbitrary safe fallback, only reachable for a pathological camXyz
  const xyz = mulMat3Vec3Wb(inv, neutral);
  return estimateFromUv(xyzToUv(xyz)).temp;
}

/** F(t) — camera-native → our Rec.2020 working space, via the DNG-spec-correct D50 PCS route (see this file's doc comment). */
function cameraToWorkingViaD50(colorMatrix: Mat3Dcp): Mat3Dcp {
  const camToXyzD50 = invertMat3Dcp(colorMatrix);
  return mulMat3Mat3(mulMat3Mat3(XYZ_D65_TO_REC2020, BRADFORD_D50_TO_D65), camToXyzD50);
}

/**
 * Compute the fix-① corrective matrix, or `null` when there's nothing to
 * correct (no DCP, single-illuminant DCP, or the shot's CCT lands exactly
 * at ColorMatrix2's own illuminant, `fraction === 1` — a true no-op).
 *
 * `camMul` — libraw's as-shot camera multipliers (`WbMeta.camMul`, [R,G,B,…])
 * — the same metadata `createWbModel` derives its own as-shot estimate from;
 * `camXyz` — the SAME matrix `whiteBalance.ts`'s `WbModel` already carries
 * (`wb.camXyz`) — used ONLY to estimate the shot's CCT (see
 * `estimateTempThrough`'s doc comment), never mixed into the correction
 * matrix itself.
 */
export function computeWbColorMatrixCorrection(dcp: ParsedDcp, camMul: readonly number[] | undefined, camXyz: Mat3Dcp): Mat3Dcp | null {
  if (dcp.calibrationIlluminant2 == null) return null; // single-illuminant profile — nothing to interpolate (documented fallback)
  if (!Array.isArray(camMul) || camMul.length < 3 || !camMul.slice(0, 3).every((v) => Number.isFinite(v) && v > 0)) return null;
  const neutral: [number, number, number] = [camMul[1]! / camMul[0]!, 1, camMul[1]! / camMul[2]!];

  // CCT↔matrix fixed-point iteration (brief: "the CCT↔matrix circularity is
  // standard — iterate"). 3 rounds converge well past slider-visible
  // precision in practice (round-2's own finding is that the as-shot
  // estimate is already close, so this moves little after the first pass).
  let tempK = estimateTempThrough(camXyz, neutral);
  let interpolatedForEstimate: Mat3Dcp = camXyz;
  let fraction = illuminantFraction(dcp, tempK);
  for (let i = 0; i < 3; i++) {
    fraction = illuminantFraction(dcp, tempK);
    interpolatedForEstimate = lerpMat3Flat(dcp.colorMatrix1, dcp.colorMatrix2 ?? dcp.colorMatrix1, fraction);
    const nextTemp = estimateTempThrough(interpolatedForEstimate, neutral);
    if (Math.abs(nextTemp - tempK) < 1) {
      tempK = nextTemp;
      break;
    }
    tempK = nextTemp;
  }
  fraction = illuminantFraction(dcp, tempK);

  if (fraction >= 1 - 1e-9) return null; // shot sits at (or above) ColorMatrix2's own illuminant — F(1)·F(1)⁻¹ is exactly identity, no-op

  const colorMatrix2 = dcp.colorMatrix2 ?? dcp.colorMatrix1;
  const interpolated = lerpMat3Flat(dcp.colorMatrix1, colorMatrix2, fraction);
  const fAtFraction = cameraToWorkingViaD50(interpolated);
  // reshape colorMatrix2 (flat) via the SAME lerp helper at t=1 (pure colorMatrix2) rather than a second ad hoc reshape function
  const fAtOne = cameraToWorkingViaD50(lerpMat3Flat(dcp.colorMatrix1, colorMatrix2, 1));
  const fAtOneInv = invertMat3Dcp(fAtOne);
  return mulMat3Mat3(fAtFraction, fAtOneInv);
}

/** Row-major 3×3 → a flat 9-array (row-major), the shape threaded through CompileContext/RenderWorkerCommand (structured-cloneable, unlike a nested readonly-tuple type). */
export function flattenMat3(m: Mat3Dcp): number[] {
  return [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]];
}

/** Inverse of `flattenMat3`. */
export function unflattenMat3(flat: readonly number[]): Mat3Dcp {
  return [
    [flat[0]!, flat[1]!, flat[2]!],
    [flat[3]!, flat[4]!, flat[5]!],
    [flat[6]!, flat[7]!, flat[8]!],
  ];
}
