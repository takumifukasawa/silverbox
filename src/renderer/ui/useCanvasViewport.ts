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
  suppressPan = false,
  /**
   * True while the PLAIN wheel must NOT zoom the viewport — spot mode (task
   * #50) repurposes it to adjust the brush radius instead (CanvasView.tsx
   * registers its own wheel listener on the same container; this just opts
   * the zoom handler out so the two don't fight over the same event).
   * ctrlKey wheel (trackpad pinch, round-6) is NEVER suppressed — pinch must
   * keep zooming even while a mode owns the plain wheel, see onWheel below.
   * preventDefault still fires either way, so the page itself never scrolls
   * underneath the canvas.
   */
  suppressWheelZoom = false,
  /**
   * CSS px reserved at the container's BOTTOM by fit-to-view — crop mode
   * passes the floating .crop-controls bar's footprint here so the fitted
   * image never extends underneath it (with the always-visible filmstrip
   * shrinking the canvas, a bottom-area crop's S/SE/SW handles could land
   * under the bar, which sits at a higher z-index and swallowed their
   * pointerdowns — caught by verify-crop's SE ratio-lock drag going no-op).
   * Only fit math reserves it; free zoom/pan may still move under the bar.
   */
  bottomInset = 0
) {
  const [view, setView] = useState<ViewportState>({ mode: 'fit', scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const imageRef = useRef(image);
  imageRef.current = image;
  const suppressPanRef = useRef(suppressPan);
  suppressPanRef.current = suppressPan;
  const suppressWheelZoomRef = useRef(suppressWheelZoom);
  suppressWheelZoomRef.current = suppressWheelZoom;
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;

  const computeFit = useCallback((): ViewportState | null => {
    const container = containerRef.current;
    const img = imageRef.current;
    if (!container || !img) return null;
    const { width: cw, height: ch } = container.getBoundingClientRect();
    if (cw === 0 || ch === 0) return null;
    // A degenerate container (smaller than the inset itself) ignores the
    // inset rather than producing a zero/negative fit height.
    const effH = ch - bottomInsetRef.current > 0 ? ch - bottomInsetRef.current : ch;
    const scale = Math.min(cw / img.width, effH / img.height);
    return { mode: 'fit', scale, tx: (cw - img.width * scale) / 2, ty: (effH - img.height * scale) / 2 };
  }, [containerRef]);

  // Space's animated fit (round-7 UX pack G §2, "スペースでpreviewにフィットする感じで滑らかに中央に戻る"):
  // an in-flight rAF loop driving fitAnimated below. Any OTHER viewport
  // mutation (wheel/pinch zoom, drag pan, double-click fit, the crop
  // overlay's rotate-gesture setViewFree) must cancel it immediately — "a new
  // gesture wins instantly, no fighting the user" — so every one of those
  // entry points calls this first.
  const fitAnimRef = useRef<number | null>(null);
  const cancelFitAnim = useCallback(() => {
    if (fitAnimRef.current !== null) {
      cancelAnimationFrame(fitAnimRef.current);
      fitAnimRef.current = null;
    }
  }, []);
  useEffect(() => cancelFitAnim, [cancelFitAnim]); // stop the rAF loop on unmount

  const fit = useCallback(() => {
    cancelFitAnim();
    const next = computeFit();
    if (next) setView(next);
  }, [computeFit, cancelFitAnim]);

  /** Zoom so the image point under (mx,my) stays put. */
  const zoomAt = useCallback(
    (mx: number, my: number, targetScale: number) => {
      cancelFitAnim();
      setView((v) => {
        const scale = Math.min(Math.max(targetScale, 0.02), MAX_SCALE);
        return {
          mode: 'free',
          scale,
          tx: mx - ((mx - v.tx) * scale) / v.scale,
          ty: my - ((my - v.ty) * scale) / v.scale,
        };
      });
    },
    [cancelFitAnim]
  );

  /**
   * Programmatic view override that also flips to 'free' mode. Used by the
   * crop overlay's LR-style rotate gesture, which drives tx/ty/scale directly
   * each pointer-move so the crop rect's on-screen box stays pinned while the
   * image rotates and zooms beneath it. Intentionally UNCLAMPED (unlike
   * zoomAt): the gesture computes an exact scale from the auto-shrink fit, and
   * a clamp here would let the rect's screen footprint drift.
   */
  const setViewFree = useCallback(
    (tx: number, ty: number, scale: number) => {
      cancelFitAnim();
      setView({ mode: 'free', scale, tx, ty });
    },
    [cancelFitAnim]
  );

  /**
   * Animated fit (Space, global shortcut — see App.tsx/CanvasView.tsx's
   * viewportFitAnimated wiring): eases the CURRENT {tx,ty,scale} to the fit
   * target over `durationMs` via easeOutCubic, instead of fit()'s instant
   * jump. Reads the live view off `viewRef` (not the `view` closed over at
   * call time) so re-triggering mid-flight — or any of the cancellers above
   * firing right before this runs — starts from wherever the view actually
   * is. The FINAL frame sets the exact `computeFit()` object (not the
   * interpolated formula at t=1, which can differ by float epsilon) so a
   * poll for "reached the fit target" can compare directly against a fresh
   * computeFit() call.
   */
  const fitAnimated = useCallback(
    (durationMs = 250) => {
      const target = computeFit();
      if (!target) return;
      cancelFitAnim();
      const from = { tx: viewRef.current.tx, ty: viewRef.current.ty, scale: viewRef.current.scale };
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / durationMs);
        if (t >= 1) {
          setView(target);
          fitAnimRef.current = null;
          return;
        }
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        setView({
          mode: 'free',
          scale: from.scale + (target.scale - from.scale) * eased,
          tx: from.tx + (target.tx - from.tx) * eased,
          ty: from.ty + (target.ty - from.ty) * eased,
        });
        fitAnimRef.current = requestAnimationFrame(step);
      };
      fitAnimRef.current = requestAnimationFrame(step);
    },
    [computeFit, cancelFitAnim]
  );

  const oneToOne = useCallback(
    (mx?: number, my?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const { width: cw, height: ch } = container.getBoundingClientRect();
      zoomAt(mx ?? cw / 2, my ?? ch / 2, 1 / devicePixelRatio);
    },
    [containerRef, zoomAt]
  );

  // Refit when the reserved bottom inset changes (crop mode enter/exit) —
  // but only while already in fit mode; a free (zoomed/panned) view is the
  // user's own and must not snap back just because a mode toggled.
  useEffect(() => {
    if (viewRef.current.mode === 'fit') fit();
  }, [bottomInset, fit]);

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
      // Trackpad pinch arrives in Chromium as a `wheel` event with
      // ctrlKey:true (there's no separate gesture event) — it must ALWAYS
      // zoom, even while suppressWheelZoom opts the plain wheel out for spot
      // mode's brush-radius gesture (task #50/round-6), so pinch keeps
      // working no matter what the plain wheel is repurposed for.
      if (suppressWheelZoomRef.current && !ev.ctrlKey) return;
      const rect = container.getBoundingClientRect();
      // Pinch deltaY per event is small (~1-10 for a typical two-finger
      // pinch, vs ~100+ per notch for a real scroll wheel), so it needs a
      // much stronger coefficient to feel like zooming rather than a crawl:
      // exp(-deltaY * 0.01) is the constant Chromium/Safari apps commonly
      // tune pinch-to-zoom to (e.g. ~10% scale change for a deltaY of ~10).
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
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
      if (target?.closest('.crop-rect, .crop-handle, .crop-controls, .mask-handle, .spot-handle, .spot-controls')) return;
      cancelFitAnim();
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
  }, [containerRef, zoomAt, fit, oneToOne, cancelFitAnim]);

  return { view, fit, fitAnimated, oneToOne, setViewFree };
}
