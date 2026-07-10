/**
 * Export encoder (REBUILD-SPEC §15) — main-process side.
 *
 * The renderer runs the graph at full resolution and reads back display-
 * encoded RGBA8 pixels (sRGB or Display P3 primaries, per `req.colorSpace`);
 * this module packages them with sharp: optional long-edge resize, JPEG
 * (quality) or PNG encode, a matching ICC profile, and an EXIF block copied
 * from the decode metadata (filtered by `req.metadata`). sharp is a native
 * addon, hence main-process only.
 *
 * Color note: the pixels are already display-encoded in the target color
 * space — no gamma or colourspace operation happens here, so the file matches
 * the preview/export GPU pass exactly; `withIccProfile` only ATTACHES the
 * matching profile (sharp does not re-transform untagged raw pixel input).
 * Orientation is baked into the pixels (applied once at decode), so no
 * Orientation tag is written.
 */
import sharp, { type Sharp } from 'sharp';
import type {
  ExportColorSpace,
  ExportEncodeRequest,
  ExportEncodeResult,
  ExportExifMeta,
  ExportMetadataPolicy,
} from '../../shared/ipc';

/** Format a positive number as an EXIF rational string libvips accepts. */
function rational(v: number, scale = 100): string {
  return `${Math.round(v * scale)}/${scale}`;
}

function exposureTime(seconds: number): string {
  if (seconds >= 1) return rational(seconds, 10);
  return `1/${Math.round(1 / seconds)}`;
}

function exifDateTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build the sharp withExif payload (IFD0 = main image, IFD2 = Exif sub-IFD),
 * filtered by policy:
 *  - 'all': today's behavior — Software, Make, Model, DateTime(Original),
 *    ISO, ExposureTime, FNumber, FocalLength. Nothing here is GPS: the decode
 *    pipeline (RawDecoder's CaptureInfo) never parses GPS EXIF from the
 *    source in the first place, so there is nothing to add even under 'all'.
 *  - 'minimal': camera model + exposure basics ONLY — Model, ISO,
 *    ExposureTime, FNumber. No Make, no DateTime, no FocalLength, no
 *    Software tag, no GPS, no serial numbers (we never carried the latter
 *    two regardless of policy).
 *  - 'none': never calls this function — no EXIF block is attached at all.
 */
function buildExif(meta: ExportExifMeta, policy: ExportMetadataPolicy): Record<string, Record<string, string>> {
  const ifd0: Record<string, string> = {};
  const ifd2: Record<string, string> = {};
  if (policy === 'all') {
    ifd0.Software = 'silverbox';
    if (meta.cameraMake) ifd0.Make = meta.cameraMake;
    if (meta.cameraModel) ifd0.Model = meta.cameraModel;
    if (meta.timestampIso) {
      const dt = exifDateTime(meta.timestampIso);
      if (dt) {
        ifd0.DateTime = dt;
        ifd2.DateTimeOriginal = dt;
      }
    }
    if (meta.focalLength && Number.isFinite(meta.focalLength) && meta.focalLength > 0) {
      ifd2.FocalLength = rational(meta.focalLength, 10);
    }
  } else if (meta.cameraModel) {
    ifd0.Model = meta.cameraModel;
  }
  if (meta.isoSpeed && Number.isFinite(meta.isoSpeed)) ifd2.ISOSpeedRatings = String(Math.round(meta.isoSpeed));
  if (meta.shutter && Number.isFinite(meta.shutter) && meta.shutter > 0) {
    ifd2.ExposureTime = exposureTime(meta.shutter);
  }
  if (meta.aperture && Number.isFinite(meta.aperture) && meta.aperture > 0) {
    ifd2.FNumber = rational(meta.aperture, 10);
  }
  return { IFD0: ifd0, IFD2: ifd2 };
}

/** sharp's built-in ICC profile name for a given export color space. */
function iccProfileName(colorSpace: ExportColorSpace): string {
  return colorSpace === 'p3' ? 'p3' : 'srgb';
}

function buildPipeline(req: ExportEncodeRequest, attachExif: boolean): Sharp {
  const { width, height, quality, maxDim } = req;
  const policy: ExportMetadataPolicy = req.metadata ?? 'all';
  const colorSpace: ExportColorSpace = req.colorSpace ?? 'srgb';
  let img = sharp(Buffer.from(req.data), { raw: { width, height, channels: 4 }, limitInputPixels: false }).removeAlpha();
  if (maxDim && maxDim > 0 && maxDim < Math.max(width, height)) {
    img = img.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
  }
  if (/\.png$/i.test(req.outPath)) {
    img = img.png();
  } else {
    img = img.jpeg({ quality: Math.min(100, Math.max(1, Math.round(quality))) });
  }
  // The color-space ICC profile is always attached regardless of metadata
  // policy — it's correctness (which primaries the pixel bytes mean), not
  // descriptive metadata, so 'none' does not affect it.
  img = img.withIccProfile(iccProfileName(colorSpace));
  if (attachExif && policy !== 'none' && req.meta) img = img.withExif(buildExif(req.meta, policy));
  return img;
}

export async function encodeExport(req: ExportEncodeRequest): Promise<ExportEncodeResult> {
  const expected = req.width * req.height * 4;
  if (req.data.byteLength !== expected) {
    throw new Error(`exportEncode: pixel buffer is ${req.data.byteLength} bytes, expected ${expected}`);
  }
  if (!/\.(jpg|jpeg|png)$/i.test(req.outPath)) {
    throw new Error('exportEncode: outPath must end with .jpg/.jpeg/.png');
  }
  try {
    const info = await buildPipeline(req, true).toFile(req.outPath);
    return { path: req.outPath, width: info.width, height: info.height, bytes: info.size };
  } catch (err) {
    if (!req.meta || req.metadata === 'none') throw err;
    // EXIF strings are parsed by libvips at encode time — metadata problems
    // must never sink the export itself.
    console.warn('exportEncode: EXIF embedding failed, retrying without EXIF:', err);
    const info = await buildPipeline(req, false).toFile(req.outPath);
    return { path: req.outPath, width: info.width, height: info.height, bytes: info.size };
  }
}
