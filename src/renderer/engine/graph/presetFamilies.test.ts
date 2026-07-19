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
  familyForDevelopKey,
  isKnownFamilyId,
  LOOK_FAMILY_IDS,
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

describe('DEFAULT_SETTINGS.syncFamilies stays pinned to DEFAULT_CHECKED_FAMILY_IDS', () => {
  it('multi-select-sync.md\'s Sync… dialog starts with the same defaults as the preset Save dialog', () => {
    expect(DEFAULT_SETTINGS.syncFamilies).toEqual(DEFAULT_CHECKED_FAMILY_IDS);
  });
});

describe('DEFAULT_SETTINGS.sharedLookFamilies stays pinned to DEFAULT_CHECKED_FAMILY_IDS', () => {
  it("linked-looks-stage-b.md's Create-shared-look dialog starts with the same defaults as the other two family dialogs", () => {
    expect(DEFAULT_SETTINGS.sharedLookFamilies).toEqual(DEFAULT_CHECKED_FAMILY_IDS);
  });
});

describe('DEFAULT_SETTINGS.publishFamilies stays pinned to DEFAULT_CHECKED_FAMILY_IDS', () => {
  it("linked-looks-stage-c.md's Publish dialog starts with the same defaults as the other family dialogs (on the rare open where its own per-look default isn't available)", () => {
    expect(DEFAULT_SETTINGS.publishFamilies).toEqual(DEFAULT_CHECKED_FAMILY_IDS);
  });
});

describe('LOOK_FAMILY_IDS', () => {
  it('is exactly the develop-group ids — no structural family is ever offered by a shared look', () => {
    expect(LOOK_FAMILY_IDS).toEqual(DEFAULT_CHECKED_FAMILY_IDS); // develop-group ids happen to all be default-checked too
    for (const id of LOOK_FAMILY_IDS) expect(['geometry', 'spots', 'masks', 'custom-nodes']).not.toContain(id);
  });
});

describe('familyForDevelopKey (fork-on-touch, linked-looks-stage-b.md semantic 4)', () => {
  it('wb keys are disjoint from basic-tone', () => {
    expect(familyForDevelopKey('basic.temp')).toBe('wb');
    expect(familyForDevelopKey('basic.tint')).toBe('wb');
  });
  it('every other basic.* and profile.* key is basic-tone', () => {
    expect(familyForDevelopKey('basic.ev')).toBe('basic-tone');
    expect(familyForDevelopKey('basic.contrast')).toBe('basic-tone');
    expect(familyForDevelopKey('profile.amount')).toBe('basic-tone');
    expect(familyForDevelopKey('profile.source')).toBe('basic-tone');
  });
  it('maps every other section prefix to its own family', () => {
    expect(familyForDevelopKey('toneCurve.rgb')).toBe('curves');
    expect(familyForDevelopKey('hsl.red.h')).toBe('hsl');
    expect(familyForDevelopKey('bw.enabled')).toBe('bw');
    expect(familyForDevelopKey('grading.blending')).toBe('grading');
    expect(familyForDevelopKey('effects.grain.amount')).toBe('effects');
    expect(familyForDevelopKey('detail.sharpen.amount')).toBe('detail');
  });
  it('returns null for an unrecognized key', () => {
    expect(familyForDevelopKey('mystery.field')).toBeNull();
  });
});

describe('isKnownFamilyId', () => {
  it('accepts every id in the shared list, rejects anything else', () => {
    for (const id of ALL_FAMILY_IDS) expect(isKnownFamilyId(id)).toBe(true);
    expect(isKnownFamilyId('mystery-family')).toBe(false);
    expect(isKnownFamilyId('bw')).toBe(true); // shipped — docs/brief-bank/bw-mixer.md
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

  it('bw moves independently of hsl (disjoint from the HSL family despite sharing the same band mask)', () => {
    const srcFull: DevelopParams = {
      ...defaultDevelopParams(),
      hsl: { ...defaultDevelopParams().hsl, red: { h: 10, s: 20, l: -5 } },
      bw: { enabled: true, mix: [30, 0, 0, 0, 0, 0, 0, 0] },
    };
    const bwOnly = pickDevelopFamilies(srcFull, identity, new Set(['bw']));
    expect(bwOnly.bw).toEqual(srcFull.bw);
    expect(bwOnly.hsl.red).toEqual(identity.hsl.red); // hsl not checked

    const hslOnly = pickDevelopFamilies(srcFull, identity, new Set(['hsl']));
    expect(hslOnly.hsl.red).toEqual(srcFull.hsl.red);
    expect(hslOnly.bw).toEqual(identity.bw); // bw not checked
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

// --- multi-output scoping fix (docs/brief-bank/virtual-copy.md) -------------
//
// The adversarial shape the brief's own repro (2026-07-18, conductor) hit:
// two independent Develop chains sharing one 'in' node, one output each —
// exactly what appStore.ts's "Duplicate output" produces once a copy's
// Develop node ends up sharing an id with some UNRELATED look/preset's own
// conventionally-named 'dev' node. `scope` (the appStore-computed
// reachableToOutput set, passed as this module's new optional parameter) is
// what appStore.ts feeds in at its own boundary — these tests exercise the
// pure function directly with a hand-built scope, the same way every other
// test in this file drives mergeScopedLook/buildScopedLook without a store.
function twoOutputGraph(): GraphDoc {
  return {
    version: 1,
    nodes: [
      inputNode(),
      devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.1 } }),
      outputNode('out'),
      devNode('dev-clone', { basic: { ...defaultDevelopParams().basic, ev: 0.2 } }),
      outputNode('out2'),
    ],
    edges: [
      edge('e0', 'in', 'dev'),
      edge('e1', 'dev', 'out'),
      edge('e2', 'in', 'dev-clone'),
      edge('e3', 'dev-clone', 'out2'),
    ],
  };
}
const reachableFrom = (graph: GraphDoc, outputId: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [outputId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.target === id) stack.push(e.source);
  }
  return seen;
};

describe('buildScopedLook — scope param (multi-output save-time fix)', () => {
  it('with no scope, behaves exactly as before (bit-identical — single-output docs are unaffected)', () => {
    const graph: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev'), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const withoutScope = buildScopedLook(graph, new Set(['basic-tone']));
    const withFullScope = buildScopedLook(graph, new Set(['basic-tone']), reachableFrom(graph, 'out'));
    expect(withFullScope).toEqual(withoutScope);
  });

  it('scoped to the FIRST output, captures only that chain — the second Develop node/output are dropped entirely, not merely left at identity', () => {
    const graph = twoOutputGraph();
    const scope = reachableFrom(graph, 'out');
    const out = buildScopedLook(graph, new Set(['basic-tone']), scope);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['dev', 'in', 'out']);
    expect(out.nodes.find((n) => n.id === 'dev')!.develop!.basic.ev).toBe(0.1);
    expect(out.nodes.some((n) => n.id === 'dev-clone' || n.id === 'out2')).toBe(false);
  });

  it('scoped to the SECOND output, captures ONLY that chain (proves this is genuinely active-output-relative, not "first wins")', () => {
    const graph = twoOutputGraph();
    const scope = reachableFrom(graph, 'out2');
    const out = buildScopedLook(graph, new Set(['basic-tone']), scope);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['dev-clone', 'in', 'out2']);
    expect(out.nodes.find((n) => n.id === 'dev-clone')!.develop!.basic.ev).toBe(0.2);
  });
});

describe('mergeScopedLook — scope param (multi-output apply-time fix, the confirmed-real "wrong copy by id" hazard)', () => {
  it('with no scope, behaves exactly as before (bit-identical — single-output docs are unaffected)', () => {
    const currentGraph: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev'), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const look: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.9 } }), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const withoutScope = mergeScopedLook(currentGraph, look, new Set(['basic-tone']));
    const withFullScope = mergeScopedLook(currentGraph, look, new Set(['basic-tone']), reachableFrom(currentGraph, 'out'));
    expect(withFullScope).toEqual(withoutScope);
  });

  it("a Develop node whose id MATCHES look's captured id, but sits OUTSIDE the active-output scope, is left completely untouched (the brief's exact hazard: 'whichever id happens to collide with the source look's, regardless of which output is actually activeOutputId')", () => {
    const graph = twoOutputGraph();
    // `look` conventionally captured id 'dev' (e.g. from an unrelated single-
    // output photo/preset) — under the OLD unscoped code this would match
    // and silently overwrite `graph`'s 'dev' node regardless of which output
    // is active.
    const look: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.99 } }), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    // Active output is 'out2' — 'dev' (id-matching, but on the OTHER chain) must be excluded from scope.
    const scope = reachableFrom(graph, 'out2');
    const merged = mergeScopedLook(graph, look, new Set(['basic-tone']), scope);
    expect(merged.nodes.find((n) => n.id === 'dev')!.develop!.basic.ev).toBe(0.1); // UNCHANGED — not silently overwritten to 0.99
    // The ACTIVE chain's own Develop (fresh id, no id match) RECEIVES the
    // look via the unambiguous-single-Develop fallback — one Develop in
    // scope, one in the look, so the pairing is not a guess (follow-up to
    // the initial scoping fix, where this was a documented no-op).
    expect(merged.nodes.find((n) => n.id === 'dev-clone')!.develop!.basic.ev).toBe(0.99);
  });

  it('the unambiguous fallback stays OFF when the pairing would be a guess (2 Develops in scope, or 2 in the look)', () => {
    // Chain with TWO Develop nodes in scope: in → devA → devB → out.
    const graph: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('devA', { basic: { ...defaultDevelopParams().basic, ev: 0.1 } }),
        devNode('devB', { basic: { ...defaultDevelopParams().basic, ev: 0.2 } }),
        outputNode('out'),
      ],
      edges: [edge('e0', 'in', 'devA'), edge('e1', 'devA', 'devB'), edge('e2', 'devB', 'out')],
    };
    const look: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.99 } }), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const scope = reachableFrom(graph, 'out');
    const merged = mergeScopedLook(graph, look, new Set(['basic-tone']), scope);
    // Ambiguous (which of devA/devB should 'dev' map to?) — both left alone.
    expect(merged.nodes.find((n) => n.id === 'devA')!.develop!.basic.ev).toBe(0.1);
    expect(merged.nodes.find((n) => n.id === 'devB')!.develop!.basic.ev).toBe(0.2);

    // Mirror case: ONE Develop in scope but TWO in the look — also ambiguous.
    const graph2 = twoOutputGraph();
    const look2: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('x1', { basic: { ...defaultDevelopParams().basic, ev: 0.5 } }),
        devNode('x2', { basic: { ...defaultDevelopParams().basic, ev: 0.6 } }),
        outputNode('out'),
      ],
      edges: [edge('e0', 'in', 'x1'), edge('e1', 'x1', 'x2'), edge('e2', 'x2', 'out')],
    };
    const merged2 = mergeScopedLook(graph2, look2, new Set(['basic-tone']), reachableFrom(graph2, 'out2'));
    expect(merged2.nodes.find((n) => n.id === 'dev-clone')!.develop!.basic.ev).toBe(0.2); // untouched
  });

  it('the SAME apply, scoped to the id-matching chain instead, updates it normally (scoping only EXCLUDES, never blocks a legitimate in-scope match)', () => {
    const graph = twoOutputGraph();
    const look: GraphDoc = { version: 1, nodes: [inputNode(), devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.99 } }), outputNode()], edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'out')] };
    const scope = reachableFrom(graph, 'out');
    const merged = mergeScopedLook(graph, look, new Set(['basic-tone']), scope);
    expect(merged.nodes.find((n) => n.id === 'dev')!.develop!.basic.ev).toBe(0.99);
    expect(merged.nodes.find((n) => n.id === 'dev-clone')!.develop!.basic.ev).toBe(0.2); // the other chain, out of scope, untouched
  });

  it('a structural graft (masks) only replaces an in-scope existing node, never an out-of-scope one sharing the same id', () => {
    const graph: GraphDoc = {
      version: 1,
      nodes: [
        inputNode(),
        devNode('dev'),
        { id: 'mask-1', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: { shapes: [] } },
        outputNode('out'),
        devNode('dev-clone'),
        { id: 'mask-2', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: { shapes: [] } },
        outputNode('out2'),
      ],
      edges: [
        edge('e0', 'in', 'dev'),
        edge('e1', 'dev', 'mask-1'),
        edge('e2', 'mask-1', 'out'),
        edge('e3', 'in', 'dev-clone'),
        edge('e4', 'dev-clone', 'mask-2'),
        edge('e5', 'mask-2', 'out2'),
      ],
    };
    // `look`'s own masks node happens to share id 'mask-1' (the OUT-of-scope
    // chain's own id) with a DIFFERENT shape payload.
    const look: GraphDoc = {
      version: 1,
      nodes: [inputNode(), devNode('dev'), { id: 'mask-1', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: defaultMaskParams() }, outputNode('out')],
      edges: [edge('e0', 'in', 'dev'), edge('e1', 'dev', 'mask-1'), edge('e2', 'mask-1', 'out')],
    };
    const scope = reachableFrom(graph, 'out2'); // active output is out2's chain — mask-1 is NOT in it
    const merged = mergeScopedLook(graph, look, new Set(['masks']), scope);
    const mask1After = merged.nodes.find((n) => n.id === 'mask-1')!;
    expect(mask1After.mask).toEqual({ shapes: [] }); // untouched — 'mask-1' is out of scope, even though its id matched `look`'s own masks node
  });
});
