import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { srgbEncode } from '../engine/color/srgb';
import { PreviewRenderer } from '../engine/gpu/previewRenderer';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number };
      rendererKind(): 'webgpu';
      outputSize(): { width: number; height: number } | null;
      readbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      cpuReferenceMean(): { r: number; g: number; b: number } | null;
    };
  }
}

/**
 * Preview area. Milestone 3: the linear preview is rendered by WebGPU
 * (rgba16float texture + exact sRGB encode in the fragment shader). The
 * verify harness compares the GPU readback against cpuReferenceMean(), which
 * runs the same encode on the CPU via engine/color/srgb.ts.
 */
export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Promise<PreviewRenderer> | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const imageError = useAppStore((s) => s.imageError);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    let cancelled = false;
    void (async () => {
      try {
        rendererRef.current ??= PreviewRenderer.create(canvas);
        const renderer = await rendererRef.current;
        if (cancelled) return;
        canvas.width = image.width;
        canvas.height = image.height;
        renderer.setImage(image);
        renderer.render();
        setGpuError(null);
      } catch (err) {
        if (!cancelled) setGpuError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [image]);

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
        const image = useAppStore.getState().image;
        if (!image) return null;
        const { data, width, height } = image;
        const n = width * height;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          r += srgbEncode(data[i * 4]!);
          g += srgbEncode(data[i * 4 + 1]!);
          b += srgbEncode(data[i * 4 + 2]!);
        }
        return { r: r / n, g: g / n, b: b / n };
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
