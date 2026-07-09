import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';

const CSS_WIDTH = 208;
const CSS_HEIGHT = 92;
const CLIP_WARN = 0.001; // light the badge above 0.1% clipped pixels

/**
 * Lightroom-style histogram of the rendered output (UI spec §4): 256 bins
 * drawn as smoothly filled curves — luminance as a gray backdrop, R/G/B
 * additively composited so overlaps read as C/M/Y/white — on a log1p
 * vertical axis. Overlaid in the canvas' top-right corner; the clipping
 * badges are this repo's extra.
 */

/** Two [1,2,1]/4 passes — enough to take sampling noise off the curve. */
function smooth(counts: number[]): Float32Array {
  const n = counts.length;
  let src = Float32Array.from(counts);
  let dst = new Float32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = src[Math.max(0, i - 1)]!;
      const c = src[Math.min(n - 1, i + 1)]!;
      dst[i] = (a + 2 * src[i]! + c) / 4;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/**
 * Fill one channel as a smooth curve: quadratic segments through midpoints
 * (stays inside the hull of adjacent vertices → no fake peaks), closed to
 * the baseline.
 */
function fillCurve(
  ctx: CanvasRenderingContext2D,
  values: Float32Array,
  w: number,
  h: number,
  toY: (v: number) => number,
  style: string
): void {
  const n = values.length;
  const xAt = (i: number) => ((i + 0.5) / n) * w;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(0, h + 1);
  ctx.lineTo(0, toY(values[0]!));
  ctx.lineTo(xAt(0), toY(values[0]!));
  for (let i = 0; i < n - 1; i++) {
    const mx = (xAt(i) + xAt(i + 1)) / 2;
    const my = (toY(values[i]!) + toY(values[i + 1]!)) / 2;
    ctx.quadraticCurveTo(xAt(i), toY(values[i]!), mx, my);
  }
  ctx.quadraticCurveTo(xAt(n - 1), toY(values[n - 1]!), w, toY(values[n - 1]!));
  ctx.lineTo(w, h + 1);
  ctx.closePath();
  ctx.fill();
}

export function HistogramPanel() {
  const histogram = useAppStore((s) => s.histogram);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !histogram) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(CSS_WIDTH * dpr);
    const h = Math.round(CSS_HEIGHT * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);

    const channels = {
      r: smooth(histogram.r),
      g: smooth(histogram.g),
      b: smooth(histogram.b),
      luma: smooth(histogram.luma),
    };
    let max = 1;
    for (const ch of Object.values(channels)) {
      for (let i = 0; i < ch.length; i++) if (ch[i]! > max) max = ch[i]!;
    }
    // log-ish vertical scale keeps shadow/highlight tails readable
    const pad = 3 * dpr;
    const logMax = Math.log1p(max);
    const toY = (v: number) => h - (Math.log1p(v) / logMax) * (h - pad);

    fillCurve(ctx, channels.luma, w, h, toY, 'rgba(175, 175, 175, 0.36)');
    ctx.globalCompositeOperation = 'lighter';
    fillCurve(ctx, channels.r, w, h, toY, 'rgba(190, 58, 58, 0.85)');
    fillCurve(ctx, channels.g, w, h, toY, 'rgba(70, 172, 84, 0.85)');
    fillCurve(ctx, channels.b, w, h, toY, 'rgba(76, 104, 210, 0.85)');
    ctx.globalCompositeOperation = 'source-over';
  }, [histogram]);

  if (!histogram) return null;
  const shadowLit = histogram.shadowClip > CLIP_WARN;
  const highlightLit = histogram.highlightClip > CLIP_WARN;
  const pct = (v: number) => `${(v * 100).toFixed(v >= 0.01 ? 0 : 1)}%`;
  return (
    <div className="histogram" data-testid="histogram" title="Output histogram (sRGB) — RGB + luminance">
      <canvas
        ref={canvasRef}
        style={{ width: CSS_WIDTH, height: CSS_HEIGHT }}
        data-testid="histogram-canvas"
      />
      <div className="histogram-clip-row">
        <span
          className={`histogram-clip${shadowLit ? ' lit' : ''}`}
          data-testid="clip-shadows"
          title="pixels with a channel at 0"
        >
          ◢ {pct(histogram.shadowClip)}
        </span>
        <span
          className={`histogram-clip${highlightLit ? ' lit' : ''}`}
          data-testid="clip-highlights"
          title="pixels with a channel at 255"
        >
          {pct(histogram.highlightClip)} ◣
        </span>
      </div>
    </div>
  );
}
