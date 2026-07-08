import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { srgbEncode } from '../engine/color/srgb';
import { GraphRenderer } from '../engine/gpu/graphRenderer';
import { opChain, type GraphDoc } from '../engine/graph/graphDoc';
import { OPS } from '../engine/graph/ops';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number };
      rendererKind(): 'webgpu';
      outputSize(): { width: number; height: number } | null;
      readbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      cpuReferenceMean(): { r: number; g: number; b: number } | null;
      graphState(): GraphDoc;
      graphDirty(): boolean;
      updateNodeParam(nodeId: string, key: string, value: number): void;
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
  const rendererRef = useRef<Promise<GraphRenderer> | null>(null);
  const lastImageRef = useRef<unknown>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const imageError = useAppStore((s) => s.imageError);
  const graph = useAppStore((s) => s.graph);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    let cancelled = false;
    void (async () => {
      try {
        rendererRef.current ??= GraphRenderer.create(canvas);
        const renderer = await rendererRef.current;
        if (cancelled) return;
        if (lastImageRef.current !== image) {
          canvas.width = image.width;
          canvas.height = image.height;
          renderer.setImage(image);
          lastImageRef.current = image;
        }
        renderer.setGraph(opChain(graph));
        renderer.render();
        setGpuError(null);
      } catch (err) {
        if (!cancelled) setGpuError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [image, graph]);

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
      cpuReferenceMean() {
        const s = useAppStore.getState();
        if (!s.image) return null;
        const { data, width, height } = s.image;
        const chain = opChain(s.graph);
        const n = width * height;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          let px: [number, number, number] = [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];
          for (const op of chain) px = OPS[op.kind].apply(px, op.uniform);
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
      updateNodeParam(nodeId, key, value) {
        useAppStore.getState().updateNodeParam(nodeId, key, value);
      },
    };
    return () => {
      delete window.__debug;
    };
  }, []);

  const overlayVisible = imageStatus !== 'ready' || gpuError !== null;
  return (
    <div className="canvas-view">
      <canvas
        ref={canvasRef}
        className="canvas-view-canvas"
        style={{ visibility: overlayVisible ? 'hidden' : 'visible' }}
      />
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
