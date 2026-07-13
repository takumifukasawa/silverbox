import type { ViewportState } from './useCanvasViewport';

interface Props {
  /** Pointer position, normalized 0..1 against the render output — same convention as spotsNode.ts's Spot / SpotDrawOverlay. */
  pos: { x: number; y: number };
  /** Current NEXT-spot brush radius, normalized by max(canvasWidth, canvasHeight) — same convention as SpotDrawOverlay. */
  radius: number;
  view: ViewportState;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Round-12 fix pack item 5 ("調整はできるけど十字カーソルだとサイズが伝わらない"): LR's
 * brush-cursor treatment for spot mode — a circle outline at the CURRENT
 * brush radius plus a small center cross, following the pointer whenever it
 * is over the canvas in spot mode AND no drag is in progress (CanvasView.tsx
 * only renders this while `spotDraft` is null; SpotDrawOverlay above takes
 * over the instant a drag actually starts). The `[`/`]`/wheel radius
 * adjustments resize it for free — it just reads the same `spotBrushRadius`
 * store value SpotOverlay's own next-spot slider does, no extra wiring.
 *
 * Two-tone (white + dark) stroke — the same idea as .crop-rect's box-shadow
 * halo (round-10 fix pack item 5), reimplemented as a paired dark-under /
 * white-over stroke since an SVG shape can't take a box-shadow (same
 * double-stroke trick CropOverlay.tsx's rotate glyph uses).
 */
export function SpotBrushCursor({ pos, radius, view, canvasWidth, canvasHeight }: Props) {
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const rPx = radius * maxDim;
  const cx = pos.x * canvasWidth;
  const cy = pos.y * canvasHeight;
  // Small fixed-ish cross, capped so it never outgrows a tiny brush circle.
  const crossHalf = Math.min(6, rPx * 0.4);
  return (
    <svg
      className="spot-brush-cursor"
      data-testid="spot-brush-cursor"
      width={canvasWidth}
      height={canvasHeight}
      style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
    >
      <circle className="spot-brush-cursor-ring-under" cx={cx} cy={cy} r={rPx} />
      <circle className="spot-brush-cursor-ring" cx={cx} cy={cy} r={rPx} />
      <line className="spot-brush-cursor-cross-under" x1={cx - crossHalf} y1={cy} x2={cx + crossHalf} y2={cy} />
      <line className="spot-brush-cursor-cross-under" x1={cx} y1={cy - crossHalf} x2={cx} y2={cy + crossHalf} />
      <line className="spot-brush-cursor-cross" x1={cx - crossHalf} y1={cy} x2={cx + crossHalf} y2={cy} />
      <line className="spot-brush-cursor-cross" x1={cx} y1={cy - crossHalf} x2={cx} y2={cy + crossHalf} />
    </svg>
  );
}
