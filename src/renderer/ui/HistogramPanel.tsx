import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';

const CLIP_WARN = 0.001; // light the badge above 0.1% clipped pixels

/**
 * Per-channel histogram of the rendered output with shadow/highlight clipping
 * badges. Data comes from GraphRenderer.stats(), refreshed debounced after
 * each render.
 */
export function HistogramPanel() {
  const histogram = useAppStore((s) => s.histogram);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !histogram) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'screen';
    const channels: Array<[number[], string]> = [
      [histogram.r, 'rgb(200, 70, 70)'],
      [histogram.g, 'rgb(80, 170, 80)'],
      [histogram.b, 'rgb(80, 110, 220)'],
    ];
    const max = Math.max(1, ...histogram.r, ...histogram.g, ...histogram.b);
    const barWidth = width / histogram.bins;
    for (const [counts, color] of channels) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < histogram.bins; i++) {
        const h = (counts[i]! / max) * height;
        ctx.rect(i * barWidth, height - h, barWidth, h);
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [histogram]);

  if (!histogram) return null;
  const shadowLit = histogram.shadowClip > CLIP_WARN;
  const highlightLit = histogram.highlightClip > CLIP_WARN;
  const pct = (v: number) => `${(v * 100).toFixed(v >= 0.01 ? 0 : 1)}%`;
  return (
    <div className="histogram-panel">
      <canvas ref={canvasRef} width={300} height={90} className="histogram-canvas" data-testid="histogram-canvas" />
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
