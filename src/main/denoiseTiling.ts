/**
 * In-engine ML denoise (denoise v2, stage 1 — docs/brief-bank/denoise-v2.md):
 * PURE tile-geometry, NCHW packing, and blend math. Zero imports (no
 * electron, no onnxruntime-node, no node:fs) — this is the "pure parts" file
 * the brief asks unit tests for (src/main/denoiseTiling.test.ts), so it must
 * stay importable from plain vitest with no Electron runtime.
 *
 * ============================================================================
 * THE DIVISIBLE-BY-16 CONTRACT (load-bearing — read before touching anything
 * here)
 * ============================================================================
 * The pinned NAFNet-SIDD-width32 ONNX model was exported WITHOUT its
 * self-pad/crop wrapper (see docs/research/nafnet-spike/spike-report.md's
 * "Pad/crop trap") — under tracing, a dynamic self-pad bakes into constants
 * and breaks dynamic H/W, so the export deliberately omits it. The
 * consequence: **every single inference call's H and W must already be
 * exact multiples of 16** (`padder_size = 2^len(enc_blk_nums) = 16`) or the
 * model throws (a confirmed 250×250 input fails with a broadcast error in a
 * skip-connection Add — see the spike report). The APP, not the model, owns
 * satisfying this: every tile this module hands to inference is reflect-
 * padded up to the next multiple of 16 first, and the result is cropped back
 * down before it re-enters the full-image accumulator. This is why
 * `computeTileGrid` and `paddedTileSize` exist as separate, testable steps —
 * getting either wrong either throws deep inside onnxruntime (grid) or
 * silently ships the model reflected garbage border pixels (padding).
 *
 * ============================================================================
 * TILE GRID (512px tiles, 32px overlap, linear feather blend — conductor's
 * stage-1 sizing, see the denoise-v2 dispatch)
 * ============================================================================
 * `tileOrigins` places tiles along one axis: interior tiles march by
 * `stride = tileSize - overlap`; the LAST tile is pulled flush against the
 * far edge instead of also using the stride (`size - tileSize`) so the
 * final tile never runs past the image — this is also what makes every tile
 * with `size > tileSize` come out EXACTLY `tileSize` (512, itself a multiple
 * of 16) wide/tall with no padding ever needed for those. Padding only
 * actually fires for the single-tile "image smaller than one tile" case
 * (`size <= tileSize`), where the one tile's size is the image's own
 * (possibly non-%16) dimension. Either way `extractPaddedTileRgba` pads
 * EVERY tile uniformly (a zero-amount pad is a cheap no-op), so there is
 * exactly one code path, not a "usually 512, sometimes special-cased" one.
 *
 * ============================================================================
 * FLOAT32-NO-QUANTIZATION INVARIANT
 * ============================================================================
 * Every function in this file operates on plain `Float32Array` RGBA/NCHW
 * buffers end to end — no `Uint8Array`/`Uint16Array` step anywhere, unlike
 * v1's external-tool node (which is stuck at 8-bit TIFF — see
 * src/main/externalTool.ts's doc comment for why). This is v2's entire
 * reason to exist: encode → tile/pad → infer → crop/unpad → decode, all
 * float32, never quantized. Keep it that way — if a future change here ever
 * needs an integer buffer for anything, that is a bug, not a shortcut.
 */

/** Inference tile size, px (conductor's stage-1 sizing) — a multiple of 16 (see this file's divisible-by-16 contract), so every FULL tile needs zero padding. Lightroom-calibration-adjacent (bigger tiles = fewer seams to feather but more memory); not derived from any formula. */
export const DENOISE_TILE_SIZE = 512;
/** Overlap between adjacent tiles, px (conductor's stage-1 sizing) — feathered linearly across this many pixels at every INTERNAL tile boundary (never at the image's own outer edge). */
export const DENOISE_TILE_OVERLAP = 32;
/** `stride = DENOISE_TILE_SIZE - DENOISE_TILE_OVERLAP` = 480, itself a multiple of 16 — interior tile origins march by this. */
export const DENOISE_TILE_STRIDE = DENOISE_TILE_SIZE - DENOISE_TILE_OVERLAP;
/** The model's own `padder_size` (see this file's divisible-by-16 contract) — every tile fed to inference is padded up to a multiple of this. */
export const DENOISE_PAD_MULTIPLE = 16;

/** Round `n` up to the next multiple of `multiple` (n itself if already aligned). */
export function ceilToMultiple(n: number, multiple: number): number {
  return Math.ceil(n / multiple) * multiple;
}

/**
 * Mirror-101 reflection (no edge-pixel duplication, matches `torch.nn.
 * functional.pad(mode='reflect')`'s convention): maps any integer index
 * (including far outside `[0, n)`, needed because a %16 pad can in principle
 * exceed a tiny tile's own size) back into `[0, n)` by bouncing off both
 * ends. `n === 1` short-circuits to avoid a divide-by-zero period.
 */
export function reflectIndex(i: number, n: number): number {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  let m = i % period;
  if (m < 0) m += period;
  return m < n ? m : period - m;
}

/** One tile's placement in the FULL image, pre-padding — `w`/`h` are the tile's real (possibly non-%16) size; padding is computed separately (see `paddedTileSize`) and applied only when extracting pixels for inference. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tile origins along ONE axis. `size <= tileSize` ⇒ a single tile spanning
 * the whole axis (`[0]`, width `size`) — the only case that can produce a
 * non-%16 tile, handled by padding at extraction time. Otherwise: interior
 * tiles at `0, stride, 2*stride, …` for as long as a FULL tile still fits,
 * then one final tile flush against the far edge (`size - tileSize`) —
 * every tile in this branch is exactly `tileSize` wide (see this file's
 * doc comment), so overlap only ever grows (never shrinks below
 * `DENOISE_TILE_OVERLAP`) as the flush-adjustment absorbs the remainder.
 */
export function tileOrigins(size: number, tileSize: number, overlap: number): number[] {
  if (size <= tileSize) return [0];
  const stride = Math.max(1, tileSize - overlap);
  const origins: number[] = [];
  let x = 0;
  while (x + tileSize < size) {
    origins.push(x);
    x += stride;
  }
  const last = size - tileSize;
  if (origins.length === 0 || origins[origins.length - 1] !== last) origins.push(last);
  return origins;
}

/** Full 2D tile grid over `width`×`height` — see `tileOrigins` for the per-axis placement rule. Row-major order (top-to-bottom, left-to-right within a row); order is not load-bearing (every tile is blended independently) but kept deterministic for reproducible per-tile progress reporting. */
export function computeTileGrid(width: number, height: number, tileSize: number, overlap: number): TileRect[] {
  const xs = tileOrigins(width, tileSize, overlap);
  const ys = tileOrigins(height, tileSize, overlap);
  const tiles: TileRect[] = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x, y, w: Math.min(tileSize, width - x), h: Math.min(tileSize, height - y) });
    }
  }
  return tiles;
}

/** The padded (multiple-of-`DENOISE_PAD_MULTIPLE`) size inference actually sees for a tile whose real size is `w`×`h` — see this file's divisible-by-16 contract. */
export function paddedTileSize(w: number, h: number): { paddedW: number; paddedH: number } {
  return { paddedW: ceilToMultiple(w, DENOISE_PAD_MULTIPLE), paddedH: ceilToMultiple(h, DENOISE_PAD_MULTIPLE) };
}

/**
 * Extract one tile from the full sRGB-encoded RGBA float32 image, reflect-
 * padded up to `paddedW`×`paddedH` (a no-op pad when the tile is already
 * aligned — see this file's doc comment). Alpha is always written as 1 —
 * the model is 3-channel; callers drop alpha before packing to NCHW anyway,
 * this just keeps the intermediate buffer's RGBA shape uniform with every
 * other buffer in this pipeline.
 */
export function extractPaddedTileRgba(
  full: Float32Array,
  fullWidth: number,
  tile: TileRect,
  paddedW: number,
  paddedH: number
): Float32Array {
  const out = new Float32Array(paddedW * paddedH * 4);
  for (let py = 0; py < paddedH; py++) {
    const sy = tile.y + reflectIndex(py, tile.h);
    const srcRowBase = sy * fullWidth;
    const dstRowBase = py * paddedW;
    for (let px = 0; px < paddedW; px++) {
      const sx = tile.x + reflectIndex(px, tile.w);
      const srcIdx = (srcRowBase + sx) * 4;
      const dstIdx = (dstRowBase + px) * 4;
      out[dstIdx] = full[srcIdx]!;
      out[dstIdx + 1] = full[srcIdx + 1]!;
      out[dstIdx + 2] = full[srcIdx + 2]!;
      out[dstIdx + 3] = 1;
    }
  }
  return out;
}

/** Crop a padded RGBA tile (inference's own output, same padded dims it was given — see this file's divisible-by-16 contract) back down to the tile's real `w`×`h`, dropping the reflect-padded border pixels. */
export function cropTileRgba(padded: Float32Array, paddedW: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRowBase = y * paddedW;
    const dstRowBase = y * w;
    for (let x = 0; x < w; x++) {
      const srcIdx = (srcRowBase + x) * 4;
      const dstIdx = (dstRowBase + x) * 4;
      out[dstIdx] = padded[srcIdx]!;
      out[dstIdx + 1] = padded[srcIdx + 1]!;
      out[dstIdx + 2] = padded[srcIdx + 2]!;
      out[dstIdx + 3] = 1;
    }
  }
  return out;
}

/**
 * RGBA interleaved float32 → NCHW planar float32 (alpha dropped) — the
 * shape `onnxruntime-node`'s `Tensor('float32', data, [1,3,H,W])` expects.
 */
export function rgbaToNchw(rgba: Float32Array, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const s = i * 4;
    out[i] = rgba[s]!;
    out[plane + i] = rgba[s + 1]!;
    out[2 * plane + i] = rgba[s + 2]!;
  }
  return out;
}

/** Inverse of `rgbaToNchw`: NCHW planar float32 → RGBA interleaved float32, alpha always 1. */
export function nchwToRgba(nchw: Float32Array, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(4 * plane);
  for (let i = 0; i < plane; i++) {
    const d = i * 4;
    out[d] = nchw[i]!;
    out[d + 1] = nchw[plane + i]!;
    out[d + 2] = nchw[2 * plane + i]!;
    out[d + 3] = 1;
  }
  return out;
}

/**
 * One axis' feather weight at pixel `pos` (0-indexed, `pos < size`): 1 in the
 * tile's interior, linearly ramping down to (but never reaching) 0 across
 * the last `overlap` pixels at an edge that genuinely overlaps a NEIGHBOR
 * tile — `touchesStart`/`touchesEnd` say whether this tile's start/end on
 * this axis is instead the image's own outer border (no fade there; the
 * image edge has no neighbor to blend against). Combining both axes'
 * weights via multiplication (see `tileWeightMap`) produces the standard
 * "tent" feather chaiNNer-style tilers use to avoid hard seams.
 */
function axisFeather(pos: number, size: number, overlap: number, touchesStart: boolean, touchesEnd: boolean): number {
  if (overlap <= 0) return 1;
  let w = 1;
  if (!touchesStart) w = Math.min(w, (pos + 1) / overlap);
  if (!touchesEnd) w = Math.min(w, (size - pos) / overlap);
  return Math.max(w, 1e-6); // never exactly 0 — every covered pixel keeps a nonzero contribution, avoiding a 0/0 in normalizeAccumulator
}

/** Precompute one tile's full `w`×`h` feather-weight map against the FULL image's dims (so this tile's own border-touching edges are known) and `overlap`. */
export function tileWeightMap(tile: TileRect, fullWidth: number, fullHeight: number, overlap: number): Float32Array {
  const out = new Float32Array(tile.w * tile.h);
  const touchesLeft = tile.x === 0;
  const touchesRight = tile.x + tile.w === fullWidth;
  const touchesTop = tile.y === 0;
  const touchesBottom = tile.y + tile.h === fullHeight;
  for (let y = 0; y < tile.h; y++) {
    const wy = axisFeather(y, tile.h, overlap, touchesTop, touchesBottom);
    const rowBase = y * tile.w;
    for (let x = 0; x < tile.w; x++) {
      out[rowBase + x] = wy * axisFeather(x, tile.w, overlap, touchesLeft, touchesRight);
    }
  }
  return out;
}

/**
 * Weighted-accumulate one (already cropped-to-real-size) tile result into
 * the FULL image's running `colorAcc`/`weightAcc` buffers (both sized
 * `fullWidth*fullHeight*{3,1}`, caller-owned, zero-initialized before the
 * first tile). Alpha is not accumulated — the model is 3-channel and the
 * whole-image alpha is always reconstructed as 1 by `normalizeAccumulator`.
 */
export function accumulateTile(
  colorAcc: Float32Array,
  weightAcc: Float32Array,
  fullWidth: number,
  tile: TileRect,
  tileRgba: Float32Array,
  weights: Float32Array
): void {
  for (let y = 0; y < tile.h; y++) {
    const destRowBase = (tile.y + y) * fullWidth + tile.x;
    const srcRowBase = y * tile.w;
    for (let x = 0; x < tile.w; x++) {
      const w = weights[srcRowBase + x]!;
      const destIdx = destRowBase + x;
      const srcIdx = (srcRowBase + x) * 4;
      const c0 = destIdx * 3;
      colorAcc[c0] = colorAcc[c0]! + tileRgba[srcIdx]! * w;
      colorAcc[c0 + 1] = colorAcc[c0 + 1]! + tileRgba[srcIdx + 1]! * w;
      colorAcc[c0 + 2] = colorAcc[c0 + 2]! + tileRgba[srcIdx + 2]! * w;
      weightAcc[destIdx] = weightAcc[destIdx]! + w;
    }
  }
}

/** Normalize the weighted-sum accumulator (divide by total weight per pixel) into a plain RGBA float32 image, alpha 1. Every pixel is covered by at least one tile with a nonzero weight (see `axisFeather`'s floor), so `weightAcc[i]` is never 0 for a fully-covered grid. */
export function normalizeAccumulator(colorAcc: Float32Array, weightAcc: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 4);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const w = weightAcc[i]! || 1;
    out[i * 4] = colorAcc[i * 3]! / w;
    out[i * 4 + 1] = colorAcc[i * 3 + 1]! / w;
    out[i * 4 + 2] = colorAcc[i * 3 + 2]! / w;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/**
 * strength blend: `output = lerp(input, denoised, t)` where `t = strength /
 * 100` (docs/brief-bank/denoise-v2.md's "strength as an output blend" —
 * the standard trick for a blind denoiser with no strength knob of its
 * own). This is the pure reference the GPU re-entry blend pass
 * (graphRenderer.ts's DENOISE_BLEND_SHADER) mirrors — production blending
 * happens GPU-side (cheap enough to redo per render, see DenoiseRunResult's
 * doc comment), this function exists so that formula has exactly one
 * unit-tested definition, same convention as OPS.*.apply's CPU mirrors.
 */
export function lerp(inputVal: number, denoisedVal: number, t: number): number {
  return inputVal + (denoisedVal - inputVal) * t;
}
