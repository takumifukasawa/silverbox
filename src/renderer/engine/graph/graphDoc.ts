/**
 * GraphDoc: the JSON-serializable node-graph document. This is the app's
 * source of truth — the node editor renders it, the GPU pass chain executes
 * it, and (in a later milestone) it is what gets saved to disk and versioned
 * in git. Node positions live here for that reason.
 */
import { OPS, isOpKind, type OpKind } from './ops';

export type GraphNodeKind = 'input' | 'output' | OpKind;

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
  /** Op parameters, keyed by OpParamDef.key. Absent for input/output. */
  params?: Record<string, number>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphDoc {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function defaultParams(kind: OpKind): Record<string, number> {
  return Object.fromEntries(OPS[kind].params.map((p) => [p.key, p.default]));
}

/** The default document: input → exposure → saturation → output, all neutral. */
export function defaultGraphDoc(): GraphDoc {
  return {
    version: 1,
    nodes: [
      { id: 'in', kind: 'input', position: { x: 20, y: 60 } },
      { id: 'exposure-1', kind: 'exposure', position: { x: 200, y: 60 }, params: defaultParams('exposure') },
      { id: 'saturation-1', kind: 'saturation', position: { x: 380, y: 60 }, params: defaultParams('saturation') },
      { id: 'out', kind: 'output', position: { x: 560, y: 60 } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'exposure-1' },
      { id: 'e1', source: 'exposure-1', target: 'saturation-1' },
      { id: 'e2', source: 'saturation-1', target: 'out' },
    ],
  };
}

/** Smallest `${prefix}-N` (N ≥ 1) not taken by any node or edge id. */
export function nextId(doc: GraphDoc, prefix: string): string {
  const taken = new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export interface ChainOp {
  nodeId: string;
  kind: OpKind;
  uniform: [number, number, number, number];
}

/**
 * Extract the ordered op chain by walking edges from input to output.
 * Throws if the graph is not a single linear input→…→output chain — the only
 * shape milestones 4 supports (branching comes with blend/merge nodes later).
 */
export function opChain(doc: GraphDoc): ChainOp[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  for (const e of doc.edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);

  const input = doc.nodes.find((n) => n.kind === 'input');
  if (!input) throw new Error('graph has no input node');
  const chain: ChainOp[] = [];
  let cur = input;
  const seen = new Set<string>([input.id]);
  while (cur.kind !== 'output') {
    const next = outgoing.get(cur.id) ?? [];
    if (next.length !== 1) throw new Error(`node ${cur.id} must have exactly one outgoing edge`);
    const node = byId.get(next[0]!);
    if (!node) throw new Error(`edge points to missing node ${next[0]}`);
    if (seen.has(node.id)) throw new Error('graph contains a cycle');
    seen.add(node.id);
    if (node.kind !== 'output') {
      if (!isOpKind(node.kind)) throw new Error(`unexpected node kind ${node.kind}`);
      chain.push({ nodeId: node.id, kind: node.kind, uniform: OPS[node.kind].packUniform(node.params ?? {}) });
    }
    cur = node;
  }
  return chain;
}
