/**
 * Unit tier for the preset-on-open pieces (docs/decisions/0004): which slug
 * is in effect, and how a preset is layered onto a freshly seeded graph
 * (same semantics as the Presets menu's apply).
 */
import { describe, it, expect } from 'vitest';
import { applyPresetOnFreshGraph, rawOpenPresetSlug } from './appStore';
import { defaultGraphDoc, DEVELOP_KIND, type GraphDoc } from '../engine/graph/graphDoc';
import { defaultDevelopParams, type DevelopParams } from '../engine/graph/developNode';
import { buildScopedLook } from '../engine/graph/presetFamilies';
import type { ParsedPreset } from '../engine/graph/presetDoc';

(globalThis as unknown as { window: unknown }).window = {
  silverbox: {
    testFlags: { isTest: false, lensProfileAutoDefault: false, baseCurveDefault: false, forceDefaults: false },
  },
};

function withDevelop(graph: GraphDoc, edit: (d: DevelopParams) => DevelopParams): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.kind === DEVELOP_KIND && n.develop ? { ...n, develop: edit(n.develop) } : n)),
  };
}

function developOf(graph: GraphDoc): DevelopParams {
  return graph.nodes.find((n) => n.kind === DEVELOP_KIND)!.develop!;
}

/** A look that brightens (basic-tone family) and adds vibrance-free sharpening (detail family). */
function editedLook(): GraphDoc {
  return withDevelop(defaultGraphDoc(), (d) => ({
    ...d,
    basic: { ...d.basic, ev: 0.7 },
    detail: { ...d.detail, sharpen: { ...d.detail.sharpen, amount: 90 } },
  }));
}

/** The fresh graph a crop is set on, to prove a preset never carries or clears geometry. */
function croppedFresh(): GraphDoc {
  const g = defaultGraphDoc();
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.kind === 'input' && n.geometry ? { ...n, geometry: { ...n.geometry, crop: { ...n.geometry.crop, x: 0.1, w: 0.8 } } } : n
    ),
  };
}

describe('rawOpenPresetSlug', () => {
  it('reads the real field outside tests and the twin inside, never the other', () => {
    const settings = { rawOpenPreset: 'mine', rawOpenPresetTest: 'test-one' };
    expect(rawOpenPresetSlug(settings, false)).toBe('mine');
    expect(rawOpenPresetSlug(settings, true)).toBe('test-one');
  });

  it("is '' (none) when the twin is unset, even if the user has a preset", () => {
    expect(rawOpenPresetSlug({ rawOpenPreset: 'mine' }, true)).toBe('');
  });
});

describe('applyPresetOnFreshGraph', () => {
  it('a whole-look preset replaces the develop look but keeps the open photo geometry', () => {
    const preset: ParsedPreset = { name: 'Whole', createdAt: '', look: editedLook() };
    const fresh = croppedFresh();
    const out = applyPresetOnFreshGraph(fresh, preset);
    expect(developOf(out).basic.ev).toBe(0.7);
    expect(developOf(out).detail.sharpen.amount).toBe(90);
    const geom = (g: GraphDoc) => g.nodes.find((n) => n.kind === 'input')!.geometry;
    expect(geom(out)).toEqual(geom(fresh));
  });

  it('a scoped preset changes only its families and leaves the rest of the fresh seed alone', () => {
    const fresh = withDevelop(defaultGraphDoc(), (d) => ({
      ...d,
      detail: { ...d.detail, sharpen: { ...d.detail.sharpen, amount: 40 } },
    }));
    const look = buildScopedLook(editedLook(), new Set(['basic-tone']));
    const preset: ParsedPreset = { name: 'Tone only', createdAt: '', look, includes: ['basic-tone'] };
    const out = applyPresetOnFreshGraph(fresh, preset);
    expect(developOf(out).basic.ev).toBe(0.7);
    expect(developOf(out).detail.sharpen.amount).toBe(40);
  });

  it('ignores family ids this build does not know', () => {
    const fresh = defaultGraphDoc();
    const look = buildScopedLook(editedLook(), new Set(['basic-tone']));
    const preset: ParsedPreset = { name: 'Future', createdAt: '', look, includes: ['basic-tone', 'some-future-family'] };
    expect(developOf(applyPresetOnFreshGraph(fresh, preset)).basic.ev).toBe(0.7);
  });

  it('does not mutate the graph it is given', () => {
    const fresh = defaultGraphDoc();
    const before = structuredClone(fresh);
    applyPresetOnFreshGraph(fresh, { name: 'Whole', createdAt: '', look: editedLook() });
    expect(fresh).toEqual(before);
    expect(developOf(fresh)).toEqual(defaultDevelopParams());
  });
});
