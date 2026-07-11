import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  clampGeometry,
  defaultGeometryOrientation,
  defaultGeometryParams,
  GEOMETRY_MIN_CROP_SIZE,
  type GeometryCrop,
  type GeometryOrientation,
} from '../engine/graph/graphDoc';
import { fitRotatedCrop } from '../engine/graph/cropFit';
import type { ViewportState } from './useCanvasViewport';

/** Corners + edges, clockwise from north-west (drag target ids double as CSS class suffixes). */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type HandleId = (typeof HANDLES)[number];

/** The 4 corners get a rotate zone (LR-style: drag OUTSIDE the corner to straighten). */
const ROTATE_CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

/** Aspect-ratio lock options (UI spec §item4): output-px width/height; 'free'/'original' are resolved dynamically. */
const RATIO_OPTIONS: { key: string; label: string; ar: number | null }[] = [
  { key: 'free', label: 'Free', ar: null },
  { key: 'original', label: 'Original', ar: null },
  { key: '1:1', label: '1:1', ar: 1 },
  { key: '3:2', label: '3:2', ar: 3 / 2 },
  { key: '2:3', label: '2:3', ar: 2 / 3 },
  { key: '4:3', label: '4:3', ar: 4 / 3 },
  { key: '16:9', label: '16:9', ar: 16 / 9 },
];

interface Props {
  view: ViewportState;
  /** Render-output dims (px) — the crop rect is normalized against these. */
  canvasWidth: number;
  canvasHeight: number;
  /** Programmatic view setter (also flips to 'free'); drives the rotate-gesture auto-zoom. */
  setViewFree: (tx: number, ty: number, scale: number) => void;
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
export function CropOverlay({ view, canvasWidth, canvasHeight, setViewFree }: Props) {
  const graph = useAppStore((s) => s.graph);
  const setGeometry = useAppStore((s) => s.setGeometry);
  const toggleCropMode = useAppStore((s) => s.toggleCropMode);
  const inputNode = graph.nodes.find((n) => n.kind === 'input');
  const geometry = inputNode?.geometry ?? defaultGeometryParams();
  const { crop, angle } = geometry;
  const orientation = geometry.orientation ?? defaultGeometryOrientation();

  const [dragging, setDragging] = useState(false);
  /** True while a rotate-zone drag is in flight — swaps the thirds grid for the fine straighten grid (LR behavior). */
  const [rotating, setRotating] = useState(false);
  const [ratioKey, setRatioKey] = useState('free');
  const dragRef = useRef<{ crop: GeometryCrop; startX: number; startY: number } | null>(null);
  const sessionRef = useRef<number | null>(null);
  const angleSessionRef = useRef<number | null>(null);
  const cropRectRef = useRef<HTMLDivElement>(null);

  // `canvasWidth`/`canvasHeight` are the ORIENTED full-frame dims (see the
  // component doc comment) — exactly what an output-px aspect ratio needs.
  const arFor = (key: string): number | null => {
    if (key === 'free') return null;
    if (key === 'original') return canvasWidth / canvasHeight;
    return RATIO_OPTIONS.find((o) => o.key === key)?.ar ?? null;
  };

  const commitCrop = (next: GeometryCrop) => {
    sessionRef.current ??= Date.now();
    setGeometry({ crop: next, angle, orientation }, `geometry:${sessionRef.current}`);
  };

  const beginDrag = (kind: 'move' | HandleId) => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    sessionRef.current = Date.now();
    setDragging(true);
    dragRef.current = { crop, startX: ev.clientX, startY: ev.clientY };
    const ar = arFor(ratioKey);

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

        // Aspect-ratio lock (normalized crop fractions, ratio in OUTPUT px —
        // account for the source's own aspect: outputAr = (w*canvasWidth) /
        // (h*canvasHeight)). Corners + vertical edges (e/w) drive off the
        // freeform `w` and recompute `h`; horizontal edges (n/s) drive off
        // `h` and recompute `w`. Each case repositions whichever edge must
        // stay pinned (the opposite corner for corners, the center for a
        // single-edge drag) so the constrained rect grows/shrinks naturally.
        if (ar !== null) {
          const isVerticalEdge = kind === 'e' || kind === 'w';
          const isHorizontalEdge = kind === 'n' || kind === 's';
          if (isHorizontalEdge) {
            const wNew = (h * canvasHeight * ar) / canvasWidth;
            const xCenter = start.crop.x + start.crop.w / 2;
            x = xCenter - wNew / 2;
            w = wNew;
          } else {
            const hNew = (w * canvasWidth) / (ar * canvasHeight);
            if (isVerticalEdge) {
              const yCenter = start.crop.y + start.crop.h / 2;
              y = yCenter - hNew / 2;
            } else if (kind.includes('n')) {
              y = start.crop.y + start.crop.h - hNew;
            }
            h = hNew;
          }
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

  /**
   * Angle slider: keeps the SAME no-void invariant as the rotate gesture, so a
   * cropped/straightened image can't develop void corners when you drag the
   * slider. Runs the shared anchor+fit (cropFit.ts) seeded from the CURRENT
   * rect+angle and writes crop+angle together — but with NO view compensation
   * (this isn't a screen-anchored gesture, so the viewport is left alone). The
   * shrink is capped at scale 1, so the slider never GROWS the rect back;
   * that's fine — reversibility is only promised for the drag gesture, which
   * reseeds from a fixed drag-start rect.
   */
  const onAngleChange = (value: number) => {
    angleSessionRef.current ??= Date.now();
    const { crop: nextCrop } = fitRotatedCrop({
      W: canvasWidth,
      H: canvasHeight,
      crop0: crop,
      angle0: angle,
      angle: value,
    });
    setGeometry({ crop: nextCrop, angle: value, orientation }, `geometry:${angleSessionRef.current}`);
  };

  /**
   * LR-style rotate (UX pack B §2), the real thing: dragging the zone just
   * OUTSIDE a corner straightens the photo. The crop rect's on-screen box
   * stays PIXEL-IDENTICAL through the whole drag while the image appears to
   * rotate around the rect center AND zoom in just enough that the rect never
   * contains void; dragging back toward the start angle reverses the zoom.
   *
   * Two coupled writes per pointer-move (batched into one undo entry via the
   * shared `angleSessionRef` session key — same coalescing the slider uses):
   *  1. geometry: crop+angle from fitRotatedCrop (cropFit.ts) — the rect
   *     re-centers on the same source detail (perceived rect-center pivot,
   *     converting the shader's frame-center pivot) and auto-shrinks by the
   *     max scale ≤ 1 that keeps all four corners void-free, recomputed FRESH
   *     from the drag-start rect each move so sweeping back to `angle0`
   *     restores the drag-start crop exactly.
   *  2. view: scale = view0.scale / s (the LR zoom), and tx/ty chosen so the
   *     image point at the rect center lands at the SAME screen point the rect
   *     center held at drag start. Rect screen width = w0·s·scale =
   *     w0·view0.scale (constant), and its center is pinned — so the rect's
   *     screen box is invariant.
   *
   * Angle delta comes from the pointer's angular sweep around the rect's
   * (fixed) on-screen center. Screen space is y-down, so a visually CLOCKWISE
   * sweep is an INCREASING atan2 angle; the "+angle rotates the image CCW"
   * convention (RESAMPLE_SHADER, untouched) means a clockwise drag DECREASES
   * geometry.angle, hence the negation.
   */
  const beginRotate = () => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    const rectEl = cropRectRef.current;
    if (!rectEl) return;
    const box = rectEl.getBoundingClientRect();
    // fixed on-screen pivot (the rect center holds here for the whole drag)
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const startPointerAngle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
    const crop0 = crop;
    const angle0 = angle;
    const view0 = { tx: view.tx, ty: view.ty, scale: view.scale };
    // container-relative screen position the rect center occupies at drag
    // start (canvas transform is translate(tx,ty) scale(scale), origin 0,0)
    const c0x = (crop0.x + crop0.w / 2) * canvasWidth;
    const c0y = (crop0.y + crop0.h / 2) * canvasHeight;
    const screenCx = view0.tx + c0x * view0.scale;
    const screenCy = view0.ty + c0y * view0.scale;
    const sessionKey = `geometry:${Date.now()}`;
    angleSessionRef.current = Date.now();
    setRotating(true);
    const onMove = (e: PointerEvent) => {
      const curPointerAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      const deltaDeg = -((curPointerAngle - startPointerAngle) * 180) / Math.PI;
      const nextAngle = Math.min(45, Math.max(-45, angle0 + deltaDeg));
      const { crop: nextCrop, scale: s } = fitRotatedCrop({
        W: canvasWidth,
        H: canvasHeight,
        crop0,
        angle0,
        angle: nextAngle,
      });
      setGeometry({ crop: nextCrop, angle: nextAngle, orientation }, sessionKey);
      // pin the rect's screen box: keep its center under screenC0, scale up
      // by 1/s so its screen size is unchanged
      const scaleNew = view0.scale / s;
      const cxNew = (nextCrop.x + nextCrop.w / 2) * canvasWidth;
      const cyNew = (nextCrop.y + nextCrop.h / 2) * canvasHeight;
      setViewFree(screenCx - cxNew * scaleNew, screenCy - cyNew * scaleNew, scaleNew);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      angleSessionRef.current = null;
      setRotating(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Selecting a new ratio re-fits the CURRENT rect immediately: a centered shrink of whichever axis is too big (one undo entry); Free changes nothing. */
  const onRatioChange = (key: string) => {
    setRatioKey(key);
    const ar = arFor(key);
    if (ar === null) return;
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    const curAr = (crop.w * canvasWidth) / (crop.h * canvasHeight);
    let w = crop.w;
    let h = crop.h;
    if (curAr > ar) {
      w = (h * canvasHeight * ar) / canvasWidth;
    } else {
      h = (w * canvasWidth) / (ar * canvasHeight);
    }
    const next = clampGeometry({ crop: { x: cx - w / 2, y: cy - h / 2, w, h }, angle, orientation });
    setGeometry(next, null);
  };

  const rotateBy = (delta: 1 | 3) => {
    const next: GeometryOrientation = {
      quarterTurns: (((orientation.quarterTurns + delta) % 4) as 0 | 1 | 2 | 3),
      flipH: orientation.flipH,
    };
    setGeometry({ crop, angle, orientation: next }, null);
  };

  const flipH = () => {
    setGeometry({ crop, angle, orientation: { quarterTurns: orientation.quarterTurns, flipH: !orientation.flipH } }, null);
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
          ref={cropRectRef}
          className="crop-rect"
          data-testid="crop-rect"
          style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
          onPointerDown={beginDrag('move')}
        >
          {/* LR-style tool overlay: the rule-of-thirds grid is ALWAYS visible
              in crop mode; a rotate drag swaps in the fine straighten grid
              (every 5%) for horizon alignment, exactly like Lightroom. */}
          {rotating ? (
            <div className="crop-thirds" data-testid="crop-grid-fine">
              {Array.from({ length: 19 }, (_, i) => (i + 1) * 5).map((p) => (
                <div key={`v${p}`} className="crop-thirds-v crop-grid-fine-line" style={{ left: `${p}%` }} />
              ))}
              {Array.from({ length: 19 }, (_, i) => (i + 1) * 5).map((p) => (
                <div key={`h${p}`} className="crop-thirds-h crop-grid-fine-line" style={{ top: `${p}%` }} />
              ))}
            </div>
          ) : (
            <div className={`crop-thirds${dragging ? ' crop-thirds--active' : ''}`} data-testid="crop-grid-thirds">
              <div className="crop-thirds-v" style={{ left: '33.333%' }} />
              <div className="crop-thirds-v" style={{ left: '66.667%' }} />
              <div className="crop-thirds-h" style={{ top: '33.333%' }} />
              <div className="crop-thirds-h" style={{ top: '66.667%' }} />
            </div>
          )}
          {/* Rotate zones render FIRST (underneath, in DOM/paint order) so the
              resize handles — same corner anchor, smaller hit radius — win
              the pointer for clicks close to the corner; the rotate ring only
              catches drags starting further out (near-but-outside). */}
          {ROTATE_CORNERS.map((c) => (
            <div
              key={`rotate-${c}`}
              className={`crop-rotate-zone crop-rotate-zone-${c}`}
              data-testid={`crop-rotate-${c}`}
              title="Drag to straighten"
              onPointerDown={beginRotate()}
            />
          ))}
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
        <button data-testid="crop-rotate-left" onClick={() => rotateBy(1)} title="Rotate left 90°">
          ⟲
        </button>
        <button data-testid="crop-rotate-right" onClick={() => rotateBy(3)} title="Rotate right 90°">
          ⟳
        </button>
        <button data-testid="crop-flip" onClick={flipH} title="Flip horizontal">
          ⇋
        </button>
        <label>
          Ratio
          <select
            data-testid="crop-ratio"
            value={ratioKey}
            onChange={(ev) => onRatioChange(ev.target.value)}
            title="Lock the crop to an aspect ratio"
          >
            {RATIO_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="crop-reset"
          onClick={() => setGeometry(defaultGeometryParams(), null)}
          title="Reset crop, straighten, rotate and flip"
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
