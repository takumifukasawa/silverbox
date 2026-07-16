/**
 * Unit tier (vitest) for presetFamilies.ts's pure scoping/filter helpers —
 * the save-time strip (buildScopedLook/stripStructuralFamilies) and
 * apply-time merge (mergeScopedLook), plus the develop-param picker both
 * directions share (pickDevelopFamilies). See docs/brief-bank/
 * preset-scoping-and-export-overrides.md §1 for the feature this backs.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_FAMILY_IDS,
  buildScopedLook,
  DEFAULT_CHECKED_FAMILY_IDS,
  isKnownFamilyId,
  mergeScopedLook,
  pickDevelopFamilies,
  stripStructuralFamilies,
  type PresetFamilyId,
} from './presetFamilies';
import { DEVELOP_KIND, type GraphDoc, type GraphEdge, type GraphNode } from './graphDoc';
import { defaultDevelopParams, type DevelopParams } from './developNode';
import { MASK_KIND, defaultMaskParams } from './maskNode';
import { SPOTS_KIND, defaultSpotsParams } from './spotsNode';
import { DEFAULT_SETTINGS } from '../../../../shared/ipc';

function devNode(id: string, develop: Partial<DevelopParams> = {}, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: DEVELOP_KIND,
    position: { x: 0, y: 0 },
    develop: { ...defaultDevelopParams(), ...develop },
    ...extra,
  };
}

function inputNode(extra: Partial<GraphNode> = {}): GraphNode {
  return { id: 'in', kind: 'input', position: { x: 0, y: 0 }, ...extra };
}

function outputNode(id = 'out'): GraphNode {
  return { id, kind: 'output', position: { x: 0, y: 0 } };
}

const edge = (id: string, source: string, target: string, targetHandle?: GraphEdge['targetHandle']): GraphEdge => ({
  id,
  source,
  target,
  ...(targetHandle ? { targetHandle } : {}),
});

describe('DEFAULT_SETTINGS.presetSaveFamilies stays pinned to DEFAULT_CHECKED_FAMILY_IDS', () => {
  it('the two lists never silently drift apart (shared/ipc.ts duplicates this array since it cannot import renderer engine code)', () => {
    expect(DEFAULT_SETTINGS.presetSaveFamilies).toEqual(DEFAULT_CHECKED_FAMILY_IDS);
  });
});

describe('isKnownFamilyId', () => {
  it('accepts every id in the shared list, rejects anything else', () => {
    for (const id of ALL_FAMILY_IDS) expect(isKnownFamilyId(id)).toBe(true);
    expect(isKnownFamilyId('mystery-family')).toBe(false);
    expect(isKnownFamilyId('bw')).toBe(false); // not shipped yet — see PRESET_FAMILIES's doc comment
  });
});

describe('pickDevelopFamilies', () => {
  const src: DevelopParams = {
    ...defaultDevelopParams(),
    basic: { ...defaultDevelopParams().basic, temp: 5500, tint: 3, ev: 0.6, contrast: 20, saturation: 10 },
  };
  const identity = defaultDevelopParams();

  it('basic-tone picks ev/contrast/saturation/etc but never temp/tint', () => {
    const out = pickDevelopFamilies(src, identity, new Set(['basic-tone']));
    expect(out.basic.ev).toBe(0.6);
    expect(out.basic.contrast).toBe(20);
    expect(out.basic.saturation).toBe(10);
    expect(out.basic.temp).toBe(0); // wb NOT checked -> stays at base (identity)
    expect(out.basic.tint).toBe(0);
  });

  it('wb picks ONLY temp/tint, disjoint from basic-tone', () => {
    const out = pickDevelopFamilies(src, identity, new Set(['wb']));
    expect(out.basic.temp).toBe(5500);
    expect(out.basic.tint).toBe(3);
    expect(out.basic.ev).toBe(0); // basic-tone NOT checked -> stays at base
    expect(out.basic.contrast).toBe(0);
  });

  it('basic-tone + wb together reproduce every `basic` field from src', () => {
    const out = pickDevelopFamilies(src, identity, new Set(['basic-tone', 'wb']));
    expect(out.basic).toEqual(src.basic);
  });

  it('an empty family set returns exactly `base`, untouched by `src`', () => {
    const out = pickDevelopFamilies(src, identity, new Set());
    expect(out).toEqual(identity);
  });

  it('curves/hsl/grading/effects/detail each move independently', () => {
    const srcFull: DevelopParams = {
      ...defaultDevelopParams(),
      toneCurve: { ...defaultDevelopParams().toneCurve, rgb: [[0, 0], [128, 100], [255, 255]] },
      hsl: { ...defaultDevelopParams().hsl, red: { h: 10, s: 20, l: -5 } },
    };
    const out = pickDevelopFamilies(srcFull, identity, new Set(['curves']));
    expect(out.toneCurve.rgb).toEqual(srcFull.toneCurve.rgb);
    expect(out.hsl.red).toEqual(identity.hsl.red); // hsl not checked
  });

  it('apply direction: base = current graph (not identity) — unchecked families stay at the CURRENT value, not reset', () => {
    const current: DevelopParams = { ...defaultDevelopParams(), basic: { ...defaultDevelopParams().basic, contrast: -30 } };
    const out = pickDevelopFamilies(src, current, new Set(['wb'])); // only wb checked
    expect(out.basic.temp).toBe(5500); // pulled from src (the preset)
    expect(out.basic.contrast).toBe(-30); // untouched — stayed at the CURRENT graph's own value
  });
});

describe('stripStructuralFamilies', () => {
  it('leaves the plain default chain untouched (nothing to strip)', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev'), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const out = stripStructuralFamilies(graph, new Set(ALL_FAMILY_IDS));
    expect(out).toBe(graph); // same reference — early-return fast path
  });

  it('splices an inline spots node out when `spots` is unchecked, bridging the edge', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), { id: 'spots-1', kind: SPOTS_KIND, position: { x: 0, y: 0 }, spots: defaultSpotsParams() }, devNode('dev'), outputNode()],
      edges: [edge('e0', 'in', 'spots-1'), edge('e1', 'spots-1', 'dev'), edge('e2', 'dev', 'out')],
    };
    const out = stripStructuralFamilies(graph, new Set(['basic-tone', 'wb', 'curves', 'hsl', 'grading', 'effects', 'detail']));
    expect(out.nodes.map((n) => n.id)).toEqual(['in', 'dev', 'out']);
    expect(out.edges).toEqual([
      { id: 'e1', source: 'in', target: 'dev' }, // bridged: spots-1's incoming source now feeds dev directly
      { id: 'e2', source: 'dev', target: 'out' },
    ]);
  });

  it('a mask node feeding a blend\'s "mask" port is dropped without touching the blend\'s a/b edges', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('dev'),
        { id: 'mask-1', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: defaultMaskParams() },
        { id: 'blend-1', kind: 'blend' as GraphNode['kind'], position: { x: 0, y: 0 }, params: { amount: 50 } },
        outputNode(),
      ],
      edges: [
        edge('e0', 'in', 'dev'),
        edge('e1', 'dev', 'mask-1'),
        edge('e2', 'dev', 'blend-1', 'a'),
        edge('e3', 'dev', 'blend-1', 'b'),
        edge('e4', 'mask-1', 'blend-1', 'mask'),
        edge('e5', 'blend-1', 'out'),
      ],
    };
    const families = new Set(ALL_FAMILY_IDS.filter((f) => f !== 'masks')) as Set<PresetFamilyId>;
    const out = stripStructuralFamilies(graph, families);
    expect(out.nodes.some((n) => n.id === 'mask-1')).toBe(false);
    expect(out.nodes.some((n) => n.id === 'blend-1')).toBe(true); // custom-nodes IS checked here
    expect(out.edges.some((e) => e.targetHandle === 'mask')).toBe(false);
    expect(out.edges.some((e) => e.id === 'e2')).toBe(true);
    expect(out.edges.some((e) => e.id === 'e3')).toBe(true);
  });

  it('dropping custom-nodes removes a blend and keeps only its "a"-port ancestry', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('dev'),
        { id: 'blend-1', kind: 'blend' as GraphNode['kind'], position: { x: 0, y: 0 }, params: { amount: 50 } },
        outputNode(),
      ],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'blend-1', 'a'), edge('e2', 'dev', 'blend-1', 'b'), edge('e3', 'blend-1', 'out')],
    };
    const families = new Set(['basic-tone', 'wb', 'curves', 'hsl', 'grading', 'effects', 'detail', 'masks', 'spots']) as Set<PresetFamilyId>;
    const out = stripStructuralFamilies(graph, families);
    expect(out.nodes.map((n) => n.id)).toEqual(['in', 'dev', 'out']);
    expect(out.edges).toEqual([
      { id: 'e0', source: 'in', target: 'dev' },
      { id: 'e3', source: 'dev', target: 'out' }, // rewired: blend-1's 'a'-port source (dev) now feeds out directly
    ]);
  });
});

describe('buildScopedLook (save-time)', () => {
  it('with only basic-tone checked, every other develop section comes back at identity/default', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.6, temp: 5500 }, hsl: { ...defaultDevelopParams().hsl, red: { h: 5, s: 5, l: 5 } } }),
        outputNode(),
      ],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const out = buildScopedLook(graph, new Set(['basic-tone']));
    const dev = out.nodes.find((n) => n.id === 'dev')!;
    expect(dev.develop!.basic.ev).toBe(0.6);
    expect(dev.develop!.basic.temp).toBe(0); // wb not checked
    expect(dev.develop!.hsl).toEqual(defaultDevelopParams().hsl); // hsl not checked
  });

  it('drops structural node kinds not in the checked set', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), { id: 'spots-1', kind: SPOTS_KIND, position: { x: 0, y: 0 }, spots: defaultSpotsParams() }, devNode('dev'), outputNode()],
      edges: [edge('e0', 'in', 'spots-1'), edge('e1', 'spots-1', 'dev'), edge('e2', 'dev', 'out')],
    };
    const out = buildScopedLook(graph, new Set(['basic-tone']));
    expect(out.nodes.some((n) => n.kind === SPOTS_KIND)).toBe(false);
  });
});

describe('mergeScopedLook (apply-time)', () => {
  it('merges only the checked family from `look` onto `graph` (basic-tone fields, incl. contrast, all move together)', () => {
    const currentGraph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, contrast: -20, temp: 4000 } }), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const look: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.8, contrast: 15 } }), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const merged = mergeScopedLook(currentGraph, look, new Set(['basic-tone']));
    const dev = merged.nodes.find((n) => n.id === 'dev')!;
    expect(dev.develop!.basic.ev).toBe(0.8); // pulled from the preset (basic-tone)
    expect(dev.develop!.basic.contrast).toBe(15); // also basic-tone -> also pulled from the preset
    expect(dev.develop!.basic.temp).toBe(4000); // wb NOT checked -> stays at the CURRENT graph's own value
  });

  it("curves stay exactly as they were on the CURRENT doc when 'curves' isn't checked", () => {
    const currentCurve = { rgb: [[0, 0], [10, 250]] as [number, number][], r: [[0, 0], [255, 255]] as [number, number][], g: [[0, 0], [255, 255]] as [number, number][], b: [[0, 0], [255, 255]] as [number, number][] };
    const currentGraph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev', { toneCurve: currentCurve }), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const look: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev', { toneCurve: { ...defaultDevelopParams().toneCurve, rgb: [[0, 0], [128, 5], [255, 255]] } }), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const merged = mergeScopedLook(currentGraph, look, new Set(['basic-tone'])); // curves NOT checked
    const dev = merged.nodes.find((n) => n.id === 'dev')!;
    expect(dev.develop!.toneCurve).toEqual(currentCurve);
  });

  it('grafts a NEW inline custom-nodes op from `look`, superseding the direct edge it splices onto', () => {
    const currentGraph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev'), outputNode()],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')],
    };
    const look: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('dev'),
        { id: 'exp-1', kind: 'exposure' as GraphNode['kind'], position: { x: 0, y: 0 }, params: { ev: 0.3 } },
        outputNode(),
      ],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'exp-1'), edge('e2', 'exp-1', 'out')],
    };
    const merged = mergeScopedLook(currentGraph, look, new Set(['custom-nodes']));
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['dev', 'exp-1', 'in', 'out']);
    // the stale direct dev->out edge is gone, replaced by dev->exp-1->out
    expect(merged.edges.some((e) => e.source === 'dev' && e.target === 'out')).toBe(false);
    expect(merged.edges.some((e) => e.source === 'dev' && e.target === 'exp-1')).toBe(true);
    expect(merged.edges.some((e) => e.source === 'exp-1' && e.target === 'out')).toBe(true);
    expect(merged.edges).toHaveLength(3); // in->dev (untouched) + the two grafted edges
  });

  it('a Develop node in `graph` with no id match in `look` is left untouched', () => {
    const currentGraph: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('other-dev', { basic: { ...defaultDevelopParams().basic, ev: 1.2 } }), outputNode()],
      edges: [edge('e0', 'in', 'other-dev'), edge('e1', 'other-dev', 'out')],
    };
    const look: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev'), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const merged = mergeScopedLook(currentGraph, look, new Set(['basic-tone']));
    expect(merged.nodes.find((n) => n.id === 'other-dev')!.develop!.basic.ev).toBe(1.2);
  });
});
