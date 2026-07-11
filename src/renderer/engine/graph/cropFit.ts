import type { GeometryCrop } from './graphDoc';

/**
 * Pure math for Lightroom-style crop-rotation ("straighten"): as the angle
 * changes, keep the SAME image detail under the crop-rect center (pivot around
 * the rect center, not the frame center the shader actually rotates about) and
 * auto-shrink the rect just enough that it never contains void.
 *
 * All work happens in ORIENTED-pixel space: W×H are the oriented frame dims
 * (post-orientation, pre-crop — the same reference frame `crop` is normalized
 * against, see graphDoc.ts / RESAMPLE_SHADER), O = (W/2, H/2) is the frame
 * center the shader pivots around.
 *
 * `rot` reproduces RESAMPLE_SHADER's `rotate(v, a)` EXACTLY (y-down texel
 * space): rot(v, +a) = (v.x·cos a + v.y·sin a, −v.x·sin a + v.y·cos a). The
 * shader's inverse map is `q = rot(p − O, −a) + O` (rotated-plane point p →
 * source point q); the forward is `p = rot(q − O, +a) + O`. A rotated-plane
 * point p is VOID-FREE iff its source q lands inside [0,W]×[0,H].
 */
export function rot(vx: number, vy: number, angleRad: number): [number, number] {
  const s = Math.sin(angleRad);
  const c = Math.cos(angleRad);
  return [vx * c + vy * s, -vx * s + vy * c];
}

const DEG = Math.PI / 180;

/** Boundary slack in source px — keeps float noise from rejecting rects that sit exactly on the border. */
const EDGE_EPS = 1e-4;

/** True iff every corner of `crop` (normalized, rotated plane) samples inside the source frame. */
export function cropRectValid(params: { W: number; H: number; crop: GeometryCrop; angle: number }): boolean {
  const { W, H, crop, angle } = params;
  const a = angle * DEG;
  const Ox = W / 2;
  const Oy = H / 2;
  const cornerFractions: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const [fx, fy] of cornerFractions) {
    const px = (crop.x + fx * crop.w) * W;
    const py = (crop.y + fy * crop.h) * H;
    const [sx, sy] = rot(px - Ox, py - Oy, -a);
    if (sx + Ox < -EDGE_EPS || sy + Oy < -EDGE_EPS || sx + Ox > W + EDGE_EPS || sy + Oy > H + EDGE_EPS) return false;
  }
  return true;
}

/**
 * MOVE constraint: clamp a rect of FIXED size so it stays inside the rotated
 * source frame, sliding along the boundary instead of stopping dead. Closed
 * form: the rect's four rotated corner offsets span ±(ex, ey) in source space
 * (ex = hw·|cos a| + hh·|sin a|, ey the transpose), so the rect is valid iff
 * its center's SOURCE position lies in the box inset by (ex, ey) — clamp the
 * center there and map back. If the rect is too big to fit at this angle at
 * all (2·ex > W or 2·ey > H), the center pins to the frame middle: the best
 * available position (the rotate/slider fit path is what shrinks rects, not
 * this).
 */
export function clampMoveToRotatedFrame(params: {
  W: number;
  H: number;
  crop: GeometryCrop;
  angle: number;
}): GeometryCrop {
  const { W, H, crop, angle } = params;
  const a = angle * DEG;
  const Ox = W / 2;
  const Oy = H / 2;
  const hw = (crop.w * W) / 2;
  const hh = (crop.h * H) / 2;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  const cx = (crop.x + crop.w / 2) * W;
  const cy = (crop.y + crop.h / 2) * H;
  const [rsx, rsy] = rot(cx - Ox, cy - Oy, -a);
  const srcX = 2 * ex > W ? Ox : Math.min(W - ex, Math.max(ex, rsx + Ox));
  const srcY = 2 * ey > H ? Oy : Math.min(H - ey, Math.max(ey, rsy + Oy));
  const [bx, by] = rot(srcX - Ox, srcY - Oy, a);
  return { x: (bx + Ox) / W - crop.w / 2, y: (by + Oy) / H - crop.h / 2, w: crop.w, h: crop.h };
}

/**
 * RESIZE constraint: the corner-validity constraints are affine in
 * (x, y, w, h), so the valid set is CONVEX — along the straight path from a
 * valid `from` rect to an invalid `to` proposal the feasible prefix is an
 * interval, and a binary search finds its end exactly (the drag simply stops
 * at the frame boundary). Returns `to` unchanged when it is already valid,
 * and refuses to "rescue" a `from` that was never valid itself (pre-existing
 * hand-written-sidecar rects must not get silently rewritten by a drag).
 */
export function constrainRectAlongPath(params: {
  W: number;
  H: number;
  from: GeometryCrop;
  to: GeometryCrop;
  angle: number;
}): GeometryCrop {
  const { W, H, from, to, angle } = params;
  if (cropRectValid({ W, H, crop: to, angle })) return to;
  if (!cropRectValid({ W, H, crop: from, angle })) return to;
  let lo = 0;
  let hi = 1;
  const lerp = (t: number): GeometryCrop => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    w: from.w + (to.w - from.w) * t,
    h: from.h + (to.h - from.h) * t,
  });
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cropRectValid({ W, H, crop: lerp(mid), angle })) lo = mid;
    else hi = mid;
  }
  return lerp(lo);
}

export interface FitResult {
  crop: GeometryCrop;
  /** The auto-shrink factor in (0,1]: rect size = (w0·scale, h0·scale). */
  scale: number;
}

/**
 * Given the drag-start (or slider-seed) rect `crop0` at angle `angle0`, return
 * the rect at the new `angle` that (a) keeps the same source detail under the
 * rect center and (b) is shrunk by the maximum scale ≤ 1 that keeps all four
 * corners void-free.
 *
 * The shrink is recomputed FRESH from `crop0` every call (never cumulative),
 * so within one drag, sweeping the angle out and back to `angle0` restores
 * `crop0` exactly. Angles are in degrees.
 *
 * NOTE: the returned crop is normalized against W×H but is NOT clamped to
 * [0,1] here — for an off-center rect the void-free rect can legitimately
 * poke past the axis-aligned oriented frame while still lying inside the
 * ROTATED frame. Callers that must keep the rect inside [0,1] (e.g. because
 * setGeometry runs clampGeometry) accept that clamp as a minor deviation; the
 * verify suite exercises the centered full-frame case where it never triggers.
 */
export function fitRotatedCrop(params: {
  W: number;
  H: number;
  crop0: GeometryCrop;
  angle0: number;
  angle: number;
}): FitResult {
  const { W, H, crop0, angle0, angle } = params;
  const a0 = angle0 * DEG;
  const a = angle * DEG;
  const Ox = W / 2;
  const Oy = H / 2;

  // drag-start rect center + half-extents, in oriented pixels
  const cx0 = (crop0.x + crop0.w / 2) * W;
  const cy0 = (crop0.y + crop0.h / 2) * H;
  const hw = (crop0.w * W) / 2;
  const hh = (crop0.h * H) / 2;

  // source point under the rect center at drag start (inside [0,W]×[0,H] by
  // construction, since crop0 was itself a valid rect at angle0)
  const [ax, ay] = rot(cx0 - Ox, cy0 - Oy, -a0);
  const anchorX = ax + Ox;
  const anchorY = ay + Oy;

  // corner half-diagonal offsets d_i = corner_i − c0
  const dirs: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];

  // Each corner's source is anchor + s·rot(d_i, −a); require it ∈ [0,W]×[0,H].
  // Every constraint is linear in s ≥ 0, so collect the tightest upper bound.
  let s = 1;
  for (const [dx, dy] of dirs) {
    const [rx, ry] = rot(dx, dy, -a);
    // x: 0 ≤ anchorX + s·rx ≤ W
    if (rx > 1e-9) s = Math.min(s, (W - anchorX) / rx);
    else if (rx < -1e-9) s = Math.min(s, (0 - anchorX) / rx);
    // y: 0 ≤ anchorY + s·ry ≤ H
    if (ry > 1e-9) s = Math.min(s, (H - anchorY) / ry);
    else if (ry < -1e-9) s = Math.min(s, (0 - anchorY) / ry);
  }
  s = Math.max(0, Math.min(1, s));

  // rect center at the new angle (perceived pivot around the rect center)
  const [rcx, rcy] = rot(anchorX - Ox, anchorY - Oy, a);
  const cx = rcx + Ox;
  const cy = rcy + Oy;

  const w = crop0.w * s;
  const h = crop0.h * s;
  return {
    crop: {
      x: cx / W - w / 2,
      y: cy / H - h / 2,
      w,
      h,
    },
    scale: s,
  };
}
