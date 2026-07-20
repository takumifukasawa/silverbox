import LibRaw from 'libraw-wasm';
import type { Metadata as LibRawMetadata } from 'libraw-wasm';
import type { CameraColorInfo, DecodedImage, RawDecoder } from './RawDecoder';

/**
 * libraw `-o` output color space: 8 = linear Rec.2020, the engine's working
 * space (see engine/color/workingSpace.ts). Surfaced by the __debug
 * workingSpaceInfo() hook so the verify harness can assert the decode target.
 */
export const DECODE_OUTPUT_COLOR = 8;

/**
 * Shared libraw `open()` settings for BOTH decode passes below (see
 * `decode()`'s doc comment) — kept identical across passes so metadata read
 * from either one is consistent.
 */
const OPEN_SETTINGS = { useCameraWb: true, outputBps: 16, outputColor: DECODE_OUTPUT_COLOR, noAutoBright: true } as const;

/**
 * Camera-recommended crop for round-11's decode-frame fix (task: "libraw
 * decodes 4624×3080 for an a7C II shot whose camera JPEG/LR export are
 * 4608×3072 with a DIFFERENT origin — a too-large, off-origin source frame
 * that a naive symmetric border-crop can't fix, because the required origin
 * shift isn't symmetric").
 *
 * libraw-wasm ≥1.6 exposes `imgdata.sizes.raw_inset_crops` (Sony's own
 * recommended develop crop, straight from the ARW) via `metadata(true)`.
 * Verified empirically against the camera JPEG (scratchpad NCC alignment,
 * both DSC02993 and DSC03298): applying `raw_inset_crops[0]` via libraw's
 * `cropbox` setting (which operates in the SAME pre-rotation frame as
 * `sizes.iwidth`/`iheight` — "applied before rotation" per LibRawSettings'
 * own doc) lands the decoded frame's center within ~1px of the camera's, vs.
 * ~35px off before. This is the libraw route the task brief asked to
 * exhaust first, and it works — no per-model fallback table needed.
 *
 * One real limitation found during validation: for DSC02993 (landscape,
 * flip=0), libraw's own `iwidth`/`iheight` (its internal "active area" size)
 * is a few pixels SHORT of `cleft+cwidth`/`ctop+cheight` — Sony's crop
 * rectangle claims 28 columns / 22 rows that this libraw-wasm build never
 * demosaics at all (confirmed: `imageData()`, `rawImageData()`, and a
 * cropbox spanning the FULL `raw_width`×`raw_height` all cap out at
 * `iwidth`×`iheight`, so those pixels are not recoverable through any
 * exposed API). DSC03298 (portrait) has no such shortfall and lands on
 * camera-exact dims.
 *
 * round-12 CENTER-PRESERVING clamp: the original fix here trimmed only the
 * unavailable side (kept `cleft`/`ctop` as-is, shrank `cwidth`/`cheight` to
 * fit) — dims-close, but it leaves the decoded frame's CENTER offset from
 * the camera/LR frame's center by ~half the shortfall on each axis (~13,11px
 * for DSC02993), which reads as a real position shift in side-by-side
 * comparisons. `computeCropbox` below instead trims the SAME amount off
 * BOTH sides of an overflowing axis (about the camera crop's own center,
 * `cleft + cwidth/2`), so the decoded frame's center lands exactly on the
 * camera crop's center — at the cost of 2× the shortfall in lost extent
 * instead of 1× (DSC02993: 4608×3072 → 4552×3028, ~1.2%/1.4% smaller, vs.
 * ~0.6%/0.7% for the old one-sided trim). Center alignment beats a few extra
 * columns for both comparisons and real use. The no-shortfall path (DSC03298
 * and other full-frame shots) is untouched — byte-identical to before.
 */
export function computeCropbox(meta: LibRawMetadata): [number, number, number, number] | null {
  const crop = meta.raw_inset_crops?.[0];
  if (!crop) return null;
  const { cleft, ctop, cwidth, cheight } = crop;
  // libraw fills unused raw_inset_crops slots with the 0xFFFF sentinel.
  if (!(cwidth > 0) || !(cheight > 0) || cleft >= 0xffff || ctop >= 0xffff || cleft < 0 || ctop < 0) return null;
  const iw = meta.iwidth ?? 0;
  const ih = meta.iheight ?? 0;
  if (iw <= 0 || ih <= 0 || cleft >= iw || ctop >= ih) return null;
  // Trim the SAME amount off both sides of an axis that overflows the
  // decodable [0, iw)/[0, ih) range, rather than just the far side, so the
  // clamped frame's center exactly matches the camera crop's center. Zero
  // overflow ⇒ zero trim ⇒ [cleft, ctop, cwidth, cheight] unchanged (the
  // no-shortfall path stays byte-identical to before this fix).
  const overflowX = Math.max(0, cleft + cwidth - iw);
  const overflowY = Math.max(0, ctop + cheight - ih);
  const left = cleft + overflowX;
  const top = ctop + overflowY;
  const w = cwidth - 2 * overflowX;
  const h = cheight - 2 * overflowY;
  if (w <= 0 || h <= 0) return null;
  return [left, top, w, h];
}

/**
 * RAW decoder backed by libraw-wasm (runs in its own Web Worker).
 *
 * Settings: camera as-shot WB baked in (useCameraWb) and 16-bit output, so the
 * white-balance node later applies only a *relative* gain — as-shot Kelvin/Tint
 * is a true identity pass. `outputColor` targets linear Rec.2020 (the working
 * space); the gamma-encoded 16-bit output is linearized downstream by the exact
 * sRGB LUT exactly as before (transfer handling is primaries-independent).
 *
 * `noAutoBright: true` pins the overall exposure: LibRaw's default auto-bright
 * gain is computed from a histogram of the *already color-converted* output, so
 * it is colorspace-DEPENDENT (the spike measured this) — leaving it on would
 * make brightness silently depend on the working space. Pinning it keeps the
 * decode deterministic and scene-referred.
 *
 * One LibRaw instance is shared across decodes and never disposed: the wasm
 * worker keeps a single persistent LibRaw object that recycles on open, and
 * dispose() would terminate() the (pthread-pool) worker — whose deferred
 * teardown under a later decode's GC pressure destroys execution contexts
 * mid-flight and crashes long-running page.evaluate calls in the verify
 * harness.
 */
let sharedRaw: LibRaw | null = null;

export class LibrawDecoder implements RawDecoder {
  async decode(bytes: Uint8Array<ArrayBuffer>): Promise<DecodedImage> {
    sharedRaw ??= new LibRaw();
    const raw = sharedRaw;
    {
      // Keep an intact copy BEFORE the first open(): open() transfers its
      // argument to the worker, detaching it, so if this file needs a
      // second, crop-aware open() pass (see computeCropbox above) we need a
      // buffer that pass can still consume.
      const bytesForCropPass = bytes.slice();

      // open() transfers the buffer to the worker; `bytes` is detached after this.
      await raw.open(bytes, OPEN_SETTINGS);

      let meta = await raw.metadata(true);
      if (!meta) throw new Error('libraw: no metadata');

      // Camera-recommended crop, when libraw exposes one (see computeCropbox's
      // doc comment) — re-open with it applied BEFORE the (expensive)
      // imageData() demosaic runs, so we only ever pay for one full decode.
      const cropbox = computeCropbox(meta);
      // The readout-window origin in physical sensor px — retained for the
      // repair-sheet transform (RawDecoder.ts's readoutOrigin doc comment,
      // stage-F semantic 2). When libraw exposed a camera-recommended crop it's
      // that crop's [left, top]; otherwise the decode covers the full active
      // area whose (0,0) corner IS the sensor origin, so (0,0) is the accurate
      // value — every RAW frame therefore carries a readout window (a stable
      // RAW-only gate for repair sheets), while JPEG (which never reaches this
      // decoder) leaves it absent.
      const readoutOrigin = cropbox ? { x: cropbox[0], y: cropbox[1] } : { x: 0, y: 0 };
      if (cropbox) {
        await raw.open(bytesForCropPass, { ...OPEN_SETTINGS, cropbox });
        const croppedMeta = await raw.metadata(true);
        if (!croppedMeta) throw new Error('libraw: no metadata (cropped pass)');
        meta = croppedMeta;
      }

      const img = await raw.imageData();
      if (!img) throw new Error('libraw: no image data');
      if (img.colors !== 3) throw new Error(`libraw: expected 3 color channels, got ${img.colors}`);
      if (!(img.data instanceof Uint16Array)) throw new Error('libraw: expected 16-bit output');

      const cd = meta.color_data;
      let color: CameraColorInfo | undefined;
      if (cd && Array.isArray(cd.cam_mul) && cd.cam_mul.length >= 4 && Array.isArray(cd.cam_xyz)) {
        color = {
          camMul: [cd.cam_mul[0]!, cd.cam_mul[1]!, cd.cam_mul[2]!, cd.cam_mul[3]!],
          camXyz: cd.cam_xyz,
          // rgb_cam: the exact camera(WB'd)->sRGB matrix libraw used for THIS
          // decode (see CameraColorInfo.rgbCam's doc comment) — carried
          // alongside camXyz so the DCP pipeline's exact reconstruction path
          // (dcp/pipeline.ts's exactCameraFromWorkingMatrix) has it available.
          rgbCam: Array.isArray(cd.rgb_cam) ? cd.rgb_cam : undefined,
          black: cd.black,
          maximum: cd.maximum,
          rawBps: cd.raw_bps,
        };
      }

      return {
        width: img.width,
        height: img.height,
        colors: img.colors,
        bits: img.bits,
        data: img.data,
        flip: meta.flip,
        color,
        readoutOrigin,
        capture: {
          cameraMake: meta.camera_make,
          cameraModel: meta.camera_model,
          isoSpeed: meta.iso_speed,
          shutter: meta.shutter,
          aperture: meta.aperture,
          focalLength: meta.focal_len,
          timestamp: meta.timestamp,
        },
      };
    }
  }
}

/** File names we accept as RAW input (extension check). */
export function isRawFileName(name: string): boolean {
  return /\.(arw|cr2|cr3|nef|nrw|raf|orf|rw2|dng|pef|srw|x3f)$/i.test(name);
}
