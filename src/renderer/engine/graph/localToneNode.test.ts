/**
 * Unit tier (vitest) for the local-adaptive tone node's pure math — STAGE 1d
 * (global reference + small-radius base/detail split): the box-reduce global
 * mean (`globalLogMean`), the separable Gaussian base blur (`gaussianBlurGray`),
 * and the sign-gated bounded remap curve (`toneTail`/`remapBase`) used by the
 * GPU pass chain in graphRenderer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  boxReduceGray,
  gaussianBlurGray,
  gaussianWeights,
  globalLogMean,
  isIdentityLocalTone,
  LOCALTONE_TONE_FLOOR_HI,
  LOCALTONE_TONE_FLOOR_SH,
  LOCALTONE_TONE_ONSET_HI,
  LOCALTONE_TONE_ONSET_SH,
  pyramidLevelDims,
  remapBase,
  sanitizeLocalToneParams,
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

describe('boxReduceGray / globalLogMean (STAGE 1d global reference)', () => {
  it('reduceGray halves dims with ceil, down to 1x1', () => {
    expect(boxReduceGray({ data: new Float32Array(5 * 5), w: 5, h: 5 }).w).toBe(3);
    expect(pyramidLevelDims(5, 5).at(-1)).toEqual({ w: 1, h: 1 });
    expect(pyramidLevelDims(1024, 683).length).toBeGreaterThan(9);
  });

  it('is the EXACT arithmetic mean for a power-of-2 uniform-region image (no dyadic-alignment bias)', () => {
    // Half dark, half light, exactly 50/50 split — same construction as
    // verify-localtone.mjs's E4 fixture. A Burt-Adelson-weighted reduce
    // (stage 1c's own REDUCE_SHADER) was found in sim to bias this badly
    // (~1.6 stops toward one side) — this box reduce must not.
    const w = 64;
    const h = 64;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? -5 : 1;
    const mean = globalLogMean({ data, w, h });
    expect(mean).toBeCloseTo(-2, 6); // (-5 + 1) / 2
  });

  it('is exact for a flat constant image', () => {
    const data = new Float32Array(37 * 23).fill(-3.25);
    expect(globalLogMean({ data, w: 37, h: 23 })).toBeCloseTo(-3.25, 5);
  });

  it('is exact on a single-pixel (1x1) image (degenerate case)', () => {
    expect(globalLogMean({ data: new Float32Array([2.5]), w: 1, h: 1 })).toBeCloseTo(2.5, 6);
  });

  it('handles non-power-of-2 / odd dims without throwing and stays within the data range', () => {
    const img = makeNoise(37, 23, 12345);
    const mean = globalLogMean(img);
    const lo = Math.min(...img.data);
    const hi = Math.max(...img.data);
    expect(mean).toBeGreaterThanOrEqual(lo);
    expect(mean).toBeLessThanOrEqual(hi);
  });
});

describe('gaussianWeights / gaussianBlurGray (STAGE 1d base blur)', () => {
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
    // Monotonic non-decreasing across the row, and never outside [0,10] (no overshoot).
    let prev = -Infinity;
    for (let x = 0; x < w; x++) {
      const v = out.data[x]!;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(10 + 1e-6);
      prev = v;
    }
    // Far from the edge, the blur has fully saturated to the plateau value.
    expect(out.data[0]).toBeCloseTo(0, 3);
    expect(out.data[w - 1]).toBeCloseTo(10, 3);
  });
});

describe('toneTail (one-sided bounded tail, unchanged shape from stage 1c)', () => {
  it('is exact identity below onset regardless of floorSlope', () => {
    for (const ad of [0, LOCALTONE_TONE_ONSET_SH * 0.3, LOCALTONE_TONE_ONSET_SH * 0.5]) {
      expect(toneTail(ad, LOCALTONE_TONE_ONSET_SH, 0)).toBeCloseTo(ad, 3);
      expect(toneTail(ad, LOCALTONE_TONE_ONSET_SH, 1)).toBeCloseTo(ad, 3);
    }
  });

  it('floorSlope=1 is identity everywhere', () => {
    for (const ad of [0, 1, 5, 12]) {
      expect(toneTail(ad, LOCALTONE_TONE_ONSET_SH, 1)).toBeCloseTo(ad, 6);
    }
  });

  it('floorSlope=0 saturates to a flat cap at onset for large ad (never grows further)', () => {
    const far1 = toneTail(5, LOCALTONE_TONE_ONSET_SH, 0);
    const far2 = toneTail(10, LOCALTONE_TONE_ONSET_SH, 0);
    expect(far1).toBeCloseTo(LOCALTONE_TONE_ONSET_SH, 2);
    expect(far2).toBeCloseTo(LOCALTONE_TONE_ONSET_SH, 2);
  });

  it('is approximately monotonic in ad for any floorSlope in [0,1]', () => {
    for (const floorSlope of [0, 0.3, 0.7, 1]) {
      let prev = -Infinity;
      for (let ad = 0; ad <= 6; ad += 0.25) {
        const v = toneTail(ad, LOCALTONE_TONE_ONSET_SH, floorSlope);
        expect(v).toBeGreaterThanOrEqual(prev - 0.05);
        prev = v;
      }
    }
  });
});

describe('remapBase (STAGE 1d: sign-gated, bounded curve against a GLOBAL ref)', () => {
  it('is exact identity when shadowsAmt=highlightsAmt=0', () => {
    for (const d of [-10, -5, -1, 0, 1, 5, 12]) {
      expect(remapBase(-2 + d, -2, 0, 0)).toBeCloseTo(-2 + d, 6);
    }
  });

  it('d<0 (base below ref) is touched ONLY by shadowsAmt, never by highlightsAmt', () => {
    const ref = -2;
    const dNeg = -8;
    const withShadow = remapBase(ref + dNeg, ref, 1, 0);
    const withHighlightOnly = remapBase(ref + dNeg, ref, 0, 1);
    expect(withShadow).not.toBeCloseTo(ref + dNeg, 3); // shadows DID move it
    expect(withHighlightOnly).toBeCloseTo(ref + dNeg, 6); // highlights must NOT touch the d<0 side
  });

  it('d>=0 (base at/above ref) is touched ONLY by highlightsAmt, never by shadowsAmt', () => {
    const ref = -2;
    const dPos = 8;
    const withHighlight = remapBase(ref + dPos, ref, 0, 1);
    const withShadowOnly = remapBase(ref + dPos, ref, 1, 0);
    expect(withHighlight).not.toBeCloseTo(ref + dPos, 3); // highlights DID move it
    expect(withShadowOnly).toBeCloseTo(ref + dPos, 6); // shadows must NOT touch the d>=0 side
  });

  it('never overshoots PAST ref for any amt/offset (bounded, unlike an unbounded additive form)', () => {
    const ref = 0;
    for (const ad of [1, 4, 10, 50]) {
      const lifted = remapBase(ref - ad, ref, 1, 0);
      expect(lifted).toBeLessThanOrEqual(ref + 1e-6); // lift never crosses above ref
      const crushed = remapBase(ref + ad, ref, 0, 1);
      expect(crushed).toBeGreaterThanOrEqual(ref - 1e-6); // crush never crosses below ref
    }
  });

  it('shadowsAmt=1 lifts a deep-negative offset toward ref, more than a partial amt does', () => {
    const ref = 0;
    const liftedFull = remapBase(ref - 8, ref, 1, 0);
    const liftedPartial = remapBase(ref - 8, ref, 0.3, 0);
    const untouched = ref - 8;
    expect(liftedFull).toBeGreaterThan(untouched); // moved toward ref
    expect(liftedFull).toBeGreaterThan(liftedPartial); // stronger amt -> more lift
    expect(liftedPartial).toBeGreaterThan(untouched);
  });

  it('is exactly linear in slider strength (amt=0.5 delta is exactly half of amt=1 delta) — round-3\'s "sh_p50 = half sh_p100" finding', () => {
    const ref = 0;
    const base = ref - 3; // past the onset window, in the pure-linear-tail region
    const deltaHalf = remapBase(base, ref, 0.5, 0) - base;
    const deltaFull = remapBase(base, ref, 1, 0) - base;
    expect(deltaHalf).toBeCloseTo(deltaFull / 2, 6);
    // Same property for highlights.
    const baseHi = ref + 3;
    const deltaHalfHi = remapBase(baseHi, ref, 0, 0.5) - baseHi;
    const deltaFullHi = remapBase(baseHi, ref, 0, 1) - baseHi;
    expect(deltaHalfHi).toBeCloseTo(deltaFullHi / 2, 6);
  });
});

describe('LOCALTONE_TONE_FLOOR_SH / LOCALTONE_TONE_FLOOR_HI', () => {
  it('are valid slope fractions in [0, 1)', () => {
    expect(LOCALTONE_TONE_FLOOR_SH).toBeGreaterThanOrEqual(0);
    expect(LOCALTONE_TONE_FLOOR_SH).toBeLessThan(1);
    expect(LOCALTONE_TONE_FLOOR_HI).toBeGreaterThanOrEqual(0);
    expect(LOCALTONE_TONE_FLOOR_HI).toBeLessThan(1);
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
  it('sanitize clamps out-of-range values (sigmaR now a PIXEL radius, [1,8]) and never throws on garbage', () => {
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
