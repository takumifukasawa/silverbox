import { describe, expect, it } from 'vitest';
import {
  aggregateSignature,
  imageLumaPercentiles,
  percentileIndex,
  SIGNATURE_PERCENTILES,
  type DecodedImage,
} from './signature';
import { srgbDecode } from '../color/srgb';

/** A grayscale DecodedImage whose pixels' encoded luma are exactly `encodedLumas` (0..255) — see solve.test.ts for why gray isolates luma. */
function grayImage(encodedLumas: number[]): DecodedImage {
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

function ramp(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * 255);
}

describe('signature — luma percentile vector', () => {
  it('SIGNATURE_PERCENTILES is strictly increasing and spans p2..p98', () => {
    for (let i = 1; i < SIGNATURE_PERCENTILES.length; i++) {
      expect(SIGNATURE_PERCENTILES[i]!).toBeGreaterThan(SIGNATURE_PERCENTILES[i - 1]!);
    }
    expect(SIGNATURE_PERCENTILES[0]).toBeCloseTo(0.02, 6);
    expect(SIGNATURE_PERCENTILES[SIGNATURE_PERCENTILES.length - 1]).toBeCloseTo(0.98, 6);
  });

  it('percentileIndex finds a member and throws on a non-member', () => {
    expect(percentileIndex(0.5)).toBe(SIGNATURE_PERCENTILES.indexOf(0.5));
    expect(() => percentileIndex(0.123)).toThrow();
  });

  it('a per-image percentile vector is monotonically non-decreasing', () => {
    const v = imageLumaPercentiles(grayImage(ramp(2000)));
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThanOrEqual(v[i - 1]!);
  });

  it('a uniform ramp yields percentiles ≈ p·255 (encoded luma == distribution fraction)', () => {
    const v = imageLumaPercentiles(grayImage(ramp(4096)));
    SIGNATURE_PERCENTILES.forEach((p, k) => {
      expect(Math.abs(v[k]! - p * 255)).toBeLessThan(1.0);
    });
  });
});

describe('signature — aggregation robustness', () => {
  it('populates only the luma fields; stage-2 fields stay null', () => {
    const sig = aggregateSignature([grayImage(ramp(1000))]);
    expect(sig.imageCount).toBe(1);
    expect(sig.lumaPercentiles.length).toBe(SIGNATURE_PERCENTILES.length);
    expect(sig.globalChroma).toBeNull();
    expect(sig.hslBands).toBeNull();
    expect(sig.shadowChroma).toBeNull();
    expect(sig.highlightChroma).toBeNull();
    expect(sig.midtoneChroma).toBeNull();
    expect(sig.grainEnergy).toBeNull();
  });

  it('contrastProxy is p90 − p10 of the aggregated luma vector', () => {
    const sig = aggregateSignature([grayImage(ramp(4096))]);
    const p10 = sig.lumaPercentiles[percentileIndex(0.1)]!;
    const p90 = sig.lumaPercentiles[percentileIndex(0.9)]!;
    expect(sig.contrastProxy).toBeCloseTo(p90 - p10, 6);
  });

  it('per-percentile MEDIAN across the set is not dominated by one outlier frame', () => {
    // Three consistent frames (mid-grey heavy) + one wild outlier (all bright).
    const consistent = () => grayImage(ramp(1000).map((l) => l * 0.4 + 40)); // compressed mid
    const outlier = grayImage(ramp(1000).map(() => 250)); // a blown title-card frame
    const withOutlier = aggregateSignature([consistent(), consistent(), consistent(), outlier]);
    const withoutOutlier = aggregateSignature([consistent(), consistent(), consistent()]);
    // The median over 4 (3 agreeing + 1 outlier) must stay near the 3-frame
    // consensus — a mean would be dragged up hundreds-of-a-unit by the 250s.
    SIGNATURE_PERCENTILES.forEach((_, k) => {
      expect(Math.abs(withOutlier.lumaPercentiles[k]! - withoutOutlier.lumaPercentiles[k]!)).toBeLessThan(1.0);
    });
  });

  it('throws on an empty set and an empty image', () => {
    expect(() => aggregateSignature([])).toThrow();
    expect(() => imageLumaPercentiles({ data: new Float32Array(0), width: 0, height: 0 })).toThrow();
  });
});
