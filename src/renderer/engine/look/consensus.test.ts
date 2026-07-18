import { describe, expect, it } from 'vitest';
import { computeLookConsensus, formatConsensusReport } from './consensus';
import {
  defaultDevelopParams,
  type BwParams,
  type CurvePoints,
  type DevelopBasicParams,
  type DevelopParams,
  type EffectsParams,
  type GradingWheel,
  type HslBand,
  type HslBandParams,
  type ToneCurveParams,
} from '../graph/developNode';

interface GradingOverride {
  shadows?: Partial<GradingWheel>;
  midtones?: Partial<GradingWheel>;
  highlights?: Partial<GradingWheel>;
  global?: Partial<GradingWheel>;
  blending?: number;
  balance?: number;
}

/** Deep-ish builder: start from defaultDevelopParams() (identity everywhere), shallow-merge whichever sections a test cares about. Keeps every fixture's untouched sections trivially at perfect agreement (spread 0 across all inputs), so each test can focus on the ONE family it's exercising. */
function makeLook(over: {
  basic?: Partial<DevelopBasicParams>;
  toneCurve?: Partial<ToneCurveParams>;
  hsl?: Partial<Record<HslBand, Partial<HslBandParams>>>;
  bw?: Partial<BwParams>;
  grading?: GradingOverride;
  effects?: Partial<EffectsParams>;
}): DevelopParams {
  const d = defaultDevelopParams();
  if (over.basic) d.basic = { ...d.basic, ...over.basic };
  if (over.toneCurve) d.toneCurve = { ...d.toneCurve, ...over.toneCurve };
  if (over.bw) d.bw = { ...d.bw, ...over.bw };
  if (over.grading) {
    const { shadows, midtones, highlights, global, ...rest } = over.grading;
    if (shadows) d.grading.shadows = { ...d.grading.shadows, ...shadows };
    if (midtones) d.grading.midtones = { ...d.grading.midtones, ...midtones };
    if (highlights) d.grading.highlights = { ...d.grading.highlights, ...highlights };
    if (global) d.grading.global = { ...d.grading.global, ...global };
    d.grading = { ...d.grading, ...rest };
  }
  if (over.effects) d.effects = { ...d.effects, ...over.effects };
  if (over.hsl) {
    for (const band of Object.keys(over.hsl) as HslBand[]) {
      d.hsl[band] = { ...d.hsl[band], ...over.hsl[band]! };
    }
  }
  return d;
}

/** A degenerate flat "curve" (constant value at every x) — not a realistic tone curve, but exact and trivial to reason about for consensus math: curveEvaluator returns `c` for every input regardless of x. */
function flatCurve(c: number): CurvePoints {
  return [
    [0, c],
    [255, c],
  ];
}

describe('computeLookConsensus', () => {
  it('medians a tightly-agreeing family (basic-tone) and excludes a wildly divergent one (wb)', () => {
    const evs = [0.4, 0.45, 0.5, 0.42];
    const temps = [2000, 15000, 30000, 50000]; // spans the FULL 2000..50000 domain — max disagreement
    const tints = [-150, -50, 50, 150]; // spans the FULL -150..150 domain — max disagreement
    const looks = evs.map((ev, i) => makeLook({ basic: { ev, temp: temps[i]!, tint: tints[i]! } }));

    const result = computeLookConsensus(looks);

    expect(result.includes).toContain('basic-tone');
    expect(result.includes).not.toContain('wb');
    // median([0.40, 0.42, 0.45, 0.50]) = (0.42+0.45)/2
    expect(result.params.basic.ev).toBeCloseTo(0.435, 6);
    // wb excluded -> stays at defaultDevelopParams' identity, not some averaged Kelvin nobody asked for
    expect(result.params.basic.temp).toBe(0);
    expect(result.params.basic.tint).toBe(0);

    const wbReport = result.reports.find((r) => r.family === 'wb')!;
    expect(wbReport.included).toBe(false);
    expect(wbReport.reason).toBe('below-threshold');
    expect(wbReport.agreement).toBeLessThan(0.1);

    const basicReport = result.reports.find((r) => r.family === 'basic-tone')!;
    expect(basicReport.included).toBe(true);
    expect(basicReport.agreement).toBeGreaterThan(0.9);
  });

  it('--families restricts consideration regardless of how well the inputs actually agree', () => {
    const looks = [0.4, 0.45, 0.5, 0.42].map((ev) => makeLook({ basic: { ev } }));
    // Every OTHER family is trivially at perfect agreement here (untouched,
    // all default) — proving the filter, not the threshold, is what excludes them.
    const result = computeLookConsensus(looks, { families: ['basic-tone'] });

    expect(result.includes).toEqual(['basic-tone']);
    const others = result.reports.filter((r) => r.family !== 'basic-tone');
    expect(others.every((r) => r.included === false)).toBe(true);
    expect(others.every((r) => r.reason === 'excluded-by-filter')).toBe(true);
  });

  it('curve consensus: medians in point space and excludes a family that disagrees at every grid point', () => {
    const cs = [0, 85, 170, 255];
    const looks = cs.map((c) => makeLook({ toneCurve: { rgb: flatCurve(c), r: flatCurve(c), g: flatCurve(c), b: flatCurve(c) } }));

    const result = computeLookConsensus(looks);

    const curvesReport = result.reports.find((r) => r.family === 'curves')!;
    expect(curvesReport.included).toBe(false);
    expect(curvesReport.reason).toBe('below-threshold');
    // every grid point sees the SAME [0,85,170,255] spread (full domain) —
    // agreement should be ~0 at every point, not just on average
    expect(curvesReport.agreement).toBeLessThan(0.05);
    expect(curvesReport.curves).toBeDefined();
    for (const ch of curvesReport.curves!) {
      expect(ch.agreement).toBeLessThan(0.05);
      // median([0,85,170,255]) = (85+170)/2, constant across the whole grid
      for (const [, y] of ch.points) expect(y).toBeCloseTo(127.5, 6);
    }
    // excluded -> the extracted preset's toneCurve stays identity
    expect(result.params.toneCurve.rgb).toEqual(defaultDevelopParams().toneCurve.rgb);
  });

  it('circular consensus for grading hue: a tight cluster straddling the 0/360 wrap reads as high agreement, not high spread', () => {
    // symmetric around 0°: raw numeric values [350,5,10,355] look like they
    // span 345° apart, but on the wheel they're all within 10° of each other
    const hues = [350, 5, 10, 355];
    const looks = hues.map((hue) => makeLook({ grading: { shadows: { hue } } }));

    const result = computeLookConsensus(looks);

    const gradingReport = result.reports.find((r) => r.family === 'grading')!;
    expect(gradingReport.included).toBe(true);
    expect(gradingReport.agreement).toBeGreaterThan(0.95);
    const hueField = gradingReport.fields.find((f) => f.label === 'grading.shadows.hue')!;
    expect(hueField.agreement).toBeGreaterThan(0.98);
    // the symmetric fixture cancels to exactly 0°
    expect(((hueField.center % 360) + 360) % 360).toBeCloseTo(0, 3);
  });

  it('wb.temp treats 0 (unresolved placeholder) as absent, not a real Kelvin value to average in', () => {
    const looks = [0, 0, 5600, 5600].map((temp) => makeLook({ basic: { temp } }));
    const result = computeLookConsensus(looks);

    expect(result.params.basic.temp).toBe(5600);
    const wbReport = result.reports.find((r) => r.family === 'wb')!;
    expect(wbReport.included).toBe(true);
    expect(wbReport.agreement).toBeGreaterThan(0.95);
  });

  it('bw.enabled is a boolean median (round-to-nearest of the 0/1 vote)', () => {
    const looks = [true, true, true, false].map((enabled) => makeLook({ bw: { enabled, mix: defaultDevelopParams().bw.mix } }));
    const result = computeLookConsensus(looks);
    expect(result.params.bw.enabled).toBe(true);
  });

  it('throws on an empty input list', () => {
    expect(() => computeLookConsensus([])).toThrow();
  });
});

describe('formatConsensusReport', () => {
  it('produces human-readable lines naming each family and its inclusion status', () => {
    const looks = [0.4, 0.45, 0.5, 0.42].map((ev) => makeLook({ basic: { ev, temp: 2000 * (1 + Math.random() * 20) } }));
    const result = computeLookConsensus(looks);
    const lines = formatConsensusReport(result.reports);
    expect(lines.some((l) => l.startsWith('basic-tone: INCLUDED'))).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});
