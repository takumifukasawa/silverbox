import { describe, expect, it } from 'vitest';
import { localToImagePixel, loupePlacement } from './loupeGeometry';

describe('pixel loupe — localToImagePixel', () => {
  it('identity view maps a point to the pixel it lies in', () => {
    expect(localToImagePixel(10.9, 3.2, { tx: 0, ty: 0, scale: 1 })).toEqual({ x: 10, y: 3 });
  });
  it('undoes pan and zoom', () => {
    // 4× zoom panned by (100, 50): local (140, 70) is pixel (10, 5)
    expect(localToImagePixel(140, 70, { tx: 100, ty: 50, scale: 4 })).toEqual({ x: 10, y: 5 });
    // just left of the image is pixel -1, not 0
    expect(localToImagePixel(99, 70, { tx: 100, ty: 50, scale: 4 }).x).toBe(-1);
  });
});

describe('pixel loupe — loupePlacement', () => {
  const size = { w: 100, h: 80 };
  const bounds = { w: 800, h: 600 };
  it('sits below-right of the cursor by default', () => {
    expect(loupePlacement({ x: 200, y: 200 }, size, bounds, 20)).toEqual({ left: 220, top: 220 });
  });
  it('flips left near the right edge and above near the bottom edge', () => {
    expect(loupePlacement({ x: 750, y: 550 }, size, bounds, 20)).toEqual({ left: 630, top: 450 });
  });
  it('clamps inside bounds when neither side fits', () => {
    const p = loupePlacement({ x: 60, y: 50 }, size, { w: 150, h: 120 }, 20);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left + size.w).toBeLessThanOrEqual(150);
    expect(p.top + size.h).toBeLessThanOrEqual(120);
  });
});
