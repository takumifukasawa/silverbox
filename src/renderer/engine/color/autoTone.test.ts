import { describe, expect, it } from 'vitest';
import {
  autoToneQuantile,
  neutralLumaSample,
  solveAutoTone,
  AUTO_TONE_EV_MIN,
  AUTO_TONE_EV_MAX,
} from './autoTone';
import type { PreparedImage } from '../decoder/decodeWorker';
import { defaultDevelopParams } from '../graph/developNode';

describe('autoToneQuantile', () => {
  it('linear-interpolates a sorted array (mirrors fit-base-curve.mjs quantile())', () => {
    const sorted = Float64Array.from([0, 1, 2, 3, 4]);
    expect(autoToneQuantile(sorted, 0)).toBe(0);
    expect(autoToneQuantile(sorted, 1)).toBe(4);
    expect(autoToneQuantile(sorted, 0.5)).toBe(2);
    expect(autoToneQuantile(sorted, 0.25)).toBe(1);
  });

  it('empty input is 0, not NaN/throw', () => {
    expect(autoToneQuantile(new Float64Array(0), 0.5)).toBe(0);
  });
});

/** A minimal flat-gray PreparedImage at a given linear luma value. */
function grayImage(linearLuma: number, width = 8, height = 8): PreparedImage {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = linearLuma;
    data[i * 4 + 1] = linearLuma;
    data[i * 4 + 2] = linearLuma;
    data[i * 4 + 3] = 1;
  }
  return { data, width, height, fullWidth: width, fullHeight: height, flip: 0, decodeMs: 0 };
}

describe('neutralLumaSample + solveAutoTone', () => {
  const identityProfile = defaultDevelopParams().profile; // amount 0 — isIdentityProfile() true, profile step a no-op
  const unityWb: [number, number, number] = [1, 1, 1];

  it('a dark flat image raises exposure (positive ev); a bright one lowers it', () => {
    const dark = neutralLumaSample(grayImage(0.02), identityProfile, null, unityWb);
    const bright = neutralLumaSample(grayImage(0.8), identityProfile, null, unityWb);
    const evDark = solveAutoTone(dark).ev;
    const evBright = solveAutoTone(bright).ev;
    expect(evDark).toBeGreaterThan(0);
    expect(evBright).toBeLessThan(0);
    expect(evDark).toBeGreaterThan(evBright);
  });

  it('ev is clamped to the basic.ev slider range', () => {
    const veryDark = neutralLumaSample(grayImage(1e-5), identityProfile, null, unityWb);
    const veryBright = neutralLumaSample(grayImage(0.999), identityProfile, null, unityWb);
    expect(solveAutoTone(veryDark).ev).toBeLessThanOrEqual(AUTO_TONE_EV_MAX);
    expect(solveAutoTone(veryBright).ev).toBeGreaterThanOrEqual(AUTO_TONE_EV_MIN);
  });

  it('every returned slider value stays within ±100 (bounded, never a runaway)', () => {
    for (const luma of [1e-6, 0.001, 0.01, 0.1, 0.5, 0.9, 0.999]) {
      const patch = solveAutoTone(neutralLumaSample(grayImage(luma), identityProfile, null, unityWb));
      expect(patch.blacks).toBeGreaterThanOrEqual(-100);
      expect(patch.blacks).toBeLessThanOrEqual(100);
      expect(patch.whites).toBeGreaterThanOrEqual(-100);
      expect(patch.whites).toBeLessThanOrEqual(100);
      expect(patch.highlights).toBeGreaterThanOrEqual(-100);
      expect(patch.highlights).toBeLessThanOrEqual(0); // recovery only pulls DOWN
      expect(patch.shadows).toBeGreaterThanOrEqual(0); // recovery only lifts UP
      expect(patch.shadows).toBeLessThanOrEqual(100);
    }
  });

  it('an already-midtone-centered flat image needs ~zero exposure correction', () => {
    // 0.45 encoded ≈ AUTO_TONE_MIDTONE_TARGET_ENCODED decoded back to linear.
    const midtoneLinear = Math.pow((0.45 + 0.055) / 1.055, 2.4);
    const sample = neutralLumaSample(grayImage(midtoneLinear), identityProfile, null, unityWb);
    expect(Math.abs(solveAutoTone(sample).ev)).toBeLessThan(0.05);
  });

  it('empty sample (degenerate image) returns all-zero, not NaN/throw', () => {
    const empty = neutralLumaSample(grayImage(0.5, 0, 0), identityProfile, null, unityWb);
    const patch = solveAutoTone(empty);
    expect(patch).toEqual({ ev: 0, blacks: 0, whites: 0, highlights: 0, shadows: 0 });
  });

  it('stride-subsamples toward AUTO_TONE_SAMPLE_TARGET rather than reading every pixel on a huge image', () => {
    const huge = grayImage(0.3, 2000, 2000); // 4,000,000 px — over the sample target
    const sample = neutralLumaSample(huge, identityProfile, null, unityWb);
    expect(sample.length).toBeLessThan(2000 * 2000);
    expect(sample.length).toBeGreaterThan(0);
  });
});
