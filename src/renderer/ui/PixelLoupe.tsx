/**
 * LR-style eyedropper loupe: while an eyedropper is armed and the pointer is
 * over the image, shows the LOUPE_CELLS² pixels around the cursor magnified
 * (nearest-neighbour), the sampled pixel outlined in the center, and its
 * displayed RGB (0-255). Shared by every canvas eyedropper (WB, ColorKey).
 *
 * The pixels are copied from the on-screen canvas with drawImage — Chromium
 * returns the last committed frame of the worker-owned (offscreen) canvas, so
 * this is exactly what the user sees, with no extra GPU readback.
 */
import { useEffect, useRef, useState } from 'react';
import { LOUPE_CELL_PX, LOUPE_CELLS, LOUPE_PX, loupePlacement } from './loupeGeometry';

const READOUT_PX = 36;
const BORDER_PX = 1;

export interface LoupePoint {
  /** Canvas (= image) pixel under the cursor. */
  ix: number;
  iy: number;
  /** Cursor position local to the viewport container. */
  localX: number;
  localY: number;
}

export function PixelLoupe({
  source,
  point,
  bounds,
}: {
  source: HTMLCanvasElement | null;
  point: LoupePoint;
  bounds: { w: number; h: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rgb, setRgb] = useState<[number, number, number] | null>(null);
  const inImage = !!source && point.ix >= 0 && point.iy >= 0 && point.ix < source.width && point.iy < source.height;

  useEffect(() => {
    const out = canvasRef.current;
    const ctx = out?.getContext('2d', { willReadFrequently: true });
    if (!out || !ctx || !source) return;
    const half = (LOUPE_CELLS - 1) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
    // drawImage clips a source rect that runs off the image, so clip it here
    // and offset the destination to keep cells aligned at the edges.
    const sx0 = Math.max(0, point.ix - half);
    const sy0 = Math.max(0, point.iy - half);
    const sx1 = Math.min(source.width, point.ix + half + 1);
    const sy1 = Math.min(source.height, point.iy + half + 1);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(
        source,
        sx0,
        sy0,
        sx1 - sx0,
        sy1 - sy0,
        (sx0 - (point.ix - half)) * LOUPE_CELL_PX,
        (sy0 - (point.iy - half)) * LOUPE_CELL_PX,
        (sx1 - sx0) * LOUPE_CELL_PX,
        (sy1 - sy0) * LOUPE_CELL_PX
      );
    }
    const c = half * LOUPE_CELL_PX;
    if (inImage) {
      const d = ctx.getImageData(c + LOUPE_CELL_PX / 2, c + LOUPE_CELL_PX / 2, 1, 1).data;
      setRgb([d[0]!, d[1]!, d[2]!]);
    } else {
      setRgb(null);
    }
    // faint cell grid, then a black+white outline on the sampled cell so it
    // reads on any color
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < LOUPE_CELLS; i++) {
      const p = i * LOUPE_CELL_PX + 0.5;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, LOUPE_PX);
      ctx.moveTo(0, p);
      ctx.lineTo(LOUPE_PX, p);
    }
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.strokeRect(c - 0.5, c - 0.5, LOUPE_CELL_PX + 1, LOUPE_CELL_PX + 1);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(c + 0.5, c + 0.5, LOUPE_CELL_PX - 1, LOUPE_CELL_PX - 1);
  }, [source, point.ix, point.iy, inImage]);

  const size = { w: LOUPE_PX + 2 * BORDER_PX, h: LOUPE_PX + READOUT_PX + 2 * BORDER_PX };
  const { left, top } = loupePlacement({ x: point.localX, y: point.localY }, size, bounds);
  return (
    <div
      className="pixel-loupe"
      data-testid="pixel-loupe"
      data-ix={point.ix}
      data-iy={point.iy}
      data-rgb={rgb ? rgb.join(',') : ''}
      style={{ left, top, width: size.w }}
    >
      <canvas ref={canvasRef} width={LOUPE_PX} height={LOUPE_PX} className="pixel-loupe-grid" />
      <div className="pixel-loupe-readout">
        {rgb ? (
          <>
            <span>R {rgb[0]}</span>
            <span>G {rgb[1]}</span>
            <span>B {rgb[2]}</span>
          </>
        ) : (
          <span>—</span>
        )}
        <span className="pixel-loupe-xy">
          {point.ix}, {point.iy}
        </span>
      </div>
    </div>
  );
}
