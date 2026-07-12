import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  clampGeometry,
  defaultGeometryOrientation,
  defaultGeometryParams,
  GEOMETRY_MIN_CROP_SIZE,
  type GeometryCrop,
  type GeometryOrientation,
} from '../engine/graph/graphDoc';
import { clampMoveToRotatedFrame, constrainRectAlongPath, fitRotatedCrop } from '../engine/graph/cropFit';
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

/**
 * Caps a resize handle's driving axis/axes at the FIXED anchor edge(s)
 * implied by `kind` — e.g. the 'e' handle's WEST edge (`start.x`) never
 * moves, so `w` is capped at `1 - start.x` rather than letting the generic
 * [0,1] position clamp further down shove that west edge inward once `w`
 * exceeds the room to its right (round-6 bug: dragging 'e' past the right
 * edge dragged the LEFT edge along with it, because `x = min(x, 1 - w)` is
 * anchor-blind about which edge is supposed to stay put).
 *
 * For 'w'/'n' the fixed edge is the FAR one (right/bottom): the drag moves
 * `x`/`y` directly, so instead of capping the size we clamp the position and
 * re-derive the size from the (still-fixed) far edge. No-op on axes `kind`
 * doesn't touch (e.g. an 'n' drag leaves x/w alone entirely).
 */
function anchorClamp(kind: HandleId, start: GeometryCrop, x: number, y: number, w: number, h: number) {
  if (kind.includes('e')) {
    w = Math.min(w, 1 - start.x);
  } else if (kind.includes('w')) {
    x = Math.max(0, x);
    w = start.x + start.w - x;
  }
  if (kind.includes('s')) {
    h = Math.min(h, 1 - start.y);
  } else if (kind.includes('n')) {
    y = Math.max(0, y);
    h = start.y + start.h - y;
  }
  return { x, y, w, h };
}

/**
 * Re-applies the anchor rule AFTER the ratio-lock recompute, which can push
 * the DERIVED axis (the one ratio-lock computes FROM the already-capped
 * driving axis — e.g. `h` derived from `w` for an 'e' or corner drag) past
 * its OWN frame anchor even though the driving axis was already capped by
 * `anchorClamp` above. A corner+ratio drag is the case that needs this: e.g.
 * 'ne' caps `w` at the east room, then derives `h` from that `w` — but `h`
 * can still overshoot the north anchor if the ratio is tall enough.
 *
 * Hard-capping the derived axis alone would silently break the aspect ratio,
 * so instead this scales BOTH axes back by the same factor and re-derives
 * the anchor position(s) from the smaller size. One pass is always enough:
 * shrinking a size that already satisfied its own anchor bound can't make it
 * violate that bound, so the driving axis's cap (from the first pass) never
 * needs re-checking here.
 */
function anchorClampRatioLocked(kind: HandleId, start: GeometryCrop, x: number, y: number, w: number, h: number) {
  const wRoom = kind.includes('e') ? 1 - start.x : kind.includes('w') ? start.x + start.w : Infinity;
  const hRoom = kind.includes('s') ? 1 - start.y : kind.includes('n') ? start.y + start.h : Infinity;
  const scale = Math.min(1, w > 0 ? wRoom / w : 1, h > 0 ? hRoom / h : 1);
  if (scale < 1) {
    w *= scale;
    h *= scale;
  }
  if (kind.includes('w')) x = start.x + start.w - w;
  else if (kind.includes('e')) x = start.x;
  if (kind.includes('n')) y = start.y + start.h - h;
  else if (kind.includes('s')) y = start.y;
  return { x, y, w, h };
}

/**
 * Alt/center-resize proposal (round-7 UX pack G §1, "alt押しながらだと中央基準でcrop"):
 * mirrors BOTH edges of the driving axis/axes about the drag-start rect's
 * CENTER instead of anchoring the opposite edge — dragging 'e' by `dx` grows
 * east by `dx` AND west by `dx` (w grows by 2·dx, x shifts by -dx) so the
 * center stays exactly at the drag-start center. Independent per axis, same
 * as the anchored dx/dy assignment this replaces: an edge handle only
 * touches its own axis, a corner touches both.
 */
function centerResize(kind: HandleId, start: GeometryCrop, dx: number, dy: number) {
  let { x, y, w, h } = start;
  if (kind.includes('e')) {
    w = start.w + 2 * dx;
    x = start.x - dx;
  } else if (kind.includes('w')) {
    w = start.w - 2 * dx;
    x = start.x + dx;
  }
  if (kind.includes('s')) {
    h = start.h + 2 * dy;
    y = start.y - dy;
  } else if (kind.includes('n')) {
    h = start.h - 2 * dy;
    y = start.y + dy;
  }
  return { x, y, w, h };
}

/**
 * Symmetric counterpart of anchorClamp for alt/center-mode resizes: the
 * "anchor" is the drag-start rect's CENTER (fixed on both axes at once), so
 * the cap on each axis is the SMALLER of the room on either side of that
 * center — growing further would push one edge or the other past the frame
 * before the other edge runs out of room. Caps by shrinking the HALF-size and
 * re-deriving position from the (fixed) center, rather than anchorClamp's
 * "cap the driving size, keep the far edge fixed" — a plain min/max on x or w
 * alone would not keep the center fixed.
 */
function centerClamp(kind: HandleId, start: GeometryCrop, x: number, y: number, w: number, h: number) {
  if (kind.includes('e') || kind.includes('w')) {
    const cx = start.x + start.w / 2;
    const halfW = Math.min(w / 2, cx, 1 - cx);
    x = cx - halfW;
    w = halfW * 2;
  }
  if (kind.includes('n') || kind.includes('s')) {
    const cy = start.y + start.h / 2;
    const halfH = Math.min(h / 2, cy, 1 - cy);
    y = cy - halfH;
    h = halfH * 2;
  }
  return { x, y, w, h };
}

/**
 * Alt/center-mode ratio lock: same driving-axis convention as the non-alt
 * ratio-lock block below (horizontal edges 'n'/'s' drive off `h`; every other
 * kind — vertical edges AND corners — drives off `w`), but only derives the
 * size here; centerClampRatioLocked (below) re-centers both axes on the
 * drag-start center, since center mode never pins an edge or corner the way
 * the non-alt path does.
 */
function centerRatioLock(kind: HandleId, w: number, h: number, ar: number, canvasWidth: number, canvasHeight: number) {
  const isHorizontalEdge = kind === 'n' || kind === 's';
  if (isHorizontalEdge) {
    w = (h * canvasHeight * ar) / canvasWidth;
  } else {
    h = (w * canvasWidth) / (ar * canvasHeight);
  }
  return { w, h };
}

/**
 * Symmetric counterpart of anchorClampRatioLocked: the ratio recompute above
 * can grow the DERIVED axis past its own center-room even though the DRIVING
 * axis was already capped by centerClamp — scale both axes back together
 * (preserving the ratio), then re-derive x/y from the fixed center. Same
 * one-pass argument as anchorClampRatioLocked: shrinking a size that already
 * satisfied its own center-room bound can't make it violate that bound.
 */
function centerClampRatioLocked(start: GeometryCrop, w: number, h: number) {
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const wRoom = 2 * Math.min(cx, 1 - cx);
  const hRoom = 2 * Math.min(cy, 1 - cy);
  const scale = Math.min(1, w > 0 ? wRoom / w : 1, h > 0 ? hRoom / h : 1);
  if (scale < 1) {
    w *= scale;
    h *= scale;
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

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

  // Alt/center-resize UI legibility (round-7 UX pack G §1): the center dot
  // must show up BOTH while a resize drag with Alt held is in flight and
  // while merely hovering a handle with Alt already down (so the affordance
  // is discoverable before you commit to a drag) — two independent booleans,
  // OR'd together for the dot/handle styling below. `altKeyDown` tracks the
  // key itself at the window level (Alt can be pressed before or during the
  // hover/drag); `hoveredHandle` is which handle (if any) the pointer is
  // currently over at rest.
  const [altKeyDown, setAltKeyDown] = useState(false);
  const [hoveredHandle, setHoveredHandle] = useState<HandleId | null>(null);
  /** True while an in-flight resize drag has Alt held (read live per pointer-move — see beginDrag). */
  const [resizeAltActive, setResizeAltActive] = useState(false);
  const altCenterVisible = resizeAltActive || (hoveredHandle !== null && altKeyDown);

  useEffect(() => {
    const onAltChange = (ev: KeyboardEvent) => {
      if (ev.key === 'Alt') setAltKeyDown(ev.type === 'keydown');
    };
    window.addEventListener('keydown', onAltChange);
    window.addEventListener('keyup', onAltChange);
    return () => {
      window.removeEventListener('keydown', onAltChange);
      window.removeEventListener('keyup', onAltChange);
    };
  }, []);

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
    if (kind !== 'move') setResizeAltActive(ev.altKey);
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
        // Alt/center-resize (UX pack G §1): read LIVE off this move event (not
        // captured at drag start) — LR lets you press/release Alt mid-drag and
        // it takes effect immediately, since the whole rect is recomputed fresh
        // from `start.crop` on every move anyway (nothing incremental to reconcile).
        const centerMode = e.altKey;
        setResizeAltActive(centerMode);
        if (centerMode) {
          // Alt-symmetric proposal FIRST, then its own center-anchored clamp
          // (a symmetric variant of anchorClamp — the "anchor" is the rect
          // CENTER, so the cap is the min of both sides' room) — see
          // centerResize/centerClamp's doc comments.
          ({ x, y, w, h } = centerResize(kind, start.crop, dx, dy));
          ({ x, y, w, h } = centerClamp(kind, start.crop, x, y, w, h));

          if (ar !== null) {
            ({ w, h } = centerRatioLock(kind, w, h, ar, canvasWidth, canvasHeight));
            ({ x, y, w, h } = centerClampRatioLocked(start.crop, w, h));
          }
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

          // Anchor-aware clamp: cap the DRIVING axis at its fixed opposite edge
          // BEFORE any ratio-lock math runs, so a drag that would grow past
          // the frame boundary stops there instead of shoving the anchor edge
          // inward (round-6 bug — see anchorClamp's doc comment).
          ({ x, y, w, h } = anchorClamp(kind, start.crop, x, y, w, h));

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

            // The ratio recompute above can grow the DERIVED axis past ITS
            // OWN anchor (e.g. a corner+ratio drag: capping `w` still leaves
            // room for the derived `h` to overshoot the north/south anchor).
            // Scale both axes back together so the lock survives — see
            // anchorClampRatioLocked's doc comment.
            ({ x, y, w, h } = anchorClampRatioLocked(kind, start.crop, x, y, w, h));
          }
        }
      }
      w = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, w));
      h = Math.min(1, Math.max(GEOMETRY_MIN_CROP_SIZE, h));
      x = Math.min(Math.max(0, x), 1 - w);
      y = Math.min(Math.max(0, y), 1 - h);
      // With a straighten angle in play the valid area is the TILTED source
      // rectangle, so the [0,1] clamps above aren't enough — the rect could
      // still be dragged into the (black) rotation void. Moves slide along
      // the tilted boundary (closed-form center clamp); resizes stop at it
      // (binary search along the drag path — exact, the valid set is convex).
      // See cropFit.ts. At angle 0 the clamps above are already exact.
      if (angle !== 0) {
        const constrained =
          kind === 'move'
            ? clampMoveToRotatedFrame({ W: canvasWidth, H: canvasHeight, crop: { x, y, w, h }, angle })
            : constrainRectAlongPath({
                W: canvasWidth,
                H: canvasHeight,
                from: start.crop,
                to: { x, y, w, h },
                angle,
              });
        ({ x, y, w, h } = constrained);
        // keep the schema's [0,1] contract (clampGeometry would do it anyway)
        x = Math.min(Math.max(0, x), 1 - w);
        y = Math.min(Math.max(0, y), 1 - h);
      }
      commitCrop({ x, y, w, h });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragRef.current = null;
      sessionRef.current = null;
      setDragging(false);
      setResizeAltActive(false);
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
            >
              {/* Round-6 affordance: the rotate zone is otherwise invisible
                  until the cursor happens to enter it — a small curved-arrow
                  glyph marks it at rest (dim), brightening to full white on
                  hover via the plain CSS descendant selector below (that's
                  why the glyph lives INSIDE the zone element). Same arc
                  geometry as the zone's own custom cursor image (styles.css)
                  for visual consistency; pointer-events:none so the zone div
                  keeps handling the drag, not the svg. */}
              <svg
                className="crop-rotate-glyph"
                data-testid="crop-rotate-glyph"
                width="26"
                height="26"
                viewBox="0 0 22 22"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M11 3a8 8 0 1 1-6.5 3.3" fill="none" stroke="#000" strokeOpacity="0.55" strokeWidth="2.6" strokeLinecap="round" />
                <path d="M11 3a8 8 0 1 1-6.5 3.3" fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M2.5 4.5l1.7 2.3 2.3-1" fill="none" stroke="#000" strokeOpacity="0.55" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2.5 4.5l1.7 2.3 2.3-1" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ))}
          {HANDLES.map((h) => (
            <div
              key={h}
              className={`crop-handle crop-handle-${h}`}
              data-testid={`crop-handle-${h}`}
              onPointerDown={beginDrag(h)}
              onPointerEnter={() => setHoveredHandle(h)}
              onPointerLeave={() => setHoveredHandle((cur) => (cur === h ? null : cur))}
            />
          ))}
          {/* Alt/center-resize affordance (UX pack G §1): a small dot at the
              rect's own center, shown while Alt is held over a handle (hover
              OR an in-flight drag) — the cursor keeps its normal per-handle
              resize direction (nwse/ns/ew/nesw) since there's no standard CSS
              cursor for "resize about the center", so this dot is the primary
              legibility cue (see the crop-controls hint line below for the
              always-visible discoverability half of the same affordance). */}
          {altCenterVisible && (
            <div className="crop-center-dot" data-testid="crop-center-dot" aria-hidden="true" />
          )}
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
        {/* Always-on discoverability half of the alt/center-resize affordance
            (UX pack G §1) — cheap, and the only part of the affordance
            visible before the pointer ever reaches a handle. */}
        <span className="crop-hint" data-testid="crop-alt-hint">
          ⌥ = resize from center
        </span>
      </div>
    </>
  );
}
