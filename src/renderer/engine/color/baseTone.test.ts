/**
 * Unit tier (vitest) for the named base tones (docs/decisions/0001 + 0002):
 * the pass-skip contract for 'none', the roll-off of values above 1.0 that
 * the clamped tone curve cannot do, chain placement, and lenient sanitizing.
 * GPU-vs-CPU agreement is covered by verify-basetone.mjs.
 */
import { describe, expect, it } from 'vitest';
import { applyBaseToneCpu, BASE_TONE_IDS, baseToneWgslBody, sanitizeBaseTone, type BaseToneId } from './baseTone';
import { compileDevelop, defaultDevelopParams, type DevelopParams } from '../graph/developNode';
import { mergeDevelopParams } from '../graph/graphDoc';

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

  it.each(TONES)('%s brightens the neutral decode (includes the +1 EV pre-gain)', (id) => {
    // a typical neutral-decode midtone sits well under display mid-grey
    expect(applyBaseToneCpu(id, grey(0.05))[1]).toBeGreaterThan(0.05);
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
