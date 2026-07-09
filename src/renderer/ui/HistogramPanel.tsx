import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { HistogramData, ScopeSamples } from '../engine/gpu/graphRenderer';

const CSS_WIDTH = 208;
const CSS_HEIGHT = 92;
const CLIP_WARN = 0.001; // light the badge above 0.1% clipped pixels

type ScopeMode = 'histogram' | 'waveform' | 'parade' | 'vectorscope';

/**
 * Lightroom-style histogram of the rendered output (UI spec §4): 256 bins
 * drawn as smoothly filled curves — luminance as a gray backdrop, R/G/B
 * additively composited so overlaps read as C/M/Y/white — on a log1p
 * vertical axis. Overlaid in the canvas' top-right corner; the clipping
 * badges are this repo's extra.
 *
 * Also hosts the video-style scopes (Wave/Parade/Vec), switched via the mode
 * row above the canvas — all draw from GraphRenderer.scopeSamples() instead
 * of the 256-bin histogram, into the same canvas footprint.
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

function drawHistogram(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, histogram: HistogramData): void {
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
}

/** Luma waveform: brightness on the vertical axis, column position on x. */
function drawWaveform(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, samples: ScopeSamples): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(120, 220, 140, 0.25)';
  const { cols, rows, data } = samples;
  const dot = dpr;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 3;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const x = ((col + 0.5) / cols) * w;
      const y = h - luma * h;
      ctx.fillRect(x, y, dot, dot);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** RGB parade: waveform split into three side-by-side per-channel lanes. */
function drawParade(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, samples: ScopeSamples): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const { cols, rows, data } = samples;
  const dot = dpr;
  const thirdW = w / 3;
  const colors = ['rgba(220, 90, 90, 0.25)', 'rgba(110, 210, 120, 0.25)', 'rgba(100, 140, 230, 0.25)'];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 3;
      const laneX = ((col + 0.5) / cols) * thirdW;
      for (let ch = 0; ch < 3; ch++) {
        const v = data[i + ch]! / 255;
        const x = ch * thirdW + laneX;
        const y = h - v * h;
        ctx.fillStyle = colors[ch]!;
        ctx.fillRect(x, y, dot, dot);
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(thirdW, 0);
  ctx.lineTo(thirdW, h);
  ctx.moveTo(thirdW * 2, 0);
  ctx.lineTo(thirdW * 2, h);
  ctx.stroke();
}

/** Cb/Cr vectorscope: center cross + 75%-radius graticule, additive plot. */
function drawVectorscope(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, samples: ScopeSamples): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) / 1.4;
  ctx.strokeStyle = 'rgba(150, 150, 150, 0.4)';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.arc(cx, cy, scale * 0.75, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(190, 220, 90, 0.25)';
  const { cols, rows, data } = samples;
  const dot = dpr;
  const n = cols * rows;
  for (let idx = 0; idx < n; idx++) {
    const i = idx * 3;
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cb = b - y;
    const cr = r - y;
    const x = cx + cb * scale;
    const py = cy - cr * scale;
    ctx.fillRect(x, py, dot, dot);
  }
  ctx.globalCompositeOperation = 'source-over';
}

export function HistogramPanel() {
  const histogram = useAppStore((s) => s.histogram);
  const scopeMode = useAppStore((s) => s.scopeMode);
  const setScopeMode = useAppStore((s) => s.setScopeMode);
  const scopeSamples = useAppStore((s) => s.scopeSamples);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(CSS_WIDTH * dpr);
    const h = Math.round(CSS_HEIGHT * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (scopeMode === 'histogram') {
      if (!histogram) return;
      drawHistogram(ctx, w, h, dpr, histogram);
    } else if (scopeSamples) {
      if (scopeMode === 'waveform') drawWaveform(ctx, w, h, dpr, scopeSamples);
      else if (scopeMode === 'parade') drawParade(ctx, w, h, dpr, scopeSamples);
      else drawVectorscope(ctx, w, h, dpr, scopeSamples);
    }
  }, [histogram, scopeMode, scopeSamples]);

  // the panel appears once the first histogram lands (image ready); the
  // clip badges below read `histogram`, which keeps updating in every mode
  if (!histogram) return null;
  const shadowLit = histogram.shadowClip > CLIP_WARN;
  const highlightLit = histogram.highlightClip > CLIP_WARN;
  const pct = (v: number) => `${(v * 100).toFixed(v >= 0.01 ? 0 : 1)}%`;
  const modes: { mode: ScopeMode; label: string }[] = [
    { mode: 'histogram', label: 'Hist' },
    { mode: 'waveform', label: 'Wave' },
    { mode: 'parade', label: 'Parade' },
    { mode: 'vectorscope', label: 'Vec' },
  ];
  return (
    <div className="histogram" data-testid="histogram" title="Output scopes (sRGB) — Hist / Wave / Parade / Vec">
      <div className="scope-mode-row">
        {modes.map(({ mode, label }) => (
          <button
            key={mode}
            data-testid={`scope-mode-${mode}`}
            className={scopeMode === mode ? 'active' : undefined}
            onClick={() => setScopeMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>
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
