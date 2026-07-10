import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { defaultGeometryParams, GEOMETRY_MIN_CROP_SIZE, type GeometryCrop } from '../engine/graph/graphDoc';
import type { ViewportState } from './useCanvasViewport';

/** Corners + edges, clockwise from north-west (drag target ids double as CSS class suffixes). */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type HandleId = (typeof HANDLES)[number];

interface Props {
  view: ViewportState;
  /** Render-output dims (px) — the crop rect is normalized against these. */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Crop-mode overlay: mask + draggable rect + 8 handles + angle/reset/done
 * controls. Rendered as a sibling of the preview <canvas>, inside the SAME
 * pan/zoom transform (`view`), so it always lines up with the displayed image
 * regardless of zoom/pan — CanvasView forces the render itself to preview the
 * FULL (uncropped, still straightened) frame while crop mode is active, so
 * `canvasWidth`/`canvasHeight` here are the whole rotated frame, matching the
 * "crop is normalized against the rotated frame" contract in graphDoc.ts.
 */
export function CropOverlay({ view, canvasWidth, canvasHeight }: Props) {
  const graph = useAppStore((s) => s.graph);
  const setGeometry = useAppStore((s) => s.setGeometry);
  const toggleCropMode = useAppStore((s) => s.toggleCropMode);
  const inputNode = graph.nodes.find((n) => n.kind === 'input');
  const geometry = inputNode?.geometry ?? defaultGeometryParams();
  const { crop, angle } = geometry;

  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ crop: GeometryCrop; startX: number; startY: number } | null>(null);
  const sessionRef = useRef<number | null>(null);
  const angleSessionRef = useRef<number | null>(null);

  const commitCrop = (next: GeometryCrop) => {
    sessionRef.current ??= Date.now();
    setGeometry({ crop: next, angle }, `geometry:${sessionRef.current}`);
  };

  const beginDrag = (kind: 'move' | HandleId) => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    sessionRef.current = Date.now();
    setDragging(true);
    dragRef.current = { crop, startX: ev.clientX, startY: ev.clientY };

    const onMove = (e: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;
      const dx = (e.clientX - start.startX) / (view.scale * canvasWidth);
      const dy = (e.clientY - start.startY) / (view.scale * canvasHeight);
      let { x, y, w, h } = start.crop;
      if (kind === 'move') {
        x = start.crop.x + dx;
        y = start.crop.y + dy;
      } else {
        if (kind.includes('w')) {
          x = start.crop.x + dx;
          w = start.crop.w - dx;
        }
        if (kind.includes('e')) {
          w = start.crop.w + dx;
        }
        if (kind.includes('n')) {
          y = start.crop.y + dy;
          h = start.crop.h - dy;
        }
        if (kind.includes('s')) {
          h = start.crop.h + dy;
        }
      }
      w = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, w));
      h = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, h));
      x = Math.min(Math.max(0, x), 1 - w);
      y = Math.min(Math.max(0, y), 1 - h);
      commitCrop({ x, y, w, h });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragRef.current = null;
      sessionRef.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onAngleChange = (value: number) => {
    angleSessionRef.current ??= Date.now();
    setGeometry({ crop, angle: value }, `geometry:${angleSessionRef.current}`);
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <>
      <div
        className="crop-overlay"
        data-testid="crop-overlay"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        }}
      >
        {/* dark mask outside the crop rect, as four non-overlapping bands */}
        <div className="crop-mask-part" style={{ left: 0, top: 0, width: '100%', height: pct(crop.y) }} />
        <div
          className="crop-mask-part"
          style={{ left: 0, top: pct(crop.y + crop.h), width: '100%', height: pct(1 - crop.y - crop.h) }}
        />
        <div className="crop-mask-part" style={{ left: 0, top: pct(crop.y), width: pct(crop.x), height: pct(crop.h) }} />
        <div
          className="crop-mask-part"
          style={{ left: pct(crop.x + crop.w), top: pct(crop.y), width: pct(1 - crop.x - crop.w), height: pct(crop.h) }}
        />
        <div
          className="crop-rect"
          data-testid="crop-rect"
          style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
          onPointerDown={beginDrag('move')}
        >
          {dragging && (
            <div className="crop-thirds">
              <div className="crop-thirds-v" style={{ left: '33.333%' }} />
              <div className="crop-thirds-v" style={{ left: '66.667%' }} />
              <div className="crop-thirds-h" style={{ top: '33.333%' }} />
              <div className="crop-thirds-h" style={{ top: '66.667%' }} />
            </div>
          )}
          {HANDLES.map((h) => (
            <div
              key={h}
              className={`crop-handle crop-handle-${h}`}
              data-testid={`crop-handle-${h}`}
              onPointerDown={beginDrag(h)}
            />
          ))}
        </div>
      </div>
      {/* stopPropagation here keeps the viewport's pan handler (which grabs
          pointer capture on ANY pointerdown, see useCanvasViewport) from
          swallowing clicks/drags meant for these controls */}
      <div className="crop-controls" data-testid="crop-controls" onPointerDown={(ev) => ev.stopPropagation()}>
        <label>
          Angle
          <input
            type="range"
            min={-45}
            max={45}
            step={0.1}
            value={angle}
            data-testid="crop-angle-slider"
            onPointerDown={() => {
              angleSessionRef.current = Date.now();
            }}
            onPointerUp={() => {
              angleSessionRef.current = null;
            }}
            onChange={(ev) => onAngleChange(Number(ev.target.value))}
          />
          <span className="crop-angle-value" data-testid="crop-angle">
            {angle.toFixed(1)}°
          </span>
        </label>
        <button
          data-testid="crop-reset"
          onClick={() => setGeometry(defaultGeometryParams(), null)}
          title="Reset crop and straighten"
        >
          Reset
        </button>
        <button data-testid="crop-done" onClick={toggleCropMode} title="Exit crop mode">
          Done
        </button>
      </div>
    </>
  );
}
