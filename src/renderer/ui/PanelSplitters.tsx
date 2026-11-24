/**
 * Drag handles for the panel layout (panelLayout.ts): a vertical splitter
 * between the canvas and the Inspector, and the node editor's header bar
 * (its height handle, with a Show/Hide nodes button that collapses it).
 *
 * Double-click a handle to restore its default size.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampInspectorWidth,
  clampNodeEditorHeight,
  DEFAULT_PANEL_LAYOUT,
  sanitizePanelLayout,
  type PanelLayout,
} from '../../../shared/panelLayout';
import { useAppStore } from '../store/appStore';

/** Below this many px of pointer travel a press is a click, not a drag. */
const DRAG_THRESHOLD = 3;

/**
 * `commit: false` is a live drag frame (local state only); `commit: true`
 * also writes settings.json. Drags commit once, on release.
 */
export type PanelLayoutChange = (patch: Partial<PanelLayout>, commit: boolean) => void;

export function usePanelLayout(): [PanelLayout, PanelLayoutChange] {
  const field = window.silverbox?.testFlags?.isTest ? 'panelLayoutTest' : 'panelLayout';
  const stored = useAppStore((s) => s.settings[field]);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // live drag override; null = show what settings hold
  const [live, setLive] = useState<PanelLayout | null>(null);
  const base = live ?? sanitizePanelLayout(stored);
  const baseRef = useRef(base);
  baseRef.current = base;
  // Commits are chained so overlapping writes (click, click, double-click on
  // the node bar) land in order, and the live override is dropped only once
  // the last one has.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingRef = useRef(0);
  const change = useCallback<PanelLayoutChange>(
    (patch, commit) => {
      const next = { ...baseRef.current, ...patch };
      baseRef.current = next;
      setLive(next);
      if (!commit) return;
      pendingRef.current++;
      chainRef.current = chainRef.current
        .then(() => updateSettings({ [field]: next }))
        .catch(() => {})
        .finally(() => {
          if (--pendingRef.current === 0) setLive(null);
        });
    },
    [field, updateSettings]
  );
  // re-clamp when the window shrinks, so a remembered size never squeezes
  // the canvas out (the stored value is left alone)
  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return [
    {
      ...base,
      inspectorWidth: clampInspectorWidth(base.inspectorWidth, window.innerWidth),
      nodeEditorHeight: clampNodeEditorHeight(base.nodeEditorHeight, window.innerHeight),
    },
    change,
  ];
}

/** Pointer-captured drag: calls onMove with the travel since pointerdown. */
function startDrag(
  ev: React.PointerEvent<HTMLElement>,
  onMove: (dx: number, dy: number) => void,
  onEnd: (moved: boolean) => void
) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const el = ev.currentTarget;
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let moved = false;
  el.setPointerCapture(ev.pointerId);
  document.body.classList.add('panel-dragging');
  const move = (e: PointerEvent) => {
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    moved = true;
    onMove(dx, dy);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    document.body.classList.remove('panel-dragging');
    onEnd(moved);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

export function InspectorSplitter({
  width,
  onChange,
}: {
  width: number;
  onChange: PanelLayoutChange;
}) {
  return (
    <div
      className="panel-splitter panel-splitter--vertical"
      data-testid="inspector-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      title="Drag to resize the Inspector (double-click to reset)"
      onPointerDown={(ev) => {
        const w0 = width;
        let last = w0;
        startDrag(
          ev,
          (dx) => {
            last = clampInspectorWidth(w0 - dx, window.innerWidth);
            onChange({ inspectorWidth: last }, false);
          },
          (moved) => {
            if (moved) onChange({ inspectorWidth: last }, true);
          }
        );
      }}
      onDoubleClick={() => onChange({ inspectorWidth: DEFAULT_PANEL_LAYOUT.inspectorWidth }, true)}
    />
  );
}

export function NodeEditorBar({
  height,
  collapsed,
  onChange,
}: {
  height: number;
  collapsed: boolean;
  onChange: PanelLayoutChange;
}) {
  return (
    <div
      className="node-editor-bar"
      data-testid="node-editor-bar"
      data-collapsed={collapsed ? 'true' : 'false'}
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize the node graph (double-click to reset)"
      onPointerDown={(ev) => {
        if ((ev.target as HTMLElement).closest('button')) return;
        // dragging a collapsed editor opens it from zero height
        const h0 = collapsed ? 0 : height;
        let last = height;
        startDrag(
          ev,
          (_dx, dy) => {
            last = clampNodeEditorHeight(h0 - dy, window.innerHeight);
            onChange({ nodeEditorCollapsed: false, nodeEditorHeight: last }, false);
          },
          (moved) => {
            // A plain click does nothing: toggling here would move the bar
            // out from under the second click of a double-click (reset).
            if (moved) onChange({ nodeEditorCollapsed: false, nodeEditorHeight: last }, true);
          }
        );
      }}
      onDoubleClick={() => onChange({ nodeEditorCollapsed: false, nodeEditorHeight: DEFAULT_PANEL_LAYOUT.nodeEditorHeight }, true)}
    >
      <button
        type="button"
        className="node-editor-bar-toggle"
        data-testid="node-editor-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Show the node graph' : 'Hide the node graph'}
        onClick={() => onChange({ nodeEditorCollapsed: !collapsed }, true)}
      >
        {collapsed ? '▸ Show nodes' : '▾ Hide nodes'}
      </button>
      <span className="node-editor-bar-grip" aria-hidden="true" />
    </div>
  );
}
