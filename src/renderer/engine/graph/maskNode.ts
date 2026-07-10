/**
 * Mask node (masks milestone): an analytic per-pixel pass producing a mask
 * value replicated to rgb (single-channel semantics, `.r` is canonical).
 * Coordinates are normalized 0..1 relative to the CURRENT RENDER FRAME (the
 * same working dims every other node pass shares — see graphRenderer.ts's
 * `width`/`height`). `shapes` is an array from day one (combine modes ship
 * later), but the UI only ever creates/edits `shapes[0]` — a shape's `mode`
 * is accepted and sanitized but otherwise ignored for now.
 *
 * Radial "circular on screen" choice: rather than normalizing (dx, dy) by
 * the frame's own (width, height) separately — which would make a "circle"
 * an ellipse on any non-square frame — this pass measures distance in RAW
 * PIXEL space (dx, dy in actual texels) and only divides by the frame's max
 * dimension at the very end, purely to keep `radius`/`feather` in the same
 * normalized-ish units the rest of the app uses (crop fractions, etc). Pixel
 * space is screen space here (no additional projection), so a `radius` is a
 * true circle as displayed, on any aspect ratio.
 *
 * Linear mask: 1 on the p0 side, 0 on the p1 side, smoothstepped along the
 * p0→p1 axis; `feather` (0..1) widens the transition band symmetrically
 * around the midline (t=0.5 in the parametric projection onto the p0→p1
 * axis) instead of shifting it.
 *
 * Both the WGSL pass (evaluated per-pixel on the GPU) and `cpuMaskShape`
 * (the exact CPU mirror, same (px, x, y, w, h) signature every other
 * position-aware CPU mirror in this codebase uses) MUST stay in lockstep —
 * they encode literally the same formula.
 */
import { nodePassWgsl, smoothstepCpu } from './wgslCommon';

export const MASK_KIND = 'mask';

export type MaskShapeType = 'radial' | 'linear';

export interface RadialMaskShape {
  type: 'radial';
  /** Combine mode; only 'add' ships today — accepted/sanitized, otherwise ignored (shapes[0] only). */
  mode: 'add';
  cx: number;
  cy: number;
  /** Normalized against the frame's max dimension (see file doc comment). */
  radius: number;
  /** 0..1 — feather band width as a fraction of `radius`. */
  feather: number;
  invert: boolean;
}

export interface LinearMaskShape {
  type: 'linear';
  mode: 'add';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0..1 — feather band width around the midline, in parametric (p0→p1) units. */
  feather: number;
  invert: boolean;
}

export type MaskShape = RadialMaskShape | LinearMaskShape;

export interface MaskParams {
  shapes: MaskShape[];
}

type Rgb = [number, number, number];

export function defaultRadialMaskShape(): RadialMaskShape {
  return { type: 'radial', mode: 'add', cx: 0.5, cy: 0.5, radius: 0.25, feather: 0.5, invert: false };
}

export function defaultLinearMaskShape(): LinearMaskShape {
  return { type: 'linear', mode: 'add', x0: 0.5, y0: 0, x1: 0.5, y1: 1, feather: 0.3, invert: false };
}

export function defaultMaskParams(): MaskParams {
  return { shapes: [defaultRadialMaskShape()] };
}

/** Clamp an already-typed shape into valid ranges (feather 0..1, radius >= 0, coords finite). */
export function clampMaskShape(shape: MaskShape): MaskShape {
  const feather = Math.min(1, Math.max(0, shape.feather));
  const invert = !!shape.invert;
  if (shape.type === 'linear') {
    return { type: 'linear', mode: 'add', x0: shape.x0, y0: shape.y0, x1: shape.x1, y1: shape.y1, feather, invert };
  }
  const radius = Math.min(4, Math.max(0, shape.radius));
  return { type: 'radial', mode: 'add', cx: shape.cx, cy: shape.cy, radius, feather, invert };
}

/** Normalize an untrusted mask shape; throws on non-finite numbers (sanitizeGeometry/sanitizeLens style). */
function sanitizeMaskShape(raw: unknown, path: string): MaskShape {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} must be an object`);
  const src = raw as Record<string, unknown>;
  const num = (v: unknown, fieldPath: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${fieldPath} must be a finite number`);
    return v;
  };
  const mode: 'add' = 'add'; // only combine mode today; accepted verbatim, otherwise ignored
  const invert = typeof src.invert === 'boolean' ? src.invert : false;
  if (src.type === 'linear') {
    return clampMaskShape({
      type: 'linear',
      mode,
      x0: num(src.x0, `${path}.x0`),
      y0: num(src.y0, `${path}.y0`),
      x1: num(src.x1, `${path}.x1`),
      y1: num(src.y1, `${path}.y1`),
      feather: num(src.feather ?? 0, `${path}.feather`),
      invert,
    });
  }
  if (src.type === 'radial') {
    return clampMaskShape({
      type: 'radial',
      mode,
      cx: num(src.cx, `${path}.cx`),
      cy: num(src.cy, `${path}.cy`),
      radius: num(src.radius, `${path}.radius`),
      feather: num(src.feather ?? 0, `${path}.feather`),
      invert,
    });
  }
  throw new Error(`${path}.type must be 'radial' or 'linear'`);
}

/** Normalize an untrusted mask payload; missing ⇒ the default single radial shape. */
export function sanitizeMaskParams(raw: unknown, nodeId: string): MaskParams {
  if (typeof raw !== 'object' || raw === null) return defaultMaskParams();
  const src = raw as { shapes?: unknown };
  if (!Array.isArray(src.shapes) || src.shapes.length === 0) return defaultMaskParams();
  return { shapes: src.shapes.map((s, i) => sanitizeMaskShape(s, `${nodeId}.mask.shapes[${i}]`)) };
}

/** Pack shapes[0] into the 32-byte uniform MASK_WGSL consumes (see its struct layout). */
export function packMaskUniform(shape: MaskShape): Float32Array {
  const f = new Float32Array(8);
  f[0] = shape.type === 'linear' ? 1 : 0;
  f[1] = shape.invert ? 1 : 0;
  f[2] = shape.feather;
  f[3] = 0;
  if (shape.type === 'radial') {
    f[4] = shape.cx;
    f[5] = shape.cy;
    f[6] = shape.radius;
    f[7] = 0;
  } else {
    f[4] = shape.x0;
    f[5] = shape.y0;
    f[6] = shape.x1;
    f[7] = shape.y1;
  }
  return f;
}

/**
 * Analytic mask pass. Ignores the source color entirely (c0/c from
 * nodePassWgsl are unused) — the node's only reason to read `src` at all is
 * `textureDimensions` for frame-size context, same reason it takes a chain
 * input (see graphDoc.ts's buildPlan mask branch doc comment).
 */
export const MASK_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct MaskParams {
  // x = shape type (0 radial / 1 linear), y = invert (0/1), z = feather, w unused
  p0: vec4f,
  // radial: x=cx, y=cy, z=radius (all normalized); linear: x=x0,y=y0,z=x1,w=y1 (normalized)
  p1: vec4f,
}
@group(0) @binding(1) var<uniform> u: MaskParams;
`,
  body: /* wgsl */ `
  {
    let dims = vec2f(textureDimensions(src));
    let maxDim = max(dims.x, dims.y);
    var v: f32;
    if (u.p0.x < 0.5) {
      // radial: pixel-space distance from center, scaled to normalized-radius units
      let center = vec2f(u.p1.x, u.p1.y) * dims;
      let radius = u.p1.z * maxDim;
      let dist = length(in.pos.xy - center);
      let e0 = radius * (1.0 - u.p0.z);
      let e1 = max(radius, e0 + 0.0001);
      v = 1.0 - smoothstep(e0, e1, dist);
    } else {
      // linear: parametric projection onto the p0->p1 axis (pixel space)
      let p0pix = vec2f(u.p1.x, u.p1.y) * dims;
      let p1pix = vec2f(u.p1.z, u.p1.w) * dims;
      let d = p1pix - p0pix;
      let lenSq = max(dot(d, d), 0.0001);
      let t = dot(in.pos.xy - p0pix, d) / lenSq;
      let band0 = 0.5 - u.p0.z * 0.5;
      let band1 = max(band0 + 0.0001, 0.5 + u.p0.z * 0.5);
      v = 1.0 - smoothstep(band0, band1, t);
    }
    if (u.p0.y > 0.5) {
      v = 1.0 - v;
    }
    c = vec3f(v, v, v);
  }
`,
});

/**
 * Exact CPU mirror of MASK_WGSL. `x`/`y` are the render-target's integer
 * texel coords, `width`/`height` its dims — same convention as
 * cpuFxPixel/cpuDevelopTone's position-aware mirrors. `px` (the chain's
 * input color at this pixel) is ignored, matching the WGSL pass.
 */
export function cpuMaskShape(shape: MaskShape, _px: Rgb, x: number, y: number, width: number, height: number): Rgb {
  const maxDim = Math.max(width, height);
  const px = x + 0.5;
  const py = y + 0.5;
  let v: number;
  if (shape.type === 'radial') {
    const cx = shape.cx * width;
    const cy = shape.cy * height;
    const radius = shape.radius * maxDim;
    const dist = Math.hypot(px - cx, py - cy);
    const e0 = radius * (1 - shape.feather);
    const e1 = Math.max(radius, e0 + 0.0001);
    v = 1 - smoothstepCpu(e0, e1, dist);
  } else {
    const x0 = shape.x0 * width;
    const y0 = shape.y0 * height;
    const x1 = shape.x1 * width;
    const y1 = shape.y1 * height;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = Math.max(dx * dx + dy * dy, 0.0001);
    const t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
    const band0 = 0.5 - shape.feather * 0.5;
    const band1 = Math.max(band0 + 0.0001, 0.5 + shape.feather * 0.5);
    v = 1 - smoothstepCpu(band0, band1, t);
  }
  if (shape.invert) v = 1 - v;
  return [v, v, v];
}
