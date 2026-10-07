/**
 * Unit tier (vitest) for the named base tones (docs/decisions/0001 + 0002):
 * the pass-skip contract for 'none', the roll-off of values above 1.0 that
 * the clamped tone curve cannot do, chain placement, and lenient sanitizing.
 * GPU-vs-CPU agreement is covered by verify-basetone.mjs.
 */
import { describe, expect, it } from 'vitest';
import { applyBaseToneCpu, BASE_TONE_IDS, baseToneWgslBody, sanitizeBaseTone, sigmoidCurve, type BaseToneId } from './baseTone';
import { compileDevelop, defaultDevelopParams, type DevelopParams } from '../graph/developNode';
import { mergeDevelopParams } from '../graph/graphDoc';
import { pickDevelopFamilies } from '../graph/presetFamilies';

const WB_IDENTITY: [number, number, number] = [1, 1, 1];
const TONES = BASE_TONE_IDS.filter((id) => id !== 'none') as Exclude<BaseToneId, 'none'>[];
const grey = (v: number): [number, number, number] => [v, v, v];

function withBaseTone(id: BaseToneId): DevelopParams {
  const p = defaultDevelopParams();
  p.profile = { ...p.profile, baseTone: id };
  return p;
}

describe('base tone — none / pass-skip', () => {
  it("'none' is the default and emits no pass", () => {
    expect(defaultDevelopParams().profile.baseTone).toBe('none');
    expect(baseToneWgslBody('none')).toBeNull();
    expect(compileDevelop(defaultDevelopParams(), WB_IDENTITY, 1).passes).toHaveLength(0);
  });

  it("'none' CPU mirror is the identity", () => {
    expect(applyBaseToneCpu('none', [0.2, 1.3, 0.05])).toEqual([0.2, 1.3, 0.05]);
  });

  it.each(TONES)('%s emits exactly one develop/baseTone pass', (id) => {
    const { passes } = compileDevelop(withBaseTone(id), WB_IDENTITY, 1);
    expect(passes.map((p) => p.shaderId)).toEqual([`develop/baseTone/${id}`]);
  });
});

describe('base tone — display mapping', () => {
  it.each(TONES)('%s is monotone on neutrals and keeps the sensor peak inside display range', (id) => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const v = applyBaseToneCpu(id, grey((i / 200) * 1.42))[1];
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    // ≈1.41 = sensor saturation after the +0.5 EV baseline exposure
    expect(applyBaseToneCpu(id, grey(1.41))[1]).toBeLessThanOrEqual(1.0001);
  });

  it.each(TONES)('%s rolls off above 1.0 instead of clipping (1.0 and 1.41 stay distinct)', (id) => {
    const a = applyBaseToneCpu(id, grey(1.0))[1];
    const b = applyBaseToneCpu(id, grey(1.41))[1];
    expect(b - a).toBeGreaterThan(0.01);
  });

  // agx_punchy is a contrast look (power 1.35) and sits darker than AgX in
  // the midtones by design; it gets its own checks below.
  it.each(TONES.filter((id) => id !== 'agx_punchy'))('%s brightens the neutral decode (includes the +1 EV pre-gain)', (id) => {
    // a typical neutral-decode midtone sits well under display mid-grey
    expect(applyBaseToneCpu(id, grey(0.05))[1]).toBeGreaterThan(0.05);
  });

  it('agx_punchy: darker midtones and more saturation than agx', () => {
    expect(applyBaseToneCpu('agx_punchy', grey(0.05))[1]).toBeLessThan(applyBaseToneCpu('agx', grey(0.05))[1]);
    const sat = ([r, g, b]: [number, number, number]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    const color: [number, number, number] = [0.12, 0.06, 0.03];
    expect(sat(applyBaseToneCpu('agx_punchy', color))).toBeGreaterThan(sat(applyBaseToneCpu('agx', color)));
  });

  describe('sigmoid (darktable sigmoid defaults)', () => {
    const G = 0.1845;
    it('hits the darktable targets: black 0.0152 %, grey → grey, white → 1', () => {
      expect(sigmoidCurve(0)).toBeCloseTo(0.000152, 9);
      expect(sigmoidCurve(G)).toBeCloseTo(G, 9);
      expect(sigmoidCurve(1e9)).toBeCloseTo(1, 6);
    });
    // The exponent is solved as if the black target were 0 (darktable makes
    // the same simplification), so the small black lift shifts the slope by
    // under 1 %.
    it('slope at grey ≈ contrast · (1 − grey) = 1.5 · 0.8155 (within 1 %)', () => {
      const d = 1e-6;
      const slope = (sigmoidCurve(G + d) - sigmoidCurve(G - d)) / (2 * d);
      expect(Math.abs(slope / (1.5 * (1 - G)) - 1)).toBeLessThan(0.01);
    });
    it('includes the +1 EV pre-gain: input grey/2 lands on grey', () => {
      const out = applyBaseToneCpu('sigmoid', grey(G / 2));
      for (const v of out) expect(v).toBeCloseTo(G, 6);
    });
    it('preserves hexcone hue: (mid − min)/(max − min) is unchanged', () => {
      const hue = ([r, g, b]: [number, number, number]) => {
        const s = [r, g, b].sort((p, q) => p - q);
        return (s[1]! - s[0]!) / (s[2]! - s[0]!);
      };
      for (const c of [[0.9, 0.4, 0.05], [0.02, 0.3, 1.2], [0.5, 0.45, 0.1]] as [number, number, number][]) {
        const out = applyBaseToneCpu('sigmoid', c);
        expect(hue(out)).toBeCloseTo(hue(c), 9);
        // channel order is kept, too
        expect(out.map((v, i) => [v, i]).sort((p, q) => p[0]! - q[0]!).map((p) => p[1])).toEqual(
          c.map((v, i) => [v, i]).sort((p, q) => p[0]! - q[0]!).map((p) => p[1])
        );
      }
    });
    it('desaturates a negative channel toward the mean instead of clipping it', () => {
      const out = applyBaseToneCpu('sigmoid', [0.3, 0.1, -0.05]);
      expect(Math.min(...out)).toBeCloseTo(sigmoidCurve(0), 9);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    });
  });

  it('runs after the Basic tone stage and before the user tone curve', () => {
    const p = withBaseTone('agx');
    p.basic = { ...p.basic, ev: 1 };
    p.toneCurve = { ...p.toneCurve, rgb: [[0, 0], [128, 160], [255, 255]] };
    const ids = compileDevelop(p, WB_IDENTITY, 1).passes.map((x) => x.shaderId);
    expect(ids).toEqual(['develop/tone', 'develop/baseTone/agx', 'develop/toneCurve']);
  });
});

describe('base tone — sanitize', () => {
  it('absent key (pre-0001 docs) → none', () => {
    expect(mergeDevelopParams({ profile: { amount: 100 } }).profile.baseTone).toBe('none');
  });

  it('known ids round-trip', () => {
    for (const id of BASE_TONE_IDS) expect(mergeDevelopParams({ profile: { amount: 0, baseTone: id } }).profile.baseTone).toBe(id);
  });

  it('unknown or wrong-typed value sanitizes quietly to none', () => {
    expect(sanitizeBaseTone('filmic-v9')).toBe('none');
    expect(sanitizeBaseTone(3)).toBe('none');
    expect(mergeDevelopParams({ profile: { amount: 0, baseTone: 'nope' } }).profile.baseTone).toBe('none');
  });
});

describe('base tone — robustness', () => {
  it.each(TONES)('%s stays finite for Inf / huge / negative input', (id) => {
    for (const px of [[Infinity, Infinity, Infinity], [1e30, 0.2, 0.1], [-0.5, 0.3, -1]] as [number, number, number][]) {
      for (const v of applyBaseToneCpu(id, px)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('base tone — old docs and presets', () => {
  it('a pre-0001 doc (no baseTone key) compiles to exactly the passes of an explicit none', () => {
    const old = mergeDevelopParams({ profile: { amount: 100 }, toneCurve: { rgb: [[0, 0], [116, 180], [255, 255]] } });
    const explicit = mergeDevelopParams({ profile: { amount: 100, baseTone: 'none' }, toneCurve: { rgb: [[0, 0], [116, 180], [255, 255]] } });
    const ids = (p: DevelopParams) => compileDevelop(p, WB_IDENTITY, 1).passes.map((x) => x.shaderId);
    expect(ids(old)).toEqual(ids(explicit));
    expect(ids(old).some((s) => s.startsWith('develop/baseTone'))).toBe(false);
  });

  it('a preset carries baseTone with the basic-tone family, and leaves it alone without it', () => {
    const preset = withBaseTone('agx');
    const open = withBaseTone('sigmoid');
    expect(pickDevelopFamilies(preset, open, new Set(['basic-tone'])).profile.baseTone).toBe('agx');
    expect(pickDevelopFamilies(preset, open, new Set(['wb'])).profile.baseTone).toBe('sigmoid');
  });
});
