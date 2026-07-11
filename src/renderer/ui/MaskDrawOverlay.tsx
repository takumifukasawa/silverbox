import type { ViewportState } from './useCanvasViewport';
import { MaskShapePreview, type PreviewShape } from './MaskShapePreview';

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
 * Live area preview shown WHILE dragging a new local-adjustment shape (draw-
 * to-create masks) — nothing is committed to the graph until pointerup, this
 * is purely a preview. A sibling of the preview <canvas>, inside the SAME
 * pan/zoom transform, so it tracks the image exactly (same contract as
 * CropOverlay/MaskOverlay). Both start/current are OUTPUT-frame normalized
 * (CanvasView's imagePointFromClient), so they map straight into
 * MaskShapePreview (UX pack C §5) — the SAME LR-style area rendering the
 * post-create MaskOverlay uses. The feather values match what pointerup
 * commits (radial 0.5, linear 0.3) so the preview reads the affected area, not
 * just an outline.
 */
export function MaskDrawOverlay({ mode, start, current, view, canvasWidth, canvasHeight }: Props) {
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const dxPx = (current.x - start.x) * canvasWidth;
  const dyPx = (current.y - start.y) * canvasHeight;

  const shape: PreviewShape =
    mode === 'radial'
      ? { type: 'radial', cx: start.x, cy: start.y, radius: Math.hypot(dxPx, dyPx) / maxDim, feather: 0.5 }
      : { type: 'linear', x0: start.x, y0: start.y, x1: current.x, y1: current.y, feather: 0.3 };

  return (
    <svg
      className="mask-draw-overlay"
      data-testid="mask-draw-overlay"
      width={canvasWidth}
      height={canvasHeight}
      style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
    >
      <MaskShapePreview shape={shape} canvasWidth={canvasWidth} canvasHeight={canvasHeight} />
      {mode === 'radial' && <circle className="mask-draw-overlay-center" cx={start.x * canvasWidth} cy={start.y * canvasHeight} r={3} />}
    </svg>
  );
}
