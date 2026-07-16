/**
 * Pure GraphDoc-shaped nodes/edges → dagre → positions map (node-editor
 * presentation-form prototype, docs/brief-bank/node-editor-ux.md "decide by
 * prototype"). Kept separate from NodeEditorPanel.tsx so it's unit-testable
 * without React Flow or a DOM: feed it the same nodes/edges buildNodes
 * projects, get back a Map<id, {x,y}> of VIEW-ONLY positions — the caller is
 * responsible for never writing these back into the GraphDoc (stored
 * `position` stays layout-only/optional, see graphDoc.ts's sanitizer).
 *
 * rankdir LR: the graph flows input → output left-to-right, matching UE's
 * material editor idiom the rest of the node-editor pack follows.
 */
import * as dagre from 'dagre';

/** One node's layout inputs: id + kind (for the fixed-size fallback below) + optional measured size. */
export interface LayoutNodeInput {
  id: string;
  kind: string;
  /** React Flow's `node.measured` dimensions, when available (post-mount). Undefined falls back to a per-kind estimate. */
  width?: number;
  height?: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

// Fixed size estimates, used until React Flow has actually measured a node
// (or for the unit tests below, which run with no DOM at all). Tunable but
// not a "feel" constant in the engine-invariant sense — just enough to keep
// dagre's rank spacing from overlapping node bodies.
const DEFAULT_NODE_WIDTH = 170;
const DEFAULT_NODE_HEIGHT = 40;
// Blend nodes render two stacked target handles + a bottom mask handle
// (BlendNode in NodeEditorPanel.tsx) — visibly taller than a single-port op node.
const BLEND_NODE_HEIGHT = 74;
const RANK_SEP = 64;
const NODE_SEP = 32;

function estimateWidth(kind: string): number {
  return kind === 'blend' ? DEFAULT_NODE_WIDTH + 20 : DEFAULT_NODE_WIDTH;
}

function estimateHeight(kind: string): number {
  return kind === 'blend' ? BLEND_NODE_HEIGHT : DEFAULT_NODE_HEIGHT;
}

/**
 * Runs dagre (rankdir LR) over the given nodes/edges and returns each node's
 * computed top-left position (React Flow's convention — dagre itself hands
 * back CENTER coordinates, converted here). Deterministic for a given input:
 * dagre's layout has no randomness, so calling this twice with the same
 * nodes/edges (same order) yields identical output.
 */
export function computeAutoLayout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[]
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, {
      width: n.width ?? estimateWidth(n.kind),
      height: n.height ?? estimateHeight(n.kind),
    });
  }
  // Blend nodes have multiple inputs (a/b/mask) — dagre doesn't need to know
  // about ports at all, a plain source→target edge per connection is enough
  // for rank assignment.
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const dn = g.node(n.id);
    if (!dn) continue; // shouldn't happen (every node was just set above), but keep this total
    positions.set(n.id, { x: dn.x - dn.width / 2, y: dn.y - dn.height / 2 });
  }
  return positions;
}
