/**
 * Edit-op registry: every op is defined once as a matched pair — a WGSL
 * `applyOp` body the GPU pass chain compiles, and a CPU `apply` used by the
 * verify harness's reference path. Both consume the same packed uniform
 * (packUniform), so "GPU matches CPU" checks hold per op, not just for the
 * sRGB curve.
 */

import { srgbDecode, srgbEncode } from '../color/srgb';
import {
  cpuBrightness,
  cpuContrast,
  cpuSaturationVibrance,
  wgslBrightness,
  wgslContrast,
  wgslSaturationVibrance,
} from './developOps';

export type OpKind =
  | 'exposure'
  | 'whitebalance'
  | 'contrast'
  | 'tonecurve'
  | 'saturation'
  | 'vibrance'
  | 'brightness';

export interface OpParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** UI hint: logarithmic slider travel (Kelvin temperature). */
  scale?: 'log';
  /** UI hint: CSS gradient for the slider track (WB color ramps). */
  gradient?: string;
}

/** WB slider track ramps (UI spec §7): blue↔amber / green↔magenta. */
export const TEMP_GRADIENT = 'linear-gradient(90deg, #4a7bd4, #e8e8e8 55%, #f0a832)';
export const TINT_GRADIENT = 'linear-gradient(90deg, #57b45c, #e8e8e8 50%, #c95fc0)';

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
  /** True at default params — the pass is skipped for bit-exact pass-through. */
  isIdentity(params: Record<string, number>): boolean;
}

const LUMA_WGSL = `fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
`;

export const OPS: Record<OpKind, OpDef> = {
  exposure: {
    kind: 'exposure',
    label: 'Exposure',
    // exp2 runs in-shader (like Develop's exposure stage) so atomic EV and
    // Develop EV at the same value are the same WGSL operation.
    params: [{ key: 'ev', label: 'Exposure (EV)', min: -5, max: 5, step: 0.01, default: 0 }],
    packUniform: (params) => [params.ev ?? 0, 0, 0, 0],
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(c.rgb * exp2(p.x), c.a);
}`,
    apply: ([r, g, b], p) => {
      const k = Math.pow(2, p[0]);
      return [r * k, g * k, b * k];
    },
    isIdentity: (params) => (params.ev ?? 0) === 0,
  },
  whitebalance: {
    kind: 'whitebalance',
    label: 'White Balance',
    // Real Kelvin/Tint (REBUILD-SPEC §7). The uniform carries the RELATIVE
    // gains the per-image model computes from these params (buildPlan wires
    // that up — packUniform is unused for this op); temp 0 is the as-shot
    // placeholder, resolved on image load.
    params: [
      { key: 'temp', label: 'Temp', min: 2000, max: 50000, step: 1, default: 0, scale: 'log', gradient: TEMP_GRADIENT },
      { key: 'tint', label: 'Tint', min: -150, max: 150, step: 1, default: 0, gradient: TINT_GRADIENT },
    ],
    packUniform: () => [1, 1, 1, 0],
    wgsl: `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(c.rgb * p.xyz, c.a);
}`,
    apply: ([r, g, b], p) => [r * p[0], g * p[1], b * p[2]],
    isIdentity: (params) => (params.temp ?? 0) === 0,
  },
  contrast: {
    kind: 'contrast',
    label: 'Contrast',
    // Shared with Develop's contrast stage (developOps): mid-gray log-space
    // power, LR-style ±100 scale, 0 = identity.
    params: [{ key: 'amount', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 }],
    packUniform: (params) => [(params.amount ?? 0) / 100, 0, 0, 0],
    wgsl: `fn applyOp(c0: vec4f, p: vec4f) -> vec4f {
  var c = c0.rgb;
${wgslContrast('p.x')}
  return vec4f(c, c0.a);
}`,
    apply: (px, p) => cpuContrast(px, p[0]),
    isIdentity: (params) => (params.amount ?? 0) === 0,
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
    isIdentity: (params) =>
      (params.shadows ?? 0) === 0 &&
      (params.darks ?? 0) === 0 &&
      (params.lights ?? 0) === 0 &&
      (params.highlights ?? 0) === 0,
  },
  saturation: {
    kind: 'saturation',
    label: 'Saturation',
    // Shared with Develop's color stage: LR-style ±100, 0 = identity.
    params: [{ key: 'amount', label: 'Saturation', min: -100, max: 100, step: 1, default: 0 }],
    packUniform: (params) => [(params.amount ?? 0) / 100, 0, 0, 0],
    wgsl: `${LUMA_WGSL}fn applyOp(c0: vec4f, p: vec4f) -> vec4f {
  var c = c0.rgb;
${wgslSaturationVibrance('p.x', '0.0')}
  return vec4f(c, c0.a);
}`,
    apply: (px, p) => cpuSaturationVibrance(px, p[0], 0),
    isIdentity: (params) => (params.amount ?? 0) === 0,
  },
  vibrance: {
    kind: 'vibrance',
    label: 'Vibrance',
    params: [{ key: 'amount', label: 'Vibrance', min: -100, max: 100, step: 1, default: 0 }],
    packUniform: (params) => [(params.amount ?? 0) / 100, 0, 0, 0],
    wgsl: `${LUMA_WGSL}fn applyOp(c0: vec4f, p: vec4f) -> vec4f {
  var c = c0.rgb;
${wgslSaturationVibrance('0.0', 'p.x')}
  return vec4f(c, c0.a);
}`,
    apply: (px, p) => cpuSaturationVibrance(px, 0, p[0]),
    isIdentity: (params) => (params.amount ?? 0) === 0,
  },
  brightness: {
    kind: 'brightness',
    label: 'Brightness',
    params: [{ key: 'amount', label: 'Brightness', min: -100, max: 100, step: 1, default: 0 }],
    packUniform: (params) => [(params.amount ?? 0) / 100, 0, 0, 0],
    wgsl: `fn applyOp(c0: vec4f, p: vec4f) -> vec4f {
  var c = c0.rgb;
${wgslBrightness('p.x')}
  return vec4f(c, c0.a);
}`,
    apply: (px, p) => cpuBrightness(px, p[0]),
    isIdentity: (params) => (params.amount ?? 0) === 0,
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
 * Custom (WGSL) node kind: the user writes the body of `shade(color, uv)`;
 * everything else (wrapper, GUI params, validation, artifact cache) lives in
 * customShaderNode.ts. Not part of OPS because it has no CPU reference —
 * cpuReferenceMean() reports chains containing one as unsupported and the
 * verify harness checks known shaders by hand.
 */
export const CUSTOM_KIND = 'custom';

/**
 * Blend node: two inputs (a = base, b = overlay), output = mix(a, b, amount)
 * in linear space. Like custom, it lives outside OPS — it is the one node
 * with a different execution shape (two sources), handled by the plan.
 */
export const BLEND_KIND = 'blend';

export const BLEND_PARAM_DEFS: OpParamDef[] = [
  { key: 'amount', label: 'Mix (a → b)', min: 0, max: 1, step: 0.01, default: 0.5 },
];

export function packBlendUniform(params: Record<string, number>): [number, number, number, number] {
  return [params.amount ?? 0.5, 0, 0, 0];
}
