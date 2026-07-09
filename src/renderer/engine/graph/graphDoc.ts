/**
 * GraphDoc: the JSON-serializable node-graph document. This is the app's
 * source of truth — the node editor renders it, the GPU pass chain executes
 * it, and (in a later milestone) it is what gets saved to disk and versioned
 * in git. Node positions live here for that reason.
 */
import { BLEND_KIND, BLEND_PARAM_DEFS, CUSTOM_KIND, OPS, isOpKind, packBlendUniform, type OpKind } from './ops';
import {
  cpuDevelop,
  defaultDevelopParams,
  developPasses,
  type DevelopParams,
  type PassSpec,
} from './developNode';
import {
  createDefaultCustomShaderParams,
  getCustomShaderArtifact,
  packCustomShaderUniforms,
  DEFAULT_CUSTOM_SHADER_SRC,
  WGSL_IDENT_RE,
  type CustomShaderParam,
  type CustomShaderParams,
} from './customShaderNode';
import { DEFAULT_WB_MODEL, type WbModel } from '../color/whiteBalance';

export const DEVELOP_KIND = 'Develop';

export type GraphNodeKind =
  | 'input'
  | 'output'
  | OpKind
  | typeof CUSTOM_KIND
  | typeof BLEND_KIND
  | typeof DEVELOP_KIND;

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
  /** Op parameters, keyed by OpParamDef.key. Absent for input/output. */
  params?: Record<string, number>;
  /** Sectioned Develop parameters; only for kind 'Develop'. */
  develop?: DevelopParams;
  /** customShader payload (code + GUI params); only for kind 'custom'. */
  shader?: CustomShaderParams;
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

export function defaultParams(kind: Exclude<AddableKind, typeof CUSTOM_KIND>): Record<string, number> {
  const defs = kind === BLEND_KIND ? BLEND_PARAM_DEFS : OPS[kind].params;
  return Object.fromEntries(defs.map((p) => [p.key, p.default]));
}

/** The default document (spec §3): input → Develop → output, all neutral. */
export function defaultGraphDoc(): GraphDoc {
  return {
    version: 1,
    nodes: [
      { id: 'in', kind: 'input', position: { x: 20, y: 60 } },
      { id: 'dev', kind: DEVELOP_KIND, position: { x: 220, y: 60 }, develop: defaultDevelopParams() },
      { id: 'out', kind: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'dev' },
      { id: 'e1', source: 'dev', target: 'out' },
    ],
  };
}

/** Provenance block persisted with the graph (spec §3). */
export interface SidecarSource {
  fileName: string;
  cameraModel?: string;
  kind: 'raw' | 'jpg';
}

/** The parsed sidecar: the graph plus its wrapper metadata. */
export interface SidecarDoc {
  graph: GraphDoc;
  source?: SidecarSource;
  createdAt?: string;
}

export const SIDECAR_SCHEMA_VERSION = 2;

/**
 * Serialize for the sidecar (spec §3): a schemaVersion-2 wrapper with the
 * source block and timestamps around the graph. Nodes serialize their kind
 * as `type` and edges as from/to — the spec's field names. Pretty-printed
 * and newline-terminated for git.
 */
export function serializeGraphDoc(doc: GraphDoc, source: SidecarSource | null, createdAt: string | null): string {
  const now = new Date().toISOString();
  const wrapper = {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    ...(source ? { source } : {}),
    createdAt: createdAt ?? now,
    updatedAt: now,
    graph: {
      nodes: doc.nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: n.position,
        ...(n.params ? { params: n.params } : {}),
        ...(n.develop ? { develop: n.develop } : {}),
        ...(n.shader ? { shader: n.shader } : {}),
      })),
      edges: doc.edges.map((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      })),
    },
  };
  return JSON.stringify(wrapper, null, 2) + '\n';
}

/** Parse + validate a sidecar; throws with a reason on anything malformed. */
export function parseGraphDoc(text: string): SidecarDoc {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('graph doc must be an object');
  const wrapper = raw as {
    schemaVersion?: unknown;
    source?: SidecarSource;
    createdAt?: unknown;
    graph?: { nodes?: unknown; edges?: unknown };
  };
  if (wrapper.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
    throw new Error(`unsupported sidecar schemaVersion ${String(wrapper.schemaVersion)}`);
  }
  const rawNodes = wrapper.graph?.nodes;
  const rawEdges = wrapper.graph?.edges;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new Error('graph doc needs nodes and edges');
  const doc: GraphDoc = {
    version: 1,
    nodes: rawNodes.map((n: Record<string, unknown>) => ({
      ...(n as object),
      kind: n.type,
      type: undefined,
    })) as unknown as GraphNode[],
    edges: rawEdges.map((e: Record<string, unknown>) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      ...(e.targetHandle !== undefined ? { targetHandle: e.targetHandle } : {}),
    })) as unknown as GraphEdge[],
  };
  for (const n of doc.nodes) {
    if (typeof n.id !== 'string') throw new Error('node id must be a string');
    if (
      n.kind !== 'input' &&
      n.kind !== 'output' &&
      n.kind !== CUSTOM_KIND &&
      n.kind !== BLEND_KIND &&
      n.kind !== DEVELOP_KIND &&
      !isOpKind(n.kind)
    ) {
      throw new Error(`unknown node kind ${String(n.kind)}`);
    }
    if (typeof n.position?.x !== 'number' || typeof n.position?.y !== 'number') {
      throw new Error(`node ${n.id} needs a numeric position`);
    }
    for (const v of Object.values(n.params ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`node ${n.id} has a non-numeric param`);
    }
    if (n.kind === DEVELOP_KIND) {
      // fill missing sections/keys with identity defaults; reject bad numbers
      n.develop = mergeDevelopParams(n.develop);
    }
    if (n.kind === CUSTOM_KIND) {
      n.shader = sanitizeCustomShader(n.shader, n.id);
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
  return {
    graph: doc,
    ...(wrapper.source ? { source: wrapper.source } : {}),
    ...(typeof wrapper.createdAt === 'string' ? { createdAt: wrapper.createdAt } : {}),
  };
}

/** Normalize an untrusted customShader payload; throws on structural garbage. */
export function sanitizeCustomShader(raw: unknown, nodeId: string): CustomShaderParams {
  const base = createDefaultCustomShaderParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { code?: { src?: unknown; lastValidSrc?: unknown }; params?: unknown };
  const code = typeof src.code?.src === 'string' ? src.code.src : DEFAULT_CUSTOM_SHADER_SRC;
  const lastValid = typeof src.code?.lastValidSrc === 'string' ? src.code.lastValidSrc : code;
  const params: CustomShaderParam[] = [];
  if (src.params !== undefined) {
    if (!Array.isArray(src.params)) throw new Error(`node ${nodeId} shader params must be an array`);
    const seen = new Set<string>();
    for (const p of src.params as Array<Record<string, unknown>>) {
      const name = p?.name;
      if (typeof name !== 'string' || !WGSL_IDENT_RE.test(name) || seen.has(name)) {
        throw new Error(`node ${nodeId} has an invalid shader param name`);
      }
      seen.add(name);
      const nums = [p.min, p.max, p.default, p.value].map((v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`node ${nodeId} shader param ${name} has a non-numeric field`);
        }
        return v;
      }) as [number, number, number, number];
      params.push({ name, min: nums[0], max: nums[1], default: nums[2], value: nums[3] });
    }
  }
  return { code: { src: code, lastValidSrc: lastValid }, params };
}

/**
 * Deep-merge untrusted Develop params over the identity defaults: unknown
 * keys are dropped, missing keys filled, and non-finite numbers rejected
 * loudly (a typo must not silently zero a section).
 */
export function mergeDevelopParams(raw: unknown): DevelopParams {
  const base = defaultDevelopParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, path: string): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`develop param ${path} must be a finite number`);
    return v;
  };
  const mergeSection = <T extends Record<string, unknown>>(target: T, source: unknown, path: string): void => {
    if (typeof source !== 'object' || source === null) return;
    for (const key of Object.keys(target)) {
      const t = target[key];
      const s = (source as Record<string, unknown>)[key];
      if (typeof t === 'number') {
        (target as Record<string, unknown>)[key] = num(s, t, `${path}.${key}`);
      } else if (Array.isArray(t)) {
        if (s !== undefined) (target as Record<string, unknown>)[key] = s; // curve points; sanitized at use
      } else if (typeof t === 'object' && t !== null) {
        mergeSection(t as Record<string, unknown>, s, `${path}.${key}`);
      }
    }
  };
  mergeSection(base as unknown as Record<string, unknown>, src, 'develop');
  return base;
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
type Rgb = [number, number, number];

/**
 * One executable step; `src*` index a previous step's output (-1 = the
 * decoded input). 'passes' steps run 1..n fullscreen passes sequentially
 * (ops = 1, Develop = its active sections); `cpu` is the whole-step CPU
 * mirror, or null when no reference exists. Identity nodes never become
 * steps at all — buildPlan resolves them to their source, which is what
 * makes untouched nodes bit-exact pass-throughs.
 */
export type PlanStep =
  | { nodeId: string; type: 'passes'; passes: PassSpec[]; src: number; cpu: ((px: Rgb) => Rgb) | null }
  | { nodeId: string; type: 'blend'; uniform: Vec4; srcA: number; srcB: number };

/** Wrap an op's `applyOp` WGSL into a complete pass shader (vec4 uniform). */
export function opPassWgsl(applyOp: string): string {
  return /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: vec4f;
${applyOp}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return applyOp(textureLoad(src, vec2i(pos.xy), 0), params);
}
`;
}

function vec4Buffer(v: Vec4): ArrayBuffer {
  const buf = new ArrayBuffer(16);
  new Float32Array(buf).set(v);
  return buf;
}

export interface RenderPlan {
  /** Topologically ordered: every step only reads earlier outputs. */
  steps: PlanStep[];
  /** Step index whose output feeds the output node (-1 = the input itself). */
  output: number;
}

/** Per-compile context: the image's WB model (and later, render scale). */
export interface CompileContext {
  wb: WbModel;
}

/**
 * Compile the GraphDoc into an execution plan by resolving the output node's
 * ancestry. The graph is a DAG: ops and custom nodes take one input, blend
 * takes two ('a'/'b' handles), anything may fan out. Nodes not reachable from
 * the output are allowed but simply not executed. Throws on cycles, missing
 * connections, or unknown kinds.
 */
export function buildPlan(doc: GraphDoc, ctx?: CompileContext): RenderPlan {
  const wb = ctx?.wb ?? DEFAULT_WB_MODEL;
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
      const uniform = packBlendUniform(node.params ?? {});
      if (uniform[0] === 0) {
        // amount 0 = pure input a — identity, no step
        index = srcA;
      } else {
        steps.push({ nodeId: id, type: 'blend', uniform, srcA, srcB });
        index = steps.length - 1;
      }
    } else {
      if (ins.length !== 1) throw new Error(`node ${id} needs exactly one input (has ${ins.length})`);
      const src = resolve(ins[0]!.source);
      if (node.kind === 'output') {
        index = src;
      } else if (node.kind === CUSTOM_KIND) {
        // Only validated artifacts render (customShaderNode cache); a node
        // that has none yet (e.g. mid-revalidation after load) passes through.
        const artifact = getCustomShaderArtifact(id);
        if (!artifact) {
          index = src;
        } else {
          steps.push({
            nodeId: id,
            type: 'passes',
            passes: [
              {
                shaderId: artifact.shaderId,
                wgsl: artifact.wgsl,
                uniforms: packCustomShaderUniforms(artifact, node.shader?.params ?? []),
              },
            ],
            src,
            cpu: null, // user WGSL has no CPU mirror
          });
          index = steps.length - 1;
        }
      } else if (node.kind === DEVELOP_KIND) {
        const params = node.develop ?? defaultDevelopParams();
        const wbGains = wb.gains(params.basic.temp, params.basic.tint);
        const passes = developPasses(params, wbGains);
        if (passes.length === 0) {
          index = src; // untouched Develop = bit-exact pass-through
        } else {
          steps.push({ nodeId: id, type: 'passes', passes, src, cpu: (px) => cpuDevelop(px, params, wbGains) });
          index = steps.length - 1;
        }
      } else if (node.kind === 'whitebalance') {
        // the atomic WB shares the per-image Kelvin/Tint model — the uniform
        // carries the computed relative gains, and as-shot values skip
        const params = node.params ?? {};
        const g = wb.gains(params.temp ?? 0, params.tint ?? 0);
        if (g[0] === 1 && g[1] === 1 && g[2] === 1) {
          index = src;
        } else {
          const uniform: Vec4 = [g[0], g[1], g[2], 0];
          steps.push({
            nodeId: id,
            type: 'passes',
            passes: [{ shaderId: 'op/whitebalance', wgsl: opPassWgsl(OPS.whitebalance.wgsl), uniforms: vec4Buffer(uniform) }],
            src,
            cpu: (px) => OPS.whitebalance.apply(px, uniform),
          });
          index = steps.length - 1;
        }
      } else {
        if (!isOpKind(node.kind)) throw new Error(`unexpected node kind ${node.kind}`);
        const op = OPS[node.kind];
        const params = node.params ?? {};
        if (op.isIdentity(params)) {
          index = src; // default-valued op = bit-exact pass-through
        } else {
          const uniform = op.packUniform(params);
          steps.push({
            nodeId: id,
            type: 'passes',
            passes: [{ shaderId: `op/${node.kind}`, wgsl: opPassWgsl(op.wgsl), uniforms: vec4Buffer(uniform) }],
            src,
            cpu: (px) => op.apply(px, uniform),
          });
          index = steps.length - 1;
        }
      }
    }
    visiting.delete(id);
    memo.set(id, index);
    return index;
  };

  return { steps, output: resolve(output.id) };
}

/** CPU reference for one pixel; caller must ensure every step has a mirror. */
export function cpuEvalPlan(plan: RenderPlan, px: Rgb): Rgb {
  const outputs: Rgb[] = [];
  const at = (i: number) => (i < 0 ? px : outputs[i]!);
  for (const step of plan.steps) {
    if (step.type === 'passes') {
      if (!step.cpu) throw new Error(`step ${step.nodeId} has no CPU reference`);
      outputs.push(step.cpu(at(step.src)));
    } else {
      const a = at(step.srcA);
      const b = at(step.srcB);
      const t = step.uniform[0];
      outputs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return at(plan.output);
}

/** True when every step in the plan has a CPU mirror. */
export function planHasCpuReference(plan: RenderPlan): boolean {
  return plan.steps.every((s) => s.type !== 'passes' || s.cpu !== null);
}
