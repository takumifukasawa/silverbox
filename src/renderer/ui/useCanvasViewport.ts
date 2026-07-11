import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface ViewportState {
  /** 'fit' recomputes on container resize; any interaction switches to 'free'. */
  mode: 'fit' | 'free';
  /** CSS px per image px. 1:1 device pixels = 1 / devicePixelRatio. */
  scale: number;
  tx: number;
  ty: number;
}

const MAX_SCALE = 8;

/**
 * Zoom/pan state for the preview canvas: wheel zooms around the cursor, drag
 * pans, double-click toggles fit ↔ 1:1 (device pixels). The canvas is
 * expected to sit at the container's top-left with transform-origin 0 0; the
 * returned state maps image px → CSS px via translate(tx,ty) scale(scale).
 */
export function useCanvasViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  image: { width: number; height: number } | null,
  /**
   * True while a click on the canvas must be handled by the CALLER (e.g. the
   * WB eyedropper) instead of starting a pan. `container`'s own pointerdown
   * listener below is a raw addEventListener — it fires during real native
   * bubbling BEFORE React's synthetic dispatch reaches a descendant's own
   * onClick, so `setPointerCapture` here would otherwise redirect the click's
   * target away from the canvas before the caller ever sees it (same
   * "check the target directly" gotcha the crop overlay works around).
   */
  suppressPan = false
) {
  const [view, setView] = useState<ViewportState>({ mode: 'fit', scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const imageRef = useRef(image);
  imageRef.current = image;
  const suppressPanRef = useRef(suppressPan);
  suppressPanRef.current = suppressPan;

  const computeFit = useCallback((): ViewportState | null => {
    const container = containerRef.current;
    const img = imageRef.current;
    if (!container || !img) return null;
    const { width: cw, height: ch } = container.getBoundingClientRect();
    if (cw === 0 || ch === 0) return null;
    const scale = Math.min(cw / img.width, ch / img.height);
    return { mode: 'fit', scale, tx: (cw - img.width * scale) / 2, ty: (ch - img.height * scale) / 2 };
  }, [containerRef]);

  const fit = useCallback(() => {
    const next = computeFit();
    if (next) setView(next);
  }, [computeFit]);

  /** Zoom so the image point under (mx,my) stays put. */
  const zoomAt = useCallback((mx: number, my: number, targetScale: number) => {
    setView((v) => {
      const scale = Math.min(Math.max(targetScale, 0.02), MAX_SCALE);
      return {
        mode: 'free',
        scale,
        tx: mx - ((mx - v.tx) * scale) / v.scale,
        ty: my - ((my - v.ty) * scale) / v.scale,
      };
    });
  }, []);

  /**
   * Programmatic view override that also flips to 'free' mode. Used by the
   * crop overlay's LR-style rotate gesture, which drives tx/ty/scale directly
   * each pointer-move so the crop rect's on-screen box stays pinned while the
   * image rotates and zooms beneath it. Intentionally UNCLAMPED (unlike
   * zoomAt): the gesture computes an exact scale from the auto-shrink fit, and
   * a clamp here would let the rect's screen footprint drift.
   */
  const setViewFree = useCallback((tx: number, ty: number, scale: number) => {
    setView({ mode: 'free', scale, tx, ty });
  }, []);

  const oneToOne = useCallback(
    (mx?: number, my?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const { width: cw, height: ch } = container.getBoundingClientRect();
      zoomAt(mx ?? cw / 2, my ?? ch / 2, 1 / devicePixelRatio);
    },
    [containerRef, zoomAt]
  );

  // refit when the image changes, and follow container resizes in fit mode
  useEffect(() => {
    fit();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (viewRef.current.mode === 'fit') fit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [image, fit, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = container.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * 0.0015);
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, viewRef.current.scale * factor);
    };

    // double-click resets to fit (UI spec §3); 1:1 stays on the 100% button
    const onDblClick = () => {
      fit();
    };

    let dragging: { x: number; y: number } | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      if (suppressPanRef.current) return;
      // This is a raw addEventListener on the container, so it fires during
      // native bubbling BEFORE React's root-delegated synthetic dispatch —
      // a descendant's `ev.stopPropagation()` (e.g. the crop overlay's drag
      // handles/controls, or the mask overlay's center/rim/endpoint handles)
      // cannot preempt it. Check the target directly instead: crop-mode and
      // mask-editing UI each own their own pointer handling — without this
      // exclusion, dragging a mask handle ALSO pans the canvas underneath by
      // the same delta (both listeners see the same pointermove stream),
      // which silently drifts the view out of 'fit' on every mask edit.
      const target = ev.target as HTMLElement | null;
      if (target?.closest('.crop-rect, .crop-handle, .crop-controls, .mask-handle')) return;
      dragging = { x: ev.clientX, y: ev.clientY };
      container.setPointerCapture(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const dx = ev.clientX - dragging.x;
      const dy = ev.clientY - dragging.y;
      dragging = { x: ev.clientX, y: ev.clientY };
      setView((v) => ({ ...v, mode: 'free', tx: v.tx + dx, ty: v.ty + dy }));
    };
    const onPointerUp = (ev: PointerEvent) => {
      dragging = null;
      if (container.hasPointerCapture(ev.pointerId)) container.releasePointerCapture(ev.pointerId);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('dblclick', onDblClick);
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('dblclick', onDblClick);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
    };
  }, [containerRef, zoomAt, fit, oneToOne]);

  return { view, fit, oneToOne, setViewFree };
}
