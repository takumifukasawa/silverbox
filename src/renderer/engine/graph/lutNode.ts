/**
 * LUT import node (docs/brief-bank/lut-import-node.md): a chain op (one
 * input, one output) that samples an owned .cube film-sim/creative LUT — the
 * READ mirror of the shipped LUT export (engine/color/lutExport.ts). Its own
 * kind, not an OPS entry (like blend/custom): the payload is a FILE
 * REFERENCE (path + input-space selector + amount), never the baked table,
 * same non-destructive posture as every other sidecar param.
 *
 * Doc-shape module only (params/sanitizer/1D WGSL), same split as
 * spotsNode.ts/externalNode.ts: file loading + parsing (engine/color/
 * lutCube.ts, main-thread only — file IO can't happen inside buildPlan)
 * lives in lutSource.ts; the actual GPU sampling machinery for the 3D case
 * (a manual-trilinear pass over a packed "strip" texture, since the engine
 * has no native texture_3d) lives in graphRenderer.ts's LUT3D_SHADER.
 *
 * Payload mirrors the Image node's file-reference policy exactly (path:
 * absolute v1 UI write, sidecar-relative ACCEPTED on parse — see
 * imageNode.ts's resolveImagePath, reused verbatim by lutSource.ts).
 */
import { nodePassWgsl, WGSL_SRGB_DECODE, WGSL_SRGB_ENCODE } from './wgslCommon';
import { WGSL_SRGB_TO_WORK, WGSL_WORK_TO_SRGB } from '../color/workingSpace';
import type { CubeLut1D } from '../color/lutCube';

export const LUT_KIND = 'lut';

/**
 * v1 assumption (the film-sim norm): the referenced .cube is sRGB-display-
 * referred. 'rec709' is exposed as a selector for correctness/documentation
 * but currently applies the SAME math as 'srgb' — see engine/color/
 * lutCube.ts's applyCubeLutCpu doc comment for why (sRGB/Rec.709 share
 * primaries, and the engine has no separately-implemented Rec.709 transfer
 * curve to reuse without re-deriving one — an engine invariant violation).
 */
export type LutInputSpace = 'srgb' | 'rec709';

export interface LutParams {
  /** Absolute (v1 UI) or sidecar-relative (accepted on parse) path to the referenced .cube — same policy as ImageParams.path. Empty = no file chosen yet ⇒ identity (bit-exact pass-through). */
  path: string;
  inputSpace: LutInputSpace;
  /** 0..1 mix vs identity, like the develop lattice's amount / blend's uniform.x. 0 = IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through), same invariant every other node kind upholds. */
  amount: number;
}

export function defaultLutParams(): LutParams {
  return { path: '', inputSpace: 'srgb', amount: 1 };
}

/** amount <= 0 ⇒ IDENTITY, same convention as denoiseNode.ts's isIdentityDenoise. Missing path / not-yet-loaded / malformed table are separate buildPlan-level pass-through conditions (graphDoc.ts), not reflected here. */
export function isIdentityLut(p: LutParams): boolean {
  return p.amount <= 0;
}

/**
 * Normalize an untrusted lut payload; NEVER throws (imageNode.ts's
 * sanitizeImageParams convention, explicitly named by the brief as the
 * precedent to follow) — a bad/missing LUT param must never take an
 * otherwise-good sidecar down with it, same as a bad image-node path.
 */
export function sanitizeLutParams(raw: unknown, _nodeId: string): LutParams {
  const base = defaultLutParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { path?: unknown; inputSpace?: unknown; amount?: unknown };
  const path = typeof src.path === 'string' ? src.path : base.path;
  const inputSpace: LutInputSpace = src.inputSpace === 'rec709' ? 'rec709' : 'srgb';
  const amount =
    typeof src.amount === 'number' && Number.isFinite(src.amount) ? Math.min(1, Math.max(0, src.amount)) : base.amount;
  return { path, inputSpace, amount };
}

/**
 * The 1D-LUT GPU pass (per-channel tone — LUT_1D_SIZE): a small read-only
 * storage array (PROFILE_WGSL's precedent for "table too big for the 64KB
 * uniform cap", developNode.ts) holding `size` per-channel curve rows plus a
 * `meta.x = amount` header, so this pass needs NO extra bindings beyond the
 * generic 'passes' step's src+storage contract — no graphRenderer.ts changes
 * needed for the 1D case (unlike the 3D case's strip texture, which DOES
 * need a dedicated PlanStep — see graphDoc.ts's buildPlan LUT_KIND branch).
 * `size` is baked as a WGSL compile-time array length (PROFILE_N's
 * precedent), so the pipeline cache key must include it (buildPlan uses
 * `lut/1d-${size}`).
 *
 * Must mirror engine/color/lutCube.ts's applyCubeLutCpu/sampleLut1DLinear
 * EXACTLY (same encode → per-channel-linear-lookup → decode → mix order) —
 * the GPU↔CPU parity check (scripts/verify-lut-import.mjs) depends on it.
 */
export function buildLut1DWgsl(size: number): string {
  return nodePassWgsl({
    uniformDecl: /* wgsl */ `
struct Lut1D {
  hdr: vec4f, // x = amount (0..1), yzw unused — NOT named "meta": that's a reserved WGSL identifier (getCompilationInfo() rejects it)
  data: array<vec4f, ${size}>, // xyz = (rCurve[i], gCurve[i], bCurve[i]) at row i, w unused
}
@group(0) @binding(1) var<storage, read> u: Lut1D;
`,
    helpers: WGSL_SRGB_ENCODE + WGSL_SRGB_DECODE,
    body: /* wgsl */ `
  {
    let lin = ${WGSL_WORK_TO_SRGB} * c;
    let enc = clamp(srgbEncode(lin), vec3f(0.0), vec3f(1.0));
    let coord = enc * ${size - 1}.0;
    let i0 = min(vec3i(coord), vec3i(${size - 2}));
    let f = coord - vec3f(i0);
    let sampled = vec3f(
      mix(u.data[i0.x].x, u.data[i0.x + 1].x, f.x),
      mix(u.data[i0.y].y, u.data[i0.y + 1].y, f.y),
      mix(u.data[i0.z].z, u.data[i0.z + 1].z, f.z)
    );
    let outWork = ${WGSL_SRGB_TO_WORK} * srgbDecode(sampled);
    c = mix(c, outWork, u.hdr.x);
  }
`,
  });
}

/** Pack a 1D table + amount into buildLut1DWgsl's storage buffer layout — see its doc comment. */
export function packLut1DStorage(table: CubeLut1D, amount: number): ArrayBuffer {
  const size = table.size;
  const buf = new ArrayBuffer((1 + size) * 16);
  const f = new Float32Array(buf);
  f[0] = amount;
  for (let i = 0; i < size; i++) {
    const base = 4 + i * 4;
    f[base] = table.data[i * 3]!;
    f[base + 1] = table.data[i * 3 + 1]!;
    f[base + 2] = table.data[i * 3 + 2]!;
  }
  return buf;
}
