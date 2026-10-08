/**
 * Pixel loupe geometry (LR-style eyedropper magnifier): the pure math behind
 * PixelLoupe.tsx, kept free of React/DOM so vitest can cover it.
 *
 * The loupe shows the DISPLAYED canvas pixels (what the user sees, look
 * applied), magnified nearest-neighbour, with the sampled pixel outlined in
 * the center. The pick handlers themselves still sample whatever they always
 * did (WB: the decoded pixel); the loupe only helps aim at one pixel.
 */

/** Odd, so one cell sits exactly in the center. */
export const LOUPE_CELLS = 11;
export const LOUPE_CELL_PX = 12;
export const LOUPE_PX = LOUPE_CELLS * LOUPE_CELL_PX;
/** Gap between the cursor and the loupe's nearest corner. */
export const LOUPE_OFFSET = 24;

export interface ViewTransform {
  tx: number;
  ty: number;
  scale: number;
}

/**
 * Container-local point → canvas pixel. The same mapping handleWbPick uses:
 * the canvas's untransformed grid is the image 1:1 and only a CSS
 * translate+scale pans/zooms it.
 */
export function localToImagePixel(localX: number, localY: number, view: ViewTransform): { x: number; y: number } {
  return { x: Math.floor((localX - view.tx) / view.scale), y: Math.floor((localY - view.ty) / view.scale) };
}

/**
 * Top-left of a `size` box placed beside the cursor inside `bounds`: below
 * right by default, flipped to the left / above when it would overflow, and
 * finally clamped so it never leaves the bounds.
 */
export function loupePlacement(
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  bounds: { w: number; h: number },
  offset = LOUPE_OFFSET
): { left: number; top: number } {
  let left = cursor.x + offset;
  if (left + size.w > bounds.w) left = cursor.x - offset - size.w;
  let top = cursor.y + offset;
  if (top + size.h > bounds.h) top = cursor.y - offset - size.h;
  left = Math.min(Math.max(left, 0), Math.max(0, bounds.w - size.w));
  top = Math.min(Math.max(top, 0), Math.max(0, bounds.h - size.h));
  return { left, top };
}
