/**
 * Sidecar visual diff — "code review for looks" (git-native completion brief
 * §1). `diffLook` is the load-bearing pure function: walk two PARSED sidecars
 * (SidecarDoc — the graph plus its wrapper rating) and emit human-readable,
 * param-language diff lines. No DOM/Electron/GPU dependency, so it runs
 * identically from the hot-reload notice's "Show diff" dialog (renderer),
 * the CLI's `--diff` (also the renderer process — see appStore.ts's
 * runCliDiff), and this file's own unit tests. The VISUAL half (rendering
 * both docs and reporting ΔE) rides the existing compare/CLI render
 * machinery elsewhere; this module only ever compares JSON structure.
 *
 * Both docs should already be `parseGraphDoc`'d (with `srcDims` supplied
 * when available) BEFORE reaching here — exactly what the hot-reload path's
 * `readAndParseSidecar` and the CLI's `--diff` both already do, so a v2/v3
 * sidecar's old-frame mask/spot coordinates are migrated to anchor space the
 * same way a real load would, and `develop`/`mask`/`spots`/etc. are already
 * filled to their sanitized shape (no more `undefined` sections to guard
 * against beyond simple optional chaining).
 *
 * Design choices (documented once, here, rather than re-litigated per field):
 *  - Nodes are matched by id (not position/order) — the same id in both docs
 *    is "the same node". A's nodes are walked in A's own order (matched pairs
 *    diffed in place, unmatched ones reported "removed"); nodes that exist
 *    only in B are reported "added", in B's order — together this reads like
 *    the chain order a hand-authored doc is already written in.
 *  - Every reported number carries an explicit sign (+/-, or bare `0`),
 *    uniformly — deliberately NOT special-cased per field into "signed
 *    deltas" (EV, contrast, hue offsets) vs "absolute positions" (Kelvin,
 *    normalized mask coordinates, curve point values): one rule, exhaustively
 *    testable, never inconsistent, at the minor cost of e.g. `+5600` reading
 *    a little oddly for an absolute Kelvin value.
 *  - Curves (ToneCurveParams) are NEVER dumped as point lists — a channel
 *    that changed is summarized by evaluating its curve function at the
 *    domain's p25/p50/p75 (63.75/127.5/191.25 on the 0..255 axis), before vs
 *    after. This is intentionally lossy: a hand-edit confined between the
 *    three sampled quantiles (e.g. a tweak purely in the deep shadows corner)
 *    can be invisible to this summary — an accepted tradeoff for "summarize,
 *    don't dump points" per the brief.
 *  - Edges are matched by (source, target, port) SIGNATURE, not by edge id
 *    (an edge id is as arbitrary/internal as a node id is meaningful) — an
 *    added/removed WIRE is reported, not id churn.
 *  - Node-kind MISMATCH at the same id (rare — an id reused for a different
 *    kind of node) is reported as a single "replaced" line rather than
 *    silently skipped or partially diffed.
 */
import {
  DEVELOP_KIND,
  outputName,
  type ExportOverrides,
  type GraphEdge,
  type GraphNode,
  type SidecarDoc,
} from '../graph/graphDoc';
import {
  GRADING_REGIONS,
  HSL_BANDS,
  type CurvePoints,
  type DevelopBasicParams,
  type DevelopParams,
  type EffectsParams,
} from '../graph/developNode';
import { curveEvaluator } from '../color/toneCurve';
import { MASK_KIND, type MaskShape } from '../graph/maskNode';
import { SPOTS_KIND, type Spot } from '../graph/spotsNode';
import { IMAGE_KIND } from '../graph/imageNode';
import { EXTERNAL_KIND } from '../graph/externalNode';
import type { CustomShaderParams } from '../graph/customShaderNode';
import { BLEND_KIND, BLEND_PARAM_DEFS, CUSTOM_KIND, isOpKind, OPS, type OpParamDef } from '../graph/ops';

// --- formatting ---------------------------------------------------------------

/**
 * Every reported number gets an explicit sign (or bare `0`) — see the file
 * doc comment's "uniform sign" rule. Rounds to 3 decimals first to kill float
 * noise (e.g. an EV of 0.3 landing on disk as 0.30000000000000004) and trims
 * the result to its shortest exact form.
 */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const rounded = Math.round(v * 1000) / 1000;
  if (rounded === 0) return '0'; // also catches -0
  const abs = Math.abs(rounded)
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  return rounded > 0 ? `+${abs}` : `-${abs}`;
}

function fmtBool(v: boolean): string {
  return v ? 'on' : 'off';
}

function fmtRating(r: number): string {
  return r === 0 ? 'unrated' : String(r);
}

function numPush(out: string[], label: string, a: number, b: number): void {
  if (a === b) return;
  out.push(`${label} ${fmtNum(a)} → ${fmtNum(b)}`);
}

function boolPush(out: string[], label: string, a: boolean, b: boolean): void {
  if (a === b) return;
  out.push(`${label} ${fmtBool(a)} → ${fmtBool(b)}`);
}

function strPush(out: string[], label: string, a: string, b: string): void {
  if (a === b) return;
  out.push(`${label} ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
}

// --- curves ---------------------------------------------------------------

/** p25/p50/p75 of the curve's own 0..255 domain (LR-style display units) — see the file doc comment. */
const CURVE_QUANTILES: [string, number][] = [
  ['p25', 63.75],
  ['p50', 127.5],
  ['p75', 191.25],
];

function diffCurve(out: string[], id: string, channel: 'rgb' | 'r' | 'g' | 'b', a: CurvePoints, b: CurvePoints): void {
  const evalA = curveEvaluator(a);
  const evalB = curveEvaluator(b);
  // Decide "changed" off the EVALUATED quantiles, not the raw point arrays:
  // two different point lists tracing the exact same line (e.g. an extra
  // collinear point) must not be reported as a change.
  const samples = CURVE_QUANTILES.map(([label, x]) => ({ label, av: evalA(x), bv: evalB(x) }));
  if (samples.every((s) => fmtNum(s.av) === fmtNum(s.bv))) return;
  const parts = samples.map((s) => `${s.label} ${fmtNum(s.av)}→${fmtNum(s.bv)}`);
  out.push(`${id}: toneCurve.${channel}  ${parts.join('  ')}`);
}

// --- Develop ----------------------------------------------------------------

const BASIC_KEYS: (keyof DevelopBasicParams)[] = [
  'temp',
  'tint',
  'ev',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'saturation',
  'vibrance',
];

const EFFECTS_KEYS: (keyof EffectsParams)[] = [
  'dehaze',
  'clarity',
  'texture',
  'grain',
  'grainSize',
  'vignette',
  'vignetteMidpoint',
];

function diffDevelop(out: string[], id: string, a: DevelopParams, b: DevelopParams): void {
  for (const k of BASIC_KEYS) numPush(out, `${id}: basic.${k}`, a.basic[k], b.basic[k]);

  diffCurve(out, id, 'rgb', a.toneCurve.rgb, b.toneCurve.rgb);
  diffCurve(out, id, 'r', a.toneCurve.r, b.toneCurve.r);
  diffCurve(out, id, 'g', a.toneCurve.g, b.toneCurve.g);
  diffCurve(out, id, 'b', a.toneCurve.b, b.toneCurve.b);

  for (const band of HSL_BANDS) {
    const av = a.hsl[band];
    const bv = b.hsl[band];
    numPush(out, `${id}: hsl.${band}.h`, av.h, bv.h);
    numPush(out, `${id}: hsl.${band}.s`, av.s, bv.s);
    numPush(out, `${id}: hsl.${band}.l`, av.l, bv.l);
  }

  for (const region of GRADING_REGIONS) {
    const av = a.grading[region];
    const bv = b.grading[region];
    numPush(out, `${id}: grading.${region}.hue`, av.hue, bv.hue);
    numPush(out, `${id}: grading.${region}.sat`, av.sat, bv.sat);
    numPush(out, `${id}: grading.${region}.lum`, av.lum, bv.lum);
  }
  numPush(out, `${id}: grading.blending`, a.grading.blending, b.grading.blending);
  numPush(out, `${id}: grading.balance`, a.grading.balance, b.grading.balance);

  numPush(out, `${id}: detail.sharpen.amount`, a.detail.sharpen.amount, b.detail.sharpen.amount);
  numPush(out, `${id}: detail.sharpen.radius`, a.detail.sharpen.radius, b.detail.sharpen.radius);
  numPush(out, `${id}: detail.sharpen.masking`, a.detail.sharpen.masking, b.detail.sharpen.masking);
  numPush(out, `${id}: detail.noiseLuminance.amount`, a.detail.noiseLuminance.amount, b.detail.noiseLuminance.amount);
  numPush(out, `${id}: detail.noiseLuminance.detail`, a.detail.noiseLuminance.detail, b.detail.noiseLuminance.detail);
  numPush(out, `${id}: detail.noiseLuminance.contrast`, a.detail.noiseLuminance.contrast, b.detail.noiseLuminance.contrast);
  numPush(out, `${id}: detail.noiseColor.amount`, a.detail.noiseColor.amount, b.detail.noiseColor.amount);
  numPush(out, `${id}: detail.noiseColor.detail`, a.detail.noiseColor.detail, b.detail.noiseColor.detail);
  numPush(out, `${id}: detail.noiseColor.smoothness`, a.detail.noiseColor.smoothness, b.detail.noiseColor.smoothness);

  for (const k of EFFECTS_KEYS) numPush(out, `${id}: effects.${k}`, a.effects[k], b.effects[k]);
}

// --- input (geometry + lens) -------------------------------------------------

function diffGeometry(out: string[], id: string, a: GraphNode['geometry'], b: GraphNode['geometry']): void {
  if (!a || !b) return;
  numPush(out, `${id}: geometry.crop.x`, a.crop.x, b.crop.x);
  numPush(out, `${id}: geometry.crop.y`, a.crop.y, b.crop.y);
  numPush(out, `${id}: geometry.crop.w`, a.crop.w, b.crop.w);
  numPush(out, `${id}: geometry.crop.h`, a.crop.h, b.crop.h);
  numPush(out, `${id}: geometry.angle`, a.angle, b.angle);
  numPush(out, `${id}: geometry.orientation.quarterTurns`, a.orientation.quarterTurns, b.orientation.quarterTurns);
  boolPush(out, `${id}: geometry.orientation.flipH`, a.orientation.flipH, b.orientation.flipH);
}

function diffLens(out: string[], id: string, a: GraphNode['lens'], b: GraphNode['lens']): void {
  if (!a || !b) return;
  numPush(out, `${id}: lens.distortion`, a.distortion, b.distortion);
  numPush(out, `${id}: lens.caRed`, a.caRed, b.caRed);
  numPush(out, `${id}: lens.caBlue`, a.caBlue, b.caBlue);
  numPush(out, `${id}: lens.vignette`, a.vignette, b.vignette);
  boolPush(out, `${id}: lens.profile`, a.profile?.enabled ?? false, b.profile?.enabled ?? false);
}

// --- mask --------------------------------------------------------------------

/** [key, value] pairs for one shape's own fields, in a fixed per-type order — shared by both sides of a comparison. */
function shapeFieldsOf(s: MaskShape): [string, number | boolean][] {
  switch (s.type) {
    case 'radial':
      return [
        ['cx', s.cx],
        ['cy', s.cy],
        ['radius', s.radius],
        ['feather', s.feather],
        ['invert', s.invert],
      ];
    case 'linear':
      return [
        ['x0', s.x0],
        ['y0', s.y0],
        ['x1', s.x1],
        ['y1', s.y1],
        ['feather', s.feather],
        ['invert', s.invert],
      ];
    case 'colorKey':
      return [
        ['hue', s.hue],
        ['hueRange', s.hueRange],
        ['sat', s.sat],
        ['satRange', s.satRange],
        ['lum', s.lum],
        ['lumRange', s.lumRange],
        ['softness', s.softness],
        ['invert', s.invert],
      ];
  }
}

function diffMask(out: string[], id: string, a: MaskShape[], b: MaskShape[]): void {
  if (a.length !== b.length) out.push(`${id}: shapes ${a.length} → ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i]!;
    const sb = b[i]!;
    if (sa.type !== sb.type) {
      out.push(`${id}: shapes[${i}] ${sa.type} → ${sb.type}`);
      continue;
    }
    const fa = shapeFieldsOf(sa);
    const fb = shapeFieldsOf(sb);
    for (let f = 0; f < fa.length; f++) {
      const [key, av] = fa[f]!;
      const [, bv] = fb[f]!;
      if (typeof av === 'boolean' || typeof bv === 'boolean') {
        boolPush(out, `${id}: shapes[${i}].${key}`, av as boolean, bv as boolean);
      } else {
        numPush(out, `${id}: shapes[${i}].${key}`, av as number, bv as number);
      }
    }
  }
}

// --- spots -------------------------------------------------------------------

/**
 * Spots have no stable identity across an edit (no id per circle) — like the
 * brief's own "spots: 3 → 5" example, only the COUNT is reported precisely;
 * a same-count edit (a circle nudged or resized) collapses to one summary
 * line rather than a point-by-point dump, same spirit as the curve summary.
 */
function diffSpots(out: string[], id: string, a: Spot[], b: Spot[]): void {
  if (a.length !== b.length) {
    out.push(`${id}: spots ${a.length} → ${b.length}`);
    return;
  }
  const changed = a.some((s, i) => {
    const t = b[i]!;
    return s.dx !== t.dx || s.dy !== t.dy || s.sx !== t.sx || s.sy !== t.sy || s.radius !== t.radius || s.feather !== t.feather;
  });
  if (changed) out.push(`${id}: spots edited (same count, positions/radius changed)`);
}

// --- custom shader ------------------------------------------------------------

function diffCustomShader(out: string[], id: string, a?: CustomShaderParams, b?: CustomShaderParams): void {
  if (!a || !b) return;
  if (a.code.lastValidSrc !== b.code.lastValidSrc) {
    const aLines = a.code.lastValidSrc.split('\n').length;
    const bLines = b.code.lastValidSrc.split('\n').length;
    out.push(`${id}: shader code changed (${aLines} → ${bLines} lines)`);
  }
  const aByName = new Map(a.params.map((p) => [p.name, p]));
  const bByName = new Map(b.params.map((p) => [p.name, p]));
  for (const [name, ap] of aByName) {
    const bp = bByName.get(name);
    if (!bp) {
      out.push(`${id}: shader param removed ${name}`);
      continue;
    }
    numPush(out, `${id}: shader.${name}`, ap.value, bp.value);
  }
  for (const name of bByName.keys()) {
    if (!aByName.has(name)) out.push(`${id}: shader param added ${name}`);
  }
}

// --- output --------------------------------------------------------------

function fmtExportVal(v: ExportOverrides[keyof ExportOverrides]): string {
  if (v === undefined) return 'inherit';
  if (v === null) return 'full-res';
  return String(v);
}

function diffOutput(out: string[], id: string, a: GraphNode, b: GraphNode): void {
  strPush(out, `${id}: name`, outputName(a), outputName(b));
  const ea = a.export ?? {};
  const eb = b.export ?? {};
  const keys: (keyof ExportOverrides)[] = ['quality', 'maxDim', 'metadata', 'colorSpace'];
  for (const k of keys) {
    const av = ea[k];
    const bv = eb[k];
    if (av === bv) continue;
    out.push(`${id}: export.${k} ${fmtExportVal(av)} → ${fmtExportVal(bv)}`);
  }
}

// --- op-kind / blend (flat Record<string, number> params) --------------------

function diffParamDefs(out: string[], id: string, defs: OpParamDef[], a: Record<string, number>, b: Record<string, number>): void {
  for (const def of defs) {
    const av = a[def.key] ?? def.default;
    const bv = b[def.key] ?? def.default;
    numPush(out, `${id}: ${def.key}`, av, bv);
  }
}

// --- node dispatch -------------------------------------------------------------

/** Short kind description for "replaced" lines (a node id that changed KIND) — always pairs the kind name with whatever detail it has (mask/spots/output), so both sides of the arrow read as "kind (detail)". */
function describeNodeKind(n: GraphNode): string {
  if (n.kind === MASK_KIND) {
    const shapes = n.mask?.shapes ?? [];
    return shapes.length === 1 ? `mask (${shapes[0]!.type})` : `mask (${shapes.length} shapes)`;
  }
  if (n.kind === SPOTS_KIND) return `spots (${n.spots?.spots.length ?? 0})`;
  if (n.kind === IMAGE_KIND) return 'image';
  if (n.kind === 'output') return `output (${outputName(n)})`;
  if (n.kind === DEVELOP_KIND) return 'Develop';
  if (n.kind === BLEND_KIND) return 'blend';
  if (n.kind === CUSTOM_KIND) return 'custom';
  if (n.kind === EXTERNAL_KIND) return 'external';
  if (n.kind === 'input') return 'input';
  if (isOpKind(n.kind)) return OPS[n.kind].label.toLowerCase();
  return n.kind;
}

/**
 * Parenthetical for "added"/"removed" lines — `${id} (${describeAddedDetail(n)})`.
 * Matches the brief's own "added: mask-2 (radial) + blend-2" grammar: a mask
 * node's detail is its SHAPE TYPE alone (the word "mask" would be redundant
 * next to an id that already reads as one), everything else is its kind
 * name. Deliberately a different (shorter) helper than describeNodeKind
 * above — that one exists for the rarer "kind itself changed" case, where
 * pairing the kind name with its detail is what makes the arrow legible.
 */
function describeAddedDetail(n: GraphNode): string {
  if (n.kind === MASK_KIND) {
    const shapes = n.mask?.shapes ?? [];
    return shapes.length === 1 ? shapes[0]!.type : `${shapes.length} shapes`;
  }
  if (n.kind === SPOTS_KIND) return `${n.spots?.spots.length ?? 0} spots`;
  if (n.kind === IMAGE_KIND) return 'image';
  if (n.kind === 'output') return `output · ${outputName(n)}`;
  if (n.kind === DEVELOP_KIND) return 'Develop';
  if (n.kind === BLEND_KIND) return 'blend';
  if (n.kind === CUSTOM_KIND) return 'custom';
  if (n.kind === EXTERNAL_KIND) return 'external';
  if (n.kind === 'input') return 'input';
  if (isOpKind(n.kind)) return OPS[n.kind].label.toLowerCase();
  return n.kind;
}

function diffDisabled(out: string[], id: string, a: GraphNode, b: GraphNode): void {
  const aOff = a.disabled === true;
  const bOff = b.disabled === true;
  if (aOff === bOff) return;
  out.push(`${id}: ${aOff ? 'bypassed' : 'active'} → ${bOff ? 'bypassed' : 'active'}`);
}

function diffNodeParams(out: string[], id: string, a: GraphNode, b: GraphNode): void {
  switch (a.kind) {
    case DEVELOP_KIND:
      // parseGraphDoc always fills `develop` for a Develop-kind node (mergeDevelopParams) — safe to assert.
      diffDevelop(out, id, a.develop!, b.develop!);
      return;
    case 'input':
      diffGeometry(out, id, a.geometry, b.geometry);
      diffLens(out, id, a.lens, b.lens);
      return;
    case MASK_KIND:
      diffMask(out, id, a.mask?.shapes ?? [], b.mask?.shapes ?? []);
      return;
    case SPOTS_KIND:
      diffSpots(out, id, a.spots?.spots ?? [], b.spots?.spots ?? []);
      return;
    case IMAGE_KIND:
      strPush(out, `${id}: image.path`, a.image?.path ?? '', b.image?.path ?? '');
      return;
    case EXTERNAL_KIND:
      strPush(out, `${id}: external.command`, a.external?.command ?? '', b.external?.command ?? '');
      boolPush(out, `${id}: external.encoded`, a.external?.encoded ?? true, b.external?.encoded ?? true);
      return;
    case CUSTOM_KIND:
      diffCustomShader(out, id, a.shader, b.shader);
      return;
    case 'output':
      diffOutput(out, id, a, b);
      return;
    case BLEND_KIND:
      diffParamDefs(out, id, BLEND_PARAM_DEFS, a.params ?? {}, b.params ?? {});
      return;
    default:
      if (isOpKind(a.kind)) diffParamDefs(out, id, OPS[a.kind].params, a.params ?? {}, b.params ?? {});
  }
}

// --- edges -----------------------------------------------------------------

function edgeSig(e: GraphEdge): string {
  return `${e.source}->${e.target}${e.targetHandle ? `:${e.targetHandle}` : ''}`;
}

function edgeLabel(e: GraphEdge): string {
  return `${e.source} → ${e.target}${e.targetHandle ? ` (${e.targetHandle})` : ''}`;
}

// --- top level ---------------------------------------------------------------

/**
 * Diff two parsed sidecars (see the file doc comment for the parse
 * precondition) into human-readable, param-language lines. Empty array
 * means the two docs are look-equivalent (rating, every node's params, and
 * the wiring all match) — the caller decides how to present that ("no
 * differences").
 */
export function diffLook(a: SidecarDoc, b: SidecarDoc): string[] {
  const lines: string[] = [];

  if (a.rating !== b.rating) lines.push(`rating: ${fmtRating(a.rating)} → ${fmtRating(b.rating)}`);

  const aNodes = a.graph.nodes;
  const bNodes = b.graph.nodes;
  const bById = new Map(bNodes.map((n) => [n.id, n]));
  const aIds = new Set(aNodes.map((n) => n.id));

  const removed: GraphNode[] = [];
  for (const an of aNodes) {
    const bn = bById.get(an.id);
    if (!bn) {
      removed.push(an);
      continue;
    }
    if (an.kind !== bn.kind) {
      lines.push(`${an.id}: replaced (${describeNodeKind(an)} → ${describeNodeKind(bn)})`);
      continue;
    }
    diffDisabled(lines, an.id, an, bn);
    diffNodeParams(lines, an.id, an, bn);
  }

  const added = bNodes.filter((n) => !aIds.has(n.id));
  if (added.length > 0) lines.push(`added: ${added.map((n) => `${n.id} (${describeAddedDetail(n)})`).join(' + ')}`);
  if (removed.length > 0) lines.push(`removed: ${removed.map((n) => `${n.id} (${describeAddedDetail(n)})`).join(' + ')}`);

  const aEdgeSigs = new Map(a.graph.edges.map((e) => [edgeSig(e), e]));
  const bEdgeSigs = new Map(b.graph.edges.map((e) => [edgeSig(e), e]));
  for (const [sig, e] of aEdgeSigs) {
    if (!bEdgeSigs.has(sig)) lines.push(`unwired: ${edgeLabel(e)}`);
  }
  for (const [sig, e] of bEdgeSigs) {
    if (!aEdgeSigs.has(sig)) lines.push(`wired: ${edgeLabel(e)}`);
  }

  return lines;
}
