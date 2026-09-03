/**
 * Unit tier (vitest) for the local-adaptive tone node's pure math: the
 * pyramid build/collapse round-trip mandate (docs/research/
 * local-adaptive-tone.md §4.3: "collapse(build(x))≈x を 1e-3 以内で検証する
 * ユニットテストを必ず置くこと") and the STAGE 1c remap-curve/level-weight/
 * halo-damp shapes used by the GPU pyramid in graphRenderer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGaussianPyramid,
  buildLaplacianPyramid,
  collapseLaplacianPyramid,
  discretizationLevels,
  expandGray,
  isIdentityLocalTone,
  levelAmounts,
  levelDamp,
  LOCALTONE_HALO_DAMP_START_LEVEL,
  LOCALTONE_HALO_LEVELS_PER_SIGMA_R,
  LOCALTONE_K_LEVELS,
  LOCALTONE_LEVEL_MID_LOG2,
  LOCALTONE_LEVEL_TRANSITION_STOPS,
  LOCALTONE_LOG2_HI,
  LOCALTONE_LOG2_LO,
  LOCALTONE_TONE_FLOOR,
  LOCALTONE_TONE_ONSET,
  pyramidLevelDims,
  reduceGray,
  remapLog2,
  sanitizeLocalToneParams,
  tentWeight,
  toneTail,
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

describe('toneTail (STAGE 1c one-sided bounded tail)', () => {
  it('is exact identity below onset regardless of floorSlope', () => {
    for (const ad of [0, LOCALTONE_TONE_ONSET * 0.3, LOCALTONE_TONE_ONSET * 0.5]) {
      expect(toneTail(ad, LOCALTONE_TONE_ONSET, 0)).toBeCloseTo(ad, 3);
      expect(toneTail(ad, LOCALTONE_TONE_ONSET, 1)).toBeCloseTo(ad, 3);
    }
  });

  it('floorSlope=1 is identity everywhere', () => {
    for (const ad of [0, 1, 5, 12]) {
      expect(toneTail(ad, LOCALTONE_TONE_ONSET, 1)).toBeCloseTo(ad, 6);
    }
  });

  it('floorSlope=0 saturates to a flat cap at onset for large ad (never grows further)', () => {
    const far1 = toneTail(5, LOCALTONE_TONE_ONSET, 0);
    const far2 = toneTail(10, LOCALTONE_TONE_ONSET, 0);
    expect(far1).toBeCloseTo(LOCALTONE_TONE_ONSET, 2);
    expect(far2).toBeCloseTo(LOCALTONE_TONE_ONSET, 2);
  });

  it('is approximately monotonic in ad (any tiny dip stays well under the onset scale) for any floorSlope in [0,1]', () => {
    // NOTE: this C1 smoothstep-blend shape (identical in kind to stage 1b's
    // own remapLog2 tail, just re-centered on a smaller onset) can show a
    // tiny non-monotonic dip right past the onset window's far edge — not
    // a hard invariant of the construction, just small in practice. Checked
    // loosely (dip << onset) rather than asserted away entirely.
    for (const floorSlope of [0, 0.3, 0.7, 1]) {
      let prev = -Infinity;
      for (let ad = 0; ad <= 6; ad += 0.25) {
        const v = toneTail(ad, LOCALTONE_TONE_ONSET, floorSlope);
        expect(v).toBeGreaterThanOrEqual(prev - 0.05);
        prev = v;
      }
    }
  });
});

describe('remapLog2 (STAGE 1c: sign-gated, bounded per-side tail)', () => {
  it('is exact identity when sAmt=hAmt=0 (shadows=highlights=0)', () => {
    for (const d of [-10, -5, -1, 0, 1, 5, 12]) {
      expect(remapLog2(-2 + d, -2, 0, 0)).toBeCloseTo(-2 + d, 6);
    }
  });

  it('d<0 (below gamma) is touched ONLY by sAmt, never by hAmt', () => {
    const gamma = -2;
    const dNeg = -8;
    const withShadow = remapLog2(gamma + dNeg, gamma, 1, 0);
    const withHighlightOnly = remapLog2(gamma + dNeg, gamma, 0, 1);
    expect(withShadow).not.toBeCloseTo(gamma + dNeg, 3); // shadows DID move it
    expect(withHighlightOnly).toBeCloseTo(gamma + dNeg, 6); // highlights must NOT touch the d<0 side
  });

  it('d>=0 (above/at gamma) is touched ONLY by hAmt, never by sAmt', () => {
    const gamma = -2;
    const dPos = 8;
    const withHighlight = remapLog2(gamma + dPos, gamma, 0, 1);
    const withShadowOnly = remapLog2(gamma + dPos, gamma, 1, 0);
    expect(withHighlight).not.toBeCloseTo(gamma + dPos, 3); // highlights DID move it
    expect(withShadowOnly).toBeCloseTo(gamma + dPos, 6); // shadows must NOT touch the d>=0 side
  });

  it('never overshoots PAST gamma for any sAmt/hAmt/offset (bounded, unlike an unbounded additive form)', () => {
    const gamma = 0;
    for (const ad of [1, 4, 10, 50]) {
      const lifted = remapLog2(gamma - ad, gamma, 1, 0);
      expect(lifted).toBeLessThanOrEqual(gamma + 1e-6); // lift never crosses above gamma
      const crushed = remapLog2(gamma + ad, gamma, 0, 1);
      expect(crushed).toBeGreaterThanOrEqual(gamma - 1e-6); // crush never crosses below gamma
    }
  });

  it('sAmt=1 lifts a deep-negative offset toward gamma, more than a partial sAmt does', () => {
    const gamma = 0;
    const liftedFull = remapLog2(gamma - 8, gamma, 1, 0);
    const liftedPartial = remapLog2(gamma - 8, gamma, 0.3, 0);
    const untouched = gamma - 8;
    expect(liftedFull).toBeGreaterThan(untouched); // moved toward gamma
    expect(liftedFull).toBeGreaterThan(liftedPartial); // stronger sAmt -> more lift
    expect(liftedPartial).toBeGreaterThan(untouched);
  });

  it('with LOCALTONE_TONE_FLOOR=0, sAmt=1 would saturate to a flat cap at onset (documents the formula\'s asymptote, independent of the shipped default)', () => {
    const gamma = 0;
    const d = gamma - 8;
    const ad = Math.abs(d);
    // floorSlope = 1 - sAmt*(1-floor); at sAmt=1,floor=0 -> floorSlope=0.
    const capped = gamma - toneTail(ad, LOCALTONE_TONE_ONSET, 0);
    expect(capped).toBeCloseTo(gamma - LOCALTONE_TONE_ONSET, 2);
  });
});

describe('LOCALTONE_TONE_FLOOR', () => {
  it('is a valid slope fraction in [0, 1)', () => {
    expect(LOCALTONE_TONE_FLOOR).toBeGreaterThanOrEqual(0);
    expect(LOCALTONE_TONE_FLOOR).toBeLessThan(1);
  });
});

describe('levelAmounts (STAGE 1c rename of betaForLevel: independent sAmt/hAmt weights, same inverted level-keying)', () => {
  it('both weights are 0 at every gammaJ when shadows=highlights=0', () => {
    for (const g of [-15, -8, LOCALTONE_LEVEL_MID_LOG2, -1, 3]) {
      const { sAmt, hAmt } = levelAmounts(g, 0, 0);
      expect(sAmt).toBeCloseTo(0, 6);
      expect(hAmt).toBeCloseTo(0, 6);
    }
  });

  it('deep BRIGHT gammaJ (above the mid+half-transition) gets full sAmt, zero hAmt', () => {
    const brightG = LOCALTONE_LEVEL_MID_LOG2 + LOCALTONE_LEVEL_TRANSITION_STOPS;
    const { sAmt, hAmt } = levelAmounts(brightG, 100, -100);
    expect(sAmt).toBeCloseTo(1, 6);
    expect(hAmt).toBeCloseTo(0, 6);
  });

  it('deep DARK gammaJ (below the mid-half-transition) gets full hAmt, zero sAmt', () => {
    const darkG = LOCALTONE_LEVEL_MID_LOG2 - LOCALTONE_LEVEL_TRANSITION_STOPS;
    const { sAmt, hAmt } = levelAmounts(darkG, 100, -100);
    expect(sAmt).toBeCloseTo(0, 6);
    expect(hAmt).toBeCloseTo(1, 6);
  });

  it('is a smooth (no-jump) blend across the mid transition, not a hard switch', () => {
    const eps = 1e-3;
    const below = levelAmounts(LOCALTONE_LEVEL_MID_LOG2 - eps, 100, -100);
    const above = levelAmounts(LOCALTONE_LEVEL_MID_LOG2 + eps, 100, -100);
    expect(Math.abs(above.sAmt - below.sAmt)).toBeLessThan(1e-2);
    expect(Math.abs(above.hAmt - below.hAmt)).toBeLessThan(1e-2);
  });

  it('scales exactly linearly with the slider value (shadows=50 is exactly half of shadows=100)', () => {
    const g = LOCALTONE_LEVEL_MID_LOG2 + LOCALTONE_LEVEL_TRANSITION_STOPS;
    const half = levelAmounts(g, 50, 0);
    const full = levelAmounts(g, 100, 0);
    expect(half.sAmt).toBeCloseTo(full.sAmt / 2, 6);
  });
});

describe('levelDamp (STAGE 1c halo suppression by pyramid level index)', () => {
  it('is 1 (full strength) at level 0 for any sigmaR', () => {
    for (const sigmaR of [0.5, 4, 10]) expect(levelDamp(0, sigmaR)).toBeCloseTo(1, 6);
  });

  it('is 1 up to LOCALTONE_HALO_DAMP_START_LEVEL, then decays to 0', () => {
    const sigmaR = 4;
    expect(levelDamp(LOCALTONE_HALO_DAMP_START_LEVEL, sigmaR)).toBeCloseTo(1, 6);
    const end = LOCALTONE_HALO_DAMP_START_LEVEL + sigmaR * LOCALTONE_HALO_LEVELS_PER_SIGMA_R;
    expect(levelDamp(end, sigmaR)).toBeCloseTo(0, 6);
    expect(levelDamp(end + 5, sigmaR)).toBeCloseTo(0, 6);
  });

  it('a larger sigmaR reaches (damps to 0) at a LARGER level index (more levels stay engaged)', () => {
    const levelJustPastSmallEnd = LOCALTONE_HALO_DAMP_START_LEVEL + 1 * LOCALTONE_HALO_LEVELS_PER_SIGMA_R + 0.5;
    const dampSmallSigma = levelDamp(levelJustPastSmallEnd, 1);
    const dampBigSigma = levelDamp(levelJustPastSmallEnd, 8);
    expect(dampBigSigma).toBeGreaterThan(dampSmallSigma);
  });

  it('is monotonically non-increasing in level index', () => {
    const sigmaR = 4;
    let prev = Infinity;
    for (let l = 0; l <= 20; l++) {
      const d = levelDamp(l, sigmaR);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
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
