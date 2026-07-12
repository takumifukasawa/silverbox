/**
 * LUT export (task #33): turns the active output's color pipeline into
 * game-engine-ready 3D LUTs — a standard Adobe/Resolve .cube, Unity/Unreal
 * "strip" PNGs, and a WebGL sampling snippet.
 *
 * Semantics: a 3D LUT is display-referred RGB→RGB. For every lattice point
 * (r, g, b) in sRGB-encoded [0,1]³: sRGB-decode → SRGB_TO_WORK into the
 * working space (identical to the JPEG ingest path) → run the graph's COLOR
 * pipeline exactly as the CPU reference does (buildPlan/cpuEvalPlan,
 * graphDoc.ts — the SAME machinery CanvasView's cpuReferenceMean drives, same
 * wbModel context) → WORK_TO_SRGB → sRGB-encode → clamp. Geometry (crop/
 * rotate/lens) is spatial and simply never touches this path — buildPlan's
 * `plan.geometry`/`plan.lens` are ignored entirely here, unlike
 * planHasCpuReference (graphDoc.ts) which treats their mere PRESENCE as
 * disqualifying; a LUT only cares whether the COLOR chain is capturable.
 *
 * Reduced-plan mechanism: a plan step's `cpu === null` means either a
 * Develop node with an active spatial section (Detail sharpen/NR, fx-spatial
 * clarity/texture — see developNode.ts's compileDevelop) or a custom WGSL
 * node (never has a CPU mirror). PlanStep granularity for Develop is
 * per-NODE, not per-section (compileDevelop folds every active section into
 * one step with one combined `cpu` closure or null) — so a Develop node with
 * ANY spatial section active loses its CPU mirror for sections that ARE
 * otherwise capturable (tone/curve/HSL/color/grading/fx-pixel) too. Rather
 * than duplicate compileDevelop's pass-selection logic to salvage those,
 * this module clones the doc with JUST the spatial-causing params
 * (detail.*, effects.clarity/texture) reset to their identity defaults —
 * compileDevelop's own identity invariant then naturally re-includes every
 * other active section's CPU mirror (engine invariant: identity params ⇒
 * that section's pass isn't even emitted). Custom shader nodes have no
 * identity-reset escape hatch (arbitrary user WGSL), so they're bypassed
 * outright: the node is removed and its consumers rewired to whatever fed
 * it, the same graph-surgery `bypass` shape appStore.ts's removeOpNode
 * already uses for node deletion. Spot-removal nodes (task #50) get the
 * exact same bypass treatment — a clone circle samples the input texture at
 * an offset POSITION, which a position-independent LUT fundamentally cannot
 * represent, and (unlike Detail) there is no identity-reset escape hatch
 * short of dropping every spot. A blend with a mask input is a THIRD case
 * this module must also catch that planHasCpuReference does NOT: the blend
 * step type carries no `cpu` field at all (cpuEvalPlan evaluates it inline),
 * so a masked blend never shows up as "no CPU reference" — yet its mix
 * factor is sampled at a per-pixel position, which a position-independent
 * LUT fundamentally cannot represent. Detected explicitly (`step.srcMask !==
 * undefined`) and bypassed to its 'a' input (the masked adjustment is
 * skipped entirely), per the brief.
 */
import {
  buildPlan,
  cpuEvalPlan,
  DEVELOP_KIND,
  type CompileContext,
  type GraphDoc,
  type GraphEdge,
  type RenderPlan,
} from '../graph/graphDoc';
import { defaultDevelopParams, isIdentityDetail, isIdentityEffectsSpatial } from '../graph/developNode';
import { BLEND_KIND, CUSTOM_KIND } from '../graph/ops';
import { SPOTS_KIND } from '../graph/spotsNode';
import { IMAGE_KIND } from '../graph/imageNode';
import { EXTERNAL_KIND } from '../graph/externalNode';
import type { WbModel } from './whiteBalance';
import { srgbDecode, srgbEncode } from './srgb';
import { SRGB_TO_WORK, WORK_TO_SRGB } from './workingSpace';

type Rgb = [number, number, number];
type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

export const CUBE_LUT_SIZE = 33;
export const UNITY_LUT_SIZE = 32;
export const UE_LUT_SIZE = 16;

export interface LutExportResult {
  cubeText: string;
  /** 1024×32 RGBA8, row-major (row 0 = top) — see buildStripPixels' doc comment for the exact axis convention. */
  unityRgba: Uint8Array;
  /** 256×16 RGBA8, same convention as unityRgba at UE's coarser (16³) resolution. */
  ueRgba: Uint8Array;
  webglText: string;
  /** Human-readable "node: reason" entries for color ops the export could not capture; empty when the whole active chain made it in. */
  skipped: string[];
}

function mulMat3(m: Mat3, v: Rgb): Rgb {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Position context handed to cpuEvalPlan. By the time a plan is evaluated
 * here, reduceGraphForLut has already reset every position-DEPENDENT effect
 * (vignette, grain) to identity, so nothing in the reduced plan actually
 * varies with (x, y) — this fixed frame-center position only exists because
 * the CPU-mirror signature requires one.
 */
const LUT_REFERENCE_POS = { x: 500, y: 500, width: 1000, height: 1000 };

/**
 * Build a doc + skipped-ops report that `buildPlan` can fully evaluate on the
 * CPU (color-only, position-independent). See this module's top doc comment
 * for the three cases handled. Loops (bounded) because fixing one issue
 * cannot introduce a new one here — Develop identity-resets and node
 * bypasses only ever remove problems — but re-detecting from a freshly built
 * plan each pass is cheap and keeps this robust without hand-proving a
 * fixed-point in one shot.
 */
function reduceGraphForLut(doc: GraphDoc, ctx: CompileContext): { doc: GraphDoc; skipped: string[] } {
  let working = doc;
  const skipped: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const plan = buildPlan(working, ctx);
    const byId = new Map(working.nodes.map((n) => [n.id, n]));
    const removeIds = new Set<string>();
    const bypassSource = new Map<string, string>();
    let sawIssue = false;
    let nextNodes = working.nodes;

    // Position-DEPENDENT but CPU-mirrored effects (vignette falloff, grain
    // noise — cpuFxPixel) never null the plan's cpu, so the step scan below
    // can't see them; yet a position-independent LUT cannot represent either
    // (grain would bake ONE fixed noise sample into every lattice point as a
    // uniform offset, vignette would silently vanish because the reference
    // position is the frame center where its falloff is zero). Reset + report
    // them here, unconditionally, before the cpu === null scan.
    for (const node of working.nodes) {
      if (node.kind !== DEVELOP_KIND || !node.develop) continue;
      const e = node.develop.effects;
      if (e.grain === 0 && e.vignette === 0) continue;
      sawIssue = true;
      const parts: string[] = [];
      if (e.grain !== 0) parts.push('grain');
      if (e.vignette !== 0) parts.push('vignette');
      skipped.push(`${node.id}: Effects (${parts.join(', ')}) — position-dependent, not representable in a LUT`);
      nextNodes = nextNodes.map((n) =>
        n.id === node.id && n.develop
          ? { ...n, develop: { ...n.develop, effects: { ...n.develop.effects, grain: 0, vignette: 0 } } }
          : n
      );
    }

    for (const step of plan.steps) {
      if (step.type === 'passes' && step.cpu === null) {
        const node = byId.get(step.nodeId);
        if (!node) continue;
        sawIssue = true;
        if (node.kind === DEVELOP_KIND && node.develop) {
          const d = node.develop;
          const parts: string[] = [];
          if (!isIdentityDetail(d.detail)) parts.push('Detail (sharpen / noise reduction)');
          if (!isIdentityEffectsSpatial(d.effects)) parts.push('Effects (clarity / texture)');
          skipped.push(`${node.id}: ${parts.join(', ')}`);
          const identityDetail = defaultDevelopParams().detail;
          nextNodes = nextNodes.map((n) =>
            n.id === node.id && n.develop
              ? { ...n, develop: { ...n.develop, detail: identityDetail, effects: { ...n.develop.effects, clarity: 0, texture: 0 } } }
              : n
          );
        } else if (node.kind === CUSTOM_KIND) {
          skipped.push(`${node.id}: custom shader node (no CPU reference)`);
          removeIds.add(node.id);
          const inEdge = working.edges.find((e) => e.target === node.id);
          if (inEdge) bypassSource.set(node.id, inEdge.source);
        } else if (node.kind === SPOTS_KIND) {
          skipped.push(`${node.id}: spot removal (position-dependent clone sampling, not representable in a LUT)`);
          removeIds.add(node.id);
          const inEdge = working.edges.find((e) => e.target === node.id);
          if (inEdge) bypassSource.set(node.id, inEdge.source);
        }
      } else if (step.type === 'external') {
        // External-tool hook node (task #41): an arbitrary out-of-process
        // command over a per-frame content hash — nothing a fixed 33^3
        // lattice sample could ever represent (it isn't even a pure function
        // of the pixel VALUE the way every other color op is; it depends on
        // the whole frame's content and a live subprocess). Same bypass
        // shape as custom/spots: one input, so the consumer just falls back
        // to it (not the 'image' node's no-fallback case — an external node
        // always has exactly one upstream input to degrade to).
        const node = byId.get(step.nodeId);
        if (!node) continue;
        sawIssue = true;
        skipped.push(`${step.nodeId}: external tool node (runs an out-of-process command, no CPU reference) — not representable in a LUT`);
        removeIds.add(step.nodeId);
        const inEdge = working.edges.find((e) => e.target === step.nodeId);
        if (inEdge) bypassSource.set(step.nodeId, inEdge.source);
      } else if (step.type === 'blend' && step.srcMask !== undefined) {
        const node = byId.get(step.nodeId);
        if (!node) continue;
        sawIssue = true;
        skipped.push(`${node.id}: masked local adjustment (position-dependent mask, skipped)`);
        removeIds.add(node.id);
        const aEdge = working.edges.find((e) => e.target === node.id && e.targetHandle === 'a');
        if (aEdge) bypassSource.set(node.id, aEdge.source);
      } else if (step.type === 'image') {
        // Image node (composite/mask-by-another-file feature): a per-pixel
        // TEXTURE source, not an RGB→RGB formula — a LUT lattice point has
        // no position and never loads the referenced file's pixels, so this
        // is unconditionally unrepresentable (unlike Detail/fx-spatial there
        // is no identity-reset escape hatch — "don't read another image" IS
        // the whole node). Removed with NO bypass mapping (it has no input
        // to fall back to, unlike custom/spots — see PlanStep's doc
        // comment); the cascading closure below degrades whatever consumes
        // it (typically a blend's 'b' port — its 'mask' port is already
        // caught unconditionally above, regardless of what feeds it).
        sawIssue = true;
        skipped.push(`${step.nodeId}: image node (reads pixels from another file, no CPU reference) — not representable in a LUT`);
        removeIds.add(step.nodeId);
      }
    }

    if (!sawIssue) return { doc: working, skipped };

    const resolveSource = (id: string): string => {
      let cur = id;
      const seen = new Set<string>();
      while (removeIds.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const next = bypassSource.get(cur);
        if (next === undefined) break;
        cur = next;
      }
      return cur;
    };

    // Cascading closure: a removed node with NO bypass mapping (only an
    // image node reaches this — custom/spots always have exactly one input
    // to fall back to) leaves whoever consumes it with nothing valid either,
    // UNLESS that consumer is a blend degrading via its own 'a' fallback
    // (same convention as the masked-blend/custom bypasses above). Propagate
    // one level at a time until nothing new is found — bounded by the node
    // count, and 'input'/'output' are never touched (an output must always
    // keep SOME resolution, however unrepresentable — deleting it would
    // violate "the doc always has an output"; a doc whose ENTIRE resolved
    // chain is unrepresentable, e.g. an image node wired straight to output
    // with no blend in between, is outside this feature's documented use
    // case and simply produces a LUT of whatever residual color ops remain).
    const incomingByTarget = new Map<string, GraphEdge[]>();
    for (const e of working.edges) incomingByTarget.set(e.target, [...(incomingByTarget.get(e.target) ?? []), e]);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const node of working.nodes) {
        if (removeIds.has(node.id) || node.kind === 'input' || node.kind === 'output') continue;
        const ins = incomingByTarget.get(node.id) ?? [];
        if (node.kind === BLEND_KIND) {
          const aEdge = ins.find((e) => e.targetHandle === 'a');
          const resolvedA = aEdge ? resolveSource(aEdge.source) : undefined;
          if (resolvedA !== undefined && removeIds.has(resolvedA)) {
            removeIds.add(node.id);
            skipped.push(`${node.id}: its base ('a') input is itself unrepresentable — not representable in a LUT`);
            progressed = true;
            continue;
          }
          const bEdge = ins.find((e) => e.targetHandle === 'b');
          const resolvedB = bEdge ? resolveSource(bEdge.source) : undefined;
          // Only degrade to 'a' when 'a' actually EXISTS as a fallback (a
          // malformed/disconnected blend missing its 'a' edge never reaches
          // buildPlan's own validation — it isn't reachable from the
          // resolved output — so this can't assume aEdge is present here).
          if (aEdge && resolvedB !== undefined && removeIds.has(resolvedB)) {
            bypassSource.set(node.id, aEdge.source);
            removeIds.add(node.id);
            skipped.push(`${node.id}: composited with an unrepresentable source on its 'b' input — not representable in a LUT`);
            progressed = true;
          }
        } else {
          const inEdge = ins[0];
          const resolvedIn = inEdge ? resolveSource(inEdge.source) : undefined;
          if (resolvedIn !== undefined && removeIds.has(resolvedIn)) {
            removeIds.add(node.id);
            skipped.push(`${node.id}: fed directly by an unrepresentable node — not representable in a LUT`);
            progressed = true;
          }
        }
      }
    }

    let nextEdges = working.edges;
    if (removeIds.size > 0) {
      nextEdges = working.edges
        .filter((e) => !removeIds.has(e.target))
        .map((e) => (removeIds.has(e.source) ? { ...e, source: resolveSource(e.source) } : e));
      nextNodes = nextNodes.filter((n) => !removeIds.has(n.id));
    }
    working = { ...working, nodes: nextNodes, edges: nextEdges };
  }
  return { doc: working, skipped };
}

/** One lattice point through the full exit transform: sRGB-encoded in → sRGB-encoded out. */
function evalLutPoint(plan: RenderPlan, rEnc: number, gEnc: number, bEnc: number): Rgb {
  const lin: Rgb = [srgbDecode(rEnc), srgbDecode(gEnc), srgbDecode(bEnc)];
  const work = mulMat3(SRGB_TO_WORK, lin);
  const outWork = cpuEvalPlan(plan, work, LUT_REFERENCE_POS.x, LUT_REFERENCE_POS.y, LUT_REFERENCE_POS.width, LUT_REFERENCE_POS.height);
  const outLin = mulMat3(WORK_TO_SRGB, outWork);
  return [srgbEncode(outLin[0]), srgbEncode(outLin[1]), srgbEncode(outLin[2])];
}

/**
 * Standard Adobe/Resolve .cube: header + LUT_3D_SIZE³ data lines, RED
 * fastest, then green, then blue (the .cube spec's own ordering — verified
 * by scripts/verify-lut.mjs against a red-only asymmetric edit).
 */
function buildCubeText(plan: RenderPlan, name: string): string {
  const size = CUBE_LUT_SIZE;
  const lines: string[] = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [or, og, ob] = evalLutPoint(plan, r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * "Strip" LUT texture: `size` tiles of size×size laid out side by side
 * (width = size², height = size) — Unity's URP/HDRP 3D-LUT-as-2D-texture
 * convention (Unreal's default RGBTable16x1.png uses the same tile-strip
 * family at size 16, just narrower). Axis mapping: tile index = BLUE,
 * within-tile x = RED, within-tile y = GREEN, with green increasing
 * DOWNWARD from the top row (row 0 = top = green 0, row size-1 = bottom =
 * green 1) — texture v=0 at the top, matching Unity's strip-texture import
 * convention (no vertical flip). RGBA8, alpha always 255 (opaque — these
 * load as plain color/lookup textures, not sprites). Written untagged (no
 * ICC) by the main-process encoder so the raw bytes are exactly these sRGB
 * values, unmodified.
 */
function buildStripPixels(plan: RenderPlan, size: number): Uint8Array {
  const width = size * size;
  const height = size;
  const out = new Uint8Array(width * height * 4);
  for (let bt = 0; bt < size; bt++) {
    const b = bt / (size - 1);
    for (let y = 0; y < size; y++) {
      const g = y / (size - 1);
      for (let x = 0; x < size; x++) {
        const r = x / (size - 1);
        const [or, og, ob] = evalLutPoint(plan, r, g, b);
        const px = bt * size + x;
        const idx = (y * width + px) * 4;
        out[idx] = Math.round(clamp01(or) * 255);
        out[idx + 1] = Math.round(clamp01(og) * 255);
        out[idx + 2] = Math.round(clamp01(ob) * 255);
        out[idx + 3] = 255;
      }
    }
  }
  return out;
}

/**
 * GLSL snippet sampling the Unity-style 1024×32 strip: half-texel-centered
 * lookups + a manual mix across the two nearest blue tiles (linear
 * filtering handles the red/green interpolation WITHIN a tile — mixing
 * across tiles in x would blend into the wrong blue slice, hence the
 * two-lookup approach instead of relying on hardware trilinear). Known,
 * accepted limitation of this common technique: red-axis samples very close
 * to a tile edge can still bleed a texel into the neighboring blue slice
 * under linear filtering — negligible in practice at 32³.
 */
function buildWebglSnippet(name: string): string {
  return `// ${name} — Unity-style 1024x32 strip LUT (32 tiles of 32x32; tile=blue, x=red, y=green, v=0 at top).
// Usage:
//   vec3 graded = applyLut(uLutTexture, inputSrgbColor);
//   // uLutTexture: CLAMP_TO_EDGE wrap, linear (or nearest) filtering, no mipmaps.
vec3 applyLut(sampler2D lut, vec3 srgb) {
  const float SIZE = 32.0;
  vec3 c = clamp(srgb, 0.0, 1.0) * (SIZE - 1.0);
  float bLow = floor(c.b);
  float bHigh = min(bLow + 1.0, SIZE - 1.0);
  float bFrac = c.b - bLow;
  vec2 texel = vec2(1.0 / (SIZE * SIZE), 1.0 / SIZE);
  vec2 uvLow = vec2((bLow * SIZE + c.r + 0.5) * texel.x, (c.g + 0.5) * texel.y);
  vec2 uvHigh = vec2((bHigh * SIZE + c.r + 0.5) * texel.x, (c.g + 0.5) * texel.y);
  vec3 low = texture(lut, uvLow).rgb;
  vec3 high = texture(lut, uvHigh).rgb;
  return mix(low, high, bFrac);
}
`;
}

/**
 * Build every LUT deliverable (task #33) for `doc`'s active output. Pure
 * function of the graph + the per-image WB model — no decoded pixels needed
 * at all, since a LUT captures the color TRANSFORM, not any one image's
 * content. `outputId` mirrors exportImage's rule (undefined = the doc's
 * first output); `name` becomes the .cube TITLE and the webgl comment.
 */
export function buildLutExport(doc: GraphDoc, wb: WbModel, outputId: string | undefined, name: string): LutExportResult {
  const ctx: CompileContext = { wb, renderScale: 1, outputId };
  const { doc: reducedDoc, skipped } = reduceGraphForLut(doc, ctx);
  const plan = buildPlan(reducedDoc, ctx);
  return {
    cubeText: buildCubeText(plan, name),
    unityRgba: buildStripPixels(plan, UNITY_LUT_SIZE),
    ueRgba: buildStripPixels(plan, UE_LUT_SIZE),
    webglText: buildWebglSnippet(name),
    skipped,
  };
}
