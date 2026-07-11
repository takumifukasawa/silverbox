/**
 * Unit tier (vitest) for the Sony lens-profile parser + correction math.
 * Parses the REAL default ARW bytes (node fs) and asserts the exact knot
 * arrays exiftool reports for it, plus null on non-Sony/garbage inputs; then
 * checks the pure gain math against the documented anchor values.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseSonyLensProfile,
  parseSonyLensModel,
  evalLinearSpline,
  distortionGain,
  caGain,
  vignetteGain,
  distortionNormalizer,
} from './sonyLensProfile';

const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

function bytesOf(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Ground truth from `exiftool -DistortionCorrParams -ChromaticAberrationCorrParams
// -VignettingCorrParams` on the default ARW (FE 24mm F2.8 G, a7C II).
const EXPECTED = {
  distortion: [0, -11, -41, -91, -162, -249, -355, -476, -611, -759, -918],
  caRed: [1152, 1280, 1280, 1280, 1408, 1280, 1280, 1280, 1280, 1152, 1024],
  caBlue: [-896, -896, -896, -896, -896, -896, -896, -768, -768, -640, -512],
  vignette: [0, 64, 256, 576, 1056, 1664, 2400, 3264, 4288, 5568, 6880],
};

describe('parseSonyLensProfile', () => {
  it('extracts the exact knot arrays from the real ARW', () => {
    const profile = parseSonyLensProfile(bytesOf(ARW_PATH));
    expect(profile).not.toBeNull();
    expect(profile!.distortion).toEqual(EXPECTED.distortion);
    expect(profile!.caRed).toEqual(EXPECTED.caRed);
    expect(profile!.caBlue).toEqual(EXPECTED.caBlue);
    expect(profile!.vignette).toEqual(EXPECTED.vignette);
    // n = 11 knots per curve
    expect(profile!.distortion).toHaveLength(11);
    expect(profile!.caRed).toHaveLength(11);
    expect(profile!.caBlue).toHaveLength(11);
    expect(profile!.vignette).toHaveLength(11);
  });

  it('returns null for a JPEG', () => {
    expect(parseSonyLensProfile(bytesOf(JPG_PATH))).toBeNull();
  });

  it('returns null for a truncated ARW header', () => {
    const full = bytesOf(ARW_PATH);
    expect(parseSonyLensProfile(full.slice(0, 64))).toBeNull();
    expect(parseSonyLensProfile(full.slice(0, 4))).toBeNull();
    expect(parseSonyLensProfile(new ArrayBuffer(0))).toBeNull();
  });

  it('returns null for a garbage buffer', () => {
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    expect(parseSonyLensProfile(junk.buffer)).toBeNull();
  });
});

describe('parseSonyLensModel', () => {
  it('extracts the EXIF LensModel from the real ARW', () => {
    // Ground truth from `exiftool -LensModel` on the default ARW (a7C II).
    expect(parseSonyLensModel(bytesOf(ARW_PATH))).toBe('FE 24mm F2.8 G');
  });

  it('returns null for a JPEG and for garbage', () => {
    expect(parseSonyLensModel(bytesOf(JPG_PATH))).toBeNull();
    expect(parseSonyLensModel(new ArrayBuffer(0))).toBeNull();
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    expect(parseSonyLensModel(junk.buffer)).toBeNull();
  });
});

describe('correction math', () => {
  it('linear spline hits knots exactly and interpolates between', () => {
    const k = [0, 10, 30];
    expect(evalLinearSpline(k, 0)).toBe(0);
    expect(evalLinearSpline(k, 1)).toBe(10);
    expect(evalLinearSpline(k, 2)).toBe(30);
    expect(evalLinearSpline(k, 0.5)).toBeCloseTo(5, 10);
    expect(evalLinearSpline(k, 1.5)).toBeCloseTo(20, 10);
    // constant extrapolation past the ends
    expect(evalLinearSpline(k, -1)).toBe(0);
    expect(evalLinearSpline(k, 5)).toBe(30);
  });

  it('distortion gain is 1 at center and ~0.944 at the corner', () => {
    expect(distortionGain(EXPECTED.distortion, 0)).toBe(1);
    // corner knot -918 · 2^-14 = -0.05603 ⇒ g ≈ 0.94397
    expect(distortionGain(EXPECTED.distortion, 1)).toBeCloseTo(0.94397, 4);
  });

  it('distortion normalizer s is ≥ every gain sampled on the edges', () => {
    const w = 5120;
    const h = 3584;
    const s = distortionNormalizer(EXPECTED.distortion, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const corner = Math.hypot(cx, cy);
    // spot-check many edge points
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const ex = -cx + t * w;
      const ey = -cy + t * h;
      expect(s).toBeGreaterThanOrEqual(distortionGain(EXPECTED.distortion, Math.hypot(ex, cy) / corner) - 1e-12);
      expect(s).toBeGreaterThanOrEqual(distortionGain(EXPECTED.distortion, Math.hypot(cx, ey) / corner) - 1e-12);
    }
    // and s ≥ the corner gain too (the corner is on the edge set)
    expect(s).toBeGreaterThanOrEqual(distortionGain(EXPECTED.distortion, 1));
  });

  it('CA gains are unity at center and ~1e-4 magnitude at the corner', () => {
    expect(caGain(EXPECTED.caRed, 0)).toBeCloseTo(1 + 1152 / 2097152, 10);
    // red corner knot 1024, blue corner knot -512 (2^-21 scale ⇒ ~1e-4)
    const rCorner = caGain(EXPECTED.caRed, 1);
    const bCorner = caGain(EXPECTED.caBlue, 1);
    expect(rCorner - 1).toBeCloseTo(1024 / 2097152, 10);
    expect(bCorner - 1).toBeCloseTo(-512 / 2097152, 10);
    expect(Math.abs(rCorner - 1)).toBeLessThan(1e-3);
    expect(Math.abs(bCorner - 1)).toBeLessThan(1e-3);
    // red pulls out, blue pulls in — opposite signs
    expect(rCorner).toBeGreaterThan(1);
    expect(bCorner).toBeLessThan(1);
  });

  it('vignette gain brightens toward the corner and is unity at center', () => {
    const d = 16384;
    expect(vignetteGain(EXPECTED.vignette, 0, d)).toBe(1);
    expect(vignetteGain(EXPECTED.vignette, 1, d)).toBeCloseTo(1 + 6880 / d, 10);
    expect(vignetteGain(EXPECTED.vignette, 1, d)).toBeGreaterThan(1);
  });
});
