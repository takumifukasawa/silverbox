import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { GradingRegion, GradingWheel } from '../engine/graph/developNode';

const WHEEL_SIZE = 84;

let wheelSession = 0;

/**
 * One color-grading wheel: angle = hue (0° = east, clockwise — matching the
 * conic-gradient background), radius = saturation. Drag sets hue+sat in one
 * batched, session-coalesced edit (one drag = one undo); double-click resets
 * the wheel's saturation.
 */
export function ColorWheel({
  nodeId,
  region,
  wheel,
}: {
  nodeId: string;
  region: GradingRegion;
  wheel: GradingWheel;
}) {
  const updateNodeParamsBatch = useAppStore((s) => s.updateNodeParamsBatch);
  const dragRef = useRef<number | null>(null);

  const radius = WHEEL_SIZE / 2;
  const knobR = (wheel.sat / 100) * (radius - 7);
  const rad = (wheel.hue * Math.PI) / 180;
  const knobX = radius + Math.cos(rad) * knobR;
  const knobY = radius + Math.sin(rad) * knobR;

  const applyPointer = (ev: React.PointerEvent, session: number) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const dx = ev.clientX - rect.left - radius;
    const dy = ev.clientY - rect.top - radius;
    const hue = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360);
    const sat = Math.round(Math.min(100, (Math.hypot(dx, dy) / (radius - 7)) * 100));
    updateNodeParamsBatch(
      nodeId,
      [
        [`grading.${region}.hue`, hue],
        [`grading.${region}.sat`, sat],
      ],
      `wheel:${nodeId}:${region}:${session}`
    );
  };

  return (
    <div className="grading-wheel-block">
      <div className="grading-wheel-label">{region}</div>
      <div
        className="grading-wheel"
        data-testid={`grading-wheel-${region}`}
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
        onPointerDown={(ev) => {
          dragRef.current = ++wheelSession;
          (ev.target as Element).setPointerCapture(ev.pointerId);
          applyPointer(ev, dragRef.current);
        }}
        onPointerMove={(ev) => {
          if (dragRef.current !== null) applyPointer(ev, dragRef.current);
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onDoubleClick={() =>
          updateNodeParamsBatch(nodeId, [[`grading.${region}.sat`, 0]], `wheel:${nodeId}:${region}:${++wheelSession}`)
        }
        title="Drag to tint · double-click to reset"
      >
        <div
          className="grading-wheel-knob"
          style={{ left: knobX, top: knobY }}
          data-testid={`grading-knob-${region}`}
        />
      </div>
      <input
        type="range"
        className="grading-lum"
        data-testid={`grading-lum-${region}`}
        min={-100}
        max={100}
        step={1}
        value={wheel.lum}
        title="Luminance"
        onChange={(ev) =>
          updateNodeParamsBatch(
            nodeId,
            [[`grading.${region}.lum`, Number(ev.target.value)]],
            `wheellum:${nodeId}:${region}`
          )
        }
        onDoubleClick={() =>
          updateNodeParamsBatch(nodeId, [[`grading.${region}.lum`, 0]], `wheellum:${nodeId}:${region}:${++wheelSession}`)
        }
      />
    </div>
  );
}
