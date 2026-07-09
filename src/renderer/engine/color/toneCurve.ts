/**
 * Tone curve math (REBUILD-SPEC §8) — control points → monotone cubic
 * (PCHIP / Fritsch–Butland) interpolation → LUT.
 *
 * Domain/range are Lightroom-style display units (0–255): the curve is
 * APPLIED IN DISPLAY (sRGB-encoded) SPACE — the Develop pass encodes linear
 * → sRGB, runs the per-channel LUT, and decodes back.
 *
 * Interpolation properties:
 *   - PCHIP never overshoots its data range between two points (no ringing
 *     on extreme S-curves); outputs are clamped to 0–255 when baking.
 *   - Non-monotone data (creative dips) is allowed and followed.
 *   - Outside the endpoints the curve extends FLAT — endpoint drags behave
 *     as black-point / white-point controls.
 *   - Collinear points reproduce the straight line, so the identity point
 *     set is the identity curve (still pass-skipped for bit-exactness).
 */
import { CURVE_MAX, isIdentityCurve, type CurvePoints, type ToneCurveParams } from '../graph/developNode';

/** LUT entries per channel (shader lerps between entries). */
export const TONE_CURVE_LUT_SIZE = 1024;

/**
 * Normalize an untrusted point list: finite [x,y] pairs clamped to 0..255,
 * sorted by x, duplicate x dropped (first kept). Returns null when it is
 * structurally unusable (< 2 valid points).
 */
export function sanitizeCurvePoints(raw: unknown): CurvePoints | null {
  if (!Array.isArray(raw)) return null;
  const pts: CurvePoints = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    pts.push([Math.min(CURVE_MAX, Math.max(0, p[0])), Math.min(CURVE_MAX, Math.max(0, p[1]))]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const out: CurvePoints = [];
  for (const p of pts) {
    if (out.length > 0 && out[out.length - 1]![0] === p[0]) continue;
    out.push(p);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Curve evaluator from sanitized points (sorted, strictly increasing x,
 * ≥ 2 points). Returns y(x) in 0..CURVE_MAX.
 */
export function curveEvaluator(points: CurvePoints): (x: number) => number {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);

  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  }

  // Fritsch–Butland tangents: harmonic mean of neighbouring secants where
  // they agree in sign, 0 at local extrema → no overshoot between points.
  const m: number[] = new Array(n);
  if (n === 2) {
    m[0] = d[0]!;
    m[1] = d[0]!;
  } else {
    m[0] = d[0]!;
    m[n - 1] = d[n - 2]!;
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1]! * d[i]! <= 0) {
        m[i] = 0;
      } else {
        const w1 = 2 * h[i]! + h[i - 1]!;
        const w2 = h[i]! + 2 * h[i - 1]!;
        m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!);
      }
    }
  }

  return (x: number): number => {
    // flat extension beyond the endpoints (black/white point behavior)
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const t = (x - xs[i]!) / h[i]!;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * ys[i]! + h10 * h[i]! * m[i]! + h01 * ys[i + 1]! + h11 * h[i]! * m[i + 1]!;
    return Math.min(CURVE_MAX, Math.max(0, y));
  };
}

/**
 * Bake the LUT for the Develop pass: one vec4 per entry, x/y/z = the R/G/B
 * output (display-encoded 0..1) for input i/(SIZE−1). Composition order
 * (Photoshop/ACR-compatible): per-channel curve FIRST, then the RGB master —
 * out_c(x) = rgb(curve_c(x)) — baked into one lookup per channel.
 */
export function buildToneCurveLut(tc: ToneCurveParams): Float32Array {
  const master = curveEvaluator(tc.rgb);
  const masterIdentity = isIdentityCurve(tc.rgb);
  const data = new Float32Array(TONE_CURVE_LUT_SIZE * 4);
  const channels: CurvePoints[] = [tc.r, tc.g, tc.b];
  for (let ch = 0; ch < 3; ch++) {
    const points = channels[ch]!;
    const own = isIdentityCurve(points) ? null : curveEvaluator(points);
    for (let i = 0; i < TONE_CURVE_LUT_SIZE; i++) {
      const x = (i / (TONE_CURVE_LUT_SIZE - 1)) * CURVE_MAX;
      const v = own ? own(x) : x;
      const y = masterIdentity ? v : master(v);
      data[i * 4 + ch] = Math.min(1, Math.max(0, y / CURVE_MAX));
    }
  }
  return data;
}
