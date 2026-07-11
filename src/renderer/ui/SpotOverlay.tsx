import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { clampSpot, type Spot } from '../engine/graph/spotsNode';
import type { GraphNode } from '../engine/graph/graphDoc';
import type { ViewportState } from './useCanvasViewport';

interface Props {
  /** The active chain's spots node (appStore.ts's findActiveSpotsNodeId) — undefined before the first spot is ever created. */
  node: GraphNode | undefined;
  view: ViewportState;
  /** Render-output dims (px) — spot coordinates are normalized against these (see spotsNode.ts's doc comment). */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Spot-removal editing overlay (task #50): on-canvas handles for EVERY spot
 * of the active spots node, plus the brush-radius control strip — sibling of
 * the preview <canvas>, same pan/zoom transform and one-drag-one-undo-entry
 * session-coalescing pattern as MaskOverlay.
 *
 * Per spot: a solid circle at dst (drag the body to move it), a dashed
 * circle at src (drag the body to move it), a thin connector line between
 * them, and a small rim handle on dst (drag to resize the radius — shared by
 * both circles, since src/dst are the same size). Pointerdown on any handle
 * also SELECTS that spot (visual highlight) before starting its drag, so a
 * plain click-no-drag still selects — Backspace/Delete then removes the
 * selection (see App.tsx's capture-phase shortcut chain, which takes
 * precedence over React Flow's own Delete binding only while spot mode is
 * active and a spot is actually selected).
 *
 * The brush-radius slider lives here (not gated on `node` existing) so the
 * user can dial in a radius before ever creating a first spot.
 */
export function SpotOverlay({ node, view, canvasWidth, canvasHeight }: Props) {
  const updateSpot = useAppStore((s) => s.updateSpot);
  const selectedSpotIndex = useAppStore((s) => s.selectedSpotIndex);
  const setSelectedSpotIndex = useAppStore((s) => s.setSelectedSpotIndex);
  const selectNode = useAppStore((s) => s.selectNode);
  const spotBrushRadius = useAppStore((s) => s.spotBrushRadius);
  const setSpotBrushRadius = useAppStore((s) => s.setSpotBrushRadius);
  const spots = node?.spots?.spots ?? [];
  const sessionRef = useRef<number | null>(null);
  const maxDim = Math.max(canvasWidth, canvasHeight);

  const commit = (index: number, next: Spot) => {
    if (!node) return;
    sessionRef.current ??= Date.now();
    updateSpot(node.id, index, next, `spot:${node.id}:${index}:${sessionRef.current}`);
  };
  const endSession = () => {
    sessionRef.current = null;
  };

  // Selecting a spot ALSO selects its owning node: selectedNodeId can go
  // stale (e.g. undo/redo past a point where the spots node didn't exist —
  // AppState.selectedNodeId's generic "still present?" check falls back to
  // null and has no reason to know about the ACTIVE spots node this overlay
  // tracks independently of selection). Re-asserting it here keeps the
  // inspector's Spots section in sync AND keeps App.tsx's Backspace/Delete
  // precedence check (which reads `selectedNodeId` alongside
  // `selectedSpotIndex`) working regardless of the graph-selection history.
  const select = (index: number) => {
    if (node) selectNode(node.id);
    setSelectedSpotIndex(index);
  };

  const beginDstDrag = (index: number, spot: Spot) => (ev: React.PointerEvent) => {
    select(index);
    ev.stopPropagation();
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      commit(index, clampSpot({ ...spot, dx: spot.dx + dx, dy: spot.dy + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginSrcDrag = (index: number, spot: Spot) => (ev: React.PointerEvent) => {
    select(index);
    ev.stopPropagation();
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      commit(index, clampSpot({ ...spot, sx: spot.sx + dx, sy: spot.sy + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginRimDrag = (index: number, spot: Spot) => (ev: React.PointerEvent) => {
    select(index);
    ev.stopPropagation();
    ev.preventDefault();
    const centerPxX = spot.dx * canvasWidth;
    const centerPxY = spot.dy * canvasHeight;
    const startRadiusPx = spot.radius * maxDim;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale;
      const dy = (e.clientY - startY) / view.scale;
      const handleX = centerPxX + startRadiusPx + dx;
      const handleY = centerPxY + dy;
      const radiusPx = Math.hypot(handleX - centerPxX, handleY - centerPxY);
      commit(index, clampSpot({ ...spot, radius: Math.max(0.005, radiusPx / maxDim) }));
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
    <>
      <div
        className="spot-overlay"
        data-testid="spot-overlay"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        }}
      >
        <svg className="spot-overlay-svg" width={canvasWidth} height={canvasHeight}>
          {spots.map((spot, i) => (
            <line
              key={`connector-${i}`}
              className={`spot-connector${i === selectedSpotIndex ? ' selected' : ''}`}
              x1={spot.dx * canvasWidth}
              y1={spot.dy * canvasHeight}
              x2={spot.sx * canvasWidth}
              y2={spot.sy * canvasHeight}
            />
          ))}
        </svg>
        {spots.map((spot, i) => {
          const diameter = spot.radius * maxDim * 2;
          return (
            <div key={i}>
              <div
                className={`spot-handle spot-handle-dst${i === selectedSpotIndex ? ' selected' : ''}`}
                data-testid={`spot-handle-dst-${i}`}
                style={{
                  left: pct(spot.dx),
                  top: pct(spot.dy),
                  width: diameter,
                  height: diameter,
                  marginLeft: -diameter / 2,
                  marginTop: -diameter / 2,
                }}
                onPointerDown={beginDstDrag(i, spot)}
              />
              <div
                className={`spot-handle spot-handle-src${i === selectedSpotIndex ? ' selected' : ''}`}
                data-testid={`spot-handle-src-${i}`}
                style={{
                  left: pct(spot.sx),
                  top: pct(spot.sy),
                  width: diameter,
                  height: diameter,
                  marginLeft: -diameter / 2,
                  marginTop: -diameter / 2,
                }}
                onPointerDown={beginSrcDrag(i, spot)}
              />
              <div
                className="spot-handle spot-handle-rim"
                data-testid={`spot-handle-rim-${i}`}
                style={{ left: spot.dx * canvasWidth + spot.radius * maxDim, top: spot.dy * canvasHeight }}
                onPointerDown={beginRimDrag(i, spot)}
              />
            </div>
          );
        })}
      </div>
      <div className="spot-controls" data-testid="spot-controls" onPointerDown={(ev) => ev.stopPropagation()}>
        <label>
          Brush radius
          <input
            type="range"
            min={0.002}
            max={0.15}
            step={0.001}
            value={spotBrushRadius}
            data-testid="spot-radius-slider"
            onChange={(ev) => setSpotBrushRadius(Number(ev.target.value))}
          />
          <span className="spot-radius-value" data-testid="spot-radius-value">
            {(spotBrushRadius * 100).toFixed(1)}%
          </span>
        </label>
      </div>
    </>
  );
}
