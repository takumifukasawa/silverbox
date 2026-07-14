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
      graph: twoDevelopGraph(),
      history: { past: [], future: [], lastCoalesceKey: null },
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
    const { history } = useAppStore.getState();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]).toBe(graphBefore);
    expect(history.future).toHaveLength(0);
  });

  it('is a no-op without a ready image', () => {
    useAppStore.setState({ imageStatus: 'idle', image: null });
    const graphBefore = useAppStore.getState().graph;
    const devId = graphBefore.nodes.find((n) => n.kind === DEVELOP_KIND && n.id !== 'dev2')!.id;

    useAppStore.getState().resetDevelopNode(devId);
    expect(useAppStore.getState().graph).toBe(graphBefore);
    expect(useAppStore.getState().history.past).toHaveLength(0);
  });

  it('is a no-op for a non-develop node id', () => {
    const graphBefore = useAppStore.getState().graph;
    const inputId = graphBefore.nodes.find((n) => n.kind === 'input')!.id;

    useAppStore.getState().resetDevelopNode(inputId);
    expect(useAppStore.getState().graph).toBe(graphBefore);
    expect(useAppStore.getState().history.past).toHaveLength(0);
  });

  it('is a no-op for an unknown node id', () => {
    const graphBefore = useAppStore.getState().graph;
    useAppStore.getState().resetDevelopNode('does-not-exist');
    expect(useAppStore.getState().graph).toBe(graphBefore);
  });
});
