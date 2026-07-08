import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { srgbEncode } from '../engine/color/srgb';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number };
      outputSize(): { width: number; height: number } | null;
      readbackMean(): { r: number; g: number; b: number } | null;
    };
  }
}

/**
 * Preview area. Milestone 2: draws the linear preview to a 2D canvas by
 * encoding to sRGB on the CPU. The WebGPU graph pipeline replaces this in
 * milestone 3; the layout, overlay states and __debug hooks stay.
 */
export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const imageError = useAppStore((s) => s.imageError);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const { data, width, height } = image;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const s = i * 4;
      rgba[s] = Math.round(srgbEncode(data[s]!) * 255);
      rgba[s + 1] = Math.round(srgbEncode(data[s + 1]!) * 255);
      rgba[s + 2] = Math.round(srgbEncode(data[s + 2]!) * 255);
      rgba[s + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
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
      outputSize() {
        const canvas = canvasRef.current;
        if (!canvas || canvas.width === 0) return null;
        return { width: canvas.width, height: canvas.height };
      },
      readbackMean() {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx || canvas.width === 0) return null;
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0;
        let g = 0;
        let b = 0;
        const n = canvas.width * canvas.height;
        for (let i = 0; i < n; i++) {
          r += px[i * 4]!;
          g += px[i * 4 + 1]!;
          b += px[i * 4 + 2]!;
        }
        return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
      },
    };
    return () => {
      delete window.__debug;
    };
  }, []);

  return (
    <div className="canvas-view">
      <canvas
        ref={canvasRef}
        className="canvas-view-canvas"
        style={{ visibility: imageStatus === 'ready' ? 'visible' : 'hidden' }}
      />
      {imageStatus !== 'ready' && (
        <div className="canvas-overlay">
          {imageStatus === 'idle' && <span>Open a RAW or JPEG file to start (⌘O / Open button)</span>}
          {imageStatus === 'loading' && <span>Decoding…</span>}
          {imageStatus === 'error' && <span style={{ color: '#e06c75' }}>Decode failed: {imageError}</span>}
        </div>
      )}
    </div>
  );
}
