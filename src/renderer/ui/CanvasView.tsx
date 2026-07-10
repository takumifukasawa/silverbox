import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { srgbEncode } from '../engine/color/srgb';
import { GraphRenderer } from '../engine/gpu/graphRenderer';
import { buildPlan, cpuEvalPlan, planHasCpuReference, type GraphDoc } from '../engine/graph/graphDoc';
import { useCanvasViewport, type ViewportState } from './useCanvasViewport';
import { HistogramPanel } from './HistogramPanel';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number };
      rendererKind(): 'webgpu';
      outputSize(): { width: number; height: number } | null;
      readbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      readbackSharpness(): Promise<{ luma: number; chroma: number } | null>;
      cpuReferenceMean(): { r: number; g: number; b: number } | null;
      graphState(): GraphDoc;
      graphDirty(): boolean;
      shaderErrors(): Record<string, string>;
      /** In-page access to the decoded linear pixels for reference math. */
      imageForVerify(): { data: Float32Array; width: number; height: number } | null;
      updateNodeParam(nodeId: string, key: string, value: number): void;
      applyShaderSource(nodeId: string, src: string): Promise<void>;
      addShaderParam(nodeId: string, def: { name: string; min: number; max: number; default: number }): string | null;
      updateShaderParam(nodeId: string, name: string, value: number): void;
      removeShaderParam(nodeId: string, name: string): void;
      exportImageTo(path: string): void;
      exportState(): { status: string; error: string | null };
      canvasView(): ViewportState & { dpr: number };
      wbState(): { asShot: { temp: number; tint: number }; mccamyCct: number };
      setToneCurvePoints(nodeId: string, channel: 'rgb' | 'r' | 'g' | 'b', points: [number, number][]): void;
      histogramState(): import('../engine/gpu/graphRenderer').HistogramData | null;
      historyState(): { past: number; future: number };
      scopeState(): {
        mode: string;
        samples: { cols: number; rows: number; length: number; meanLuma: number } | null;
      };
      setScopeMode(mode: 'histogram' | 'waveform' | 'parade' | 'vectorscope'): void;
    };
  }
}

/**
 * Preview area. Milestone 4: the GraphDoc op chain runs as WebGPU passes over
 * the linear preview, ending in the exact sRGB encode. The verify harness
 * compares the GPU readback against cpuReferenceMean(), which executes the
 * same chain on the CPU via the op registry's reference implementations.
 */
export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Promise<GraphRenderer> | null>(null);
  const lastImageRef = useRef<unknown>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const imageError = useAppStore((s) => s.imageError);
  const graph = useAppStore((s) => s.graph);
  const shaderRev = useAppStore((s) => s.shaderRev);
  const wbModel = useAppStore((s) => s.wbModel);
  const showBefore = useAppStore((s) => s.showBefore);
  const grayscaleView = useAppStore((s) => s.grayscaleView);
  const toggleBefore = useAppStore((s) => s.toggleBefore);
  const toggleGrayscaleView = useAppStore((s) => s.toggleGrayscaleView);
  const { view, fit, oneToOne } = useCanvasViewport(containerRef, image);
  const viewRef = useRef(view);
  viewRef.current = view;
  const statsTimerRef = useRef<number | undefined>(undefined);
  const scopeMode = useAppStore((s) => s.scopeMode);

  // switching into a non-histogram mode fetches fresh samples immediately:
  // edits made while the histogram was showing don't update scopeSamples, so
  // an existing value may be stale — always refetch, never just reuse it
  useEffect(() => {
    if (scopeMode === 'histogram') return;
    const renderer = useAppStore.getState().renderer;
    if (!renderer || !renderer.hasImage) return;
    void renderer.scopeSamples().then((samples) => {
      useAppStore.getState().setScopeSamples(samples);
    });
  }, [scopeMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    let cancelled = false;
    void (async () => {
      try {
        rendererRef.current ??= GraphRenderer.create(canvas).then((r) => {
          useAppStore.getState().setRenderer(r);
          return r;
        });
        const renderer = await rendererRef.current;
        if (cancelled) return;
        if (lastImageRef.current !== image) {
          canvas.width = image.width;
          canvas.height = image.height;
          renderer.setImage(image);
          lastImageRef.current = image;
        }
        // a broken input→output path renders as pass-through with a banner
        // in the node editor instead of killing the preview
        let plan;
        try {
          plan = buildPlan(graph, {
            wb: wbModel,
            renderScale: Math.max(image.width, image.height) / Math.max(image.fullWidth, image.fullHeight),
          });
          useAppStore.getState().setGraphBroken(false);
        } catch {
          plan = { steps: [], output: -1 };
          useAppStore.getState().setGraphBroken(true);
        }
        // Before/After: show the unedited decode (readbacks follow, so the
        // histogram describes what is on screen — LR behavior)
        if (showBefore) plan = { steps: [], output: -1 };
        renderer.viewMode = grayscaleView ? 'grayscale' : 'color';
        await renderer.setGraph(plan);
        if (cancelled) return;
        renderer.render();
        setGpuError(null);
        // refresh the histogram once edits settle (slider drags fire rapidly)
        clearTimeout(statsTimerRef.current);
        statsTimerRef.current = window.setTimeout(() => {
          void renderer.stats().then((stats) => {
            if (stats) useAppStore.getState().setHistogram(stats);
          });
          // scope samples are an extra readback — skip them in the default
          // histogram mode, where nothing consumes them
          if (useAppStore.getState().scopeMode !== 'histogram') {
            void renderer.scopeSamples().then((samples) => {
              useAppStore.getState().setScopeSamples(samples);
            });
          }
        }, 120);
      } catch (err) {
        if (!cancelled) setGpuError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [image, graph, shaderRev, wbModel, showBefore, grayscaleView]);

  useEffect(() => {
    window.__debug = {
      imageState() {
        const s = useAppStore.getState();
        return {
          status: s.imageStatus,
          width: s.image?.width,
          height: s.image?.height,
          fullWidth: s.image?.fullWidth,
          fullHeight: s.image?.fullHeight,
        };
      },
      rendererKind() {
        return 'webgpu';
      },
      outputSize() {
        const canvas = canvasRef.current;
        if (!canvas || canvas.width === 0) return null;
        return { width: canvas.width, height: canvas.height };
      },
      async readbackMean() {
        const renderer = rendererRef.current ? await rendererRef.current : null;
        if (!renderer || !renderer.hasImage) return null;
        return renderer.readbackMean();
      },
      async readbackSharpness() {
        const renderer = rendererRef.current ? await rendererRef.current : null;
        if (!renderer || !renderer.hasImage) return null;
        return renderer.readbackSharpness();
      },
      cpuReferenceMean() {
        const s = useAppStore.getState();
        if (!s.image) return null;
        const { data, width, height } = s.image;
        const plan = buildPlan(s.graph, {
          wb: s.wbModel,
          renderScale: Math.max(width, height) / Math.max(s.image.fullWidth, s.image.fullHeight),
        });
        // custom WGSL (and not-yet-mirrored Develop sections) have no CPU reference
        if (!planHasCpuReference(plan)) return null;
        const n = width * height;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          const x = i % width;
          const y = Math.floor(i / width);
          const px = cpuEvalPlan(plan, [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!], x, y, width, height);
          r += srgbEncode(px[0]);
          g += srgbEncode(px[1]);
          b += srgbEncode(px[2]);
        }
        return { r: r / n, g: g / n, b: b / n };
      },
      graphState() {
        return useAppStore.getState().graph;
      },
      graphDirty() {
        return useAppStore.getState().graphDirty;
      },
      shaderErrors() {
        return useAppStore.getState().shaderErrors;
      },
      imageForVerify() {
        const image = useAppStore.getState().image;
        return image ? { data: image.data, width: image.width, height: image.height } : null;
      },
      updateNodeParam(nodeId, key, value) {
        useAppStore.getState().updateNodeParam(nodeId, key, value);
      },
      applyShaderSource(nodeId, src) {
        return useAppStore.getState().applyShaderSource(nodeId, src);
      },
      addShaderParam(nodeId, def) {
        return useAppStore.getState().addShaderParam(nodeId, def);
      },
      updateShaderParam(nodeId, name, value) {
        useAppStore.getState().updateShaderParam(nodeId, name, value);
      },
      removeShaderParam(nodeId, name) {
        useAppStore.getState().removeShaderParam(nodeId, name);
      },
      exportImageTo(path) {
        void useAppStore.getState().exportImage(path);
      },
      exportState() {
        const s = useAppStore.getState();
        return { status: s.exportStatus, error: s.exportError };
      },
      canvasView() {
        return { ...viewRef.current, dpr: devicePixelRatio };
      },
      wbState() {
        const { wbModel: model } = useAppStore.getState();
        return { asShot: model.asShot, mccamyCct: model.mccamyCct };
      },
      setToneCurvePoints(nodeId, channel, points) {
        useAppStore.getState().setToneCurvePoints(nodeId, channel, points, Date.now());
      },
      histogramState() {
        return useAppStore.getState().histogram;
      },
      historyState() {
        const h = useAppStore.getState().history;
        return { past: h.past.length, future: h.future.length };
      },
      scopeState() {
        const s = useAppStore.getState();
        const samples = s.scopeSamples;
        let meanLuma = 0;
        if (samples) {
          const n = samples.cols * samples.rows;
          let sum = 0;
          for (let i = 0; i < n; i++) {
            const r = samples.data[i * 3]!;
            const g = samples.data[i * 3 + 1]!;
            const b = samples.data[i * 3 + 2]!;
            sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          }
          meanLuma = n > 0 ? sum / n : 0;
        }
        return {
          mode: s.scopeMode,
          samples: samples ? { cols: samples.cols, rows: samples.rows, length: samples.data.length, meanLuma } : null,
        };
      },
      setScopeMode(mode) {
        useAppStore.getState().setScopeMode(mode);
      },
    };
    return () => {
      delete window.__debug;
    };
  }, []);

  const overlayVisible = imageStatus !== 'ready' || gpuError !== null;
  return (
    <div className="canvas-view">
      <div
        ref={containerRef}
        className="canvas-viewport"
        style={{ visibility: overlayVisible ? 'hidden' : 'visible' }}
      >
        <canvas
          ref={canvasRef}
          className="canvas-view-canvas"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        />
      </div>
      {!overlayVisible && <HistogramPanel />}
      {!overlayVisible && showBefore && (
        <div className="before-badge" data-testid="before-badge">
          Before
        </div>
      )}
      {!overlayVisible && (
        <div className="canvas-controls">
          <button
            onClick={toggleBefore}
            data-testid="view-before"
            className={showBefore ? 'active' : undefined}
            title="Show the unedited image (\)"
          >
            A/B
          </button>
          <button
            onClick={toggleGrayscaleView}
            data-testid="view-grayscale"
            className={grayscaleView ? 'active' : undefined}
            title="Grayscale check view (G)"
          >
            BW
          </button>
          <button onClick={fit} data-testid="view-fit">
            Fit
          </button>
          <button onClick={() => oneToOne()} data-testid="view-100">
            100%
          </button>
          <span className="canvas-zoom-readout" data-testid="zoom-readout">
            {Math.round(view.scale * devicePixelRatio * 100)}%
          </span>
        </div>
      )}
      {overlayVisible && (
        <div className="canvas-overlay">
          {gpuError !== null ? (
            <span style={{ color: '#e06c75' }}>Render failed: {gpuError}</span>
          ) : (
            <>
              {imageStatus === 'idle' && <span>Open a RAW or JPEG file to start (⌘O / Open button)</span>}
              {imageStatus === 'loading' && <span>Decoding…</span>}
              {imageStatus === 'error' && <span style={{ color: '#e06c75' }}>Decode failed: {imageError}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
