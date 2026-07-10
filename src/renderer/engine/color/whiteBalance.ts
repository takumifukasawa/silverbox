/**
 * White-balance color model (REBUILD-SPEC §7) — real Kelvin Temp /
 * green–magenta Tint.
 *
 * The decoder keeps useCameraWb, so the working image is ALREADY as-shot
 * white balanced; the WB stage applies a RELATIVE per-channel gain
 *
 *     gain = m(temp, tint) / m(asShotTemp, asShotTint)
 *
 * where m() is the forward model below (target white point → camera-RGB
 * multipliers via cam_xyz). Numerator and denominator run the exact same
 * float computation, so at the as-shot slider values the gain is exactly
 * [1,1,1] (IEEE x/x = 1) — and callers skip the pass entirely there,
 * keeping the pass-through bit-identical.
 *
 * Color science (deliberately approximate; strict Lightroom parity is a
 * non-goal):
 *  - Planckian locus by integrating Planck's law against the CIE 1931 2°
 *    color matching functions (multi-lobe piecewise-Gaussian analytic fit,
 *    Wyman–Sloan–Shirley 2013 — xy error ≲0.001, valid at any temperature).
 *  - As-shot CCT: nearest point on the true locus in CIE 1960 uv (coarse
 *    mired scan + golden-section refine); McCamy's closed form is kept as a
 *    diagnostic. Tint = signed Δuv from the locus × 3000 (DNG-like scale,
 *    positive = magenta correction, Lightroom's direction).
 *  - Camera matrix: libraw cam_xyz (XYZ → camera RGB); first 3 rows of the
 *    4x3. Single fixed matrix (no dual-illuminant interpolation).
 */

import { SRGB_TO_WORK } from './workingSpace';

export const WB_TEMP_RANGE = { min: 2000, max: 50000 } as const;
export const WB_TINT_RANGE = { min: -150, max: 150 } as const;

export interface WbTempTint {
  temp: number;
  tint: number;
}

/** Per-image WB model: as-shot estimate + (temp,tint) → relative gains. */
export interface WbModel {
  asShot: WbTempTint;
  /** As-shot camera multipliers through the forward model (G = 1). */
  mAsShot: [number, number, number];
  /** McCamy closed-form CCT of the as-shot white point (diagnostic). */
  mccamyCct: number;
  /** Relative WB gains vs as-shot; exactly [1,1,1] at the as-shot values. */
  gains(temp: number, tint: number): [number, number, number];
}

/** Tint slider units per unit Δuv (DNG order of magnitude). */
const TINT_SCALE = 3000;

// --- CIE 1931 2° CMFs — analytic multi-lobe fit (Wyman/Sloan/Shirley 2013) ---

function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

function cmfX(l: number): number {
  return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
}
function cmfY(l: number): number {
  return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
}
function cmfZ(l: number): number {
  return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
}

// --- Planckian locus in CIE 1960 uv ------------------------------------------

/** Second radiation constant c2 = hc/k in nm·K. */
const C2 = 1.4388e7;

interface Uv {
  u: number;
  v: number;
}

/** Blackbody chromaticity at T kelvin (CIE 1960 uv) by direct integration. */
export function planckUv(T: number): Uv {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let l = 360; l <= 830; l += 5) {
    // relative spectral radiance — common factors cancel in the chromaticity
    const M = Math.pow(l, -5) / Math.expm1(C2 / (l * T));
    X += M * cmfX(l);
    Y += M * cmfY(l);
    Z += M * cmfZ(l);
  }
  return xyzToUv([X, Y, Z]);
}

function xyzToUv([X, Y, Z]: [number, number, number]): Uv {
  const d = X + 15 * Y + 3 * Z;
  return { u: (4 * X) / d, v: (6 * Y) / d };
}

function uvToXy({ u, v }: Uv): [number, number] {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/**
 * Unit normal to the locus at T pointing to the GREEN side (+v-ish).
 * Positive tint moves the assumed illuminant this way, i.e. the correction
 * pushes the image toward magenta (Lightroom's slider direction).
 */
function greenNormal(T: number): Uv {
  const mired = 1e6 / T;
  const a = planckUv(1e6 / (mired + 0.5));
  const b = planckUv(1e6 / (mired - 0.5));
  let nu = -(b.v - a.v);
  let nv = b.u - a.u;
  const len = Math.hypot(nu, nv);
  nu /= len;
  nv /= len;
  if (nv < 0) {
    nu = -nu;
    nv = -nv;
  }
  return { u: nu, v: nv };
}

/** McCamy's CCT approximation from xy (diagnostic only). */
export function mccamyCct(x: number, y: number): number {
  const n = (x - 0.332) / (y - 0.1858);
  return -449 * n ** 3 + 3525 * n ** 2 - 6823.3 * n + 5520.33;
}

// --- 3x3 matrix helpers --------------------------------------------------------

type Mat3 = number[][];
type Vec3 = [number, number, number];

function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
    m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
    m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
  ];
}

function mulMat3Mat3(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i]![j] = a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!;
    }
  }
  return out;
}

function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c] = m[0] as [number, number, number];
  const [d, e, f] = m[1] as [number, number, number];
  const [g, h, i] = m[2] as [number, number, number];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}

/** XYZ → linear sRGB (D65). */
const XYZ_TO_SRGB: Mat3 = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

/**
 * XYZ → linear Rec.2020 (D65) — the fallback "camera" when cam_xyz is absent
 * (e.g. JPG). Targets the WORKING-SPACE primaries so the WB gains it produces
 * are correct in the space the image actually lives in. Composed from the
 * working-space matrix so there is no second set of magic numbers; both sRGB
 * and Rec.2020 share the D65 white, so a neutral still lands on the locus
 * (the JPG as-shot estimate stays near 6500 K — verified).
 */
const XYZ_TO_REC2020: Mat3 = mulMat3Mat3(SRGB_TO_WORK, XYZ_TO_SRGB);

// --- forward model: (temp, tint) → camera multipliers ---------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampTemp = (t: number): number => clamp(t, WB_TEMP_RANGE.min, WB_TEMP_RANGE.max);
const clampTint = (t: number): number => clamp(t, WB_TINT_RANGE.min, WB_TINT_RANGE.max);

/** Target white point → camera-RGB multipliers, G-normalized. */
function tempTintToMul(temp: number, tint: number, camXyz: Mat3): Vec3 {
  const T = clampTemp(temp);
  const locus = planckUv(T);
  const n = greenNormal(T);
  const off = clampTint(tint) / TINT_SCALE;
  const [x, y] = uvToXy({ u: locus.u + off * n.u, v: locus.v + off * n.v });
  const xyz: Vec3 = [x / y, 1, (1 - x - y) / y];
  const cam = mulMat3Vec3(camXyz, xyz);
  // guard against degenerate matrices / extreme chromaticities
  const r = Math.max(cam[0], 1e-6);
  const g = Math.max(cam[1], 1e-6);
  const b = Math.max(cam[2], 1e-6);
  return [g / r, 1, g / b];
}

// --- inverse model: camera neutral (cam_mul) → as-shot (temp, tint) -------------

/**
 * CCT/tint of the white point `uv`: nearest locus point (coarse mired scan +
 * golden-section refine — robust at any temperature) and the signed Δuv
 * along the green normal, rounded to slider granularity (the doc stores
 * these rounded values and pass-skip compares against them exactly).
 */
function estimateFromUv(uv: Uv): WbTempTint {
  const miredMin = 1e6 / WB_TEMP_RANGE.max;
  const miredMax = 1e6 / WB_TEMP_RANGE.min;
  const d2 = (mired: number): number => {
    const p = planckUv(1e6 / mired);
    return (uv.u - p.u) ** 2 + (uv.v - p.v) ** 2;
  };

  let bestMired = miredMin;
  let bestD = Infinity;
  for (let m = miredMin; m <= miredMax; m += 2) {
    const d = d2(m);
    if (d < bestD) {
      bestD = d;
      bestMired = m;
    }
  }
  let lo = Math.max(miredMin, bestMired - 2);
  let hi = Math.min(miredMax, bestMired + 2);
  const phi = (Math.sqrt(5) - 1) / 2;
  let m1 = hi - phi * (hi - lo);
  let m2 = lo + phi * (hi - lo);
  let f1 = d2(m1);
  let f2 = d2(m2);
  for (let i = 0; i < 40 && hi - lo > 1e-4; i++) {
    if (f1 < f2) {
      hi = m2;
      m2 = m1;
      f2 = f1;
      m1 = hi - phi * (hi - lo);
      f1 = d2(m1);
    } else {
      lo = m1;
      m1 = m2;
      f1 = f2;
      m2 = lo + phi * (hi - lo);
      f2 = d2(m2);
    }
  }
  const T = 1e6 / ((lo + hi) / 2);
  const locus = planckUv(T);
  const n = greenNormal(T);
  const duv = (uv.u - locus.u) * n.u + (uv.v - locus.v) * n.v;
  return {
    temp: Math.round(clampTemp(T)),
    tint: Math.round(clampTint(duv * TINT_SCALE)),
  };
}

// --- per-image model -------------------------------------------------------------

/** The decode-metadata pieces this model needs (structural for testability). */
export interface WbMeta {
  /** As-shot WB multipliers [R,G,B,(G2)] (libraw cam_mul). */
  camMul?: number[];
  /** XYZ→camera matrix, 4x3 from libraw (first 3 rows used). */
  camXyz?: number[][];
}

function pickCamXyz(meta: WbMeta): Mat3 {
  const m = meta.camXyz;
  if (
    Array.isArray(m) &&
    m.length >= 3 &&
    m.slice(0, 3).every((row) => Array.isArray(row) && row.length >= 3 && row.slice(0, 3).every(Number.isFinite))
  ) {
    const top = m.slice(0, 3).map((row) => row.slice(0, 3));
    // all-zero rows happen when libraw has no color profile for the camera
    if (top.some((row) => row.some((v) => v !== 0)) && invertMat3(top)) return top;
  }
  return XYZ_TO_REC2020;
}

/**
 * Build the per-image WB model. Never throws: missing / degenerate metadata
 * falls back to "camera = Rec.2020 (the working space), neutral = D65" (as-shot
 * ≈ 6500 K; D65 sits slightly green of the locus, so tint lands mildly
 * positive).
 */
export function createWbModel(meta: WbMeta): WbModel {
  const camXyz = pickCamXyz(meta);

  // camera response of the scene illuminant ∝ 1/cam_mul (G-normalized)
  let neutral: Vec3 = [1, 1, 1];
  const cm = meta.camMul;
  if (Array.isArray(cm) && cm.length >= 3 && cm.slice(0, 3).every((v) => Number.isFinite(v) && v > 0)) {
    neutral = [cm[1]! / cm[0]!, 1, cm[1]! / cm[2]!];
  }

  const inv = invertMat3(camXyz)!; // pickCamXyz guarantees invertibility
  const xyz = mulMat3Vec3(inv, neutral);
  const uv = xyzToUv(xyz);
  const [x, y] = uvToXy(uv);

  const asShot = estimateFromUv(uv);
  const mAsShot = tempTintToMul(asShot.temp, asShot.tint, camXyz);

  return {
    asShot,
    mAsShot,
    mccamyCct: mccamyCct(x, y),
    gains(temp: number, tint: number): [number, number, number] {
      // temp 0 is the unresolved as-shot placeholder — stay total here
      const t = temp > 0 ? temp : asShot.temp;
      const ti = temp > 0 ? tint : asShot.tint;
      if (t === asShot.temp && ti === asShot.tint) return [1, 1, 1]; // exact pass-through
      const m = tempTintToMul(t, ti, camXyz);
      return [m[0] / mAsShot[0], 1, m[2] / mAsShot[2]];
    },
  };
}

/** Fallback model for contexts without an image. */
export const DEFAULT_WB_MODEL: WbModel = createWbModel({});

// --- WB eyedropper: solve (temp, tint) that neutralizes a sampled pixel ------

/** Golden-section minimize of a unimodal f(x) over [lo, hi]. */
function goldenMinimize(f: (x: number) => number, lo0: number, hi0: number, iters: number): number {
  let lo = lo0;
  let hi = hi0;
  const phi = (Math.sqrt(5) - 1) / 2;
  let m1 = hi - phi * (hi - lo);
  let m2 = lo + phi * (hi - lo);
  let f1 = f(m1);
  let f2 = f(m2);
  for (let i = 0; i < iters; i++) {
    if (f1 < f2) {
      hi = m2;
      m2 = m1;
      f2 = f1;
      m1 = hi - phi * (hi - lo);
      f1 = f(m1);
    } else {
      lo = m1;
      m1 = m2;
      f1 = f2;
      m2 = lo + phi * (hi - lo);
      f2 = f(m2);
    }
  }
  return (lo + hi) / 2;
}

/**
 * WB eyedropper solver: find (temp, tint) so that `model.gains(temp, tint)`
 * applied to `rgb` (a decoded, linear working-space pixel) becomes neutral
 * (r' = g' = b'). Since `gains()` always returns [gr, 1, gb] (G-normalized —
 * see WbModel.gains), neutrality means `r*gr = g = b*gb`, i.e. the target
 * gain pair is fully determined by the ratio of `rgb`'s channels; the solver
 * just has to find which (temp, tint) the per-image model produces that gain
 * pair for.
 *
 * Small, robust coordinate-descent: alternately golden-section-minimize the
 * temp axis (which mostly separates R from B) against `(errR − errB)²`, then
 * the tint axis (which mostly moves G against R+B) against `(errR + errB)²`,
 * for a few rounds. Bounded to the UI's slider ranges; ~1e-3-of-range
 * practical convergence in well under the iteration budget below.
 */
export function solveNeutralWb(rgb: readonly [number, number, number], model: WbModel): WbTempTint {
  const [r, g, b] = rgb;
  const errorsAt = (temp: number, tint: number): { errR: number; errB: number } => {
    const [gr, , gb] = model.gains(temp, tint);
    return { errR: r * gr - g, errB: b * gb - g };
  };

  let temp = clampTemp(model.asShot.temp);
  let tint = clampTint(model.asShot.tint);
  const ROUNDS = 8;
  const ITERS_PER_AXIS = 48;
  for (let round = 0; round < ROUNDS; round++) {
    temp = goldenMinimize(
      (t) => {
        const { errR, errB } = errorsAt(t, tint);
        return (errR - errB) * (errR - errB);
      },
      WB_TEMP_RANGE.min,
      WB_TEMP_RANGE.max,
      ITERS_PER_AXIS
    );
    tint = goldenMinimize(
      (ti) => {
        const { errR, errB } = errorsAt(temp, ti);
        const avg = (errR + errB) / 2;
        return avg * avg;
      },
      WB_TINT_RANGE.min,
      WB_TINT_RANGE.max,
      ITERS_PER_AXIS
    );
  }
  return { temp: Math.round(clampTemp(temp)), tint: Math.round(clampTint(tint)) };
}
