import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { defaultMaskParams, defaultLinearMaskShape, defaultRadialMaskShape, type MaskShape } from '../engine/graph/maskNode';
import type { GraphNode } from '../engine/graph/graphDoc';
import type { ViewportState } from './useCanvasViewport';

interface Props {
  node: GraphNode;
  view: ViewportState;
  /** Render-output dims (px) — mask coordinates are normalized against these (see maskNode.ts's doc comment). */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Mask-editing overlay (masks milestone): on-canvas handles for the selected
 * mask node's shapes[0], rendered as a sibling of the preview <canvas>,
 * inside the SAME pan/zoom transform as CropOverlay — same precedent, same
 * pointer-capture drag pattern, same one-drag-one-undo-entry coalescing via
 * a session key threaded through every mutation of a single drag.
 *
 * Radial: a center handle (drag to move) + one rim handle at angle 0 (east)
 * from center (drag to resize the radius — measured as the new distance from
 * center, not just the horizontal delta, so a diagonal drag still tracks
 * naturally). Linear: two endpoint handles (p0/p1), each independent.
 */
export function MaskOverlay({ node, view, canvasWidth, canvasHeight }: Props) {
  const setMaskShape = useAppStore((s) => s.setMaskShape);
  const shapes = node.mask?.shapes ?? defaultMaskParams().shapes;
  const shape = shapes[0] ?? defaultMaskParams().shapes[0]!;
  const sessionRef = useRef<number | null>(null);
  const maxDim = Math.max(canvasWidth, canvasHeight);

  const commit = (next: MaskShape) => {
    sessionRef.current ??= Date.now();
    setMaskShape(node.id, next, `mask:${node.id}:${sessionRef.current}`);
  };

  const endSession = () => {
    sessionRef.current = null;
  };

  const beginCenterDrag = (ev: React.PointerEvent) => {
    if (shape.type !== 'radial') return;
    ev.stopPropagation();
    ev.preventDefault();
    const start = shape;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      commit({ ...start, cx: Math.min(1, Math.max(0, start.cx + dx)), cy: Math.min(1, Math.max(0, start.cy + dy)) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginRimDrag = (ev: React.PointerEvent) => {
    if (shape.type !== 'radial') return;
    ev.stopPropagation();
    ev.preventDefault();
    const start = shape;
    const centerPxX = start.cx * canvasWidth;
    const centerPxY = start.cy * canvasHeight;
    const startRadiusPx = start.radius * maxDim;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale;
      const dy = (e.clientY - startY) / view.scale;
      const handleX = centerPxX + startRadiusPx + dx;
      const handleY = centerPxY + dy;
      const radiusPx = Math.hypot(handleX - centerPxX, handleY - centerPxY);
      commit({ ...start, radius: Math.max(0.01, radiusPx / maxDim) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginEndpointDrag = (which: 'p0' | 'p1') => (ev: React.PointerEvent) => {
    if (shape.type !== 'linear') return;
    ev.stopPropagation();
    ev.preventDefault();
    const start = shape;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      if (which === 'p0') {
        commit({ ...start, x0: start.x0 + dx, y0: start.y0 + dy });
      } else {
        commit({ ...start, x1: start.x1 + dx, y1: start.y1 + dy });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      className="mask-overlay"
      data-testid="mask-overlay"
      style={{
        width: canvasWidth,
        height: canvasHeight,
        transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
      }}
    >
      {shape.type === 'radial' ? (
        <>
          <div
            className="mask-handle mask-handle-center"
            data-testid="mask-handle-center"
            style={{ left: pct(shape.cx), top: pct(shape.cy) }}
            onPointerDown={beginCenterDrag}
          />
          <div
            className="mask-handle mask-handle-rim"
            data-testid="mask-handle-rim"
            style={{
              left: shape.cx * canvasWidth + shape.radius * maxDim,
              top: shape.cy * canvasHeight,
            }}
            onPointerDown={beginRimDrag}
          />
        </>
      ) : shape.type === 'linear' ? (
        <>
          <div
            className="mask-handle mask-handle-endpoint"
            data-testid="mask-handle-p0"
            style={{ left: pct(shape.x0), top: pct(shape.y0) }}
            onPointerDown={beginEndpointDrag('p0')}
          />
          <div
            className="mask-handle mask-handle-endpoint"
            data-testid="mask-handle-p1"
            style={{ left: pct(shape.x1), top: pct(shape.y1) }}
            onPointerDown={beginEndpointDrag('p1')}
          />
        </>
      ) : null /* colorKey has no on-canvas spatial handles — see the eyedropper in InspectorPanel */}
    </div>
  );
}

/** Toolbar/inspector convenience: swap shapes[0] to a fresh default shape of the OTHER type, keeping nothing else. */
export function toggledMaskShapeType(shape: MaskShape): MaskShape {
  return shape.type === 'radial' ? defaultLinearMaskShape() : defaultRadialMaskShape();
}
