/**
 * Unit tier (vitest) for the local-adaptive tone node's pure math — STAGE 1e
 * (two percentile anchors + an ungated saturating curve + a scene-adaptive
 * amplitude law): the tile-reduce + histogram percentile/std computation
 * (`computeFrameStats`), the separable Gaussian base blur (`gaussianBlurGray`,
 * unchanged from stage 1d), the ungated curve (`shadowsCurve`/
 * `highlightsCurve`/`localToneShift`), and the amplitude law
 * (`amplitudeMultiplier`) used by the GPU pass chain in graphRenderer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  amplitudeMultiplier,
  boxReduceGray,
  computeFrameStats,
  gaussianBlurGray,
  gaussianWeights,
  highlightsCurve,
  histogramOf,
  isIdentityLocalTone,
  LOCALTONE_AMP_FLOOR,
  LOCALTONE_AMP_HI_A,
  LOCALTONE_AMP_HI_B,
  LOCALTONE_AMP_SH_A,
  LOCALTONE_AMP_SH_B,
  LOCALTONE_AMP_STAT_HIGH,
  LOCALTONE_AMP_STAT_LOW,
  LOCALTONE_HI_AMPLITUDE,
  LOCALTONE_SH_AMPLITUDE,
  localToneShift,
  pyramidLevelDims,
  reduceToTile,
  sanitizeLocalToneParams,
  shadowsCurve,
  statsFromHistogram,
  tileLevelDims,
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

describe('boxReduceGray / tileLevelDims / reduceToTile', () => {
  it('reduceGray halves dims with ceil, down to 1x1', () => {
    expect(boxReduceGray({ data: new Float32Array(5 * 5), w: 5, h: 5 }).w).toBe(3);
    expect(pyramidLevelDims(5, 5).at(-1)).toEqual({ w: 1, h: 1 });
    expect(pyramidLevelDims(1024, 683).length).toBeGreaterThan(9);
  });

  it('tileLevelDims stops at the first level with both dims <= maxDim, not 1x1', () => {
    const levels = tileLevelDims(1024, 683, 64);
    const last = levels.at(-1)!;
    expect(last.w).toBeLessThanOrEqual(64);
    expect(last.h).toBeLessThanOrEqual(64);
    expect(levels.length).toBeLessThan(pyramidLevelDims(1024, 683).length);
  });

  it('tileLevelDims is a no-op (single level) when the image is already <= maxDim', () => {
    expect(tileLevelDims(40, 30, 64)).toEqual([{ w: 40, h: 30 }]);
  });

  it('reduceToTile never exceeds maxDim in either axis', () => {
    const img = makeNoise(300, 500, 1);
    const tile = reduceToTile(img, 64);
    expect(tile.w).toBeLessThanOrEqual(64);
    expect(tile.h).toBeLessThanOrEqual(64);
  });

  it('boxReduceGray is the EXACT arithmetic mean for a power-of-2 uniform-region image (no dyadic-alignment bias)', () => {
    // Half dark, half light, exactly 50/50 split — same construction as
    // verify-localtone.mjs's E4 fixture. A Burt-Adelson-weighted reduce
    // (stage 1c's own REDUCE_SHADER) was found in sim to bias this badly
    // (~1.6 stops toward one side) — this box reduce must not.
    const w = 64;
    const h = 64;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? -5 : 1;
    let cur: GrayImage = { data, w, h };
    while (cur.w > 1 || cur.h > 1) cur = boxReduceGray(cur);
    expect(cur.data[0]).toBeCloseTo(-2, 6); // (-5 + 1) / 2
  });
});

describe('histogramOf / statsFromHistogram', () => {
  it('a flat constant tile gives p25≈p75≈mean≈that value (within one histogram bin width — the within-bin uniform-density interpolation is only exact when the population truly spans the bin, not for a single repeated value), std=0', () => {
    const tile: GrayImage = { data: new Float32Array(16).fill(-3.25), w: 4, h: 4 };
    const { p25, p75, mean, std } = statsFromHistogram(histogramOf(tile));
    expect(Math.abs(p25 - -3.25)).toBeLessThan(0.3);
    expect(Math.abs(p75 - -3.25)).toBeLessThan(0.3);
    expect(Math.abs(mean - -3.25)).toBeLessThan(0.3);
    expect(std).toBeCloseTo(0, 6);
  });

  it('a 50/50 bimodal tile gives p25 near the low mode, p75 near the high mode, nonzero std', () => {
    const data = new Float32Array(256);
    for (let i = 0; i < 256; i++) data[i] = i < 128 ? -6 : -1;
    const tile: GrayImage = { data, w: 16, h: 16 };
    const { p25, p75, std } = statsFromHistogram(histogramOf(tile));
    expect(p25).toBeCloseTo(-6, 0);
    expect(p75).toBeCloseTo(-1, 0);
    expect(std).toBeGreaterThan(1);
  });

  it('p25 <= p75 always, on noisy data', () => {
    const img = makeNoise(64, 64, 99);
    const { p25, p75 } = statsFromHistogram(histogramOf(img));
    expect(p25).toBeLessThanOrEqual(p75);
  });
});

describe('computeFrameStats', () => {
  it('a small (<=tile) uniform image collapses to a single bin: p25=p75=value, std=0', () => {
    const img: GrayImage = { data: new Float32Array(32 * 32).fill(-2), w: 32, h: 32 };
    const stats = computeFrameStats(img);
    expect(Math.abs(stats.p25 - -2)).toBeLessThan(0.3);
    expect(Math.abs(stats.p75 - -2)).toBeLessThan(0.3);
    expect(stats.std).toBeCloseTo(0, 3);
    // std well below LOCALTONE_AMP_STAT_LOW -> amplitude multiplier is exactly 1.
    expect(stats.ampMultSh).toBe(1);
    expect(stats.ampMultHi).toBe(1);
  });
});

describe('amplitudeMultiplier (scene-adaptive law)', () => {
  it('is exactly 1 for std at or below LOCALTONE_AMP_STAT_LOW (round-3/E1/E4 own std range, ~0.1-0.3, is UNCHANGED)', () => {
    for (const std of [0, 0.1, 0.3, LOCALTONE_AMP_STAT_LOW]) {
      expect(amplitudeMultiplier(std, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B)).toBe(1);
      expect(amplitudeMultiplier(std, LOCALTONE_AMP_HI_A, LOCALTONE_AMP_HI_B)).toBe(1);
    }
  });

  it('is the exact fitted line at/above LOCALTONE_AMP_STAT_HIGH (real photos measured 1.6-3.3 std)', () => {
    const std = LOCALTONE_AMP_STAT_HIGH + 1;
    const expectedSh = Math.max(LOCALTONE_AMP_FLOOR, LOCALTONE_AMP_SH_A + LOCALTONE_AMP_SH_B * std);
    expect(amplitudeMultiplier(std, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B)).toBeCloseTo(expectedSh, 6);
  });

  it('is continuous and monotonic across the blend window', () => {
    let prev = amplitudeMultiplier(0, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B);
    for (let std = 0; std <= 4; std += 0.05) {
      const v = amplitudeMultiplier(std, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B);
      expect(Math.abs(v - prev)).toBeLessThan(0.3); // no jump discontinuity
      prev = v;
    }
  });

  it('never goes below the floor', () => {
    expect(amplitudeMultiplier(100, LOCALTONE_AMP_HI_A, -1)).toBeGreaterThanOrEqual(LOCALTONE_AMP_FLOOR);
  });

  it('real-photo std range (1.6-3.3): Shadows multiplier grows with std, Highlights shrinks (both LR-measured directions, see the implementer report)', () => {
    const shLow = amplitudeMultiplier(1.6, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B);
    const shHigh = amplitudeMultiplier(3.3, LOCALTONE_AMP_SH_A, LOCALTONE_AMP_SH_B);
    expect(shHigh).toBeGreaterThan(shLow);
    const hiLow = amplitudeMultiplier(1.6, LOCALTONE_AMP_HI_A, LOCALTONE_AMP_HI_B);
    expect(hiLow).toBeLessThan(1); // highlights always reduced vs the round-3 baseline in the measured range
  });
});

describe('shadowsCurve / highlightsCurve (ungated, no dead zone)', () => {
  it('shadowsCurve is monotonic DECREASING in x (never increases as x grows)', () => {
    let prev = Infinity;
    for (let x = -8; x <= 4; x += 0.25) {
      const v = shadowsCurve(x, 1);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('highlightsCurve is monotonic DECREASING (more negative) in x', () => {
    let prev = Infinity;
    for (let x = -4; x <= 8; x += 0.25) {
      const v = highlightsCurve(x, 1);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('shadowsCurve saturates toward LOCALTONE_SH_AMPLITUDE*ampMult as x -> -infinity, toward 0 as x -> +infinity', () => {
    expect(shadowsCurve(-50, 1)).toBeCloseTo(LOCALTONE_SH_AMPLITUDE, 3);
    expect(shadowsCurve(50, 1)).toBeCloseTo(0, 6);
  });

  it('highlightsCurve saturates toward -LOCALTONE_HI_AMPLITUDE*ampMult as x -> +infinity, toward 0 as x -> -infinity', () => {
    expect(highlightsCurve(50, 1)).toBeCloseTo(-LOCALTONE_HI_AMPLITUDE, 3);
    expect(highlightsCurve(-50, 1)).toBeCloseTo(0, 6);
  });

  it('NO dead zone: both curves are strictly nonzero arbitrarily close to x=0 (refutes stage 1d\'s identity onset window)', () => {
    expect(Math.abs(shadowsCurve(-0.01, 1))).toBeGreaterThan(0);
    expect(Math.abs(highlightsCurve(0.01, 1))).toBeGreaterThan(0);
  });

  it('ampMult scales the curve linearly (amplitude multiplier is a pure prefactor)', () => {
    expect(shadowsCurve(-1, 2)).toBeCloseTo(2 * shadowsCurve(-1, 1), 9);
    expect(highlightsCurve(1, 0.5)).toBeCloseTo(0.5 * highlightsCurve(1, 1), 9);
  });
});

describe('localToneShift', () => {
  const stats = { p25: -2, p75: 2, ampMultSh: 1, ampMultHi: 1 };

  it('is EXACTLY zero when both sliders are 0, regardless of base (isIdentityLocalTone\'s second branch depends on this)', () => {
    for (const base of [-10, -2, 0, 2, 10]) {
      expect(localToneShift(base, stats, 0, 0)).toBe(0);
    }
  });

  it('shadowsAmt alone lifts a pixel below refSh (positive shift)', () => {
    const shift = localToneShift(-4, stats, 1, 0); // base=-4, refSh=2 -> x=-6, deep shadow
    expect(shift).toBeGreaterThan(0);
  });

  it('highlightsAmt alone crushes a pixel above refHi (negative shift)', () => {
    const shift = localToneShift(6, stats, 0, 1); // base=6, refHi=-2 -> x=8, deep highlight
    expect(shift).toBeLessThan(0);
  });

  it('is exactly linear in slider strength (amt=0.5 shift is exactly half of amt=1 shift) — round-3\'s "sh_p50 = half sh_p100" finding, still holds under the new curve', () => {
    const half = localToneShift(-4, stats, 0.5, 0);
    const full = localToneShift(-4, stats, 1, 0);
    expect(half).toBeCloseTo(full / 2, 9);
    const halfHi = localToneShift(6, stats, 0, 0.5);
    const fullHi = localToneShift(6, stats, 0, 1);
    expect(halfHi).toBeCloseTo(fullHi / 2, 9);
  });

  it('both sliders active compose additively (shadows reads base-p75, highlights reads base-p25, independently)', () => {
    const base = 0;
    const shOnly = localToneShift(base, stats, 1, 0);
    const hiOnly = localToneShift(base, stats, 0, 1);
    const both = localToneShift(base, stats, 1, 1);
    expect(both).toBeCloseTo(shOnly + hiOnly, 9);
  });
});

describe('gaussianWeights / gaussianBlurGray (base blur, unchanged from stage 1d)', () => {
  it('weights sum to exactly 1 for any sigma/radius', () => {
    for (const sigma of [0.5, 2.5, 8]) {
      const w = gaussianWeights(sigma, Math.ceil(3 * sigma));
      let sum = 0;
      for (const v of w) sum += v;
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('is symmetric around the center tap', () => {
    const radius = 6;
    const w = gaussianWeights(2.5, radius);
    for (let i = 1; i <= radius; i++) expect(w[radius - i]).toBeCloseTo(w[radius + i]!, 9);
  });

  it('leaves a flat constant image untouched (clamp-to-edge preserves a uniform field exactly)', () => {
    const w = 16;
    const h = 16;
    const data = new Float32Array(w * h).fill(-1.75);
    const out = gaussianBlurGray({ data, w, h }, 2.5);
    for (const v of out.data) expect(v).toBeCloseTo(-1.75, 5);
  });

  it('blurs a hard step edge into a smooth monotonic transition (no ringing/overshoot)', () => {
    const w = 64;
    const h = 4;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? 0 : 10;
    const out = gaussianBlurGray({ data, w, h }, 2.5);
    let prev = -Infinity;
    for (let x = 0; x < w; x++) {
      const v = out.data[x]!;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(10 + 1e-6);
      prev = v;
    }
    expect(out.data[0]).toBeCloseTo(0, 3);
    expect(out.data[w - 1]).toBeCloseTo(10, 3);
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
  it('sanitize clamps out-of-range values (sigmaR a PIXEL radius, [1,8]) and never throws on garbage', () => {
    const p = sanitizeLocalToneParams({ shadows: 500, highlights: 500, clarity: -5, sigmaR: 0, amount: 5 }, 'n');
    expect(p.shadows).toBe(100);
    expect(p.highlights).toBe(0);
    expect(p.clarity).toBe(0);
    expect(p.sigmaR).toBeGreaterThanOrEqual(1);
    expect(p.sigmaR).toBeLessThanOrEqual(8);
    expect(p.amount).toBe(1);
    expect(() => sanitizeLocalToneParams('garbage', 'n')).not.toThrow();
    expect(() => sanitizeLocalToneParams(null, 'n')).not.toThrow();
  });
});
