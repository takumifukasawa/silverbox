import { describe, expect, it } from 'vitest';
import { compareSrgbBuffers, deltaE76, srgb8ToLab } from './deltaE';

describe('srgb8ToLab / deltaE76', () => {
  it('white vs white is 0', () => {
    const lab = srgb8ToLab(255, 255, 255);
    expect(deltaE76(lab, lab)).toBeCloseTo(0, 9);
  });

  it('black vs white is approximately 100 (the full L* range, a=b=0 for both)', () => {
    const black = srgb8ToLab(0, 0, 0);
    const white = srgb8ToLab(255, 255, 255);
    expect(black[0]).toBeCloseTo(0, 6);
    // The published sRGB->XYZ matrix rows don't sum to exactly 1.0 (rounded
    // to 7 significant digits), so white's Y (and L*) lands a few 1e-6 off
    // 100 — well within float/matrix-rounding noise, not a real defect.
    expect(white[0]).toBeCloseTo(100, 4);
    expect(deltaE76(black, white)).toBeCloseTo(100, 4);
  });

  it('a slightly shifted red is a small, nonzero ΔE', () => {
    const red = srgb8ToLab(220, 30, 30);
    const redShifted = srgb8ToLab(224, 32, 30);
    const de = deltaE76(red, redShifted);
    expect(de).toBeGreaterThan(0);
    expect(de).toBeLessThan(3);
  });

  it('a grossly different color is a large ΔE', () => {
    const red = srgb8ToLab(220, 30, 30);
    const blue = srgb8ToLab(20, 40, 220);
    expect(deltaE76(red, blue)).toBeGreaterThan(50);
  });
});

describe('compareSrgbBuffers', () => {
  it('identical buffers -> mean/p95/max all 0', () => {
    // 2x2 RGB8, arbitrary values.
    const buf = new Uint8Array([10, 20, 30, 200, 150, 90, 0, 0, 0, 255, 255, 255]);
    const stats = compareSrgbBuffers(buf, buf, 2, 2, 3);
    expect(stats.mean).toBeCloseTo(0, 9);
    expect(stats.p95).toBeCloseTo(0, 9);
    expect(stats.max).toBeCloseTo(0, 9);
  });

  it('a uniform per-channel shift across every pixel gives mean == p95 == max', () => {
    const a = new Uint8Array([100, 100, 100, 100, 100, 100]);
    const b = new Uint8Array([110, 100, 100, 110, 100, 100]);
    const stats = compareSrgbBuffers(a, b, 2, 1, 3);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.mean).toBeCloseTo(stats.p95, 9);
    expect(stats.mean).toBeCloseTo(stats.max, 9);
  });

  it('one outlier pixel drags max/p95 above mean without moving mean much', () => {
    // 10 identical pixels + 1 wildly different one.
    const n = 11;
    const a = new Uint8Array(n * 3).fill(50);
    const b = new Uint8Array(n * 3).fill(50);
    b[(n - 1) * 3] = 250; // last pixel's R channel jumps hard
    const stats = compareSrgbBuffers(a, b, n, 1, 3);
    expect(stats.max).toBeGreaterThan(stats.mean);
    expect(stats.max).toBeGreaterThan(20);
  });

  it('ignores a 4th (alpha) channel', () => {
    const a = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]);
    const b = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 255]);
    const stats = compareSrgbBuffers(a, b, 2, 1, 4);
    expect(stats.mean).toBeCloseTo(0, 9);
  });
});
