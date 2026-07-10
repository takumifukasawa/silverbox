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
 * ColorKey mask (secondary): unlike radial/linear, this is the only shape
 * that reads the pass's own input color (`c0`/`px`) — radial/linear ignore
 * it entirely (see MASK_WGSL's doc comment). The pixel's hue/sat/lum are
 * computed in the SAME encoded-working-space HSL terms the Develop HSL band
 * op uses (WGSL_HSL_HELPERS' rgb2hsl, fed sRGB-curve-encoded clamped working
 * color — see developOps.ts). Per axis (hue/sat/lum), weight is 1 inside the
 * shape's half-range (`*Range`/2 either side of the target value) and
 * smoothstep-falls to 0 over an extra `softness * range` band beyond that
 * half-range; hue distance wraps at 360 (the shorter way around the circle).
 * The final key is the PRODUCT of the three axis weights (all three axes
 * must agree for a pixel to key in); `invert` flips it, same as the other
 * shapes.
 *
 * Both the WGSL pass (evaluated per-pixel on the GPU) and `cpuMaskShape`
 * (the exact CPU mirror, same (px, x, y, w, h) signature every other
 * position-aware CPU mirror in this codebase uses) MUST stay in lockstep —
 * they encode literally the same formula.
 */
import { srgbEncode } from '../color/srgb';
import { cpuRgb2hsl, WGSL_HSL_HELPERS } from './developOps';
import { nodePassWgsl, smoothstepCpu, WGSL_SRGB_ENCODE } from './wgslCommon';

export const MASK_KIND = 'mask';

export type MaskShapeType = 'radial' | 'linear' | 'colorKey';

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

export interface ColorKeyMaskShape {
  type: 'colorKey';
  mode: 'add';
  /** Target hue, 0..360 degrees. */
  hue: number;
  /** Full width of the hue band centered on `hue`, degrees; half either side is the flat interior. */
  hueRange: number;
  /** Target saturation, 0..1 (display-encoded HSL, see the file doc comment). */
  sat: number;
  /** Full width of the saturation band centered on `sat`, 0..1. */
  satRange: number;
  /** Target luminance, 0..1 (display-encoded HSL). */
  lum: number;
  /** Full width of the luminance band centered on `lum`, 0..1. */
  lumRange: number;
  /** 0..1 — extra falloff band beyond each axis's half-range, as a fraction of that axis's range. */
  softness: number;
  invert: boolean;
}

export type MaskShape = RadialMaskShape | LinearMaskShape | ColorKeyMaskShape;

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

export function defaultColorKeyMaskShape(): ColorKeyMaskShape {
  return {
    type: 'colorKey',
    mode: 'add',
    hue: 120,
    hueRange: 30,
    sat: 0.5,
    satRange: 0.35,
    lum: 0.5,
    lumRange: 0.35,
    softness: 0.5,
    invert: false,
  };
}

export function defaultMaskParams(): MaskParams {
  return { shapes: [defaultRadialMaskShape()] };
}

/** Clamp an already-typed shape into valid ranges (feather 0..1, radius >= 0, coords finite). */
export function clampMaskShape(shape: MaskShape): MaskShape {
  const invert = !!shape.invert;
  if (shape.type === 'colorKey') {
    const hue = ((shape.hue % 360) + 360) % 360;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    return {
      type: 'colorKey',
      mode: 'add',
      hue,
      hueRange: Math.min(180, Math.max(0, shape.hueRange)),
      sat: clamp01(shape.sat),
      satRange: clamp01(shape.satRange),
      lum: clamp01(shape.lum),
      lumRange: clamp01(shape.lumRange),
      softness: clamp01(shape.softness),
      invert,
    };
  }
  const feather = Math.min(1, Math.max(0, shape.feather));
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
  if (src.type === 'colorKey') {
    return clampMaskShape({
      type: 'colorKey',
      mode,
      hue: num(src.hue, `${path}.hue`),
      hueRange: num(src.hueRange ?? 30, `${path}.hueRange`),
      sat: num(src.sat, `${path}.sat`),
      satRange: num(src.satRange ?? 0.35, `${path}.satRange`),
      lum: num(src.lum, `${path}.lum`),
      lumRange: num(src.lumRange ?? 0.35, `${path}.lumRange`),
      softness: num(src.softness ?? 0.5, `${path}.softness`),
      invert,
    });
  }
  throw new Error(`${path}.type must be 'radial', 'linear', or 'colorKey'`);
}

/** Normalize an untrusted mask payload; missing ⇒ the default single radial shape. */
export function sanitizeMaskParams(raw: unknown, nodeId: string): MaskParams {
  if (typeof raw !== 'object' || raw === null) return defaultMaskParams();
  const src = raw as { shapes?: unknown };
  if (!Array.isArray(src.shapes) || src.shapes.length === 0) return defaultMaskParams();
  return { shapes: src.shapes.map((s, i) => sanitizeMaskShape(s, `${nodeId}.mask.shapes[${i}]`)) };
}

/** Pack shapes[0] into the 48-byte uniform MASK_WGSL consumes (see its struct layout). */
export function packMaskUniform(shape: MaskShape): Float32Array {
  const f = new Float32Array(12);
  f[1] = shape.invert ? 1 : 0;
  if (shape.type === 'radial') {
    f[0] = 0;
    f[2] = shape.feather;
    f[4] = shape.cx;
    f[5] = shape.cy;
    f[6] = shape.radius;
  } else if (shape.type === 'linear') {
    f[0] = 1;
    f[2] = shape.feather;
    f[4] = shape.x0;
    f[5] = shape.y0;
    f[6] = shape.x1;
    f[7] = shape.y1;
  } else {
    f[0] = 2;
    f[2] = shape.softness;
    f[4] = shape.hue;
    f[5] = shape.hueRange;
    f[6] = shape.sat;
    f[7] = shape.satRange;
    f[8] = shape.lum;
    f[9] = shape.lumRange;
  }
  return f;
}

/**
 * Analytic mask pass. Radial/linear ignore the source color entirely (c0/c
 * from nodePassWgsl are unused there) — their only reason to read `src` at
 * all is `textureDimensions` for frame-size context, same reason the mask
 * node takes a chain input (see graphDoc.ts's buildPlan mask branch doc
 * comment). colorKey is the exception: it keys on `c0`, the pass's own input
 * pixel (see the file doc comment for the exact per-axis formula).
 */
export const MASK_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct MaskParams {
  // x = shape type (0 radial / 1 linear / 2 colorKey), y = invert (0/1),
  // z = feather (radial/linear) or softness (colorKey), w unused
  p0: vec4f,
  // radial: x=cx, y=cy, z=radius (normalized); linear: x=x0,y=y0,z=x1,w=y1
  // (normalized); colorKey: x=hue(deg), y=hueRange(deg), z=sat, w=satRange
  p1: vec4f,
  // colorKey only: x=lum, y=lumRange, zw unused
  p2: vec4f,
}
@group(0) @binding(1) var<uniform> u: MaskParams;
`,
  helpers: WGSL_SRGB_ENCODE + WGSL_HSL_HELPERS,
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
    } else if (u.p0.x < 1.5) {
      // linear: parametric projection onto the p0->p1 axis (pixel space)
      let p0pix = vec2f(u.p1.x, u.p1.y) * dims;
      let p1pix = vec2f(u.p1.z, u.p1.w) * dims;
      let d = p1pix - p0pix;
      let lenSq = max(dot(d, d), 0.0001);
      let t = dot(in.pos.xy - p0pix, d) / lenSq;
      let band0 = 0.5 - u.p0.z * 0.5;
      let band1 = max(band0 + 0.0001, 0.5 + u.p0.z * 0.5);
      v = 1.0 - smoothstep(band0, band1, t);
    } else {
      // colorKey: hue/sat/lum of THIS pass's own input pixel, same
      // encoded-working-space HSL terms the Develop HSL band op uses
      let enc = srgbEncode(clamp(c0.rgb, vec3f(0.0), vec3f(1.0)));
      let hsl = rgb2hsl(enc);
      let softness = u.p0.z;
      let hueDist0 = abs(hsl.x - u.p1.x);
      let hueDist = min(hueDist0, 360.0 - hueDist0);
      let hueE0 = u.p1.y * 0.5;
      let hueE1 = hueE0 + max(softness * u.p1.y, 0.0001);
      let hueWeight = 1.0 - smoothstep(hueE0, hueE1, hueDist);
      let satDist = abs(hsl.y - u.p1.z);
      let satE0 = u.p1.w * 0.5;
      let satE1 = satE0 + max(softness * u.p1.w, 0.0001);
      let satWeight = 1.0 - smoothstep(satE0, satE1, satDist);
      let lumDist = abs(hsl.z - u.p2.x);
      let lumE0 = u.p2.y * 0.5;
      let lumE1 = lumE0 + max(softness * u.p2.y, 0.0001);
      let lumWeight = 1.0 - smoothstep(lumE0, lumE1, lumDist);
      v = hueWeight * satWeight * lumWeight;
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
 * cpuFxPixel/cpuDevelopTone's position-aware mirrors. `srcColor` (the
 * chain's input color at this pixel) is ignored by radial/linear, matching
 * the WGSL pass, but IS used by colorKey.
 */
export function cpuMaskShape(
  shape: MaskShape,
  srcColor: Rgb,
  x: number,
  y: number,
  width: number,
  height: number
): Rgb {
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
  } else if (shape.type === 'linear') {
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
  } else {
    const enc: Rgb = [
      srgbEncode(Math.min(Math.max(srcColor[0], 0), 1)),
      srgbEncode(Math.min(Math.max(srcColor[1], 0), 1)),
      srgbEncode(Math.min(Math.max(srcColor[2], 0), 1)),
    ];
    const [h, s, l] = cpuRgb2hsl(enc);
    const softness = shape.softness;
    const axisWeight = (dist: number, range: number): number => {
      const e0 = range * 0.5;
      const e1 = e0 + Math.max(softness * range, 0.0001);
      return 1 - smoothstepCpu(e0, e1, dist);
    };
    const hueDist0 = Math.abs(h - shape.hue);
    const hueDist = Math.min(hueDist0, 360 - hueDist0);
    const hueWeight = axisWeight(hueDist, shape.hueRange);
    const satWeight = axisWeight(Math.abs(s - shape.sat), shape.satRange);
    const lumWeight = axisWeight(Math.abs(l - shape.lum), shape.lumRange);
    v = hueWeight * satWeight * lumWeight;
  }
  if (shape.invert) v = 1 - v;
  return [v, v, v];
}
