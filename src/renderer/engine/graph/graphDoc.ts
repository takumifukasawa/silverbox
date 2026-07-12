/**
 * GraphDoc: the JSON-serializable node-graph document. This is the app's
 * source of truth — the node editor renders it, the GPU pass chain executes
 * it, and (in a later milestone) it is what gets saved to disk and versioned
 * in git. Node positions live here for that reason.
 */
import { BLEND_KIND, BLEND_PARAM_DEFS, CUSTOM_KIND, OPS, isOpKind, packBlendUniform, type OpKind } from './ops';
import { compileDevelop, defaultDevelopParams, type DevelopParams, type PassSpec } from './developNode';
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
import { sanitizeCurvePoints } from '../color/toneCurve';
import { cpuMaskShape, defaultMaskParams, MASK_KIND, MASK_WGSL, packMaskUniform, sanitizeMaskParams, type MaskParams, type MaskShape } from './maskNode';
import { defaultSpotsParams, packSpotsUniform, sanitizeSpotsParams, SPOTS_KIND, SPOTS_WGSL, type SpotsParams, type Spot } from './spotsNode';
import { maskShapeAnchorToOutput, maskShapeOutputToAnchor, spotAnchorToOutput, spotOutputToAnchor } from './anchorSpace';
import type { ExportColorSpace, ExportMetadataPolicy } from '../../../../shared/ipc';

export const DEVELOP_KIND = 'Develop';

export type GraphNodeKind =
  | 'input'
  | 'output'
  | OpKind
  | typeof CUSTOM_KIND
  | typeof BLEND_KIND
  | typeof DEVELOP_KIND
  | typeof MASK_KIND
  | typeof SPOTS_KIND;

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
  /** Non-destructive crop + straighten; only for kind 'input'. */
  geometry?: GeometryParams;
  /** Manual lens corrections (distortion/CA/vignette); only for kind 'input'. */
  lens?: LensParams;
  /** Analytic mask shapes; only for kind 'mask' (masks milestone). */
  mask?: MaskParams;
  /** Non-destructive clone-circle list (spot removal, task #50); only for kind 'spots'. */
  spots?: SpotsParams;
  /** Display name; only meaningful for kind 'output' (default 'main' — see outputName()). */
  name?: string;
  /**
   * Per-output export setting overrides (per-output export settings design
   * note); only meaningful for kind 'output'. All fields optional — an
   * ABSENT field inherits the export dialog's/CLI's value at export time
   * (see resolveExportSettings, the one place effective settings are
   * computed). Never present with zero keys on a parsed doc — parseGraphDoc
   * normalizes an all-absent payload back to `undefined`, same as `name`.
   */
  export?: ExportOverrides;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Which input port of a multi-input node this edge feeds: 'a'/'b' for
   * blend's base/overlay, 'mask' for blend's optional mask input; absent =
   * the target node's primary (only) input. Serialized as `port` in schema
   * v3 (see serializeGraphDoc/parseGraphDoc); this internal field name is
   * unchanged from before v3 to minimize churn at every call site already
   * keyed on `targetHandle`.
   */
  targetHandle?: 'a' | 'b' | 'mask';
}

export interface GraphDoc {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type AddableKind = OpKind | typeof CUSTOM_KIND | typeof BLEND_KIND | typeof MASK_KIND | typeof SPOTS_KIND | 'output';

/** Output node's display name, defaulting the unset/blank case to 'main' (spec §6). */
export function outputName(node: GraphNode): string {
  return node.name?.trim() || 'main';
}

/**
 * Human-readable label for a graph node — the single source of truth for
 * NodeEditorPanel's node bodies AND CanvasView's inspect-mode badge (per-
 * node-preview pack), so the two never drift apart. `fileName` is only used
 * by the input node's own label.
 */
export function nodeLabel(node: GraphNode, fileName: string | null): string {
  if (node.kind === 'input') return fileName ? `input — ${fileName}` : 'input';
  if (node.kind === 'output') return `output (sRGB) — ${outputName(node)}`;
  if (node.kind === DEVELOP_KIND) return 'Develop';
  if (node.kind === CUSTOM_KIND) return 'custom (wgsl)';
  if (node.kind === BLEND_KIND) return 'blend';
  if (node.kind === MASK_KIND) return 'mask';
  if (node.kind === SPOTS_KIND) return 'spots';
  if (isOpKind(node.kind)) return OPS[node.kind].label.toLowerCase();
  return node.kind;
}

// --- Export overrides: per-output export settings ---------------------------
//
// A "main" full-res output and a "web" 2048px/q80 output are often the SAME
// doc — this lets each output node carry its own export quality/maxDim/
// metadata/colorSpace, with the export dialog's/CLI's own controls as the
// fallback for whatever a given output doesn't override. Node-resident (not
// a dialog-side map keyed by output id) because the sidecar IS the document:
// "this output is the 2048px web export" is intent that should travel with
// the doc through git, presets, and the CLI.

/**
 * All fields optional; an ABSENT key means "inherit the dialog's/CLI's
 * value". `maxDim`'s own explicit `null` (force full resolution) IS a real
 * override and must be distinguished from the key being absent — see
 * resolveExportSettings, which checks presence rather than using `??`
 * (which would treat both as nullish and silently discard the override).
 */
export interface ExportOverrides {
  quality?: number;
  maxDim?: number | null;
  metadata?: ExportMetadataPolicy;
  colorSpace?: ExportColorSpace;
}

/**
 * Effective export settings for one output node: each field of `node.export`
 * wins when PRESENT (independently — quality can be overridden while maxDim/
 * metadata/colorSpace still inherit); otherwise `fallbacks` (the export
 * dialog's controls, or the CLI's --quality/--max-dim/--metadata/--colorspace)
 * applies. This is the ONE place effective settings are computed — appStore's
 * exportOnePath calls it, which every export path (UI's exportImage/
 * exportSelectedOutputs, and the headless CLI's runCliRender) funnels through.
 */
export function resolveExportSettings(node: GraphNode | undefined, fallbacks: ExportOverrides): ExportOverrides {
  const ov = node?.export;
  const has = (key: keyof ExportOverrides) => !!ov && Object.prototype.hasOwnProperty.call(ov, key);
  return {
    quality: has('quality') ? ov!.quality : fallbacks.quality,
    maxDim: has('maxDim') ? ov!.maxDim : fallbacks.maxDim,
    metadata: has('metadata') ? ov!.metadata : fallbacks.metadata,
    colorSpace: has('colorSpace') ? ov!.colorSpace : fallbacks.colorSpace,
  };
}

/**
 * Compact badge text for the export dialog's output-selector rows (e.g.
 * "q80 · 2048px"); null when the node carries no overrides at all. Only the
 * fields actually overridden appear, in a fixed order.
 */
export function describeExportOverrides(node: GraphNode | undefined): string | null {
  const e = node?.export;
  if (!e) return null;
  const parts: string[] = [];
  if (e.quality !== undefined) parts.push(`q${e.quality}`);
  if ('maxDim' in e) parts.push(e.maxDim === null ? 'full-res' : `${e.maxDim}px`);
  if (e.metadata !== undefined) parts.push(`exif:${e.metadata}`);
  if (e.colorSpace !== undefined) parts.push(e.colorSpace);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Normalize an untrusted export-overrides payload; absent/empty → `{}` (the
 * caller — parseGraphDoc — normalizes an all-empty result back to `undefined`
 * on the node, same as `name`). Throws on structural garbage, sanitizeLens
 * style. `maxDim` alone distinguishes "absent" (`in`) from `null` (explicit
 * full-res override) — see ExportOverrides's doc comment.
 */
export function sanitizeExportOverrides(raw: unknown, nodeId: string): ExportOverrides {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null) throw new Error(`${nodeId}.export must be an object`);
  const src = raw as Record<string, unknown>;
  const out: ExportOverrides = {};
  if (src.quality !== undefined) {
    const q = src.quality;
    if (typeof q !== 'number' || !Number.isFinite(q)) throw new Error(`${nodeId}.export.quality must be a finite number`);
    out.quality = Math.min(100, Math.max(1, Math.round(q)));
  }
  if ('maxDim' in src && src.maxDim !== undefined) {
    const m = src.maxDim;
    if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m <= 0)) {
      throw new Error(`${nodeId}.export.maxDim must be null or a positive finite number`);
    }
    out.maxDim = m as number | null;
  }
  if (src.metadata !== undefined) {
    if (src.metadata !== 'all' && src.metadata !== 'minimal' && src.metadata !== 'none') {
      throw new Error(`${nodeId}.export.metadata must be all|minimal|none`);
    }
    out.metadata = src.metadata;
  }
  if (src.colorSpace !== undefined) {
    if (src.colorSpace !== 'srgb' && src.colorSpace !== 'p3') {
      throw new Error(`${nodeId}.export.colorSpace must be srgb|p3`);
    }
    out.colorSpace = src.colorSpace;
  }
  return out;
}

export function defaultParams(
  kind: Exclude<AddableKind, typeof CUSTOM_KIND | typeof MASK_KIND | typeof SPOTS_KIND | 'output'>
): Record<string, number> {
  const defs = kind === BLEND_KIND ? BLEND_PARAM_DEFS : OPS[kind].params;
  return Object.fromEntries(defs.map((p) => [p.key, p.default]));
}

/** The default document (spec §3): input → Develop → output, all neutral. */
export function defaultGraphDoc(): GraphDoc {
  return {
    version: 1,
    nodes: [
      { id: 'in', kind: 'input', position: { x: 20, y: 60 }, geometry: defaultGeometryParams(), lens: defaultLensParams() },
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
  /** Unrecognized wrapper-level keys (DESIGN §9 passthrough) — round-tripped verbatim by serializeGraphDoc. */
  unknown?: Record<string, unknown>;
}

export const SIDECAR_SCHEMA_VERSION = 4;

// --- Geometry: non-destructive crop + straighten (input node only) ----------
//
// crop is normalized 0..1 in the ROTATED frame (i.e. it shares the source's
// width/height — rotation alone never changes canvas dims, only the crop
// fraction does). angle is degrees, -45..45 (straighten). Both default to the
// identity transform, so an untouched input node stays a bit-exact
// pass-through — the same invariant every other node kind upholds.

export interface GeometryCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Orientation: applied FIRST, before crop/rotate±45 — flipH (horizontal
 * mirror) happens BEFORE the quarterTurns rotation (documented order; see
 * RESAMPLE_SHADER's orientInverse for the exact inverse mapping). quarterTurns
 * counts 90° counter-clockwise-on-screen turns (same "+angle rotates the
 * displayed image CCW" convention the straighten pass already promises).
 * Identity = 0 turns, no flip — an untouched input node stays a bit-exact
 * pass-through, same invariant crop/angle uphold.
 */
export interface GeometryOrientation {
  quarterTurns: 0 | 1 | 2 | 3;
  flipH: boolean;
}

export interface GeometryParams {
  crop: GeometryCrop;
  angle: number;
  orientation: GeometryOrientation;
}

/** Smallest allowed crop.w/h — keeps the resample from collapsing to a sliver. */
export const GEOMETRY_MIN_CROP_SIZE = 0.05;
const GEOMETRY_MAX_ANGLE = 45;

export function defaultGeometryOrientation(): GeometryOrientation {
  return { quarterTurns: 0, flipH: false };
}

export function defaultGeometryParams(): GeometryParams {
  return { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, orientation: defaultGeometryOrientation() };
}

export function isIdentityGeometry(g: GeometryParams): boolean {
  const o = g.orientation ?? defaultGeometryOrientation();
  return (
    g.angle === 0 &&
    g.crop.x === 0 &&
    g.crop.y === 0 &&
    g.crop.w === 1 &&
    g.crop.h === 1 &&
    o.quarterTurns === 0 &&
    o.flipH === false
  );
}

/**
 * Dims of the frame AFTER orientation (before crop): odd quarterTurns swap
 * width/height (a 90°/270° turn), even turns leave them unchanged. Shared by
 * computeOutputDims (sync UI sizing) and GraphRenderer.baseDims (GPU) so both
 * agree on the crop rectangle's reference frame.
 */
export function orientedDims(
  srcWidth: number,
  srcHeight: number,
  orientation: GeometryOrientation
): { width: number; height: number } {
  return orientation.quarterTurns % 2 === 1
    ? { width: srcHeight, height: srcWidth }
    : { width: srcWidth, height: srcHeight };
}

/**
 * Clamp an already-numeric geometry into valid ranges: w/h in
 * [GEOMETRY_MIN_CROP_SIZE, 1], x/y in [0, 1 - w/h] (crop never spills past the
 * rotated frame), angle in [-45, 45]. Used both by the sidecar sanitizer and
 * by runtime mutations (drag handles, the angle slider) so a stray value can
 * never wedge the doc into an invalid state. `orientation` passes through
 * untouched (already validated by the caller — sanitizeGeometry or a typed
 * runtime literal); missing (older call sites / debug-hook payloads) falls
 * back to identity.
 */
export function clampGeometry(g: GeometryParams): GeometryParams {
  const w = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, g.crop.w));
  const h = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, g.crop.h));
  let x = Math.min(1, Math.max(0, g.crop.x));
  let y = Math.min(1, Math.max(0, g.crop.y));
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  const angle = Math.min(GEOMETRY_MAX_ANGLE, Math.max(-GEOMETRY_MAX_ANGLE, g.angle));
  const orientation = g.orientation ?? defaultGeometryOrientation();
  return { crop: { x, y, w, h }, angle, orientation };
}

/**
 * Output dims for a decoded image of (srcWidth, srcHeight) under `doc`'s
 * input-node geometry — the same round(crop.w*srcW)/round(crop.h*srcH)
 * formula GraphRenderer applies, exposed here so the UI (viewport fit, canvas
 * sizing) can compute it SYNCHRONOUSLY from store state, without waiting on
 * the GPU renderer's own async setGraph()/render() round-trip.
 */
export function computeOutputDims(srcWidth: number, srcHeight: number, doc: GraphDoc): { width: number; height: number } {
  const inputNode = doc.nodes.find((n) => n.kind === 'input');
  const geometry = inputNode?.geometry ?? defaultGeometryParams();
  if (isIdentityGeometry(geometry)) return { width: srcWidth, height: srcHeight };
  const oriented = orientedDims(srcWidth, srcHeight, geometry.orientation ?? defaultGeometryOrientation());
  return {
    width: Math.max(1, Math.round(geometry.crop.w * oriented.width)),
    height: Math.max(1, Math.round(geometry.crop.h * oriented.height)),
  };
}

/**
 * Normalize an untrusted orientation payload; missing ⇒ identity default (old
 * sidecars with no `orientation` field load unchanged). Throws on structural
 * garbage, same convention as the rest of sanitizeGeometry.
 */
function sanitizeOrientation(raw: unknown, nodeId: string): GeometryOrientation {
  const base = defaultGeometryOrientation();
  if (raw === undefined) return base;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${nodeId}.geometry.orientation must be an object`);
  }
  const src = raw as Partial<Record<keyof GeometryOrientation, unknown>>;
  const quarterTurns = src.quarterTurns === undefined ? base.quarterTurns : src.quarterTurns;
  if (quarterTurns !== 0 && quarterTurns !== 1 && quarterTurns !== 2 && quarterTurns !== 3) {
    throw new Error(`${nodeId}.geometry.orientation.quarterTurns must be 0, 1, 2, or 3`);
  }
  const flipH = src.flipH === undefined ? base.flipH : src.flipH;
  if (typeof flipH !== 'boolean') throw new Error(`${nodeId}.geometry.orientation.flipH must be a boolean`);
  return { quarterTurns, flipH };
}

/** Normalize an untrusted geometry payload; throws on non-finite numbers (mergeDevelopParams style). */
export function sanitizeGeometry(raw: unknown, nodeId: string): GeometryParams {
  const base = defaultGeometryParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { crop?: Partial<GeometryCrop>; angle?: unknown; orientation?: unknown };
  const num = (v: unknown, fallback: number, path: string): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`geometry ${path} must be a finite number`);
    return v;
  };
  return clampGeometry({
    crop: {
      x: num(src.crop?.x, base.crop.x, `${nodeId}.geometry.crop.x`),
      y: num(src.crop?.y, base.crop.y, `${nodeId}.geometry.crop.y`),
      w: num(src.crop?.w, base.crop.w, `${nodeId}.geometry.crop.w`),
      h: num(src.crop?.h, base.crop.h, `${nodeId}.geometry.crop.h`),
    },
    angle: num(src.angle, base.angle, `${nodeId}.geometry.angle`),
    orientation: sanitizeOrientation(src.orientation, nodeId),
  });
}

// --- Lens: manual lens corrections (distortion / CA / vignette recovery) ----
//
// Optical, like geometry, so it lives on the input node and is folded into
// the SAME resample pass as crop/straighten — the image is resampled once.
// Unlike geometry it never changes output dims (crop alone does). All four
// fields default to 0 = identity, so an untouched input node stays a
// bit-exact pass-through, same invariant geometry upholds.

/**
 * Sony embedded lens-profile toggle (task #34, F3b). The correction SPLINES
 * live on the decoded image (parsed from the ARW bytes — see
 * decodeWorker.ts / sonyLensProfile.ts); only this on/off flag is
 * document/sidecar state. DEFAULT enabled true on a fresh open WHEN the image
 * carries a profile (camera/LR behavior — set in appStore.openImageByPath);
 * older sidecars with no `profile` key sanitize to enabled:false so their
 * existing renders never change.
 */
export interface LensProfileState {
  enabled: boolean;
}

export interface LensParams {
  /** −100..100; + straightens barrel distortion. */
  distortion: number;
  /** −100..100; radial scale of the R channel (chromatic aberration). */
  caRed: number;
  /** −100..100; radial scale of the B channel (chromatic aberration). */
  caBlue: number;
  /** 0..100; corner illumination recovery. */
  vignette: number;
  /** Sony embedded auto-correction toggle; stacks on TOP of the manual fields (LR-style). */
  profile?: LensProfileState;
}

export function defaultLensParams(): LensParams {
  return { distortion: 0, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: false } };
}

/**
 * True when the MANUAL corrections are all identity. Deliberately ignores
 * `profile` — the profile's own activation (it needs the image's splines,
 * which the doc can't see) is decided by the renderer (GraphRenderer). This
 * keeps the manual-only pass-through invariant intact.
 */
export function isIdentityLens(l: LensParams): boolean {
  return l.distortion === 0 && l.caRed === 0 && l.caBlue === 0 && l.vignette === 0;
}

/** Clamp an already-numeric lens payload into valid ranges (see LensParams field docs). */
export function clampLens(l: LensParams): LensParams {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  return {
    distortion: clamp(l.distortion, -100, 100),
    caRed: clamp(l.caRed, -100, 100),
    caBlue: clamp(l.caBlue, -100, 100),
    vignette: clamp(l.vignette, 0, 100),
    ...(l.profile ? { profile: { enabled: l.profile.enabled } } : {}),
  };
}

/** Normalize an untrusted lens payload; throws on non-finite numbers (sanitizeGeometry style). */
export function sanitizeLens(raw: unknown, nodeId: string): LensParams {
  const base = defaultLensParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as Partial<Record<keyof LensParams, unknown>>;
  const num = (v: unknown, fallback: number, path: string): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`lens ${path} must be a finite number`);
    return v;
  };
  // Profile toggle is additive: a sidecar with no `profile` key (every
  // pre-F3b sidecar) sanitizes to enabled:false, leaving its render unchanged.
  const rawProfile = src.profile;
  let profile: LensProfileState = { enabled: false };
  if (rawProfile !== undefined) {
    if (typeof rawProfile !== 'object' || rawProfile === null) {
      throw new Error(`${nodeId}.lens.profile must be an object`);
    }
    const enabled = (rawProfile as { enabled?: unknown }).enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error(`${nodeId}.lens.profile.enabled must be a boolean`);
    }
    profile = { enabled: enabled === true };
  }
  return clampLens({
    distortion: num(src.distortion, base.distortion, `${nodeId}.lens.distortion`),
    caRed: num(src.caRed, base.caRed, `${nodeId}.lens.caRed`),
    caBlue: num(src.caBlue, base.caBlue, `${nodeId}.lens.caBlue`),
    vignette: num(src.vignette, base.vignette, `${nodeId}.lens.vignette`),
    profile,
  });
}

/** Wrapper-level keys `serializeGraphDoc`/`parseGraphDoc` know about; anything else round-trips verbatim (DESIGN §9). */
const KNOWN_WRAPPER_KEYS = new Set(['schemaVersion', 'source', 'createdAt', 'updatedAt', 'graph']);
/** Node-level keys the schema knows about; anything else round-trips verbatim per node. */
const KNOWN_NODE_KEYS = new Set([
  'id',
  'kind',
  'position',
  'params',
  'develop',
  'shader',
  'geometry',
  'lens',
  'mask',
  'spots',
  'name',
  'export',
]);
/** Edge-level keys the schema knows about; anything else round-trips verbatim per edge. */
const KNOWN_EDGE_KEYS = new Set(['id', 'source', 'target', 'targetHandle']);

/**
 * Serialize for the sidecar (spec §3): a schemaVersion-3 wrapper with the
 * source block and timestamps around the graph. Nodes serialize their kind
 * as `type` and edges as from/to — the spec's field names; an edge's
 * internal `targetHandle` port serializes as `port` (schema v3's formalized
 * port concept — see GraphEdge's doc comment). Unrecognized keys on the
 * wrapper/nodes/edges (`unknownWrapperFields` + whatever extra properties
 * ride along on a parsed node/edge object — see parseGraphDoc) are written
 * back verbatim, with known keys winning on conflict (DESIGN §9). Pretty-
 * printed and newline-terminated for git.
 */
export function serializeGraphDoc(
  doc: GraphDoc,
  source: SidecarSource | null,
  createdAt: string | null,
  unknownWrapperFields?: Record<string, unknown>
): string {
  const now = new Date().toISOString();
  const wrapper = {
    ...(unknownWrapperFields ?? {}),
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    ...(source ? { source } : {}),
    createdAt: createdAt ?? now,
    updatedAt: now,
    graph: {
      nodes: doc.nodes.map((n) => {
        const rec = n as unknown as Record<string, unknown>;
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (!KNOWN_NODE_KEYS.has(k) && v !== undefined) extra[k] = v;
        }
        return {
          ...extra,
          id: n.id,
          type: n.kind,
          position: n.position,
          ...(n.params ? { params: n.params } : {}),
          ...(n.develop ? { develop: n.develop } : {}),
          ...(n.shader ? { shader: n.shader } : {}),
          ...(n.geometry ? { geometry: n.geometry } : {}),
          ...(n.lens ? { lens: n.lens } : {}),
          ...(n.mask ? { mask: n.mask } : {}),
          ...(n.spots ? { spots: n.spots } : {}),
          ...(n.name !== undefined ? { name: n.name } : {}),
          ...(n.export ? { export: n.export } : {}),
        };
      }),
      edges: doc.edges.map((e) => {
        const rec = e as unknown as Record<string, unknown>;
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (!KNOWN_EDGE_KEYS.has(k) && v !== undefined) extra[k] = v;
        }
        return {
          ...extra,
          id: e.id,
          from: e.source,
          to: e.target,
          ...(e.targetHandle ? { port: e.targetHandle } : {}),
        };
      }),
    },
  };
  return JSON.stringify(wrapper, null, 2) + '\n';
}

/**
 * Parse + validate a sidecar; throws with a reason on anything malformed.
 * Accepts schemaVersion 2 (today's shape: edges carry `targetHandle` directly,
 * no `mask` kind, no output `name`), 3 (edges carry `port`, formalizing the
 * same concept), and 4 (mask/spot coords stored in ANCHOR space — see
 * anchorSpace.ts). A v2 sidecar loads byte-semantically identically to before
 * v3 existed. Unrecognized keys on the wrapper and on each node/edge are
 * preserved (as extra untyped properties riding along on the parsed objects,
 * or on the returned SidecarDoc's `unknown` for the wrapper) so
 * serializeGraphDoc can write them back verbatim (DESIGN §9).
 *
 * Coordinate migration (v2/v3 → anchor space): pre-v4 docs stored mask/spot
 * coords in the OLD post-geometry OUTPUT frame; they are converted to anchor
 * space here using the doc's OWN input-node geometry (identity geometry ⇒
 * no-op, so the overwhelming-majority untouched-geometry doc is unchanged).
 * The conversion needs the oriented-frame aspect, supplied by the caller as
 * `srcDims` (the decoded image's dims — appStore has them by open time). When
 * `srcDims` is omitted AND geometry is non-identity the coords are left as-is
 * (only reached by dimensionless callers — preset embedding, internal
 * validation — which carry identity geometry).
 */
export function parseGraphDoc(text: string, srcDims?: { width: number; height: number }): SidecarDoc {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('graph doc must be an object');
  const wrapper = raw as {
    schemaVersion?: unknown;
    source?: SidecarSource;
    createdAt?: unknown;
    graph?: { nodes?: unknown; edges?: unknown };
  };
  const version = wrapper.schemaVersion;
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`unsupported sidecar schemaVersion ${String(version)}`);
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
    edges: rawEdges.map((e: Record<string, unknown>) => {
      // v2 read the port straight off `targetHandle`; v3+ (v3 and v4)
      // formalize it as `port` — either way it lands on the internal
      // `targetHandle` field.
      const portRaw = version === 2 ? e.targetHandle : e.port;
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e)) {
        if (k !== 'id' && k !== 'from' && k !== 'to' && k !== 'targetHandle' && k !== 'port') extra[k] = v;
      }
      return {
        ...extra,
        id: e.id,
        source: e.from,
        target: e.to,
        ...(portRaw !== undefined ? { targetHandle: portRaw } : {}),
      };
    }) as unknown as GraphEdge[],
  };
  doc.nodes.forEach((n, i) => {
    if (typeof n.id !== 'string') throw new Error('node id must be a string');
    if (
      n.kind !== 'input' &&
      n.kind !== 'output' &&
      n.kind !== CUSTOM_KIND &&
      n.kind !== BLEND_KIND &&
      n.kind !== DEVELOP_KIND &&
      n.kind !== MASK_KIND &&
      n.kind !== SPOTS_KIND &&
      !isOpKind(n.kind)
    ) {
      throw new Error(`unknown node kind ${String(n.kind)}`);
    }
    if (typeof n.position?.x !== 'number' || typeof n.position?.y !== 'number') {
      // position is layout-only and optional — hand-written docs fall back
      // to a simple chain layout
      n.position = { x: 40 + 220 * i, y: 60 };
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
    if (n.kind === 'input') {
      n.geometry = sanitizeGeometry(n.geometry, n.id);
      n.lens = sanitizeLens(n.lens, n.id);
    }
    if (n.kind === MASK_KIND) {
      n.mask = sanitizeMaskParams(n.mask, n.id);
    }
    if (n.kind === SPOTS_KIND) {
      n.spots = sanitizeSpotsParams(n.spots, n.id);
    }
    if (n.kind === 'output') {
      n.name = typeof n.name === 'string' && n.name.trim() !== '' ? n.name : undefined;
      const exportOverrides = sanitizeExportOverrides(n.export, n.id);
      n.export = Object.keys(exportOverrides).length > 0 ? exportOverrides : undefined;
    }
  });
  for (const e of doc.edges) {
    if (typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') {
      throw new Error('edges need string id/source/target');
    }
    if (
      e.targetHandle !== undefined &&
      e.targetHandle !== 'a' &&
      e.targetHandle !== 'b' &&
      e.targetHandle !== 'mask'
    ) {
      throw new Error(`edge ${e.id} has an invalid targetHandle`);
    }
  }
  // pre-v4 mask/spot coords are in the OLD post-geometry OUTPUT frame — bring
  // them into anchor space now, before validation/return (see this function's
  // doc comment). Identity geometry (the common case) makes this a no-op.
  if (version !== 4) migrateCoordsToAnchor(doc, srcDims);

  // every output resolves through a valid DAG (buildPlan is pure/side-effect-free — see its doc comment)
  const outputNodes = doc.nodes.filter((n) => n.kind === 'output');
  if (outputNodes.length === 0) throw new Error('graph has no output node');
  for (const out of outputNodes) buildPlan(doc, { outputId: out.id });

  const unknownWrapper: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wrapper as Record<string, unknown>)) {
    if (!KNOWN_WRAPPER_KEYS.has(k)) unknownWrapper[k] = v;
  }
  return {
    graph: doc,
    ...(wrapper.source ? { source: wrapper.source } : {}),
    ...(typeof wrapper.createdAt === 'string' ? { createdAt: wrapper.createdAt } : {}),
    ...(Object.keys(unknownWrapper).length > 0 ? { unknown: unknownWrapper } : {}),
  };
}

/**
 * In-place migrate a pre-v4 doc's mask/spot coords from the OLD post-geometry
 * OUTPUT frame into anchor space (see parseGraphDoc's doc comment). No-op when
 * the input node's geometry is identity, or when `srcDims` is missing and the
 * geometry is non-identity (can't convert without the oriented aspect).
 */
function migrateCoordsToAnchor(doc: GraphDoc, srcDims?: { width: number; height: number }): void {
  const inputNode = doc.nodes.find((n) => n.kind === 'input');
  const geometry = inputNode?.geometry ?? defaultGeometryParams();
  if (isIdentityGeometry(geometry) || !srcDims) return;
  const oriented = orientedDims(srcDims.width, srcDims.height, geometry.orientation ?? defaultGeometryOrientation());
  for (const n of doc.nodes) {
    if (n.kind === MASK_KIND && n.mask) {
      n.mask = { shapes: n.mask.shapes.map((s) => maskShapeOutputToAnchor(s, geometry, oriented.width, oriented.height)) };
    } else if (n.kind === SPOTS_KIND && n.spots) {
      n.spots = { spots: n.spots.spots.map((s) => spotOutputToAnchor(s, geometry, oriented.width, oriented.height)) };
    }
  }
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
  for (const ch of ['rgb', 'r', 'g', 'b'] as const) {
    const sanitized = sanitizeCurvePoints(base.toneCurve[ch]);
    if (!sanitized) throw new Error(`develop toneCurve.${ch} is invalid`);
    base.toneCurve[ch] = sanitized;
  }
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
  | {
      nodeId: string;
      type: 'passes';
      passes: PassSpec[];
      src: number;
      /** (px, x, y, width, height) — x/y are the render target's integer texel coords. */
      cpu: ((px: Rgb, x: number, y: number, width: number, height: number) => Rgb) | null;
    }
  | {
      nodeId: string;
      type: 'blend';
      uniform: Vec4;
      srcA: number;
      srcB: number;
      /** Optional mask input (spec §3): out = mix(a, b, maskValue.r * uniform.amount) when present. */
      srcMask?: number;
    };

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
  /**
   * Every node id's OWN resolved step index (-1 = the raw/geometry-resampled
   * source), for every node reachable from whichever id `output` above was
   * resolved from (per-node-preview pack, tier 1: node thumbnails). An
   * identity/bypassed node (default-valued op, unconnected mask, a blend at
   * amount 0…) maps to the SAME index as its upstream ancestor — buildPlan's
   * `resolve()` returns that ancestor's index for it rather than pushing a
   * new step — so GraphRenderer.thumbnails() naturally renders the identical
   * texture for both, which IS "show the upstream thumb" with no special
   * casing. A node NOT reachable from the resolved output (a disconnected
   * branch) has no entry at all — the UI shows a placeholder for those.
   */
  nodeSteps: Record<string, number>;
  /**
   * Present only when the input node's geometry is non-identity (crop and/or
   * straighten). When present, the renderer resamples the source into a BASE
   * texture of dims (round(crop.w*srcW), round(crop.h*srcH)) before running
   * `steps` — absent means zero added cost, bit-exact pass-through.
   */
  geometry?: { angleRad: number; crop: GeometryCrop; orientation: GeometryOrientation };
  /**
   * Present only when the input node's lens corrections are non-identity.
   * Folded into the SAME resample pass as `geometry` (one resample, not two)
   * — absent means zero added cost, same rule as geometry.
   */
  lens?: LensParams;
}

/** Per-compile context: the image's WB model + render/full resolution ratio. */
export interface CompileContext {
  /** Defaults to DEFAULT_WB_MODEL when omitted (e.g. parseGraphDoc's own internal validation calls). */
  wb?: WbModel;
  /** renderLongEdge / fullLongEdge (≤1 preview, 1 export); scales Detail kernels. */
  renderScale?: number;
  /**
   * Selects which output node to resolve when the doc has more than one
   * (named-outputs, spec §6) — matched against a node's `id`. Default (or no
   * match) = the doc's first output node, in `doc.nodes` array order.
   */
  outputId?: string;
  /**
   * Decoded image dims (pre-orientation), used ONLY to convert anchor-space
   * mask/spot coords into the output frame the passes evaluate in (see
   * anchorSpace.ts). Omitted (validation / LUT paths) ⇒ no conversion, which
   * is correct there because those paths carry identity geometry (the map is
   * the identity anyway).
   */
  srcWidth?: number;
  srcHeight?: number;
  /**
   * Inspect mode (per-node-preview pack, tier 2): render THIS node's own
   * output instead of the selected output node's — "up to node X" is exactly
   * the step index `resolve(id)` returns, so the rest of buildPlan is
   * unchanged; anything downstream of the inspected node is simply never
   * visited. Falls back to the normal output resolution when the id doesn't
   * name a node in `doc` (e.g. the inspected node was deleted mid-flight —
   * the caller is expected to clear inspection itself, but a stale id must
   * never throw).
   */
  inspectNodeId?: string;
}

/**
 * Compile the GraphDoc into an execution plan by resolving the output node's
 * ancestry. The graph is a DAG: ops and custom nodes take one input, blend
 * takes two or three ('a'/'b'/optional 'mask' handles), anything may fan
 * out. Nodes not reachable from the SELECTED output are allowed but simply
 * not executed. Throws on cycles, missing connections, or unknown kinds.
 */
export function buildPlan(doc: GraphDoc, ctx?: CompileContext): RenderPlan {
  const wb = ctx?.wb ?? DEFAULT_WB_MODEL;
  const renderScale = ctx?.renderScale ?? 1;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of doc.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  const outputs = doc.nodes.filter((n) => n.kind === 'output');
  if (outputs.length === 0) throw new Error('graph has no output node');
  const output = (ctx?.outputId !== undefined && outputs.find((n) => n.id === ctx.outputId)) || outputs[0]!;
  const inputNode = doc.nodes.find((n) => n.kind === 'input');
  if (!inputNode) throw new Error('graph has no input node');

  // Anchor→output conversion context (see anchorSpace.ts): mask/spot coords
  // are STORED in anchor space but the passes evaluate in the output frame, so
  // convert when we pack their uniforms + build their CPU mirrors below. When
  // the geometry map is the identity (untouched geometry) OR we weren't given
  // the source dims, the shapes pass through unchanged — bit-exact.
  const geometry = inputNode.geometry ?? defaultGeometryParams();
  const orientedForAnchor =
    ctx?.srcWidth !== undefined && ctx?.srcHeight !== undefined && !isIdentityGeometry(geometry)
      ? orientedDims(ctx.srcWidth, ctx.srcHeight, geometry.orientation ?? defaultGeometryOrientation())
      : null;
  const toOutputMaskShape = (shape: MaskShape) =>
    orientedForAnchor ? maskShapeAnchorToOutput(shape, geometry, orientedForAnchor.width, orientedForAnchor.height) : shape;
  const toOutputSpot = (spot: Spot) =>
    orientedForAnchor ? spotAnchorToOutput(spot, geometry, orientedForAnchor.width, orientedForAnchor.height) : spot;

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
      const emask = ins.find((e) => e.targetHandle === 'mask');
      const expectedCount = emask ? 3 : 2;
      if (!ea || !eb || ins.length !== expectedCount) throw new Error(`blend ${id} needs exactly inputs a and b`);
      const srcA = resolve(ea.source);
      const srcB = resolve(eb.source);
      const srcMask = emask ? resolve(emask.source) : undefined;
      const uniform = packBlendUniform(node.params ?? {});
      if (uniform[0] === 0) {
        // amount 0 = pure input a — identity, no step (mix(a,b,mask*0)=a regardless of the mask)
        index = srcA;
      } else {
        steps.push({ nodeId: id, type: 'blend', uniform, srcA, srcB, ...(srcMask !== undefined ? { srcMask } : {}) });
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
        const compiled = compileDevelop(params, wbGains, renderScale);
        if (compiled.passes.length === 0) {
          index = src; // untouched Develop = bit-exact pass-through
        } else {
          steps.push({ nodeId: id, type: 'passes', passes: compiled.passes, src, cpu: compiled.cpu });
          index = steps.length - 1;
        }
      } else if (node.kind === MASK_KIND) {
        // Analytic per-pixel mask (masks milestone): NO identity skip — a
        // mask node always produces its mask when it's part of the resolved
        // DAG. An UNCONNECTED mask node never affects any render simply
        // because it's never reached by `resolve()` in the first place (same
        // "not reachable from output = not executed" rule every other node
        // kind gets — see this function's doc comment). The node's own
        // input (`src`) is read only for frame-size context by the shader/
        // CPU mirror; its color is ignored entirely.
        const shapes = node.mask?.shapes ?? defaultMaskParams().shapes;
        // Convert the STORED anchor-space shape into the output frame the pass
        // evaluates in; the GPU uniform AND the CPU mirror both use this same
        // converted shape, so the GPU/CPU parity check stays green untouched.
        const shape = toOutputMaskShape(shapes[0] ?? defaultMaskParams().shapes[0]!);
        steps.push({
          nodeId: id,
          type: 'passes',
          passes: [{ shaderId: 'mask/analytic', wgsl: MASK_WGSL, uniforms: packMaskUniform(shape).buffer as ArrayBuffer }],
          src,
          cpu: (px, x, y, w, h) => cpuMaskShape(shape, px, x, y, w, h),
        });
        index = steps.length - 1;
      } else if (node.kind === SPOTS_KIND) {
        // Spot removal (task #50): empty list = bit-exact pass-through, same
        // "identity params ⇒ pass not emitted" invariant every other node
        // kind upholds. Once any spot is present the pass is SPATIAL (it
        // samples the input texture at an offset position, not just this
        // pixel) — cpu: null, same mechanism Detail/custom shaders use, and
        // planHasCpuReference (below) picks that up automatically.
        const spotsParams = node.spots ?? defaultSpotsParams();
        if (spotsParams.spots.length === 0) {
          index = src;
        } else {
          // Stored in anchor space; convert each spot into the output frame the
          // pass evaluates in (see the mask branch above / anchorSpace.ts).
          const outSpots = spotsParams.spots.map(toOutputSpot);
          steps.push({
            nodeId: id,
            type: 'passes',
            passes: [
              { shaderId: 'spots/clone', wgsl: SPOTS_WGSL, uniforms: packSpotsUniform(outSpots).buffer as ArrayBuffer },
            ],
            src,
            cpu: null,
          });
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

  // Inspect mode (per-node-preview pack, tier 2): resolve the inspected
  // node's OWN id instead of the selected output's — see CompileContext's
  // inspectNodeId doc comment. Anything downstream of it is simply never
  // reached by resolve(), which is exactly "render up to node X".
  const targetId = ctx?.inspectNodeId !== undefined && byId.has(ctx.inspectNodeId) ? ctx.inspectNodeId : output.id;
  const plan: RenderPlan = { steps, output: resolve(targetId), nodeSteps: Object.fromEntries(memo) };
  if (!isIdentityGeometry(geometry)) {
    plan.geometry = {
      angleRad: (geometry.angle * Math.PI) / 180,
      crop: geometry.crop,
      orientation: geometry.orientation ?? defaultGeometryOrientation(),
    };
  }
  const lens = inputNode.lens ?? defaultLensParams();
  // Emit plan.lens when the MANUAL fields are non-identity OR the embedded
  // profile is toggled on. Whether the profile actually does work (the image
  // must carry splines) is the renderer's call — see GraphRenderer; a
  // profile-on doc opened against a JPEG/non-Sony image resamples to nothing
  // and the renderer skips the pass, preserving the bit-exact invariant.
  if (!isIdentityLens(lens) || lens.profile?.enabled) {
    plan.lens = lens;
  }
  return plan;
}

/**
 * CPU reference for one pixel; caller must ensure every step has a mirror.
 * `x`/`y` are the render target's integer texel coords, `width`/`height` its
 * dimensions — passed through to each step's cpu mirror for position-aware
 * ops (vignette, grain); every other mirror simply ignores them.
 */
export function cpuEvalPlan(plan: RenderPlan, px: Rgb, x: number, y: number, width: number, height: number): Rgb {
  const outputs: Rgb[] = [];
  const at = (i: number) => (i < 0 ? px : outputs[i]!);
  for (const step of plan.steps) {
    if (step.type === 'passes') {
      if (!step.cpu) throw new Error(`step ${step.nodeId} has no CPU reference`);
      outputs.push(step.cpu(at(step.src), x, y, width, height));
    } else {
      const a = at(step.srcA);
      const b = at(step.srcB);
      // out = mix(a, b, maskValue.r * factor) when a mask is connected
      // (factor = the blend's own uniform, now acting as an adjustment
      // strength); exactly today's mix(a,b,amount) otherwise.
      const t =
        step.srcMask !== undefined ? Math.min(Math.max(at(step.srcMask)[0] * step.uniform[0], 0), 1) : step.uniform[0];
      outputs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return at(plan.output);
}

/**
 * True when every step in the plan has a CPU mirror (geometry/lens have none
 * — like spatial ops). Analytic masks always carry a CPU mirror (see
 * buildPlan's mask branch), so a masked blend keeps the CPU reference alive
 * exactly like an unmasked one.
 */
export function planHasCpuReference(plan: RenderPlan): boolean {
  if (plan.geometry || plan.lens) return false;
  return plan.steps.every((s) => s.type !== 'passes' || s.cpu !== null);
}
