import type { ViewportState } from './useCanvasViewport';

interface Props {
  /** Fixed at mousedown, normalized 0..1 against the render output — same convention as spotsNode.ts's Spot. */
  dst: { x: number; y: number };
  /** Follows the cursor while dragging. */
  src: { x: number; y: number };
  /** Current brush radius, normalized by max(canvasWidth, canvasHeight) — FIXED for the whole gesture (unlike mask draw, dragging moves the source, not the size). */
  radius: number;
  view: ViewportState;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Live preview while dragging a NEW spot (spot removal, task #50, UX pack
 * B-style create-by-drag) — nothing is committed until pointerup
 * (CanvasView.tsx's handleSpotPointerDown). Deliberately lighter than
 * SpotOverlay (no handles, no store writes): a sibling of the preview
 * <canvas>, inside the SAME pan/zoom transform, same contract as
 * MaskDrawOverlay. Solid circle at dst (fixed), dashed circle at src
 * (follows the cursor), thin connector line between them.
 */
export function SpotDrawOverlay({ dst, src, radius, view, canvasWidth, canvasHeight }: Props) {
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const rPx = radius * maxDim;
  const dstX = dst.x * canvasWidth;
  const dstY = dst.y * canvasHeight;
  const srcX = src.x * canvasWidth;
  const srcY = src.y * canvasHeight;
  return (
    <svg
      className="spot-draw-overlay"
      data-testid="spot-draw-overlay"
      width={canvasWidth}
      height={canvasHeight}
      style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
    >
      <line className="spot-draw-overlay-connector" x1={dstX} y1={dstY} x2={srcX} y2={srcY} />
      <circle className="spot-draw-overlay-dst" cx={dstX} cy={dstY} r={rPx} />
      <circle className="spot-draw-overlay-src" cx={srcX} cy={srcY} r={rPx} />
    </svg>
  );
}
