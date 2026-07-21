/**
 * Unit tier (vitest) for the develop-aware filmstrip thumbnail bug fix
 * (docs/brief-bank/develop-aware-thumbnails-impl.md's "ROOT CAUSE"/"FIX"):
 * getDevelopAwareThumbnail used to hand cpuEvalPlan a look's FULL plan,
 * which throws on the first no-CPU-mirror (spatial) step — and a real RAW's
 * default look always seeds Detail (sharpening), so every real-RAW cell fell
 * back to the plain preview, discarding otherwise-mirrorable color/tone
 * edits. Pins the two pieces of the fix directly, without spinning up
 * Electron/Playwright (see scripts/verify-develop-thumbnails.mjs for the
 * end-to-end regression case over an actual filmstrip cell):
 *  - `stripSpatialDevelopParams` (developNode.ts) flips a Develop node's
 *    `compileDevelop().cpu` from null back to non-null by zeroing ONLY
 *    Detail/fx-spatial, leaving tone/curve/etc. edits intact.
 *  - `stripNoCpuMirrorSteps` (graphDoc.ts) bypasses a no-CPU-mirror step
 *    from a DIFFERENT node (spots) mid-chain, keeping the mirrorable steps
 *    around it usable by cpuEvalPlan.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  cpuEvalPlan,
  DEVELOP_KIND,
  defaultGraphDoc,
  planHasCpuReference,
  stripNoCpuMirrorSteps,
  type GraphDoc,
} from './graphDoc';
import { defaultDevelopParams, stripSpatialDevelopParams } from './developNode';
import { defaultSpotsParams, SPOTS_KIND, type SpotsParams } from './spotsNode';

describe('stripSpatialDevelopParams', () => {
  it('a Develop node with ONLY Detail active compiles to no CPU mirror before stripping', () => {
    const doc = defaultGraphDoc();
    const dev = doc.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    dev.develop = { ...defaultDevelopParams(), detail: { ...defaultDevelopParams().detail, sharpen: { amount: 40, radius: 1, masking: 0 } } };
    const plan = buildPlan(doc);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe('passes');
    expect((plan.steps[0] as { cpu: unknown }).cpu).toBeNull();
    expect(planHasCpuReference(plan)).toBe(false);
  });

  it('zeroing Detail+fx-spatial flips the SAME node back to a non-null CPU mirror', () => {
    const doc = defaultGraphDoc();
    const dev = doc.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    dev.develop = { ...defaultDevelopParams(), detail: { ...defaultDevelopParams().detail, sharpen: { amount: 40, radius: 1, masking: 0 } } };
    dev.develop = stripSpatialDevelopParams(dev.develop);
    const plan = buildPlan(doc);
    expect(plan.steps).toHaveLength(0); // Detail was the ONLY edit — stripped to nothing = identity, bit-exact pass-through
  });

  it('a Develop node with BOTH a tonal edit AND Detail active: stripping keeps the tonal edit and drops only Detail', () => {
    const doc = defaultGraphDoc();
    const dev = doc.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    const base = defaultDevelopParams();
    dev.develop = { ...base, basic: { ...base.basic, ev: 1.8 }, detail: { ...base.detail, sharpen: { amount: 40, radius: 1, masking: 0 } } };

    const fullPlan = buildPlan(doc);
    expect((fullPlan.steps[0] as { cpu: unknown }).cpu).toBeNull(); // bundled node, Detail nulls the WHOLE mirror

    dev.develop = stripSpatialDevelopParams(dev.develop);
    const plan = buildPlan(doc);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0] as { type: 'passes'; cpu: ((px: [number, number, number], x: number, y: number, w: number, h: number) => [number, number, number]) | null };
    expect(step.cpu).not.toBeNull(); // the +EV tone edit is still mirrorable once Detail is zeroed
    const out = cpuEvalPlan(plan, [0.1, 0.1, 0.1], 0, 0, 1, 1);
    expect(out[0]).toBeGreaterThan(0.1); // +1.8 EV brightens
  });

  it('leaves every OTHER section (tone/curve/HSL/BW/grading) untouched', () => {
    const base = defaultDevelopParams();
    base.basic.ev = 1;
    base.hsl.red.s = 20;
    base.bw.enabled = true;
    base.detail.sharpen.amount = 40;
    base.detail.noiseLuminance.amount = 30;
    base.effects.clarity = 15;
    const stripped = stripSpatialDevelopParams(base);
    expect(stripped.basic.ev).toBe(1);
    expect(stripped.hsl.red.s).toBe(20);
    expect(stripped.bw.enabled).toBe(true);
    expect(stripped.detail.sharpen.amount).toBe(0);
    expect(stripped.detail.noiseLuminance.amount).toBe(0);
    expect(stripped.effects.clarity).toBe(0);
  });
});

describe('stripNoCpuMirrorSteps', () => {
  function docWithSpotAfterDevelop(): GraphDoc {
    const doc = defaultGraphDoc();
    const dev = doc.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    dev.develop = { ...defaultDevelopParams(), basic: { ...defaultDevelopParams().basic, ev: 1 } };
    const spotsParams: SpotsParams = { spots: [{ dx: 0.5, dy: 0.5, sx: 0.2, sy: 0.2, radius: 0.05, feather: 0.3 }] };
    doc.nodes.splice(2, 0, { id: 'spots1', kind: SPOTS_KIND, position: { x: 320, y: 60 }, spots: spotsParams });
    doc.edges = [
      { id: 'e0', source: 'in', target: 'dev' },
      { id: 'e1', source: 'dev', target: 'spots1' },
      { id: 'e2', source: 'spots1', target: 'out' },
    ];
    return doc;
  }

  it('a plan with a real spot mid-chain has NO CPU reference and cpuEvalPlan throws', () => {
    const plan = buildPlan(docWithSpotAfterDevelop());
    expect(plan.steps).toHaveLength(2); // Develop (cpu ok), spots (cpu null)
    expect(planHasCpuReference(plan)).toBe(false);
    expect(() => cpuEvalPlan(plan, [0.1, 0.1, 0.1], 0, 0, 1, 1)).toThrow();
  });

  it('bypasses the spots step, keeping the mirrorable Develop step usable', () => {
    const plan = buildPlan(docWithSpotAfterDevelop());
    const stripped = stripNoCpuMirrorSteps(plan);
    expect(stripped.steps).toHaveLength(1);
    expect(planHasCpuReference(stripped)).toBe(true);
    const out = cpuEvalPlan(stripped, [0.1, 0.1, 0.1], 0, 0, 1, 1);
    expect(out[0]).toBeGreaterThan(0.1); // the upstream +1 EV still applies
  });

  it('an all-spatial plan (no tonal edit at all) strips down to zero steps', () => {
    const doc = defaultGraphDoc(); // default develop = identity, no step emitted
    const spotsParams: SpotsParams = { spots: [{ dx: 0.5, dy: 0.5, sx: 0.2, sy: 0.2, radius: 0.05, feather: 0.3 }] };
    doc.nodes.splice(2, 0, { id: 'spots1', kind: SPOTS_KIND, position: { x: 320, y: 60 }, spots: spotsParams });
    doc.edges = [
      { id: 'e0', source: 'in', target: 'dev' },
      { id: 'e1', source: 'dev', target: 'spots1' },
      { id: 'e2', source: 'spots1', target: 'out' },
    ];
    const plan = buildPlan(doc);
    expect(plan.steps).toHaveLength(1); // just the spot
    const stripped = stripNoCpuMirrorSteps(plan);
    expect(stripped.steps).toHaveLength(0);
    expect(stripped.output).toBe(-1); // bypassed all the way to the raw input pixel
  });

  it('defaultSpotsParams() (empty list) never even reaches buildPlan as a step — sanity on the fixture', () => {
    expect(defaultSpotsParams().spots).toHaveLength(0);
  });
});
