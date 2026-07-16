/**
 * Unit tier (vitest) for the auto-layout toggle prototype's pure part — see
 * nodeAutoLayout.ts's doc comment. No React Flow / DOM involved: dagre runs
 * happily on plain nodes/edges, which is exactly why this part was pulled out
 * of NodeEditorPanel.tsx rather than only exercised via the app.
 */
import { describe, it, expect } from 'vitest';
import { computeAutoLayout, type LayoutEdgeInput, type LayoutNodeInput } from './nodeAutoLayout';

describe('computeAutoLayout', () => {
  it('lays out a linear chain left-to-right, monotonically increasing x', () => {
    const nodes: LayoutNodeInput[] = [
      { id: 'in', kind: 'input' },
      { id: 'dev', kind: 'develop' },
      { id: 'hsl', kind: 'hsl' },
      { id: 'out', kind: 'output' },
    ];
    const edges: LayoutEdgeInput[] = [
      { source: 'in', target: 'dev' },
      { source: 'dev', target: 'hsl' },
      { source: 'hsl', target: 'out' },
    ];
    const positions = computeAutoLayout(nodes, edges);
    expect(positions.size).toBe(4);
    const xs = ['in', 'dev', 'hsl', 'out'].map((id) => positions.get(id)!.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
    }
    // rankdir LR with a single chain: every node sits on the same rank's y baseline.
    const ys = ['in', 'dev', 'hsl', 'out'].map((id) => positions.get(id)!.y);
    expect(new Set(ys).size).toBe(1);
  });

  it('does not overlap ranks on a branch/merge graph (two parallel branches into a blend)', () => {
    const nodes: LayoutNodeInput[] = [
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'develop' },
      { id: 'b', kind: 'hsl' },
      { id: 'mix', kind: 'blend' },
      { id: 'out', kind: 'output' },
    ];
    const edges: LayoutEdgeInput[] = [
      { source: 'in', target: 'a' },
      { source: 'in', target: 'b' },
      { source: 'a', target: 'mix' },
      { source: 'b', target: 'mix' },
      { source: 'mix', target: 'out' },
    ];
    const positions = computeAutoLayout(nodes, edges);
    // 'a' and 'b' are on the same rank (both direct children of 'in', both
    // feeding 'mix') — same x, but distinct y so their boxes don't overlap.
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    expect(a.x).toBe(b.x);
    expect(a.y).not.toBe(b.y);
    const nodeHeight = 40; // DEFAULT_NODE_HEIGHT in nodeAutoLayout.ts
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(nodeHeight);
    // whole graph still flows left-to-right: in < a,b < mix < out
    const inX = positions.get('in')!.x;
    const mixX = positions.get('mix')!.x;
    const outX = positions.get('out')!.x;
    expect(a.x).toBeGreaterThan(inX);
    expect(mixX).toBeGreaterThan(a.x);
    expect(outX).toBeGreaterThan(mixX);
  });

  it('is deterministic: same input twice yields identical positions', () => {
    const nodes: LayoutNodeInput[] = [
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'develop' },
      { id: 'b', kind: 'hsl' },
      { id: 'mix', kind: 'blend' },
      { id: 'out', kind: 'output' },
    ];
    const edges: LayoutEdgeInput[] = [
      { source: 'in', target: 'a' },
      { source: 'in', target: 'b' },
      { source: 'a', target: 'mix' },
      { source: 'b', target: 'mix' },
      { source: 'mix', target: 'out' },
    ];
    const first = computeAutoLayout(nodes, edges);
    const second = computeAutoLayout(nodes, edges);
    expect(second).toEqual(first);
  });

  it('uses measured dimensions when given, falling back to per-kind estimates otherwise', () => {
    const nodesWithMeasured: LayoutNodeInput[] = [
      { id: 'in', kind: 'input', width: 300, height: 300 },
      { id: 'out', kind: 'output', width: 300, height: 300 },
    ];
    const nodesWithoutMeasured: LayoutNodeInput[] = [
      { id: 'in', kind: 'input' },
      { id: 'out', kind: 'output' },
    ];
    const edges: LayoutEdgeInput[] = [{ source: 'in', target: 'out' }];
    const measured = computeAutoLayout(nodesWithMeasured, edges);
    const unmeasured = computeAutoLayout(nodesWithoutMeasured, edges);
    // A much bigger measured node pushes its neighbor further away on x than the fixed-estimate case.
    const dxMeasured = measured.get('out')!.x - measured.get('in')!.x;
    const dxUnmeasured = unmeasured.get('out')!.x - unmeasured.get('in')!.x;
    expect(dxMeasured).toBeGreaterThan(dxUnmeasured);
  });

  it('skips edges referencing a node not present in the node list (defensive — should not throw)', () => {
    const nodes: LayoutNodeInput[] = [{ id: 'in', kind: 'input' }];
    const edges: LayoutEdgeInput[] = [{ source: 'in', target: 'ghost' }];
    expect(() => computeAutoLayout(nodes, edges)).not.toThrow();
  });
});
