/**
 * Unit tier (vitest) for the in-engine ML denoise pure math (denoise v2,
 * stage 1): tile-geometry, NCHW packing, and the strength-blend formula —
 * exactly the "pure parts" the brief calls out for unit coverage (the actual
 * ORT inference round trip is scripts/verify-denoise.mjs's job, end to end
 * against the tiny fixture model).
 */
import { describe, it, expect } from 'vitest';
import {
  DENOISE_PAD_MULTIPLE,
  DENOISE_TILE_OVERLAP,
  DENOISE_TILE_SIZE,
  accumulateTile,
  ceilToMultiple,
  computeTileGrid,
  cropTileRgba,
  extractPaddedTileRgba,
  lerp,
  nchwToRgba,
  normalizeAccumulator,
  paddedTileSize,
  reflectIndex,
  rgbaToNchw,
  tileOrigins,
  tileWeightMap,
} from './denoiseTiling';

describe('ceilToMultiple', () => {
  it('rounds up to the next multiple, leaving an already-aligned value alone', () => {
    expect(ceilToMultiple(16, 16)).toBe(16);
    expect(ceilToMultiple(17, 16)).toBe(32);
    expect(ceilToMultiple(0, 16)).toBe(0);
    expect(ceilToMultiple(1707, 16)).toBe(1712);
  });
});

describe('reflectIndex', () => {
  it('is the identity within range', () => {
    for (let i = 0; i < 5; i++) expect(reflectIndex(i, 5)).toBe(i);
  });
  it('mirrors without duplicating the edge pixel (mirror-101)', () => {
    // n=5: valid indices 0..4; index 5 reflects to 3, 6→2, 7→1, 8→0, 9→1, -1→1
    expect(reflectIndex(5, 5)).toBe(3);
    expect(reflectIndex(6, 5)).toBe(2);
    expect(reflectIndex(7, 5)).toBe(1);
    expect(reflectIndex(8, 5)).toBe(0);
    expect(reflectIndex(-1, 5)).toBe(1);
  });
  it('never divides by zero for a size-1 tile', () => {
    expect(reflectIndex(0, 1)).toBe(0);
    expect(reflectIndex(100, 1)).toBe(0);
  });
});

describe('tileOrigins / computeTileGrid — the divisible-by-16 contract', () => {
  it('a single tile spanning the whole axis when size <= tileSize', () => {
    expect(tileOrigins(300, 512, 32)).toEqual([0]);
    expect(tileOrigins(512, 512, 32)).toEqual([0]);
  });

  it('every FULL tile (size > tileSize) is exactly tileSize wide — already %16, no padding needed', () => {
    const origins = tileOrigins(2560, DENOISE_TILE_SIZE, DENOISE_TILE_OVERLAP);
    expect(origins.length).toBeGreaterThan(1);
    for (const x of origins) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(Math.min(DENOISE_TILE_SIZE, 2560 - x)).toBe(DENOISE_TILE_SIZE);
    }
    // last tile flush against the far edge
    expect(origins[origins.length - 1]).toBe(2560 - DENOISE_TILE_SIZE);
  });

  it('computeTileGrid covers the full non-%16 preview size with no gaps and every tile stays in bounds', () => {
    const width = 2560;
    const height = 1707; // NOT a multiple of 16 — the brief's own seam-check scenario
    const tiles = computeTileGrid(width, height, DENOISE_TILE_SIZE, DENOISE_TILE_OVERLAP);
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(width);
      expect(t.y + t.h).toBeLessThanOrEqual(height);
    }
    // every pixel is covered by at least one tile
    const covered = new Uint8Array(width * height);
    for (const t of tiles) {
      for (let y = t.y; y < t.y + t.h; y++) {
        for (let x = t.x; x < t.x + t.w; x++) covered[y * width + x] = 1;
      }
    }
    expect(covered.every((c) => c === 1)).toBe(true);
  });

  it('paddedTileSize is always a multiple of DENOISE_PAD_MULTIPLE and never smaller than the input', () => {
    for (const [w, h] of [
      [512, 512],
      [1707, 2560],
      [5, 5],
      [16, 17],
    ] as const) {
      const { paddedW, paddedH } = paddedTileSize(w, h);
      expect(paddedW % DENOISE_PAD_MULTIPLE).toBe(0);
      expect(paddedH % DENOISE_PAD_MULTIPLE).toBe(0);
      expect(paddedW).toBeGreaterThanOrEqual(w);
      expect(paddedH).toBeGreaterThanOrEqual(h);
    }
  });
});

describe('extractPaddedTileRgba / cropTileRgba round trip', () => {
  it('extracting then cropping a tile with zero padding is the identity', () => {
    const width = 8;
    const height = 8;
    const full = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      full[i * 4] = i / (width * height);
      full[i * 4 + 1] = 0.5;
      full[i * 4 + 2] = 1 - i / (width * height);
      full[i * 4 + 3] = 1;
    }
    const tile = { x: 0, y: 0, w: 8, h: 8 };
    const padded = extractPaddedTileRgba(full, width, tile, 8, 8); // 8 already %16? no — but pad amount 0 either way since paddedW=w here
    expect(padded).toEqual(full);
    const cropped = cropTileRgba(padded, 8, 8, 8);
    expect(cropped).toEqual(full);
  });

  it('reflect-pads a small non-aligned tile without duplicating the border pixel and crops back exactly to the original values', () => {
    const width = 5;
    const height = 5;
    const full = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      full[i * 4] = i;
      full[i * 4 + 1] = i * 2;
      full[i * 4 + 2] = i * 3;
      full[i * 4 + 3] = 1;
    }
    const tile = { x: 0, y: 0, w: 5, h: 5 };
    const { paddedW, paddedH } = paddedTileSize(5, 5); // 16,16
    const padded = extractPaddedTileRgba(full, width, tile, paddedW, paddedH);
    expect(padded.length).toBe(paddedW * paddedH * 4);
    const cropped = cropTileRgba(padded, paddedW, 5, 5);
    expect(cropped).toEqual(full);
  });
});

describe('rgbaToNchw / nchwToRgba round trip', () => {
  it('packs and unpacks a small buffer exactly (alpha dropped then reconstructed as 1)', () => {
    const width = 4;
    const height = 3;
    const rgba = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = Math.sin(i);
      rgba[i * 4 + 1] = Math.cos(i);
      rgba[i * 4 + 2] = i / 10;
      rgba[i * 4 + 3] = 0.42; // deliberately not 1 — proves alpha is dropped, not carried through
    }
    const nchw = rgbaToNchw(rgba, width, height);
    expect(nchw.length).toBe(3 * width * height);
    const back = nchwToRgba(nchw, width, height);
    for (let i = 0; i < width * height; i++) {
      expect(back[i * 4]).toBeCloseTo(rgba[i * 4]!, 10);
      expect(back[i * 4 + 1]).toBeCloseTo(rgba[i * 4 + 1]!, 10);
      expect(back[i * 4 + 2]).toBeCloseTo(rgba[i * 4 + 2]!, 10);
      expect(back[i * 4 + 3]).toBe(1); // reconstructed, never the original 0.42
    }
  });

  it('planar layout is channel-major (R plane, then G plane, then B plane)', () => {
    const width = 2;
    const height = 2;
    const rgba = new Float32Array([1, 2, 3, 1, 4, 5, 6, 1, 7, 8, 9, 1, 10, 11, 12, 1]);
    const nchw = rgbaToNchw(rgba, width, height);
    expect(Array.from(nchw)).toEqual([1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 12]);
  });
});

describe('tileWeightMap / accumulateTile / normalizeAccumulator — seamless reassembly', () => {
  it('a single full-image tile normalizes back to exactly its own input (weight is uniformly 1, no neighbor to feather against)', () => {
    const width = 6;
    const height = 4;
    const tile = { x: 0, y: 0, w: width, h: height };
    const weights = tileWeightMap(tile, width, height, DENOISE_TILE_OVERLAP);
    expect(Array.from(weights)).toEqual(new Array(width * height).fill(1));

    const tileRgba = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      tileRgba[i * 4] = i;
      tileRgba[i * 4 + 1] = i + 1;
      tileRgba[i * 4 + 2] = i + 2;
      tileRgba[i * 4 + 3] = 1;
    }
    const colorAcc = new Float32Array(width * height * 3);
    const weightAcc = new Float32Array(width * height);
    accumulateTile(colorAcc, weightAcc, width, tile, tileRgba, weights);
    const result = normalizeAccumulator(colorAcc, weightAcc, width, height);
    for (let i = 0; i < width * height; i++) {
      expect(result[i * 4]).toBeCloseTo(tileRgba[i * 4]!, 6);
      expect(result[i * 4 + 1]).toBeCloseTo(tileRgba[i * 4 + 1]!, 6);
      expect(result[i * 4 + 2]).toBeCloseTo(tileRgba[i * 4 + 2]!, 6);
    }
  });

  it('two overlapping tiles with IDENTICAL content reassemble to that same content everywhere, including the overlap (no seam)', () => {
    const width = 20;
    const height = 10;
    const overlap = 4;
    const tileSize = 12;
    const tiles = computeTileGrid(width, height, tileSize, overlap);
    expect(tiles.length).toBeGreaterThan(1); // this grid genuinely has overlap to test

    // Every tile "infers" the identical transform: value = (globalX + globalY*width) — a stand-in for a
    // model with no receptive-field bleed, same spirit as the verify fixture's per-pixel Conv.
    const colorAcc = new Float32Array(width * height * 3);
    const weightAcc = new Float32Array(width * height);
    for (const tile of tiles) {
      const weights = tileWeightMap(tile, width, height, overlap);
      const tileRgba = new Float32Array(tile.w * tile.h * 4);
      for (let y = 0; y < tile.h; y++) {
        for (let x = 0; x < tile.w; x++) {
          const gx = tile.x + x;
          const gy = tile.y + y;
          const v = gx + gy * width;
          const i = (y * tile.w + x) * 4;
          tileRgba[i] = v;
          tileRgba[i + 1] = v;
          tileRgba[i + 2] = v;
          tileRgba[i + 3] = 1;
        }
      }
      accumulateTile(colorAcc, weightAcc, width, tile, tileRgba, weights);
    }
    const result = normalizeAccumulator(colorAcc, weightAcc, width, height);
    for (let gy = 0; gy < height; gy++) {
      for (let gx = 0; gx < width; gx++) {
        const expected = gx + gy * width;
        const i = (gy * width + gx) * 4;
        expect(result[i]).toBeCloseTo(expected, 4);
      }
    }
  });
});

describe('lerp — the strength blend formula (mirrors the GPU re-entry shader)', () => {
  it('t=0 is exactly the input, t=1 is exactly the denoised value', () => {
    expect(lerp(0.2, 0.8, 0)).toBeCloseTo(0.2, 10);
    expect(lerp(0.2, 0.8, 1)).toBeCloseTo(0.8, 10);
  });
  it('is linear in between', () => {
    expect(lerp(0, 1, 0.5)).toBeCloseTo(0.5, 10);
    expect(lerp(1, 0, 0.25)).toBeCloseTo(0.75, 10);
  });
});
