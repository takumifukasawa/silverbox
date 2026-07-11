import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { clampSpot, type Spot } from '../engine/graph/spotsNode';
import type { GeometryParams, GraphNode } from '../engine/graph/graphDoc';
import { anchorToOutput, outputRadiusToAnchor, outputToAnchor, spotAnchorToOutput } from '../engine/graph/anchorSpace';
import type { ViewportState } from './useCanvasViewport';

interface Props {
  /** The active chain's spots node (appStore.ts's findActiveSpotsNodeId) — undefined before the first spot is ever created. */
  node: GraphNode | undefined;
  view: ViewportState;
  /** Render-output dims (px) — the frame the on-canvas handles are drawn in. */
  canvasWidth: number;
  canvasHeight: number;
  /** The committed input-node geometry + decoded oriented dims for anchor↔output conversion (anchorSpace.ts). */
  geometry: GeometryParams;
  orientedWidth: number;
  orientedHeight: number;
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
export function SpotOverlay({ node, view, canvasWidth, canvasHeight, geometry, orientedWidth, orientedHeight }: Props) {
  const updateSpot = useAppStore((s) => s.updateSpot);
  const selectedSpotIndex = useAppStore((s) => s.selectedSpotIndex);
  const setSelectedSpotIndex = useAppStore((s) => s.setSelectedSpotIndex);
  const selectNode = useAppStore((s) => s.selectNode);
  const spotBrushRadius = useAppStore((s) => s.spotBrushRadius);
  const setSpotBrushRadius = useAppStore((s) => s.setSpotBrushRadius);
  const spots = node?.spots?.spots ?? [];
  const sessionRef = useRef<number | null>(null);
  const sliderSessionRef = useRef<number | null>(null);
  const maxDim = Math.max(canvasWidth, canvasHeight);
  const ow = orientedWidth;
  const oh = orientedHeight;
  // Spots are stored in ANCHOR space (anchorSpace.ts); project to the OUTPUT
  // frame for rendering. Drags convert the dragged OUTPUT position back to
  // anchor before committing (identity geometry ⇒ both maps are the identity).
  const outSpots = spots.map((s) => spotAnchorToOutput(s, geometry, ow, oh));

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
    const startOut = anchorToOutput(spot.dx, spot.dy, geometry, ow, oh);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      const a = outputToAnchor(startOut.x + dx, startOut.y + dy, geometry, ow, oh);
      commit(index, clampSpot({ ...spot, dx: a.x, dy: a.y }));
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
    const startOut = anchorToOutput(spot.sx, spot.sy, geometry, ow, oh);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale / canvasWidth;
      const dy = (e.clientY - startY) / view.scale / canvasHeight;
      const a = outputToAnchor(startOut.x + dx, startOut.y + dy, geometry, ow, oh);
      commit(index, clampSpot({ ...spot, sx: a.x, sy: a.y }));
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
    const outSpot = spotAnchorToOutput(spot, geometry, ow, oh);
    const centerPxX = outSpot.dx * canvasWidth;
    const centerPxY = outSpot.dy * canvasHeight;
    const startRadiusPx = outSpot.radius * maxDim;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / view.scale;
      const dy = (e.clientY - startY) / view.scale;
      const handleX = centerPxX + startRadiusPx + dx;
      const handleY = centerPxY + dy;
      const radiusPx = Math.hypot(handleX - centerPxX, handleY - centerPxY);
      const outRadius = Math.max(0.005, radiusPx / maxDim);
      commit(index, clampSpot({ ...spot, radius: outputRadiusToAnchor(outRadius, geometry, ow, oh) }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endSession();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // LR expectation (round-5 finding): with a spot SELECTED, the size
  // slider/wheel resizes THAT spot instead of the next-spot brush radius —
  // this is the only place that distinction is made; the wheel handler in
  // CanvasView.tsx mirrors it independently (no shared code, since it has no
  // access to this component's per-spot output-space radius already computed
  // in outSpots). `spots[selectedSpotIndex]` guards against a stale index
  // (e.g. after undo/redo past a point where this spot no longer exists).
  const selectedSpot = selectedSpotIndex !== null ? spots[selectedSpotIndex] : undefined;
  const selectedOutSpot = selectedSpotIndex !== null ? outSpots[selectedSpotIndex] : undefined;
  const isEditingSelection = !!node && !!selectedSpot && !!selectedOutSpot;

  const handleSliderChange = (outputRadius: number) => {
    if (isEditingSelection && node && selectedSpotIndex !== null) {
      sliderSessionRef.current ??= Date.now();
      const anchorRadius = outputRadiusToAnchor(outputRadius, geometry, ow, oh);
      updateSpot(
        node.id,
        selectedSpotIndex,
        { radius: anchorRadius },
        `spot-radius:${node.id}:${selectedSpotIndex}:${sliderSessionRef.current}`
      );
    } else {
      setSpotBrushRadius(outputRadius);
    }
  };

  const sliderValue = isEditingSelection ? selectedOutSpot!.radius : spotBrushRadius;
  const sliderLabel = isEditingSelection ? 'Spot radius' : 'Brush radius';

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
          {outSpots.map((out, i) => (
            <line
              key={`connector-${i}`}
              className={`spot-connector${i === selectedSpotIndex ? ' selected' : ''}`}
              x1={out.dx * canvasWidth}
              y1={out.dy * canvasHeight}
              x2={out.sx * canvasWidth}
              y2={out.sy * canvasHeight}
            />
          ))}
        </svg>
        {outSpots.map((out, i) => {
          const spot = spots[i]!;
          const diameter = out.radius * maxDim * 2;
          return (
            <div key={i}>
              <div
                className={`spot-handle spot-handle-dst${i === selectedSpotIndex ? ' selected' : ''}`}
                data-testid={`spot-handle-dst-${i}`}
                style={{
                  left: pct(out.dx),
                  top: pct(out.dy),
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
                  left: pct(out.sx),
                  top: pct(out.sy),
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
                style={{ left: out.dx * canvasWidth + out.radius * maxDim, top: out.dy * canvasHeight }}
                onPointerDown={beginRimDrag(i, spot)}
              />
            </div>
          );
        })}
      </div>
      <div className="spot-controls" data-testid="spot-controls" onPointerDown={(ev) => ev.stopPropagation()}>
        <label>
          {sliderLabel}
          <input
            type="range"
            min={0.002}
            max={0.15}
            step={0.001}
            value={sliderValue}
            data-testid="spot-radius-slider"
            onPointerDown={() => {
              if (isEditingSelection) sliderSessionRef.current = Date.now();
            }}
            onPointerUp={() => {
              sliderSessionRef.current = null;
            }}
            onChange={(ev) => handleSliderChange(Number(ev.target.value))}
          />
          <span className="spot-radius-value" data-testid="spot-radius-value">
            {(sliderValue * 100).toFixed(1)}%
          </span>
        </label>
      </div>
    </>
  );
}
