/**
 * Edit-op registry: every op is defined once as a matched pair — a WGSL
 * `applyOp` body the GPU pass chain compiles, and a CPU `apply` used by the
 * verify harness's reference path. Both consume the same packed uniform
 * (packUniform), so "GPU matches CPU" checks hold per op, not just for the
 * sRGB curve.
 */

export type OpKind = 'exposure' | 'whitebalance' | 'contrast' | 'saturation';

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
