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
import { parseSonyLensModel, parseSonyLensProfile, type LensProfile } from '../lens/sonyLensProfile';

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
  /**
   * EXIF LensModel (task #51 §2), parsed from the ARW bytes — e.g. "FE 24mm
   * F2.8 G". Absent for JPEG and non-Sony RAW (libraw's CaptureInfo carries the
   * camera model but not the lens). Surfaced in the toolbar capture line + the
   * Lens inspector's embedded-profile row.
   */
  lensModel?: string;
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

// NOTE (round-7 orientation bug, DSC06787.ARW): there used to be an
// applyFlip() here re-applying `decoded.flip` to the decoded pixels — but
// LibRaw's mem-image output has ALREADY applied the EXIF orientation
// (dcraw_make_mem_image honors sizes.flip), so a portrait ARW arrives as an
// already-portrait buffer (measured: 4688×7028 for a flip=5 shot whose
// sensor raster is 7028×4688). Rotating it AGAIN put every portrait photo
// back on its side; landscape shots (flip=0) double-rotated harmlessly,
// which is why the whole test corpus never caught it. The decoded buffer is
// used exactly as LibRaw hands it over; `flip` is kept on PreparedImage as
// metadata only.

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
  const lensModel = parseSonyLensModel(bytes) ?? undefined;
  const decoded = await new LibrawDecoder().decode(new Uint8Array(bytes));
  const pixels = decoded.width * decoded.height;
  const linear = linearizeRgb16(decoded.data, pixels, baselineExposureGain(baselineExposureEV));
  const scaled = downsampleBox(linear, decoded.width, decoded.height, previewLongEdge);
  return {
    data: scaled.data,
    width: scaled.width,
    height: scaled.height,
    fullWidth: decoded.width,
    fullHeight: decoded.height,
    flip: decoded.flip,
    color: decoded.color,
    capture: decoded.capture,
    ...(profile ? { profile } : {}),
    ...(lensModel ? { lensModel } : {}),
    decodeMs: Math.round(performance.now() - t0),
  };
}

/** PNG's fixed 8-byte magic (spec-defined, never varies) — see sniffMimeType. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Round-9 fix pack item 4 ("maskはpngも許容でいい気がする" — the Image node
 * should accept PNG, not just JPEG): this 'jpg'-kind path is really "any
 * browser-decodable raster", already true of createImageBitmap itself — the
 * one thing that was actually JPEG-specific was hardcoding the Blob's MIME
 * type, which matters for engines that trust the declared type over
 * sniffing the bytes. Detect PNG by its fixed magic (no decoding library
 * needed, exactly per the brief) and label the Blob correctly; anything else
 * keeps the original 'image/jpeg' label unchanged.
 */
function sniffMimeType(bytes: ArrayBuffer): string {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  if (head.length === 8 && PNG_SIGNATURE.every((b, i) => head[i] === b)) return 'image/png';
  return 'image/jpeg';
}

async function prepareJpeg(bytes: ArrayBuffer, previewLongEdge: number): Promise<PreparedImage> {
  const t0 = performance.now();
  // imageOrientation:'from-image' applies EXIF orientation during decode.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: sniffMimeType(bytes) }), {
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
