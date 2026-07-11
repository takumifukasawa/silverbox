/**
 * Image preparation worker: file bytes → linear Rec.2020 RGBA preview.
 *
 * RAW goes through libraw-wasm (decoded straight to linear Rec.2020 via
 * outputColor; the gamma-encoded 16-bit output is inverted by the exact sRGB
 * LUT — transfer handling is primaries-independent). JPEG is decoded with
 * createImageBitmap to sRGB, linearized (exact inverse sRGB via LUT), then
 * matrixed sRGB→Rec.2020 so it enters the SAME working space (the exit's
 * Rec.2020→sRGB round-trips it back, so a JPEG still displays as itself). Both
 * paths box-downsample in linear space and apply EXIF orientation once —
 * downstream code never re-orients.
 */
import { LibrawDecoder } from './librawDecoder';
import type { CameraColorInfo, CaptureInfo } from './RawDecoder';
import { buildDecodeLut16, buildDecodeLut8 } from '../color/srgb';
import { SRGB_TO_WORK } from '../color/workingSpace';
import { parseSonyLensProfile, type LensProfile } from '../lens/sonyLensProfile';

export interface DecodeRequest {
  id: number;
  kind: 'raw' | 'jpg';
  bytes: ArrayBuffer;
  previewLongEdge: number;
  /** Baseline exposure gain in EV, RAW only (settings.baselineExposureEV) — ignored for 'jpg'. */
  baselineExposureEV: number;
}

export interface PreparedImage {
  /** Linear RGBA float pixels (alpha = 1), orientation already applied. */
  data: Float32Array;
  width: number;
  height: number;
  /** Decoded (full) dimensions before downsampling, after orientation. */
  fullWidth: number;
  fullHeight: number;
  flip: number;
  color?: CameraColorInfo;
  capture?: CaptureInfo;
  /**
   * Sony embedded lens-correction splines (task #34), parsed from the ARW
   * bytes before libraw consumes them. Absent for JPEG and non-Sony RAW. The
   * knots are relative to the DECODED raster corner (see decode note below);
   * the render (GraphRenderer resample pass) uses them when the input node's
   * `lens.profile.enabled` is on.
   */
  profile?: LensProfile;
  decodeMs: number;
}

export type DecodeResponse =
  | { id: number; ok: true; result: PreparedImage }
  | { id: number; ok: false; error: string };

const lut16 = buildDecodeLut16();
const lut8 = buildDecodeLut8();

/**
 * Interleaved RGB u16 (gamma) → linear RGBA f32, with `gain` (2^EV, see
 * `applyBaselineExposure`'s caller) folded into the SAME loop that
 * linearizes — one pass, no extra allocation. `gain` is 1 for JPEG (never
 * called on that path) and the RAW-only baseline-exposure multiplier here.
 */
function linearizeRgb16(src: Uint16Array, pixels: number, gain: number): Float32Array {
  const out = new Float32Array(pixels * 4);
  for (let i = 0, o = 0; i < pixels; i++, o += 4) {
    out[o] = lut16[src[i * 3]!]! * gain;
    out[o + 1] = lut16[src[i * 3 + 1]!]! * gain;
    out[o + 2] = lut16[src[i * 3 + 2]!]! * gain;
    out[o + 3] = 1;
  }
  return out;
}

// sRGB→Rec.2020 primaries (row-major), hoisted so the per-pixel loop indexes
// plain locals instead of the readonly tuple.
const S2W = SRGB_TO_WORK;

/** RGBA u8 (sRGB) → linear Rec.2020 RGBA f32 (working space). */
function linearizeRgba8(src: Uint8ClampedArray, pixels: number): Float32Array {
  const out = new Float32Array(pixels * 4);
  for (let i = 0, o = 0; i < pixels; i++, o += 4) {
    const r = lut8[src[o]!]!;
    const g = lut8[src[o + 1]!]!;
    const b = lut8[src[o + 2]!]!;
    out[o] = S2W[0][0] * r + S2W[0][1] * g + S2W[0][2] * b;
    out[o + 1] = S2W[1][0] * r + S2W[1][1] * g + S2W[1][2] * b;
    out[o + 2] = S2W[2][0] * r + S2W[2][1] * g + S2W[2][2] * b;
    out[o + 3] = 1;
  }
  return out;
}

/** Box-downsample linear RGBA so the long edge becomes `longEdge` (no-op if smaller). */
function downsampleBox(
  src: Float32Array,
  w: number,
  h: number,
  longEdge: number
): { data: Float32Array; width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= longEdge) return { data: src, width: w, height: h };
  const scale = longEdge / long;
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = (y * w + x) * 4;
          r += src[s]!;
          g += src[s + 1]!;
          b += src[s + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * ow + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 1;
    }
  }
  return { data: out, width: ow, height: oh };
}

/**
 * Apply libraw `flip` (EXIF orientation): 0 none, 3 = 180°, 5 = 90° CCW,
 * 6 = 90° CW. Returns possibly swapped dimensions.
 */
function applyFlip(
  src: Float32Array,
  w: number,
  h: number,
  flip: number
): { data: Float32Array; width: number; height: number } {
  if (flip === 0) return { data: src, width: w, height: h };
  const rotates = flip === 5 || flip === 6;
  const ow = rotates ? h : w;
  const oh = rotates ? w : h;
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number;
      let oy: number;
      if (flip === 3) {
        ox = w - 1 - x;
        oy = h - 1 - y;
      } else if (flip === 6) {
        // 90° clockwise
        ox = h - 1 - y;
        oy = x;
      } else if (flip === 5) {
        // 90° counter-clockwise
        ox = y;
        oy = w - 1 - x;
      } else {
        ox = x;
        oy = y;
      }
      const s = (y * w + x) * 4;
      const d = (oy * ow + ox) * 4;
      out[d] = src[s]!;
      out[d + 1] = src[s + 1]!;
      out[d + 2] = src[s + 2]!;
      out[d + 3] = 1;
    }
  }
  return { data: out, width: ow, height: oh };
}

/**
 * RAW-only deterministic "baseline exposure" (LR/Resolve-style): a fixed
 * linear gain of 2^EV applied right where libraw's gamma-encoded output
 * becomes the linear working-space float buffer, so both the GPU render and
 * the CPU reference (which reads this SAME `image.data`) see identical,
 * already-brightened values — no separate node/pass needed. This exists
 * because noAutoBright:true (librawDecoder.ts) pins LibRaw's own
 * colorspace-dependent auto-bright off for determinism, which otherwise
 * leaves RAW opens looking dark next to a same-scene JPEG.
 */
function baselineExposureGain(ev: number): number {
  return Math.pow(2, ev);
}

async function prepareRaw(bytes: ArrayBuffer, previewLongEdge: number, baselineExposureEV: number): Promise<PreparedImage> {
  const t0 = performance.now();
  // Parse the embedded Sony correction splines from the ORIGINAL bytes first —
  // libraw's decode() may detach/consume the buffer. Non-Sony/JPEG ⇒ null.
  const profile = parseSonyLensProfile(bytes) ?? undefined;
  const decoded = await new LibrawDecoder().decode(new Uint8Array(bytes));
  const pixels = decoded.width * decoded.height;
  const linear = linearizeRgb16(decoded.data, pixels, baselineExposureGain(baselineExposureEV));
  const scaled = downsampleBox(linear, decoded.width, decoded.height, previewLongEdge);
  const oriented = applyFlip(scaled.data, scaled.width, scaled.height, decoded.flip);
  const rotated = decoded.flip === 5 || decoded.flip === 6;
  return {
    data: oriented.data,
    width: oriented.width,
    height: oriented.height,
    fullWidth: rotated ? decoded.height : decoded.width,
    fullHeight: rotated ? decoded.width : decoded.height,
    flip: decoded.flip,
    color: decoded.color,
    capture: decoded.capture,
    ...(profile ? { profile } : {}),
    decodeMs: Math.round(performance.now() - t0),
  };
}

async function prepareJpeg(bytes: ArrayBuffer, previewLongEdge: number): Promise<PreparedImage> {
  const t0 = performance.now();
  // imageOrientation:'from-image' applies EXIF orientation during decode.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
    imageOrientation: 'from-image',
  });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const linear = linearizeRgba8(rgba, width * height);
  const scaled = downsampleBox(linear, width, height, previewLongEdge);
  return {
    data: scaled.data,
    width: scaled.width,
    height: scaled.height,
    fullWidth: width,
    fullHeight: height,
    flip: 0, // orientation already applied by createImageBitmap
    decodeMs: Math.round(performance.now() - t0),
  };
}

self.onmessage = async (ev: MessageEvent<DecodeRequest>) => {
  const { id, kind, bytes, previewLongEdge, baselineExposureEV } = ev.data;
  try {
    const result =
      kind === 'raw'
        ? await prepareRaw(bytes, previewLongEdge, baselineExposureEV)
        : await prepareJpeg(bytes, previewLongEdge);
    const response: DecodeResponse = { id, ok: true, result };
    (self as unknown as Worker).postMessage(response, [result.data.buffer]);
  } catch (err) {
    const response: DecodeResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};
