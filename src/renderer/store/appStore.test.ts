/**
 * Unit tier (vitest) for appStore's `resetDevelopNode` action (round-2 hand-
 * test follow-up, "Reset Develop" button in the Develop inspector): a pure
 * state-transition check on the ACTION itself, not a full render. This
 * environment has no `window` (no Electron preload — see vitest.config.ts's
 * `environment: 'node'`), so this stubs the one piece resetDevelopNode reads
 * through it: `window.silverbox.testFlags`, the same shape every real
 * render-time caller (seedDefaultLook via openImageByPath/resetAllEdits)
 * already goes through — see shared/ipc.ts's `testFlags` field.
 *
 * Scope: only what's cheaply testable without a real decoded image or GPU —
 * the store-level graph transform (which node gets replaced, which stay
 * byte-for-byte untouched, one undo entry, the no-op guards). The actual
 * seeded VALUES (camera-matched base curve, LR NR/sharpen seeds) are a `jpg`
 * `fileName` here specifically to bypass that RAW-only branch — see
 * seedDefaultLook's own doc comment — those formulas have their own
 * coverage (verify-basecurve.mjs and friends); this file is scoped to
 * resetDevelopNode's own "which node, how many undo entries" logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './appStore';
import { defaultGraphDoc, DEVELOP_KIND, type GraphDoc } from '../engine/graph/graphDoc';
import { defaultDevelopParams } from '../engine/graph/developNode';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import { emptyUndoStackState } from './undoStack';

(globalThis as unknown as { window: unknown }).window = {
  silverbox: {
    testFlags: { isTest: false, lensProfileAutoDefault: false, baseCurveDefault: false, forceDefaults: false },
  },
};

/** Minimal PreparedImage — every field seedDefaultLook reads (`color`/`capture`/`profile`) is optional and left undefined; createWbModel/baseCurveForModel both tolerate that (DEFAULT_WB_MODEL is itself `createWbModel({})`). */
const fakeImage: PreparedImage = {
  data: new Float32Array(4),
  width: 1,
  height: 1,
  fullWidth: 1,
  fullHeight: 1,
  flip: 0,
  decodeMs: 0,
};

const EDITED_EV = 1.5;

/** defaultGraphDoc()'s single develop node ('dev') edited away from its default, PLUS a second develop node ('dev2') — proves a reset only ever touches the ONE node it's asked to. */
function twoDevelopGraph(): GraphDoc {
  const base = defaultGraphDoc();
  const edited = { ...defaultDevelopParams(), basic: { ...defaultDevelopParams().basic, ev: EDITED_EV } };
  return {
    ...base,
    nodes: [
      ...base.nodes.map((n) => (n.kind === DEVELOP_KIND ? { ...n, develop: edited } : n)),
      { id: 'dev2', kind: DEVELOP_KIND, position: { x: 500, y: 60 }, develop: edited },
    ],
  };
}

describe('appStore.resetDevelopNode', () => {
  beforeEach(() => {
    useAppStore.setState({
      imageStatus: 'ready',
      image: fakeImage,
      fileName: 'test.jpg', // isRawFileName -> false: the RAW-only base-curve/lens-profile seeding never engages, keeping the expected reset shape simple (flat defaultDevelopParams()).
      // Global-undo (docs/brief-bank/global-undo.md): pushHistory now tags
      // every entry with the open photo's path (`imagePath`) — without one,
      // resetDevelopNode's undo entry would silently never get pushed at all.
      imagePath: '/fake/test.jpg',
      graph: twoDevelopGraph(),
      undoStack: emptyUndoStackState(),
      graphDirty: false,
    });
  });

  it("resets only the targeted develop node's params — a second develop node and the rest of the graph are untouched", () => {
    const before = useAppStore.getState().graph;
    const dev1Id = before.nodes.find((n) => n.kind === DEVELOP_KIND && n.id !== 'dev2')!.id;

    useAppStore.getState().resetDevelopNode(dev1Id);
    const after = useAppStore.getState().graph;

    const dev1After = after.nodes.find((n) => n.id === dev1Id)!;
    const dev2After = after.nodes.find((n) => n.id === 'dev2')!;
    expect(dev1After.develop?.basic.ev).toBe(0); // back to the seeded fresh-open default
    expect(dev2After.develop?.basic.ev).toBe(EDITED_EV); // untouched
    expect(dev2After.develop).toBe(before.nodes.find((n) => n.id === 'dev2')!.develop); // same object, not even cloned

    // Graph shape (node ids/order, edges) unchanged.
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    expect(after.edges).toBe(before.edges);
  });

  it('records exactly one undo entry', () => {
    const graphBefore = useAppStore.getState().graph;
    const devId = graphBefore.nodes.find((n) => n.kind === DEVELOP_KIND && n.id !== 'dev2')!.id;

    useAppStore.getState().resetDevelopNode(devId);
    const { undoStack } = useAppStore.getState();
    expect(undoStack.undo).toHaveLength(1);
    expect(undoStack.undo[0]!.kind).toBe('develop-reset');
    expect((undoStack.undo[0] as { before: GraphDoc }).before).toBe(graphBefore);
    expect(undoStack.redo).toHaveLength(0);
  });

  it('is a no-op without a ready image', () => {
    useAppStore.setState({ imageStatus: 'idle', image: null });
    const graphBefore = useAppStore.getState().graph;
    const devId = graphBefore.nodes.find((n) => n.kind === DEVELOP_KIND && n.id !== 'dev2')!.id;

    useAppStore.getState().resetDevelopNode(devId);
    expect(useAppStore.getState().graph).toBe(graphBefore);
    expect(useAppStore.getState().undoStack.undo).toHaveLength(0);
  });

  it('is a no-op for a non-develop node id', () => {
    const graphBefore = useAppStore.getState().graph;
    const inputId = graphBefore.nodes.find((n) => n.kind === 'input')!.id;

    useAppStore.getState().resetDevelopNode(inputId);
    expect(useAppStore.getState().graph).toBe(graphBefore);
    expect(useAppStore.getState().undoStack.undo).toHaveLength(0);
  });

  it('is a no-op for an unknown node id', () => {
    const graphBefore = useAppStore.getState().graph;
    useAppStore.getState().resetDevelopNode('does-not-exist');
    expect(useAppStore.getState().graph).toBe(graphBefore);
  });
});

/**
 * Unit tier (vitest) for the virtual-copy pack (docs/brief-bank/virtual-
 * copy.md): "Duplicate output" (the creation gesture) and the multi-output
 * scoping fix for whole-look paste/apply (appStore.ts's applyLook — the
 * PRIVATE replaceActiveChainWithLook helper, only reachable through the
 * public pasteDevelopSettings action, same "test the action, not the
 * internals" discipline resetDevelopNode's own tests above already follow).
 * These are the store-level "2-output adversarial case" checks the brief
 * calls for; presetFamilies.test.ts covers the pure mergeScopedLook/
 * buildScopedLook `scope` parameter directly.
 */
describe('appStore.duplicateOutput', () => {
  beforeEach(() => {
    useAppStore.setState({
      imageStatus: 'ready',
      image: fakeImage,
      fileName: 'test.jpg',
      imagePath: '/fake/test.jpg',
      graph: defaultGraphDoc(),
      activeOutputId: null,
      undoStack: emptyUndoStackState(),
      graphDirty: false,
    });
  });

  it("clones the active output's own chain with fresh ids, sharing the same input node, and selects + activates the new output", () => {
    const before = useAppStore.getState().graph;
    useAppStore.getState().duplicateOutput();
    const after = useAppStore.getState().graph;

    const outputs = after.nodes.filter((n) => n.kind === 'output');
    expect(outputs).toHaveLength(2);
    const clone = outputs.find((n) => n.id !== 'out')!;
    expect(clone.name).toBe('main copy');

    // exactly one shared input node — never cloned
    expect(after.nodes.filter((n) => n.kind === 'input')).toHaveLength(1);

    // the clone's own Develop node is a FRESH id, distinct from 'dev'
    const cloneDevEdge = after.edges.find((e) => e.target === clone.id)!;
    expect(cloneDevEdge.source).not.toBe('dev');
    const cloneDev = after.nodes.find((n) => n.id === cloneDevEdge.source)!;
    expect(cloneDev.kind).toBe(DEVELOP_KIND);
    expect(cloneDev.develop).toEqual(before.nodes.find((n) => n.id === 'dev')!.develop); // exact clone at creation time

    // both chains reconnect from the SAME shared input
    expect(after.edges.some((e) => e.source === 'in' && e.target === 'dev')).toBe(true);
    expect(after.edges.some((e) => e.source === 'in' && e.target === cloneDevEdge.source)).toBe(true);

    // the ORIGINAL chain's own nodes/edges are completely untouched
    expect(after.nodes.find((n) => n.id === 'dev')).toBe(before.nodes.find((n) => n.id === 'dev'));
    expect(after.nodes.find((n) => n.id === 'out')).toBe(before.nodes.find((n) => n.id === 'out'));

    expect(useAppStore.getState().activeOutputId).toBe(clone.id);
    expect(useAppStore.getState().selectedNodeId).toBe(clone.id);
    expect(useAppStore.getState().undoStack.undo).toHaveLength(1);
    expect(useAppStore.getState().undoStack.undo[0]!.label).toBe('Duplicate output');
  });

  it('dedupes the clone name against every existing output name', () => {
    useAppStore.getState().duplicateOutput(); // 'out' -> clone named "main copy", now active
    useAppStore.getState().duplicateOutput(); // duplicating the (now-active) clone -> "main copy copy"... but from 'main copy' this time
    const names = useAppStore
      .getState()
      .graph.nodes.filter((n) => n.kind === 'output')
      .map((n) => n.name ?? 'main');
    expect(new Set(names).size).toBe(names.length); // every name distinct — no silent collision
  });

  it('is a no-op without a matching output (defensive — every valid doc has one, so this only guards a malformed graph)', () => {
    useAppStore.setState({ graph: { version: 1, nodes: [], edges: [] } });
    const before = useAppStore.getState().graph;
    useAppStore.getState().duplicateOutput();
    expect(useAppStore.getState().graph).toBe(before);
    expect(useAppStore.getState().undoStack.undo).toHaveLength(0);
  });
});

describe('appStore.pasteDevelopSettings — multi-output scoping fix (virtual-copy.md)', () => {
  beforeEach(() => {
    useAppStore.setState({
      imageStatus: 'ready',
      image: fakeImage,
      fileName: 'test.jpg',
      imagePath: '/fake/test.jpg',
      graph: defaultGraphDoc(),
      activeOutputId: null,
      undoStack: emptyUndoStackState(),
      graphDirty: false,
      developClipboard: null,
    });
  });

  it('on a single-output doc, still wholesale-replaces the graph — bit-identical to before this feature (the common-case regression bar)', () => {
    const clip: GraphDoc = {
      ...defaultGraphDoc(),
      nodes: defaultGraphDoc().nodes.map((n) => (n.kind === DEVELOP_KIND ? { ...n, develop: { ...defaultDevelopParams(), basic: { ...defaultDevelopParams().basic, ev: 1.1 } } } : n)),
    };
    useAppStore.setState({ developClipboard: clip });
    useAppStore.getState().pasteDevelopSettings();
    const after = useAppStore.getState().graph;
    expect(after.nodes.find((n) => n.kind === DEVELOP_KIND)!.develop!.basic.ev).toBe(1.1);
    expect(useAppStore.getState().undoStack.undo).toHaveLength(1);
  });

  it('on a 2-output doc, paste replaces ONLY the active chain — the OTHER output keeps byte-identical node ids/params (the confirmed-real data-loss hazard this brief fixes)', () => {
    useAppStore.getState().duplicateOutput(); // 'out' (dev) + a clone output (active), sharing 'in'
    const cloneOutId = useAppStore.getState().activeOutputId!;
    const beforePaste = useAppStore.getState().graph;
    const originalDevBefore = beforePaste.nodes.find((n) => n.id === 'dev')!;
    const originalOutBefore = beforePaste.nodes.find((n) => n.id === 'out')!;

    const clip: GraphDoc = {
      version: 1,
      nodes: [
        { id: 'in', kind: 'input', position: { x: 0, y: 0 } },
        { id: 'dev', kind: DEVELOP_KIND, position: { x: 0, y: 0 }, develop: { ...defaultDevelopParams(), basic: { ...defaultDevelopParams().basic, ev: 0.66 } } },
        { id: 'out', kind: 'output', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e0', source: 'in', target: 'dev' },
        { id: 'e1', source: 'dev', target: 'out' },
      ],
    };
    useAppStore.setState({ developClipboard: clip });
    useAppStore.getState().pasteDevelopSettings();
    const after = useAppStore.getState().graph;

    // the untouched ORIGINAL chain: byte-identical content (applyLook's
    // multi-output branch structuredClone's its whole return value — same
    // defensive-copy discipline mergeLookWithCurrentGeometry's own
    // single-output path already uses — so this is content equality, not
    // object identity).
    expect(after.nodes.find((n) => n.id === 'dev')).toEqual(originalDevBefore);
    expect(after.nodes.find((n) => n.id === 'out')).toEqual(originalOutBefore);
    expect(after.nodes.filter((n) => n.kind === 'output')).toHaveLength(2); // paste never deletes the inactive output

    // the ACTIVE (clone) chain picked up the pasted settings, on a FRESH id (never literally 'dev')
    const activeOutEdge = after.edges.find((e) => e.target === cloneOutId)!;
    const activeDev = after.nodes.find((n) => n.id === activeOutEdge.source)!;
    expect(activeDev.develop!.basic.ev).toBe(0.66);
  });
});
