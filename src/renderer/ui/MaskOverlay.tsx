import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { defaultMaskParams, defaultLinearMaskShape, defaultRadialMaskShape, type MaskShape } from '../engine/graph/maskNode';
import type { GeometryParams, GraphNode } from '../engine/graph/graphDoc';
import { anchorToOutput, maskShapeAnchorToOutput, outputRadiusToAnchor, outputToAnchor } from '../engine/graph/anchorSpace';
import { MaskShapePreview, type PreviewShape } from './MaskShapePreview';
import type { ViewportState } from './useCanvasViewport';

interface Props {
  node: GraphNode;
  view: ViewportState;
  /** Render-output dims (px) — the frame the on-canvas handles are drawn in. */
  canvasWidth: number;
  canvasHeight: number;
  /** The committed input-node geometry + decoded oriented dims for anchor↔output conversion (anchorSpace.ts). */
  geometry: GeometryParams;
  orientedWidth: number;
  orientedHeight: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Mask-editing overlay (masks milestone; UX pack C §1/§5): on-canvas handles
 * for the selected mask node's shapes[0] PLUS the Lightroom-style area preview
 * (shared MaskShapePreview), rendered as a sibling of the preview <canvas>,
 * inside the SAME pan/zoom transform as CropOverlay.
 *
 * shapes[0] is stored in ANCHOR space (anchorSpace.ts); it is converted to the
 * OUTPUT frame here for rendering, and every drag converts the dragged OUTPUT
 * position back to anchor before committing — so handles track image content
 * across crop/straighten. When geometry is identity both conversions are the
 * identity, exactly reproducing the pre-anchor behavior.
 */
export function MaskOverlay({ node, view, canvasWidth, canvasHeight, geometry, orientedWidth, orientedHeight }: Props) {
  const setMaskShape = useAppStore((s) => s.setMaskShape);
  const shapes = node.mask?.shapes ?? defaultMaskParams().shapes;
  const shape = shapes[0] ?? defaultMaskParams().shapes[0]!;
  const sessionRef = useRef<number | null>(null);
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const ow = orientedWidth;
  const oh = orientedHeight;

  // OUTPUT-frame view of the anchor-space shape — drives every handle position
  // and the area preview below.
  const outShape = maskShapeAnchorToOutput(shape, geometry, ow, oh);

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
    const startOut = anchorToOutput(start.cx, start.cy, geometry, ow, oh);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      const a = outputToAnchor(startOut.x + dx, startOut.y + dy, geometry, ow, oh);
      commit({ ...start, cx: clamp01(a.x), cy: clamp01(a.y) });
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
    const centerPxX = outShape.type === 'radial' ? outShape.cx * canvasWidth : 0;
    const centerPxY = outShape.type === 'radial' ? outShape.cy * canvasHeight : 0;
    const startRadiusPx = (outShape.type === 'radial' ? outShape.radius : 0) * maxDim;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale;
      const dy = (e.clientY - startY) / view.scale;
      const radiusPx = Math.hypot(centerPxX + startRadiusPx + dx - centerPxX, centerPxY + dy - centerPxY);
      const outRadius = Math.max(0.01, radiusPx / maxDim);
      commit({ ...start, radius: outputRadiusToAnchor(outRadius, geometry, ow, oh) });
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
    const startOut = anchorToOutput(which === 'p0' ? start.x0 : start.x1, which === 'p0' ? start.y0 : start.y1, geometry, ow, oh);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      const a = outputToAnchor(startOut.x + dx, startOut.y + dy, geometry, ow, oh);
      if (which === 'p0') commit({ ...start, x0: a.x, y0: a.y });
      else commit({ ...start, x1: a.x, y1: a.y });
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

  const preview: PreviewShape | null =
    outShape.type === 'radial'
      ? { type: 'radial', cx: outShape.cx, cy: outShape.cy, radius: outShape.radius, feather: outShape.feather }
      : outShape.type === 'linear'
        ? { type: 'linear', x0: outShape.x0, y0: outShape.y0, x1: outShape.x1, y1: outShape.y1, feather: outShape.feather }
        : null;

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
      {preview && (
        <svg className="mask-overlay-area" width={canvasWidth} height={canvasHeight}>
          <MaskShapePreview shape={preview} canvasWidth={canvasWidth} canvasHeight={canvasHeight} />
        </svg>
      )}
      {outShape.type === 'radial' ? (
        <>
          <div
            className="mask-handle mask-handle-center"
            data-testid="mask-handle-center"
            style={{ left: pct(outShape.cx), top: pct(outShape.cy) }}
            onPointerDown={beginCenterDrag}
          />
          <div
            className="mask-handle mask-handle-rim"
            data-testid="mask-handle-rim"
            style={{
              left: outShape.cx * canvasWidth + outShape.radius * maxDim,
              top: outShape.cy * canvasHeight,
            }}
            onPointerDown={beginRimDrag}
          />
        </>
      ) : outShape.type === 'linear' ? (
        <>
          <div
            className="mask-handle mask-handle-endpoint"
            data-testid="mask-handle-p0"
            style={{ left: pct(outShape.x0), top: pct(outShape.y0) }}
            onPointerDown={beginEndpointDrag('p0')}
          />
          <div
            className="mask-handle mask-handle-endpoint"
            data-testid="mask-handle-p1"
            style={{ left: pct(outShape.x1), top: pct(outShape.y1) }}
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
