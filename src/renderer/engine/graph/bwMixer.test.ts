/**
 * Unit tier (vitest) for the B&W conversion + channel mixer's pure math
 * (docs/brief-bank/bw-mixer.md) — compileDevelop's CPU mirror is a plain
 * function of (px, x, y, width, height), no GPU/Electron needed, so the
 * formula (band weighting via the shared HSL band mask, the clamp-at-zero
 * floor, and the mono-replacement identity) is exercised directly here
 * rather than only through the GPU-vs-CPU comparison in verify-bw.mjs.
 */
import { describe, expect, it } from 'vitest';
import { compileDevelop, defaultDevelopParams, HSL_BANDS, type DevelopParams } from './developNode';
import { WORKING_LUMA } from '../color/workingSpace';

const WB_IDENTITY: [number, number, number] = [1, 1, 1];

function bwParams(enabled: boolean, mix: number[]): DevelopParams {
  return { ...defaultDevelopParams(), bw: { enabled, mix } };
}

/** Runs the CPU mirror on a single pixel — x/y/width/height are irrelevant for B&W (not position-aware). */
function cpuOf(params: DevelopParams, px: [number, number, number]): [number, number, number] {
  const { cpu } = compileDevelop(params, WB_IDENTITY, 1);
  expect(cpu).not.toBeNull();
  return cpu!(px, 0, 0, 1, 1);
}

const luma = (px: [number, number, number]) => WORKING_LUMA[0] * px[0] + WORKING_LUMA[1] * px[1] + WORKING_LUMA[2] * px[2];

describe('B&W mixer — identity / pass-skip', () => {
  it('disabled contributes NO pass and the CPU mirror is untouched (bit-exact passthrough)', () => {
    const px: [number, number, number] = [0.3, 0.6, 0.1];
    const params = bwParams(false, [50, -30, 0, 0, 0, 0, 0, 0]); // non-zero mix, but disabled
    const { passes, cpu } = compileDevelop(params, WB_IDENTITY, 1);
    expect(passes.some((p) => p.shaderId === 'develop/bw')).toBe(false);
    expect(cpu).not.toBeNull();
    expect(cpu!(px, 0, 0, 1, 1)).toEqual(px);
  });
});

describe('B&W mixer — mono replacement', () => {
  it('all-zero mix: pixel-wise gray (r===g===b) matching the input luma', () => {
    const params = bwParams(true, HSL_BANDS.map(() => 0));
    const px: [number, number, number] = [0.4, 0.2, 0.7];
    const [r, g, b] = cpuOf(params, px);
    expect(r).toBeCloseTo(g, 10);
    expect(g).toBeCloseTo(b, 10);
    expect(r).toBeCloseTo(luma(px), 10);
  });

  it('replaces all three channels even for an already-gray input (still runs the pass)', () => {
    const params = bwParams(true, HSL_BANDS.map(() => 0));
    const px: [number, number, number] = [0.5, 0.5, 0.5];
    const [r, g, b] = cpuOf(params, px);
    expect(r).toBeCloseTo(0.5, 10);
    expect(g).toBeCloseTo(0.5, 10);
    expect(b).toBeCloseTo(0.5, 10);
  });
});

describe('B&W mixer — band weighting (reuses the HSL band mask)', () => {
  const redIdx = HSL_BANDS.indexOf('red');
  const greenIdx = HSL_BANDS.indexOf('green');

  it('red band −100 darkens a saturated red pixel; +100 lightens it', () => {
    const px: [number, number, number] = [1, 0, 0]; // pure red, fully saturated once encoded
    const neutralMono = cpuOf(bwParams(true, HSL_BANDS.map(() => 0)), px)[0]!;

    const darkMix = HSL_BANDS.map((_, i) => (i === redIdx ? -100 : 0));
    const brightMix = HSL_BANDS.map((_, i) => (i === redIdx ? 100 : 0));
    const dark = cpuOf(bwParams(true, darkMix), px)[0]!;
    const bright = cpuOf(bwParams(true, brightMix), px)[0]!;

    expect(dark).toBeLessThan(neutralMono);
    expect(bright).toBeGreaterThan(neutralMono);
  });

  it("red band mix leaves a fully-saturated green pixel's mono value unmoved", () => {
    const px: [number, number, number] = [0, 1, 0]; // pure green, hue 120° — the green band's own center
    const neutralMono = cpuOf(bwParams(true, HSL_BANDS.map(() => 0)), px)[0]!;
    const redDarkMix = HSL_BANDS.map((_, i) => (i === redIdx ? -100 : 0));
    const withRedMix = cpuOf(bwParams(true, redDarkMix), px)[0]!;
    expect(withRedMix).toBeCloseTo(neutralMono, 10);
  });

  it('green band moves a saturated green pixel the same way red moves red', () => {
    const px: [number, number, number] = [0, 1, 0];
    const neutralMono = cpuOf(bwParams(true, HSL_BANDS.map(() => 0)), px)[0]!;
    const darkMix = HSL_BANDS.map((_, i) => (i === greenIdx ? -100 : 0));
    const dark = cpuOf(bwParams(true, darkMix), px)[0]!;
    expect(dark).toBeLessThan(neutralMono);
  });
});

describe('B&W mixer — clamp-at-zero floor', () => {
  it('a fully-in-band, fully-saturated pixel never goes negative even at an extreme (future-calibration) mix', () => {
    // packBw divides by 100 with no runtime clamp, so an out-of-slider-range
    // value (simulating a much larger K_BW after LR calibration bumps
    // BW_MIX_STRENGTH past 1.0) exercises the multiplier's max(...,0) floor
    // without needing to touch the provisional constant itself.
    const redIdx = HSL_BANDS.indexOf('red');
    const extremeMix = HSL_BANDS.map((_, i) => (i === redIdx ? -100000 : 0));
    const px: [number, number, number] = [1, 0, 0];
    const [r, g, b] = cpuOf(bwParams(true, extremeMix), px);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('never inverts (goes negative) for any mix in the normal −100..100 slider range', () => {
    const redIdx = HSL_BANDS.indexOf('red');
    const mix = HSL_BANDS.map((_, i) => (i === redIdx ? -100 : 0));
    const [r] = cpuOf(bwParams(true, mix), [1, 0, 0]);
    expect(r).toBeGreaterThanOrEqual(0);
  });
});
