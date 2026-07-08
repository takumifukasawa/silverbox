/**
 * GraphDoc: the JSON-serializable node-graph document. This is the app's
 * source of truth — the node editor renders it, the GPU pass chain executes
 * it, and (in a later milestone) it is what gets saved to disk and versioned
 * in git. Node positions live here for that reason.
 */
import {
  BLEND_KIND,
  BLEND_PARAM_DEFS,
  CUSTOM_KIND,
  CUSTOM_PARAM_DEFS,
  DEFAULT_CUSTOM_CODE,
  OPS,
  isOpKind,
  packBlendUniform,
  packCustomUniform,
  type OpKind,
} from './ops';

export type GraphNodeKind = 'input' | 'output' | OpKind | typeof CUSTOM_KIND | typeof BLEND_KIND;

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
  /** Op parameters, keyed by OpParamDef.key. Absent for input/output. */
  params?: Record<string, number>;
  /** WGSL applyOp source; only for kind 'custom'. */
  code?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Which input of a blend node this edge feeds ('a' = base, 'b' = overlay). */
  targetHandle?: 'a' | 'b';
}

export interface GraphDoc {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type AddableKind = OpKind | typeof CUSTOM_KIND | typeof BLEND_KIND;

export function defaultParams(kind: AddableKind): Record<string, number> {
  const defs = kind === CUSTOM_KIND ? CUSTOM_PARAM_DEFS : kind === BLEND_KIND ? BLEND_PARAM_DEFS : OPS[kind].params;
  return Object.fromEntries(defs.map((p) => [p.key, p.default]));
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

/** Serialize for the sidecar: pretty-printed and newline-terminated for git. */
export function serializeGraphDoc(doc: GraphDoc): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Parse + validate a sidecar; throws with a reason on anything malformed. */
export function parseGraphDoc(text: string): GraphDoc {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('graph doc must be an object');
  const doc = raw as GraphDoc;
  if (doc.version !== 1) throw new Error(`unsupported graph doc version ${String(doc.version)}`);
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('graph doc needs nodes and edges');
  for (const n of doc.nodes) {
    if (typeof n.id !== 'string') throw new Error('node id must be a string');
    if (
      n.kind !== 'input' &&
      n.kind !== 'output' &&
      n.kind !== CUSTOM_KIND &&
      n.kind !== BLEND_KIND &&
      !isOpKind(n.kind)
    ) {
      throw new Error(`unknown node kind ${String(n.kind)}`);
    }
    if (typeof n.position?.x !== 'number' || typeof n.position?.y !== 'number') {
      throw new Error(`node ${n.id} needs a numeric position`);
    }
    if (n.code !== undefined && typeof n.code !== 'string') {
      throw new Error(`node ${n.id} code must be a string`);
    }
    for (const v of Object.values(n.params ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`node ${n.id} has a non-numeric param`);
    }
  }
  for (const e of doc.edges) {
    if (typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') {
      throw new Error('edges need string id/source/target');
    }
    if (e.targetHandle !== undefined && e.targetHandle !== 'a' && e.targetHandle !== 'b') {
      throw new Error(`edge ${e.id} has an invalid targetHandle`);
    }
  }
  buildPlan(doc); // throws unless the output resolves through a valid DAG
  return doc;
}

/** Smallest `${prefix}-N` (N ≥ 1) not taken by any node or edge id. */
export function nextId(doc: GraphDoc, prefix: string): string {
  const taken = new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.has(id)) return id;
  }
}

type Vec4 = [number, number, number, number];

/** One executable step; `src*` index a previous step's output (-1 = the decoded input). */
export type PlanStep =
  | { nodeId: string; type: 'builtin'; kind: OpKind; uniform: Vec4; src: number }
  | { nodeId: string; type: 'custom'; code: string; uniform: Vec4; src: number }
  | { nodeId: string; type: 'blend'; uniform: Vec4; srcA: number; srcB: number };

export interface RenderPlan {
  /** Topologically ordered: every step only reads earlier outputs. */
  steps: PlanStep[];
  /** Step index whose output feeds the output node (-1 = the input itself). */
  output: number;
}

/**
 * Compile the GraphDoc into an execution plan by resolving the output node's
 * ancestry. The graph is a DAG: ops and custom nodes take one input, blend
 * takes two ('a'/'b' handles), anything may fan out. Nodes not reachable from
 * the output are allowed but simply not executed. Throws on cycles, missing
 * connections, or unknown kinds.
 */
export function buildPlan(doc: GraphDoc): RenderPlan {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of doc.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  const output = doc.nodes.find((n) => n.kind === 'output');
  if (!output) throw new Error('graph has no output node');
  if (!doc.nodes.some((n) => n.kind === 'input')) throw new Error('graph has no input node');

  const steps: PlanStep[] = [];
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error('graph contains a cycle');
    const node = byId.get(id);
    if (!node) throw new Error(`edge references missing node ${id}`);
    if (node.kind === 'input') {
      memo.set(id, -1);
      return -1;
    }
    visiting.add(id);
    const ins = incoming.get(id) ?? [];
    let index: number;
    if (node.kind === BLEND_KIND) {
      const ea = ins.find((e) => e.targetHandle === 'a');
      const eb = ins.find((e) => e.targetHandle === 'b');
      if (!ea || !eb || ins.length !== 2) throw new Error(`blend ${id} needs exactly inputs a and b`);
      const srcA = resolve(ea.source);
      const srcB = resolve(eb.source);
      steps.push({ nodeId: id, type: 'blend', uniform: packBlendUniform(node.params ?? {}), srcA, srcB });
      index = steps.length - 1;
    } else {
      if (ins.length !== 1) throw new Error(`node ${id} needs exactly one input (has ${ins.length})`);
      const src = resolve(ins[0]!.source);
      if (node.kind === 'output') {
        index = src;
      } else if (node.kind === CUSTOM_KIND) {
        steps.push({
          nodeId: id,
          type: 'custom',
          code: node.code ?? DEFAULT_CUSTOM_CODE,
          uniform: packCustomUniform(node.params ?? {}),
          src,
        });
        index = steps.length - 1;
      } else {
        if (!isOpKind(node.kind)) throw new Error(`unexpected node kind ${node.kind}`);
        steps.push({
          nodeId: id,
          type: 'builtin',
          kind: node.kind,
          uniform: OPS[node.kind].packUniform(node.params ?? {}),
          src,
        });
        index = steps.length - 1;
      }
    }
    visiting.delete(id);
    memo.set(id, index);
    return index;
  };

  return { steps, output: resolve(output.id) };
}

/** CPU reference for one pixel; caller must ensure the plan has no custom steps. */
export function cpuEvalPlan(plan: RenderPlan, px: [number, number, number]): [number, number, number] {
  const outputs: [number, number, number][] = [];
  const at = (i: number) => (i < 0 ? px : outputs[i]!);
  for (const step of plan.steps) {
    if (step.type === 'builtin') {
      outputs.push(OPS[step.kind].apply(at(step.src), step.uniform));
    } else if (step.type === 'blend') {
      const a = at(step.srcA);
      const b = at(step.srcB);
      const t = step.uniform[0];
      outputs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    } else {
      throw new Error('custom steps have no CPU reference');
    }
  }
  return at(plan.output);
}
