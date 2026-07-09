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
  image: { width: number; height: number } | null
) {
  const [view, setView] = useState<ViewportState>({ mode: 'fit', scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const imageRef = useRef(image);
  imageRef.current = image;

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

  return { view, fit, oneToOne };
}
