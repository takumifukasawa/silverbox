import type { ViewportState } from './useCanvasViewport';

interface Props {
  mode: 'radial' | 'linear';
  /** Drag start/current, normalized 0..1 against the render output — same convention as maskNode.ts's shapes. */
  start: { x: number; y: number };
  current: { x: number; y: number };
  view: ViewportState;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Live outline shown WHILE dragging a new local-adjustment shape (draw-to-
 * create masks, UX pack B §1) — nothing is committed to the graph until
 * pointerup, this is purely a preview. Deliberately lighter than
 * MaskOverlay (no handles, no store writes): a sibling of the preview
 * <canvas>, inside the SAME pan/zoom transform, so it tracks the image
 * exactly regardless of zoom/pan (same contract as CropOverlay/MaskOverlay).
 * Radial: circle centered on the drag start, radius = drag distance (in the
 * SAME pixel-space-then-max-dimension-normalized convention maskNode.ts's
 * cpuMaskShape/MASK_WGSL use — visually, that normalization cancels out here
 * since this draws directly in canvas px, so the radius is simply the drag
 * distance). Linear: the start→current axis as a line.
 */
export function MaskDrawOverlay({ mode, start, current, view, canvasWidth, canvasHeight }: Props) {
  const cx = start.x * canvasWidth;
  const cy = start.y * canvasHeight;
  const dxPx = (current.x - start.x) * canvasWidth;
  const dyPx = (current.y - start.y) * canvasHeight;

  return (
    <svg
      className="mask-draw-overlay"
      data-testid="mask-draw-overlay"
      width={canvasWidth}
      height={canvasHeight}
      style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
    >
      {mode === 'radial' ? (
        <>
          <circle className="mask-draw-overlay-shape" cx={cx} cy={cy} r={Math.hypot(dxPx, dyPx)} />
          <circle className="mask-draw-overlay-center" cx={cx} cy={cy} r={3} />
        </>
      ) : (
        <line className="mask-draw-overlay-shape" x1={cx} y1={cy} x2={cx + dxPx} y2={cy + dyPx} />
      )}
    </svg>
  );
}
