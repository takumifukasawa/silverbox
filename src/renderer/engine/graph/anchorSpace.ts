/**
 * Anchor-space coordinate conversion (UX pack C §1).
 *
 * Masks (radial center, linear endpoints) and spots (dst/src centers) are
 * STORED normalized against the ORIENTED FULL frame — post-orientation, but
 * PRE-crop and PRE-rotation ("anchor space"), the same frame `geometry.crop`
 * is normalized against (see graphDoc.ts / cropFit.ts). That anchors them to
 * the IMAGE, so rotating/cropping never re-points a spot at different image
 * content (Lightroom behavior).
 *
 * The passes, however, evaluate in the OUTPUT frame (the cropped/straightened
 * raster the resample produces — see graphRenderer.ts's RESAMPLE_SHADER), so
 * coords must be converted anchor→output when packing uniforms (buildPlan) and
 * when drawing overlays, and output→anchor when a gesture writes to the store.
 *
 * The exact geometry map (all in ORIENTED px, O = oriented center,
 * cropOrigin = crop.x/y × oriented dims) reproduces the shader:
 *   output texel `pos` samples source `q = rot(pos + cropOrigin − O, −a) + O`
 * so an anchor-space point `a` appears at output position
 *   `pos = rot(a − O, +a) + O − cropOrigin`
 * (`rot` is cropFit.ts's exact y-down shader rotation, REUSED here). Rotation
 * preserves distances and crop is a plain window (no scaling), so a radius
 * converts only by the normalization denominator (oriented max dim → output
 * max dim). Only the ORIENTED-frame ASPECT RATIO enters — the conversion is
 * resolution-independent (preview vs. export give the identical normalized
 * result).
 *
 * Identity guard: when the crop is full and the angle is 0 the map is the
 * identity (orientation alone never moves a point WITHIN its own oriented
 * frame), so anchor and output coords coincide — bit-exact, and every
 * pre-existing identity-geometry doc/verify is untouched.
 */
import { rot } from './cropFit';
import type { GeometryParams } from './graphDoc';
import type { MaskShape } from './maskNode';
import type { Spot } from './spotsNode';

const DEG = Math.PI / 180;

export interface NormPoint {
  x: number;
  y: number;
}

/**
 * True when the anchor↔output map is the identity: full crop + zero angle.
 * Deliberately IGNORES orientation — a 90°/flip turn swaps the oriented dims
 * (ow/oh the caller passes) but never moves a point within its own oriented
 * frame, so with a full crop and no straighten the normalized coords coincide.
 */
function isIdentityMap(geom: GeometryParams): boolean {
  const c = geom.crop;
  return geom.angle === 0 && c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
}

/** Anchor-space normalized point → output-frame normalized point. `ow`/`oh` = oriented dims. */
export function anchorToOutput(nx: number, ny: number, geom: GeometryParams, ow: number, oh: number): NormPoint {
  if (isIdentityMap(geom)) return { x: nx, y: ny };
  const a = geom.angle * DEG;
  const { crop } = geom;
  const vx = (nx - 0.5) * ow;
  const vy = (ny - 0.5) * oh;
  const [rx, ry] = rot(vx, vy, a); // forward rot(v, +a) — inverse of the shader's sampling rotate
  const px = rx + ow / 2 - crop.x * ow;
  const py = ry + oh / 2 - crop.y * oh;
  return { x: px / (crop.w * ow), y: py / (crop.h * oh) };
}

/** Output-frame normalized point → anchor-space normalized point (inverse of anchorToOutput). */
export function outputToAnchor(nx: number, ny: number, geom: GeometryParams, ow: number, oh: number): NormPoint {
  if (isIdentityMap(geom)) return { x: nx, y: ny };
  const a = geom.angle * DEG;
  const { crop } = geom;
  const posx = nx * crop.w * ow;
  const posy = ny * crop.h * oh;
  const [qx, qy] = rot(posx + crop.x * ow - ow / 2, posy + crop.y * oh - oh / 2, -a);
  return { x: (qx + ow / 2) / ow, y: (qy + oh / 2) / oh };
}

/** Anchor-space radius (÷ oriented max dim) → output-space radius (÷ output max dim). */
export function anchorRadiusToOutput(r: number, geom: GeometryParams, ow: number, oh: number): number {
  if (isIdentityMap(geom)) return r;
  const anchorMax = Math.max(ow, oh);
  const outputMax = Math.max(geom.crop.w * ow, geom.crop.h * oh);
  return (r * anchorMax) / outputMax;
}

/** Output-space radius → anchor-space radius (inverse of anchorRadiusToOutput). */
export function outputRadiusToAnchor(r: number, geom: GeometryParams, ow: number, oh: number): number {
  if (isIdentityMap(geom)) return r;
  const anchorMax = Math.max(ow, oh);
  const outputMax = Math.max(geom.crop.w * ow, geom.crop.h * oh);
  return (r * outputMax) / anchorMax;
}

/** Convert a mask shape's spatial fields anchor→output (colorKey has none — returned untouched). */
export function maskShapeAnchorToOutput(shape: MaskShape, geom: GeometryParams, ow: number, oh: number): MaskShape {
  if (shape.type === 'radial') {
    const c = anchorToOutput(shape.cx, shape.cy, geom, ow, oh);
    return { ...shape, cx: c.x, cy: c.y, radius: anchorRadiusToOutput(shape.radius, geom, ow, oh) };
  }
  if (shape.type === 'linear') {
    const p0 = anchorToOutput(shape.x0, shape.y0, geom, ow, oh);
    const p1 = anchorToOutput(shape.x1, shape.y1, geom, ow, oh);
    return { ...shape, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  }
  return shape;
}

/** Convert a mask shape's spatial fields output→anchor (inverse of maskShapeAnchorToOutput). */
export function maskShapeOutputToAnchor(shape: MaskShape, geom: GeometryParams, ow: number, oh: number): MaskShape {
  if (shape.type === 'radial') {
    const c = outputToAnchor(shape.cx, shape.cy, geom, ow, oh);
    return { ...shape, cx: c.x, cy: c.y, radius: outputRadiusToAnchor(shape.radius, geom, ow, oh) };
  }
  if (shape.type === 'linear') {
    const p0 = outputToAnchor(shape.x0, shape.y0, geom, ow, oh);
    const p1 = outputToAnchor(shape.x1, shape.y1, geom, ow, oh);
    return { ...shape, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  }
  return shape;
}

/** Convert a spot's dst/src centers + radius anchor→output. */
export function spotAnchorToOutput(spot: Spot, geom: GeometryParams, ow: number, oh: number): Spot {
  const dst = anchorToOutput(spot.dx, spot.dy, geom, ow, oh);
  const src = anchorToOutput(spot.sx, spot.sy, geom, ow, oh);
  return { ...spot, dx: dst.x, dy: dst.y, sx: src.x, sy: src.y, radius: anchorRadiusToOutput(spot.radius, geom, ow, oh) };
}

/** Convert a spot's dst/src centers + radius output→anchor (inverse of spotAnchorToOutput). */
export function spotOutputToAnchor(spot: Spot, geom: GeometryParams, ow: number, oh: number): Spot {
  const dst = outputToAnchor(spot.dx, spot.dy, geom, ow, oh);
  const src = outputToAnchor(spot.sx, spot.sy, geom, ow, oh);
  return { ...spot, dx: dst.x, dy: dst.y, sx: src.x, sy: src.y, radius: outputRadiusToAnchor(spot.radius, geom, ow, oh) };
}
