import { describe, expect, it } from 'vitest';
import {
  DEFERRED_STAGES,
  PLACEHOLDER_BASELINE_SIGNATURE,
  solveToneCurve,
  formatToneSolveReport,
} from './solve';
import {
  aggregateSignature,
  encodedLuma255,
  SIGNATURE_PERCENTILES,
  TONE_CONTROL_PERCENTILES,
  type DecodedImage,
} from './signature';
import { curveEvaluator } from '../color/toneCurve';
import { srgbDecode } from '../color/srgb';
import type { CurvePoints } from '../graph/developNode';

// --- synthetic-image helpers -------------------------------------------------
//
// A GRAYSCALE frame is the clean isolation for the TONE (achromatic) stage:
// for a neutral working-linear pixel [v,v,v], encodedLuma255 ≈ srgbEncode(v)·255
// (WORK_TO_SRGB maps the shared D65 white to itself within ~1e-4), so a pixel
// built from a target encoded luma T via v = srgbDecode(T/255) reads back at
// encoded luma ≈ T. That makes "apply a curve to luma" EXACT: applying a
// monotone curve K per channel gives a frame whose encoded-luma percentiles are
// K(the input's percentiles) — the property the recovery proof rests on.

/** A grayscale DecodedImage whose pixels' encoded luma are exactly `encodedLumas` (0..255). */
function grayImageFromEncodedLuma(encodedLumas: number[]): DecodedImage {
  const n = encodedLumas.length;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = srgbDecode(Math.min(255, Math.max(0, encodedLumas[i]!)) / 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  return { data, width: n, height: 1 };
}

/** A uniform encoded-luma ramp 0..255 over `n` pixels — a flat neutral baseline distribution. */
function rampEncodedLuma(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * 255);
}

describe('solveToneCurve — the correctness proof (known curve → recover it)', () => {
  it('every TONE_CONTROL_PERCENTILES entry is a member of SIGNATURE_PERCENTILES', () => {
    for (const p of TONE_CONTROL_PERCENTILES) expect(SIGNATURE_PERCENTILES).toContain(p);
  });

  it('recovers a KNOWN injected tone curve from the extracted signatures', () => {
    // A contrasty S-curve, endpoints pinned so it matches the assembled curve's
    // own (0,0)/(255,255) pins (the recovery is meaningful in the interior).
    const KNOWN: CurvePoints = [
      [0, 0],
      [64, 40],
      [128, 150],
      [192, 225],
      [255, 255],
    ];
    const K = curveEvaluator(KNOWN);

    // Baseline (test render) = a uniform encoded-luma ramp. Reference = the
    // SAME frame with the known curve applied in display luma space.
    const baseLumas = rampEncodedLuma(4096);
    const baseImage = grayImageFromEncodedLuma(baseLumas);
    const refImage = grayImageFromEncodedLuma(baseLumas.map((l) => K(l)));

    const baseline = aggregateSignature([baseImage]);
    const reference = aggregateSignature([refImage]);
    const { curve, report } = solveToneCurve(baseline, reference);
    const recovered = curveEvaluator(curve);

    // 1. At each control percentile, the recovered curve reproduces the known
    //    curve's mapping of that percentile's baseline luma (within rounding).
    for (const p of TONE_CONTROL_PERCENTILES) {
      const idx = SIGNATURE_PERCENTILES.indexOf(p);
      const x = baseline.lumaPercentiles[idx]!;
      expect(Math.abs(recovered(x) - K(x))).toBeLessThan(1.5);
    }

    // 2. Densely across the fitted interior, the recovered curve reproduces the
    //    known curve within a few /255 (PCHIP through control points on K).
    const lo = baseline.lumaPercentiles[SIGNATURE_PERCENTILES.indexOf(0.05)]!;
    const hi = baseline.lumaPercentiles[SIGNATURE_PERCENTILES.indexOf(0.9)]!;
    let maxDense = 0;
    for (let x = lo; x <= hi; x += 1) maxDense = Math.max(maxDense, Math.abs(recovered(x) - K(x)));
    expect(maxDense).toBeLessThan(3.5);

    // 3. The report's own residual (fitted vs measured reference percentile) is
    //    tight — the solve reports honest fit quality, not just the curve.
    expect(report.maxResidual).toBeLessThan(3.5);
    expect(report.solved).toEqual(['tone']);
    expect(report.deferred).toEqual([...DEFERRED_STAGES]);
  });

  it('an identity look (reference == baseline) yields an identity curve', () => {
    const lumas = rampEncodedLuma(2048);
    const img = grayImageFromEncodedLuma(lumas);
    const sig = aggregateSignature([img]);
    const { curve } = solveToneCurve(sig, sig);
    const evalC = curveEvaluator(curve);
    // A curve mapping a distribution to itself must be ~identity everywhere.
    for (let x = 0; x <= 255; x += 5) expect(Math.abs(evalC(x) - x)).toBeLessThan(2);
  });

  it('the assembled curve is a valid, strictly-increasing, monotone point set', () => {
    const baseLumas = rampEncodedLuma(2048);
    // A reference darker in shadows, brighter in highlights (more contrast).
    const K = curveEvaluator([
      [0, 0],
      [128, 110],
      [255, 255],
    ]);
    const baseline = aggregateSignature([grayImageFromEncodedLuma(baseLumas)]);
    const reference = aggregateSignature([grayImageFromEncodedLuma(baseLumas.map((l) => K(l)))]);
    const { curve } = solveToneCurve(baseline, reference);
    expect(curve[0]).toEqual([0, 0]);
    expect(curve[curve.length - 1]).toEqual([255, 255]);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]![0]).toBeGreaterThan(curve[i - 1]![0]!); // strictly increasing x
      expect(curve[i]![1]).toBeGreaterThanOrEqual(curve[i - 1]![1]!); // monotone y
    }
  });
});

describe('PLACEHOLDER_BASELINE_SIGNATURE', () => {
  it('is the linear/identity neutral distribution (encoded luma = p·255)', () => {
    SIGNATURE_PERCENTILES.forEach((p, k) => {
      expect(PLACEHOLDER_BASELINE_SIGNATURE.lumaPercentiles[k]).toBeCloseTo(p * 255, 6);
    });
  });

  it('carries the stage-2 fields as null (nothing but tone is claimed)', () => {
    expect(PLACEHOLDER_BASELINE_SIGNATURE.globalChroma).toBeNull();
    expect(PLACEHOLDER_BASELINE_SIGNATURE.hslBands).toBeNull();
    expect(PLACEHOLDER_BASELINE_SIGNATURE.grainEnergy).toBeNull();
  });

  it('solves cleanly against a real reference signature and reports tone-only', () => {
    const lumas = rampEncodedLuma(1024);
    // Encode a mild lift so the reference differs from the linear baseline.
    const K = curveEvaluator([
      [0, 0],
      [128, 160],
      [255, 255],
    ]);
    const reference = aggregateSignature([grayImageFromEncodedLuma(lumas.map((l) => K(l)))]);
    const { curve, report } = solveToneCurve(PLACEHOLDER_BASELINE_SIGNATURE, reference);
    expect(curve.length).toBeGreaterThanOrEqual(2);
    const lines = formatToneSolveReport(report, reference.imageCount);
    expect(lines.some((l) => l.includes('solved: tone'))).toBe(true);
    expect(lines.some((l) => l.includes('deferred'))).toBe(true);
  });
});

describe('encodedLuma255 round-trip (grayscale construction is faithful)', () => {
  it('reads back a gray pixel at its intended encoded luma within ~0.1/255', () => {
    for (const target of [8, 32, 64, 128, 200, 248]) {
      const v = srgbDecode(target / 255);
      expect(Math.abs(encodedLuma255(v, v, v) - target)).toBeLessThan(0.15);
    }
  });
});
