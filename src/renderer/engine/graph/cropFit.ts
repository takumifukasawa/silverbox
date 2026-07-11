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
