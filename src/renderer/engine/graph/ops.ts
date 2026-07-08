/**
 * Edit-op registry: every op is defined once as a matched pair — a WGSL
 * `applyOp` body the GPU pass chain compiles, and a CPU `apply` used by the
 * verify harness's reference path. Both consume the same packed uniform
 * (packUniform), so "GPU matches CPU" checks hold per op, not just for the
 * sRGB curve.
 */

import { srgbDecode, srgbEncode } from '../color/srgb';

export type OpKind = 'exposure' | 'whitebalance' | 'contrast' | 'tonecurve' | 'saturation';

export interface OpParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface OpDef {
  kind: OpKind;
  label: string;
  params: OpParamDef[];
  /** Pack node params into the vec4f uniform both implementations consume. */
  packUniform(params: Record<string, number>): [number, number, number, number];
  /** WGSL `fn applyOp(c: vec4f, p: vec4f) -> vec4f` implementing the op. */
  wgsl: string;
  /** CPU reference; must mirror `wgsl` exactly (linear in, linear out). */
  apply(rgb: [number, number, number], p: [number, number, number, number]): [number, number, number];
}

export const OPS: Record<OpKind, OpDef> = {
  exposure: {
    kind: 'exposure',
    label: 'Exposure',
    params: [{ key: 'ev', label: 'Exposure (EV)', min: -4, max: 4, step: 0.01, default: 0 }],
    packUniform: (params) => [Math.pow(2, params.ev ?? 0), 0, 0, 0],
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(c.rgb * p.x, c.a);
}`,
    apply: ([r, g, b], p) => [r * p[0], g * p[0], b * p[0]],
  },
  whitebalance: {
    kind: 'whitebalance',
    label: 'White Balance',
    // Relative gains with green anchored at 1 — as-shot WB is baked in at
    // decode (useCameraWb), so gains of 1 are a true identity.
    params: [
      { key: 'rGain', label: 'R gain', min: 0.25, max: 4, step: 0.01, default: 1 },
      { key: 'bGain', label: 'B gain', min: 0.25, max: 4, step: 0.01, default: 1 },
    ],
    packUniform: (params) => [params.rGain ?? 1, params.bGain ?? 1, 0, 0],
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(c.rgb * vec3f(p.x, 1.0, p.y), c.a);
}`,
    apply: ([r, g, b], p) => [r * p[0], g, b * p[1]],
  },
  contrast: {
    kind: 'contrast',
    label: 'Contrast',
    // Power curve pivoting on 0.18 mid-gray in linear; amount 1 = identity.
    params: [{ key: 'amount', label: 'Contrast', min: 0.5, max: 2, step: 0.01, default: 1 }],
    packUniform: (params) => [params.amount ?? 1, 0, 0, 0],
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  let r = pow(max(c.rgb, vec3f(0.0)) / 0.18, vec3f(p.x)) * 0.18;
  return vec4f(r, c.a);
}`,
    apply: ([r, g, b], p) => {
      const curve = (v: number) => Math.pow(Math.max(v, 0) / 0.18, p[0]) * 0.18;
      return [curve(r), curve(g), curve(b)];
    },
  },
  tonecurve: {
    kind: 'tonecurve',
    label: 'Tone Curve',
    // Region offsets applied in sRGB-encoded space (encode → curve → decode)
    // as raised-cosine bumps; all zeros = exact identity. toneCurvePoint()
    // below is the shared curve definition (CPU apply + inspector preview).
    params: [
      { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'darks', label: 'Darks', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'lights', label: 'Lights', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, default: 0 },
    ],
    packUniform: (params) => [
      params.shadows ?? 0,
      params.darks ?? 0,
      params.lights ?? 0,
      params.highlights ?? 0,
    ],
    wgsl: `fn tcBump(x: f32, c: f32, r: f32) -> f32 {
  let t = abs(x - c) / r;
  return select(0.0, 0.5 * (1.0 + cos(3.14159265358979 * t)), t < 1.0);
}
fn tcEncode(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}
fn tcDecode(v: f32) -> f32 {
  return select(pow((v + 0.055) / 1.055, 2.4), v / 12.92, v <= 0.04045);
}
fn tcCurve(x: f32, p: vec4f) -> f32 {
  let y = x + 0.25 * (p.x * tcBump(x, 0.15, 0.25) + p.y * tcBump(x, 0.4, 0.3)
    + p.z * tcBump(x, 0.65, 0.3) + p.w * tcBump(x, 0.9, 0.25));
  return clamp(y, 0.0, 1.0);
}
fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(
    tcDecode(tcCurve(tcEncode(c.r), p)),
    tcDecode(tcCurve(tcEncode(c.g), p)),
    tcDecode(tcCurve(tcEncode(c.b), p)),
    c.a
  );
}`,
    apply: ([r, g, b], p) => {
      const f = (v: number) => srgbDecode(toneCurvePoint(srgbEncode(v), p));
      return [f(r), f(g), f(b)];
    },
  },
  saturation: {
    kind: 'saturation',
    label: 'Saturation',
    params: [{ key: 'amount', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 1 }],
    packUniform: (params) => [params.amount ?? 1, 0, 0, 0],
    // Rec.709 luma weights on linear RGB; amount 0 = grayscale, 1 = identity.
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  let l = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(vec3f(l) + (c.rgb - vec3f(l)) * p.x, c.a);
}`,
    apply: ([r, g, b], p) => {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [l + (r - l) * p[0], l + (g - l) * p[0], l + (b - l) * p[0]];
    },
  },
};

export function isOpKind(kind: string): kind is OpKind {
  return kind in OPS;
}

/** The tone curve in encoded space; must mirror tcCurve/tcBump in the WGSL. */
export function toneCurvePoint(x: number, p: [number, number, number, number]): number {
  const bump = (c: number, r: number) => {
    const t = Math.abs(x - c) / r;
    return t < 1 ? 0.5 * (1 + Math.cos(Math.PI * t)) : 0;
  };
  const y = x + 0.25 * (p[0] * bump(0.15, 0.25) + p[1] * bump(0.4, 0.3) + p[2] * bump(0.65, 0.3) + p[3] * bump(0.9, 0.25));
  return Math.min(Math.max(y, 0), 1);
}

/**
 * Custom (WGSL) node: the user edits the applyOp body directly; p0..p3 are
 * free uniform knobs (params.x/y/z/w in the shader). Not part of OPS because
 * it has no CPU reference — cpuReferenceMean() reports chains containing one
 * as unsupported, and the verify harness checks known shaders by hand.
 */
export const CUSTOM_KIND = 'custom';

export const CUSTOM_PARAM_DEFS: OpParamDef[] = [0, 1, 2, 3].map((i) => ({
  key: `p${i}`,
  label: `p${i}`,
  min: 0,
  max: 1,
  step: 0.01,
  default: 0,
}));

export const DEFAULT_CUSTOM_CODE = `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return c;
}`;

export function packCustomUniform(params: Record<string, number>): [number, number, number, number] {
  return [params.p0 ?? 0, params.p1 ?? 0, params.p2 ?? 0, params.p3 ?? 0];
}
