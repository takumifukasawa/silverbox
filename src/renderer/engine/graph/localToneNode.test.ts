/**
 * Unit tier (vitest) for the local-adaptive tone node's pure math: the
 * pyramid build/collapse round-trip mandate (docs/research/
 * local-adaptive-tone.md §4.3: "collapse(build(x))≈x を 1e-3 以内で検証する
 * ユニットテストを必ず置くこと") and the remap-curve/tent-weight shape used
 * by the GPU pyramid in graphRenderer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  betaForLevel,
  buildGaussianPyramid,
  buildLaplacianPyramid,
  collapseLaplacianPyramid,
  discretizationLevels,
  expandGray,
  highlightsToBeta,
  isIdentityLocalTone,
  LOCALTONE_BETA_FLOOR,
  LOCALTONE_K_LEVELS,
  LOCALTONE_LEVEL_MID_LOG2,
  LOCALTONE_LEVEL_TRANSITION_STOPS,
  LOCALTONE_LOG2_HI,
  LOCALTONE_LOG2_LO,
  pyramidLevelDims,
  reduceGray,
  remapLog2,
  sanitizeLocalToneParams,
  shadowsToBeta,
  tentWeight,
  type GrayImage,
} from './localToneNode';

function makeNoise(w: number, h: number, seed: number): GrayImage {
  // Deterministic xorshift-ish PRNG, no external dependency.
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = -8 + 12 * next(); // spans a realistic log2-luma range
  return { data, w, h };
}

describe('pyramid build/collapse round trip (doc §4.3 mandate)', () => {
  it('collapse(build(x)) ≈ x within 1e-3 on random noise (non-power-of-2 dims)', () => {
    const img = makeNoise(37, 23, 12345);
    const gaussian = buildGaussianPyramid(img);
    const laplacian = buildLaplacianPyramid(gaussian);
    const recon = collapseLaplacianPyramid(laplacian);
    expect(recon.w).toBe(img.w);
    expect(recon.h).toBe(img.h);
    let maxErr = 0;
    for (let i = 0; i < img.data.length; i++) maxErr = Math.max(maxErr, Math.abs(recon.data[i]! - img.data[i]!));
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('collapse(build(x)) ≈ x on a flat constant image', () => {
    const w = 16;
    const h = 16;
    const data = new Float32Array(w * h).fill(-2.5);
    const img: GrayImage = { data, w, h };
    const recon = collapseLaplacianPyramid(buildLaplacianPyramid(buildGaussianPyramid(img)));
    for (let i = 0; i < data.length; i++) expect(recon.data[i]!).toBeCloseTo(-2.5, 3);
  });

  it('collapse(build(x)) ≈ x on a single-pixel (1x1) image (degenerate top level)', () => {
    const img: GrayImage = { data: new Float32Array([3.14]), w: 1, h: 1 };
    const recon = collapseLaplacianPyramid(buildLaplacianPyramid(buildGaussianPyramid(img)));
    expect(recon.data[0]).toBeCloseTo(3.14, 3);
  });

  it('reduceGray halves dims with ceil, down to 1x1', () => {
    expect(reduceGray({ data: new Float32Array(5 * 5), w: 5, h: 5 }).w).toBe(3);
    expect(pyramidLevelDims(5, 5).at(-1)).toEqual({ w: 1, h: 1 });
    expect(pyramidLevelDims(1024, 683).length).toBeGreaterThan(9);
  });

  it('expandGray targets the exact requested dims', () => {
    const coarse: GrayImage = { data: new Float32Array(4 * 3).fill(1), w: 4, h: 3 };
    const out = expandGray(coarse, 9, 7);
    expect(out.w).toBe(9);
    expect(out.h).toBe(7);
  });
});

describe('remapLog2 (band-limited remap curve, STAGE 1b: single symmetric beta)', () => {
  const sigmaR = 4;

  it('is exact identity when beta is 1 (shadows=highlights=0)', () => {
    for (const d of [-10, -5, -4.5, -4, -3.5, -1, 0, 1, 3.5, 4, 4.5, 5, 12]) {
      expect(remapLog2(-2 + d, -2, sigmaR, 1)).toBeCloseTo(-2 + d, 6);
    }
  });

  it('leaves the detail zone (|d| well under sigmaR) untouched regardless of beta', () => {
    const gamma = -3;
    for (const d of [-1, -0.5, 0, 0.5, 1]) {
      expect(remapLog2(gamma + d, gamma, sigmaR, 0)).toBeCloseTo(gamma + d, 3);
    }
  });

  it('compresses BOTH tails toward gamma symmetrically as beta -> 0 (the paper\'s own fe(a)=beta*a form)', () => {
    const gamma = -2;
    const dNeg = -8; // deep in the negative tail
    const dPos = 8; // deep in the positive tail
    const fullNeg = remapLog2(gamma + dNeg, gamma, sigmaR, 1);
    const liftedNeg = remapLog2(gamma + dNeg, gamma, sigmaR, 0);
    const fullPos = remapLog2(gamma + dPos, gamma, sigmaR, 1);
    const crushedPos = remapLog2(gamma + dPos, gamma, sigmaR, 0);
    // beta=0 pulls BOTH tails to a flat plateau exactly sigmaR stops from
    // gamma (the tail becomes CONSTANT beyond sigmaR, not collapsed all the
    // way to gamma itself — see remapLog2's tailOut formula).
    expect(liftedNeg).toBeGreaterThan(fullNeg);
    expect(liftedNeg).toBeCloseTo(gamma - sigmaR, 6);
    expect(crushedPos).toBeLessThan(fullPos);
    expect(crushedPos).toBeCloseTo(gamma + sigmaR, 6);
    // Symmetry: the negative and positive tails move the SAME distance toward gamma for the same |d| and beta.
    expect(gamma - liftedNeg).toBeCloseTo(-(gamma - crushedPos), 6);
  });

  it('is continuous (no hard knee) across |d|=sigmaR', () => {
    const gamma = 0;
    const eps = 1e-4;
    const below = remapLog2(gamma + sigmaR - eps, gamma, sigmaR, 0.3);
    const above = remapLog2(gamma + sigmaR + eps, gamma, sigmaR, 0.3);
    expect(Math.abs(above - below)).toBeLessThan(1e-2);
  });
});

describe('shadows/highlights -> beta mapping', () => {
  it('shadows 0..100 -> beta 1..LOCALTONE_BETA_FLOOR', () => {
    expect(shadowsToBeta(0)).toBeCloseTo(1, 6);
    expect(shadowsToBeta(100)).toBeCloseTo(LOCALTONE_BETA_FLOOR, 6);
    expect(shadowsToBeta(50)).toBeCloseTo((1 + LOCALTONE_BETA_FLOOR) / 2, 6);
  });
  it('highlights -100..0 -> beta LOCALTONE_BETA_FLOOR..1', () => {
    expect(highlightsToBeta(0)).toBeCloseTo(1, 6);
    expect(highlightsToBeta(-100)).toBeCloseTo(LOCALTONE_BETA_FLOOR, 6);
    expect(highlightsToBeta(-50)).toBeCloseTo((1 + LOCALTONE_BETA_FLOOR) / 2, 6);
  });
});

describe('betaForLevel (STAGE 1b: beta keyed to the discretization level gammaJ, not offset sign)', () => {
  it('is 1 (identity) at every gammaJ when shadows=highlights=0', () => {
    for (const g of [-15, -8, LOCALTONE_LEVEL_MID_LOG2, -1, 3]) {
      expect(betaForLevel(g, 0, 0)).toBeCloseTo(1, 6);
    }
  });

  it('deep BRIGHT gammaJ (above the mid+half-transition) gets the SHADOWS beta, unaffected by highlights', () => {
    const brightG = LOCALTONE_LEVEL_MID_LOG2 + LOCALTONE_LEVEL_TRANSITION_STOPS; // well past the transition window
    expect(betaForLevel(brightG, 100, 0)).toBeCloseTo(LOCALTONE_BETA_FLOOR, 6);
    expect(betaForLevel(brightG, 0, -100)).toBeCloseTo(1, 6);
  });

  it('deep DARK gammaJ (below the mid-half-transition) gets the HIGHLIGHTS beta, unaffected by shadows', () => {
    const darkG = LOCALTONE_LEVEL_MID_LOG2 - LOCALTONE_LEVEL_TRANSITION_STOPS;
    expect(betaForLevel(darkG, 0, -100)).toBeCloseTo(LOCALTONE_BETA_FLOOR, 6);
    expect(betaForLevel(darkG, 100, 0)).toBeCloseTo(1, 6);
  });

  it('is a smooth (no-jump) blend across the mid transition, not a hard switch', () => {
    const eps = 1e-3;
    const below = betaForLevel(LOCALTONE_LEVEL_MID_LOG2 - eps, 100, -100);
    const above = betaForLevel(LOCALTONE_LEVEL_MID_LOG2 + eps, 100, -100);
    expect(Math.abs(above - below)).toBeLessThan(1e-2);
  });
});

describe('tent weight / discretization levels', () => {
  it('discretizationLevels spans exactly [LOG2_LO, LOG2_HI] with K entries', () => {
    const levels = discretizationLevels(LOCALTONE_K_LEVELS);
    expect(levels.length).toBe(LOCALTONE_K_LEVELS);
    expect(levels[0]).toBeCloseTo(LOCALTONE_LOG2_LO, 9);
    expect(levels.at(-1)).toBeCloseTo(LOCALTONE_LOG2_HI, 9);
  });

  it('tent weights across consecutive references sum to 1 for any g in range', () => {
    const levels = discretizationLevels(6);
    const step = levels[1]! - levels[0]!;
    for (const g of [levels[0]!, levels[0]! + step * 0.25, levels[2]! + step * 0.7, levels.at(-1)!]) {
      const sum = levels.reduce((acc, gj) => acc + tentWeight(g, gj, step), 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('tent weight is 0 at/beyond +-step and 1 exactly at the reference', () => {
    expect(tentWeight(5, 5, 2)).toBeCloseTo(1, 9);
    expect(tentWeight(7, 5, 2)).toBeCloseTo(0, 9);
    expect(tentWeight(9, 5, 2)).toBe(0);
  });
});

describe('identity / sanitize', () => {
  it('default params are identity (amount=1 but shadows=highlights=0)', () => {
    expect(isIdentityLocalTone(sanitizeLocalToneParams(undefined, 'n'))).toBe(true);
  });
  it('amount<=0 is identity regardless of shadows/highlights', () => {
    expect(isIdentityLocalTone({ shadows: 100, highlights: -100, clarity: 0, sigmaR: 4, amount: 0 })).toBe(true);
  });
  it('a nonzero shadows or highlights with amount>0 is NOT identity', () => {
    expect(isIdentityLocalTone({ shadows: 1, highlights: 0, clarity: 0, sigmaR: 4, amount: 1 })).toBe(false);
    expect(isIdentityLocalTone({ shadows: 0, highlights: -1, clarity: 0, sigmaR: 4, amount: 1 })).toBe(false);
  });
  it('sanitize clamps out-of-range values and never throws on garbage', () => {
    const p = sanitizeLocalToneParams({ shadows: 500, highlights: 500, clarity: -5, sigmaR: 0, amount: 5 }, 'n');
    expect(p.shadows).toBe(100);
    expect(p.highlights).toBe(0);
    expect(p.clarity).toBe(0);
    expect(p.sigmaR).toBeGreaterThanOrEqual(0.5);
    expect(p.amount).toBe(1);
    expect(() => sanitizeLocalToneParams('garbage', 'n')).not.toThrow();
    expect(() => sanitizeLocalToneParams(null, 'n')).not.toThrow();
  });
});
