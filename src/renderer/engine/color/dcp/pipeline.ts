/**
 * DNG 1.7 spec, chapter 6 ("Mapping Camera Color Space to CIE XYZ Space") +
 * the profile-rendering chapter (HueSatMap / LookTable / ProfileToneCurve) —
 * executed against a `ParsedDcp` (parser.ts). Every stage below cites the
 * spec concept it implements; where this implementation simplifies or
 * approximates, the simplification is called out explicitly (see also the
 * "camera-native RGB reconstruction" doc comments below — the render report
 * enumerates the rest).
 *
 * Pipeline, camera-native RGB in → working-space (linear Rec.2020, D65) RGB out:
 *
 *   1. reconstruct camera-native, as-shot-white-balanced RGB from the
 *      working-space pixel (see `exactCameraFromWorkingMatrix` /
 *      `approxCameraFromWorkingMatrix`'s doc comments)
 *   2. illuminant-interpolate ForwardMatrix (or invert ColorMatrix) by the
 *      shot's own CCT → camera RGB × M → XYZ (D50)                    [§6]
 *   3. XYZ (D50) → linear ProPhoto RGB (matrices.ts)
 *   4. linear ProPhoto RGB → HSV (V unclamped — DNG's profile pipeline keeps
 *      highlights above 1.0 meaningful, since the source is scene-referred)
 *   5. ProfileHueSatMap lookup (trilinear hue/sat/val; hue circular, val
 *      optionally sRGB-encoded before indexing) — hue/sat/val deltas applied
 *   6. ProfileLookTable lookup (identical structure, applied AFTER
 *      HueSatMap per spec precedence — deltas applied again)
 *   7. HSV → linear ProPhoto RGB
 *   8. ProfileToneCurve (per-channel identical spline, in sRGB-encoded
 *      domain — a documented Stage-1 simplification, see `applyToneCurve`)
 *   9. linear ProPhoto RGB → XYZ (D50) → Bradford-adapt → XYZ (D65) →
 *      linear Rec.2020 (our working space)
 *  10. BaselineExposureOffset: a final 2^offset gain on the result
 */
import { srgbDecode, srgbEncode } from '../srgb';
import { WORK_TO_SRGB } from '../workingSpace';
import {
  BRADFORD_D50_TO_D65,
  invertMat3,
  mulMat3Mat3,
  mulMat3Vec3,
  PROPHOTO_TO_XYZ_D50,
  REC2020_TO_XYZ_D65,
  XYZ_D50_TO_PROPHOTO,
  XYZ_D65_TO_REC2020,
  type Mat3,
  type Vec3,
} from './matrices';
import { illuminantCct } from './tiffTags';
import type { HueSatTable, Mat3Flat, ParsedDcp, ToneCurve } from './parser';

function reshapeMat3(flat: Mat3Flat): Mat3 {
  return [
    [flat[0], flat[1], flat[2]],
    [flat[3], flat[4], flat[5]],
    [flat[6], flat[7], flat[8]],
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpMat3Flat(a: Mat3Flat, b: Mat3Flat, t: number): Mat3 {
  const out = new Array(9) as number[];
  for (let i = 0; i < 9; i++) out[i] = lerp(a[i]!, b[i]!, t);
  return reshapeMat3(out as unknown as Mat3Flat);
}

/**
 * Interpolation fraction (0 = CalibrationIlluminant1, 1 = CalibrationIlluminant2,
 * clamped to that range) from the SHOT's own white-balance CCT — per the
 * brief: "interpolate matrices... by inverse correlated color temperature of
 * the shot's white balance" (mired-linear, the DNG-standard convention; NOT
 * the user's live temp/tint slider — see whiteBalance.ts's `asShot`, and this
 * pass's position FIRST in the Develop chain, before any user WB edit).
 * Fancier per-spec white-point solving (beyond linear 2-point mired
 * interpolation) is explicitly deferred (brief).
 */
export function illuminantFraction(dcp: ParsedDcp, asShotTempK: number): number {
  if (dcp.calibrationIlluminant2 == null) return 0;
  const cct1 = illuminantCct(dcp.calibrationIlluminant1);
  const cct2 = illuminantCct(dcp.calibrationIlluminant2);
  if (cct1 === cct2) return 0;
  const mired1 = 1e6 / cct1;
  const mired2 = 1e6 / cct2;
  const miredShot = 1e6 / Math.max(1, asShotTempK);
  const t = (miredShot - mired1) / (mired2 - mired1);
  return Math.min(1, Math.max(0, t));
}

/**
 * Camera RGB → XYZ (D50) matrix, illuminant-interpolated. ForwardMatrix is
 * preferred (spec §6.1: it maps camera-neutral-balanced RGB directly to
 * XYZ D50); when absent, the ColorMatrix inverse route (spec §6.2/6.3) is
 * used instead — CameraCalibration/AnalogBalance composition is explicitly
 * deferred (brief), so this is ColorMatrix's raw inverse, which is exact
 * when a profile carries no CameraCalibration (the common case) and an
 * approximation otherwise.
 */
export function cameraToXyzD50Matrix(dcp: ParsedDcp, fraction: number): Mat3 {
  if (dcp.forwardMatrix1) {
    const fm2 = dcp.forwardMatrix2 ?? dcp.forwardMatrix1;
    return lerpMat3Flat(dcp.forwardMatrix1, fm2, fraction);
  }
  const cm2 = dcp.colorMatrix2 ?? dcp.colorMatrix1;
  const colorMatrix = lerpMat3Flat(dcp.colorMatrix1, cm2, fraction);
  return invertMat3(colorMatrix);
}

/**
 * STAGE 2 — exact camera-native RGB reconstruction (replaces the Stage-1
 * approximation below). Root cause of the Stage-1 green cast: it inverted
 * our Rec.2020 working pixel through `camXyz` (XYZ→camera), a matrix libraw
 * never actually applies to a WB'd, demosaiced pixel — it skipped the WB
 * scaling entirely and used the wrong normalization convention. The fix is
 * to invert the LITERAL matrix libraw used instead.
 *
 * Provenance (LibRaw / dcraw `cam_xyz_coeff`, `src/utils/utils_dcraw.cpp` —
 * read from the public LibRaw GitHub source; relationship replicated below,
 * no LibRaw code copied):
 *
 *   cam_rgb[i][j]  = Σ_k cam_xyz[i][k] · xyz_rgb[k][j]     // camera-from-sRGB(D65)
 *   pre_mul[i]     = 1 / Σ_j cam_rgb[i][j]                 // implied per-channel WB
 *   cam_rgb[i][*] /= Σ_j cam_rgb[i][j]                     // row-normalize (⇒ WB'd input)
 *   rgb_cam        = pseudoinverse(cam_rgb)                // sRGB(D65)-from-camera(WB'd)
 *
 * `rgb_cam` therefore maps the ALREADY as-shot-WB'd, demosaiced camera-native
 * RGB (the row-normalization folds the implied WB into the matrix) to linear
 * sRGB D65 — libraw-wasm exposes this exact matrix as `color_data.rgb_cam`
 * ("3x4 camera-to-sRGB matrix"; see librawDecoder.ts / RawDecoder.ts).
 * `convert_to_rgb()` then composes it with the requested output colorspace
 * table (`out_cam = out_rgb[outputColor-1] · rgb_cam`) before applying it
 * per pixel; for our decoder's `outputColor` (Rec.2020, DECODE_OUTPUT_COLOR),
 * `out_rgb[...]` is the standard sRGB(D65)→Rec.2020(D65) primaries matrix —
 * i.e. workingSpace.ts's `SRGB_TO_WORK`, here reached via its exact inverse
 * `WORK_TO_SRGB` (both D65; reused rather than re-derived a second time in
 * this module's own matrix family, since it's THE canonical working-space
 * boundary conversion — workingSpace.ts's own charter — and duplicating it
 * would risk a rounding mismatch that defeats the whole point of this fix).
 *
 * So: workingRgb = SRGB_TO_WORK · rgb_cam · cameraWbRgb, and inverting both
 * factors recovers cameraWbRgb EXACTLY (up to libraw's own float32 precision
 * and highlight-recovery clipping) — not a second approximating model, the
 * literal matrix libraw applied, run backward.
 */
export function exactCameraFromWorkingMatrix(rgbCam: Mat3): Mat3 {
  return mulMat3Mat3(invertMat3(rgbCam), WORK_TO_SRGB);
}

/**
 * STAGE-1 APPROXIMATION — kept as the fallback path for inputs where the
 * decoder didn't expose `rgb_cam` (see `exactCameraFromWorkingMatrix`'s doc
 * comment for the exact route, which is preferred whenever available).
 *
 * The DNG spec's ColorMatrix/ForwardMatrix are defined against true
 * PRE-libraw sensor RGB, but Silverbox's decoder (librawDecoder.ts) hands
 * back pixels already converted to linear Rec.2020. Absent `rgb_cam`, this
 * inverts libraw's XYZ→camera matrix (`camXyz`, the same one whiteBalance.ts
 * carries for its own WB math) instead: workingRGB → XYZ (D65, standard
 * primaries conversion) → `camXyz` → an approximate camera-native RGB. This
 * ignores libraw's actual WB scaling and normalization convention, so it is
 * markedly less accurate than the exact route (the documented source of
 * Stage 1's green cast) — a fallback of last resort, not a target.
 */
export function approxCameraFromWorkingMatrix(camXyzD65: Mat3): Mat3 {
  return mulMat3Mat3(camXyzD65, REC2020_TO_XYZ_D65);
}

/**
 * Pick the exact route when `rgbCam` is available (the decoder exposed
 * libraw's own matrix — see `exactCameraFromWorkingMatrix`), else fall back
 * to the `camXyz` approximation (`approxCameraFromWorkingMatrix`).
 */
export function cameraFromWorkingMatrix(rgbCam: Mat3 | null, camXyzD65: Mat3): Mat3 {
  return rgbCam ? exactCameraFromWorkingMatrix(rgbCam) : approxCameraFromWorkingMatrix(camXyzD65);
}

/** Apply a precomposed camera-from-working matrix (see `cameraFromWorkingMatrix`) to one working-space pixel. */
export function cameraNativeFromWorking(workingRgb: Vec3, cameraFromWorking: Mat3): Vec3 {
  return mulMat3Vec3(cameraFromWorking, workingRgb);
}

// --- HSV (V unclamped) ------------------------------------------------------

/** RGB → HSV; H in degrees [0,360), S in [0,1], V UNCLAMPED (matches the DNG profile pipeline's own convention — see this file's doc comment). Negative input components are clamped to 0 first (out-of-gamut safety). */
export function rgbToHsv(rgbIn: Vec3): [number, number, number] {
  const r = Math.max(rgbIn[0], 0);
  const g = Math.max(rgbIn[1], 0);
  const b = Math.max(rgbIn[2], 0);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max > 0 ? delta / max : 0;
  let h: number;
  if (delta === 0) h = 0;
  else if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;
  return [h, Math.min(Math.max(s, 0), 1), v];
}

/** HSV → RGB, inverse of `rgbToHsv` (V unclamped: a V > 1 produces components > 1, preserved for scene-referred highlights). */
export function hsvToRgb([h, s, v]: readonly [number, number, number]): Vec3 {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1: number, g1: number, b1: number;
  if (hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  return [r1 + m, g1 + m, b1 + m];
}

// --- HueSatMap / LookTable (identical shape, spec-defined trilinear grid) ----

/**
 * Trilinear (or bilinear when valDivisions === 1 — the spec's documented 2D
 * special case) lookup into a HueSatMap/LookTable grid. Hue is CIRCULAR
 * (wraps at the 360°/0° boundary, matching the color wheel it samples); sat
 * and val are clamped-edge axes (spec: divisions span exactly [0,1], no
 * wraparound). `vCoord` is the ALREADY-ENCODED value lookup coordinate (see
 * `valueLookupCoord`) — the table itself doesn't know about encoding.
 */
export function lookupTable(table: HueSatTable, hueDeg: number, sat: number, vCoord: number): [number, number, number] {
  const [H, S, V] = table.dims;
  const hueStep = 360 / H;
  const hf = ((((hueDeg % 360) + 360) % 360) / hueStep) % H;
  const hi0 = Math.floor(hf) % H;
  const hi1 = (hi0 + 1) % H;
  const hFrac = H > 1 ? hf - Math.floor(hf) : 0;

  const sClamped = Math.min(Math.max(sat, 0), 1);
  const sf = S > 1 ? sClamped * (S - 1) : 0;
  const si0 = S > 1 ? Math.min(S - 2, Math.floor(sf)) : 0;
  const si1 = S > 1 ? si0 + 1 : 0;
  const sFrac = S > 1 ? sf - si0 : 0;

  const vClamped = Math.min(Math.max(vCoord, 0), 1);
  const vf = V > 1 ? vClamped * (V - 1) : 0;
  const vi0 = V > 1 ? Math.min(V - 2, Math.floor(vf)) : 0;
  const vi1 = V > 1 ? vi0 + 1 : 0;
  const vFrac = V > 1 ? vf - vi0 : 0;

  const at = (hi: number, si: number, vi: number): [number, number, number] => {
    const idx = ((hi * S + si) * V + vi) * 3;
    return [table.data[idx]!, table.data[idx + 1]!, table.data[idx + 2]!];
  };

  let dh = 0;
  let ds = 0;
  let dv = 0;
  for (let a = 0; a < 2; a++) {
    const hi = a === 0 ? hi0 : hi1;
    const wh = a === 0 ? 1 - hFrac : hFrac;
    if (wh === 0) continue;
    for (let b = 0; b < 2; b++) {
      const si = b === 0 ? si0 : si1;
      const ws = b === 0 ? 1 - sFrac : sFrac;
      if (ws === 0) continue;
      for (let c = 0; c < 2; c++) {
        const vi = c === 0 ? vi0 : vi1;
        const wv = c === 0 ? 1 - vFrac : vFrac;
        if (wv === 0) continue;
        const w = wh * ws * wv;
        const [th, ts, tv] = at(hi, si, vi);
        dh += w * th;
        ds += w * ts;
        dv += w * tv;
      }
    }
  }
  return [dh, ds, dv];
}

/** The lookup coordinate for the value axis: sRGB-encode (via the shared exact helper) when the table's encoding tag says so, else linear — spec's ProfileHueSatMapEncoding/ProfileLookTableEncoding. `v` may exceed 1 (unclamped HSV); clamped to [0,1] before encoding, same convention TONECURVE_WGSL uses for its own >1-highlights domain clamp. */
export function valueLookupCoord(v: number, encoding: 'linear' | 'sRGB'): number {
  const clamped = Math.min(Math.max(v, 0), 1);
  return encoding === 'sRGB' ? srgbEncode(clamped) : clamped;
}

/** Blend two same-shaped tables by `fraction` (illuminant interpolation); returns `a` unchanged when `b` is absent or the shapes disagree (documented single-illuminant fallback). */
export function blendTables(a: HueSatTable, b: HueSatTable | null, fraction: number): HueSatTable {
  if (!b || b.dims[0] !== a.dims[0] || b.dims[1] !== a.dims[1] || b.dims[2] !== a.dims[2]) return a;
  const out = new Float32Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = lerp(a.data[i]!, b.data[i]!, fraction);
  return { dims: a.dims, data: out };
}

// --- ProfileToneCurve --------------------------------------------------------

/**
 * Evaluate a DNG ProfileToneCurve at `x` ∈ [0,1] — PIECEWISE LINEAR between
 * its control points (flat-extrapolated past the first/last point).
 *
 * STAGE-1 SIMPLIFICATION: the DNG SDK's real curve is a smooth spline
 * through the same control points; piecewise-linear is monotonic-preserving
 * and (unlike a spline) trivially hand-computable for the golden-math verify
 * fixture, at the cost of a slightly less smooth curve on a coarse control-
 * point set — negligible for the dense curves real profiles ship (100+
 * points), and irrelevant for the fixture's own 2-3 point synthetic curve.
 */
export function evalToneCurve(points: readonly (readonly [number, number])[], x: number): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i]!;
    if (x <= p1[0]) {
      const p0 = points[i - 1]!;
      const f = (x - p0[0]) / (p1[0] - p0[0]);
      return p0[1] + (p1[1] - p0[1]) * f;
    }
  }
  return last[1];
}

/**
 * Apply the tone curve identically to R/G/B ("RGB" method — the common case;
 * DNG also allows a "PerChannel" method this Stage-1 implementation does not
 * distinguish, since ProfileToneCurve alone doesn't carry a method tag).
 * Domain: sRGB-ENCODED (via the shared exact srgb.ts helpers, per the engine
 * invariant), clamped to [0,1] first exactly like TONECURVE_WGSL's own
 * >1-highlights convention — a documented Stage-1 choice of encoding domain
 * (see this file's doc comment); the curve's SHAPE is spec data either way.
 */
export function applyToneCurve(curve: ToneCurve, rgb: Vec3): Vec3 {
  const ch = (v: number): number => srgbDecode(evalToneCurve(curve.points, srgbEncode(Math.min(Math.max(v, 0), 1))));
  return [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
}

// --- Full pipeline -----------------------------------------------------------

/**
 * Render one working-space (linear Rec.2020) pixel through the DCP pipeline,
 * returning the working-space result (same space, so the caller can treat
 * this as a drop-in replacement / residual source — see `bakeDcpLattice`).
 *
 * `cameraFromWorking` is the PRECOMPOSED matrix from `cameraFromWorkingMatrix`
 * (exact `rgb_cam`-based route when available, else the `camXyz` fallback) —
 * computed once by the caller rather than per pixel, since it never varies
 * within one bake.
 */
export function renderDcpPixel(dcp: ParsedDcp, workingRgb: Vec3, cameraFromWorking: Mat3, asShotTempK: number): Vec3 {
  const fraction = illuminantFraction(dcp, asShotTempK);
  const camToXyz = cameraToXyzD50Matrix(dcp, fraction);
  const cameraRgb = cameraNativeFromWorking(workingRgb, cameraFromWorking);
  const xyzD50 = mulMat3Vec3(camToXyz, cameraRgb);
  const prophotoLin = mulMat3Vec3(XYZ_D50_TO_PROPHOTO, xyzD50);

  let [h, s, v] = rgbToHsv(prophotoLin);

  if (dcp.hueSatMap1) {
    const table = blendTables(dcp.hueSatMap1, dcp.hueSatMap2, fraction);
    const vCoord = valueLookupCoord(v, dcp.hueSatMapEncoding);
    const [dh, sScale, vScale] = lookupTable(table, h, s, vCoord);
    h = ((h + dh) % 360 + 360) % 360;
    s = Math.min(Math.max(s * sScale, 0), 1);
    v = v * vScale;
  }
  if (dcp.lookTable) {
    const vCoord = valueLookupCoord(v, dcp.lookTableEncoding);
    const [dh, sScale, vScale] = lookupTable(dcp.lookTable, h, s, vCoord);
    h = ((h + dh) % 360 + 360) % 360;
    s = Math.min(Math.max(s * sScale, 0), 1);
    v = v * vScale;
  }

  let rgbAdjusted = hsvToRgb([h, s, v]);
  if (dcp.toneCurve) rgbAdjusted = applyToneCurve(dcp.toneCurve, rgbAdjusted);

  const xyzD50Out = mulMat3Vec3(PROPHOTO_TO_XYZ_D50, rgbAdjusted);
  const xyzD65Out = mulMat3Vec3(BRADFORD_D50_TO_D65, xyzD50Out);
  const workingOut = mulMat3Vec3(XYZ_D65_TO_REC2020, xyzD65Out);
  const gain = Math.pow(2, dcp.baselineExposureOffset);
  return [workingOut[0] * gain, workingOut[1] * gain, workingOut[2] * gain];
}

/**
 * Bake a composed camera-RGB→working-RGB transform as an N³ RESIDUAL lattice
 * — the EXACT same shape profileFit.ts's fitted lattice uses (grid node
 * (ix,iy,iz) ↔ input [ix,iy,iz]/(N-1); flat layout `((ix*N+iy)*N+iz)*3+c`),
 * so it can be sampled through the IDENTICAL trilinear WGSL/CPU pair
 * (developNode.ts's PROFILE_WGSL / profileFit.ts's `profileResidual`) —
 * chosen deliberately (see the render report's "GPU LUT strategy" note) so
 * DCP mode needs no new shader code and inherits that pair's already-proven
 * GPU/CPU parity for free. `n` is normally `PROFILE_LATTICE_N`
 * (profileFit.ts) — passed in rather than imported to keep this module
 * independent of profileFit.ts's own concerns.
 *
 * `cameraFromWorking` — see `renderDcpPixel`'s doc comment — is built ONCE by
 * the caller (`cameraFromWorkingMatrix`) and reused across all n³ nodes.
 */
export function bakeDcpLattice(dcp: ParsedDcp, cameraFromWorking: Mat3, asShotTempK: number, n: number): number[] {
  const out = new Array<number>(n * n * n * 3);
  for (let ix = 0; ix < n; ix++) {
    const r = ix / (n - 1);
    for (let iy = 0; iy < n; iy++) {
      const g = iy / (n - 1);
      for (let iz = 0; iz < n; iz++) {
        const b = iz / (n - 1);
        const rendered = renderDcpPixel(dcp, [r, g, b], cameraFromWorking, asShotTempK);
        const base = ((ix * n + iy) * n + iz) * 3;
        out[base] = rendered[0] - r;
        out[base + 1] = rendered[1] - g;
        out[base + 2] = rendered[2] - b;
      }
    }
  }
  return out;
}
