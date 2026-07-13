import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  CURVE_MAX,
  identityCurvePoints,
  isIdentityCurve,
  type CurvePoints,
  type DevelopParams,
} from '../engine/graph/developNode';
import { curveEvaluator } from '../engine/color/toneCurve';

const CHANNELS = ['rgb', 'r', 'g', 'b'] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_COLOR: Record<Channel, string> = { rgb: '#e6e6e6', r: '#e57373', g: '#7fc97f', b: '#6ea8e5' };
const HIT_PX = 10;
const MIN_GAP = 1;
const CURVE_SAMPLES = 128;

let dragSession = 0;

/**
 * Point tone-curve editor (UI spec §8): channel tabs, an SVG plot in 0–255
 * display units with grid + identity diagonal, click-to-add / drag / double-
 * click to delete points; endpoints are the black/white points (movable on
 * both axes, never deletable). All edits flow through setToneCurvePoints —
 * the GraphDoc stays the single source of truth, one drag = one undo entry
 * (session-keyed coalescing).
 *
 * Round-8 NG fix pack item 3: dragging a point outside the plot used to
 * DELETE it (re-inserting it if the drag re-entered the plot), which jumped
 * the curve mid-drag and confused users. It now just CLAMPS the point to the
 * plot bounds instead — no delete, no jump. Deletion stays double-click only
 * (onDoubleClick below, unchanged), with a dim discoverability hint under the
 * editor now that drag-out no longer doubles as a delete gesture.
 */
export function ToneCurveEditor({ nodeId, params }: { nodeId: string; params: DevelopParams }) {
  const setToneCurvePoints = useAppStore((s) => s.setToneCurvePoints);
  const [channel, setChannel] = useState<Channel>('rgb');
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ index: number; session: number } | null>(null);
  const [readout, setReadout] = useState<string | null>(null);

  const points = params.toneCurve[channel];
  const evalCurve = curveEvaluator(points);
  const path = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => {
    const x = (i / CURVE_SAMPLES) * CURVE_MAX;
    return `${x},${CURVE_MAX - evalCurve(x)}`;
  }).join(' ');

  /** Pointer event → curve coordinates (y up). */
  const toCurve = (ev: React.PointerEvent): { x: number; y: number; pxPerUnitX: number; pxPerUnitY: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * CURVE_MAX,
      y: (1 - (ev.clientY - rect.top) / rect.height) * CURVE_MAX,
      pxPerUnitX: rect.width / CURVE_MAX,
      pxPerUnitY: rect.height / CURVE_MAX,
    };
  };

  const commit = (pts: CurvePoints, session: number) => setToneCurvePoints(nodeId, channel, pts, session);

  const onPointerDown = (ev: React.PointerEvent) => {
    const { x, y, pxPerUnitX, pxPerUnitY } = toCurve(ev);
    const session = ++dragSession;
    // hit-test existing points (10 CSS px)
    let index = -1;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot((p[0] - x) * pxPerUnitX, (p[1] - y) * pxPerUnitY);
      if (d < best) {
        best = d;
        index = i;
      }
    });
    if (best > HIT_PX) {
      // add a point at the clicked input x, on the current curve
      const nx = Math.round(Math.min(CURVE_MAX, Math.max(0, x)));
      if (points.some((p) => Math.abs(p[0] - nx) < MIN_GAP)) return;
      const ny = Math.round(evalCurve(nx));
      const next = [...points, [nx, ny] as [number, number]].sort((a, b) => a[0] - b[0]);
      index = next.findIndex((p) => p[0] === nx);
      commit(next, session);
    }
    dragRef.current = { index, session };
    (ev.target as Element).setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const current = useAppStore.getState().graph.nodes.find((n) => n.id === nodeId)?.develop?.toneCurve[channel];
    if (!current) return;
    const { x, y } = toCurve(ev);

    const next = current.map((p) => [...p] as [number, number]);
    const p = next[drag.index]!;
    // x clamps between the neighbours (endpoints keep their input range
    // edge-free); y clamps to the plot's 0..CURVE_MAX bounds. `x`/`y` above
    // are unclamped (toCurve is a plain linear map from pointer position, so
    // dragging past any edge of the SVG sends them negative or past
    // CURVE_MAX) — clamping HERE, rather than deleting the point once the
    // pointer clears some outside threshold, is the round-8 fix: the point
    // just holds at the edge instead of vanishing and (on re-entry)
    // reappearing at a new position, which read as a visible jump.
    const lo = drag.index === 0 ? 0 : next[drag.index - 1]![0] + MIN_GAP;
    const hi = drag.index === next.length - 1 ? CURVE_MAX : next[drag.index + 1]![0] - MIN_GAP;
    p[0] = Math.round(Math.min(hi, Math.max(lo, x)));
    p[1] = Math.round(Math.min(CURVE_MAX, Math.max(0, y)));
    setReadout(`in ${p[0]} / out ${p[1]}`);
    commit(next, drag.session);
  };

  const onPointerUp = () => {
    dragRef.current = null;
    setReadout(null);
  };

  const onDoubleClick = (ev: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * CURVE_MAX;
    const y = (1 - (ev.clientY - rect.top) / rect.height) * CURVE_MAX;
    let index = -1;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot(((p[0] - x) * rect.width) / CURVE_MAX, ((p[1] - y) * rect.height) / CURVE_MAX);
      if (d < best) {
        best = d;
        index = i;
      }
    });
    if (best <= HIT_PX && index > 0 && index < points.length - 1) {
      commit(points.filter((_, i) => i !== index), ++dragSession);
    }
  };

  return (
    <div className="tonecurve">
      <div className="tonecurve-toolbar">
        {CHANNELS.map((ch) => (
          <button
            key={ch}
            className={`tonecurve-tab${ch === channel ? ' active' : ''}`}
            style={{ color: CHANNEL_COLOR[ch] }}
            data-testid={`curve-tab-${ch}`}
            onClick={() => setChannel(ch)}
          >
            {ch.toUpperCase()}
            {!isIdentityCurve(params.toneCurve[ch]) && <span className="tonecurve-dot">●</span>}
          </button>
        ))}
        <button
          className="tonecurve-reset"
          data-testid="curve-reset"
          onClick={() => commit(identityCurvePoints(), ++dragSession)}
        >
          Reset
        </button>
      </div>
      <svg
        ref={svgRef}
        className="tonecurve-svg"
        data-testid="curve-editor"
        viewBox={`0 0 ${CURVE_MAX} ${CURVE_MAX}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * CURVE_MAX} y1="0" x2={f * CURVE_MAX} y2={CURVE_MAX} stroke="#2e2e2e" />
            <line x1="0" y1={f * CURVE_MAX} x2={CURVE_MAX} y2={f * CURVE_MAX} stroke="#2e2e2e" />
          </g>
        ))}
        <line x1="0" y1={CURVE_MAX} x2={CURVE_MAX} y2="0" stroke="#3d3d3d" strokeDasharray="6 6" />
        <polyline points={path} fill="none" stroke={CHANNEL_COLOR[channel]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p[0]}
            cy={CURVE_MAX - p[1]}
            r="5"
            fill={CHANNEL_COLOR[channel]}
            stroke="#141414"
          />
        ))}
      </svg>
      <div className="tonecurve-readout">{readout ?? 'click: add point · drag to edit'}</div>
      {/* Discoverability hint (round-8 fix pack item 3): drag-out no longer
          deletes a point (it clamps — see onPointerMove), so double-click is
          now the ONLY way to remove one and needs its own callout, same dim
          treatment as the crop strip's ⌥ hint (CropOverlay.tsx). */}
      <div className="tonecurve-hint" data-testid="curve-delete-hint">
        double-click a point to remove it
      </div>
    </div>
  );
}
