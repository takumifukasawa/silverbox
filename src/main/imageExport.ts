/**
 * Export encoder (REBUILD-SPEC §15) — main-process side.
 *
 * The renderer runs the graph at full resolution and reads back display-
 * encoded sRGB RGBA8 pixels; this module packages them with sharp: optional
 * long-edge resize, JPEG (quality) or PNG encode, an sRGB ICC profile, and a
 * minimal EXIF block copied from the decode metadata. sharp is a native
 * addon, hence main-process only.
 *
 * Color note: the pixels are already display-encoded sRGB — no gamma or
 * colourspace operation happens here, so the file matches the preview.
 * Orientation is baked into the pixels (applied once at decode), so no
 * Orientation tag is written.
 */
import sharp, { type Sharp } from 'sharp';
import type { ExportEncodeRequest, ExportEncodeResult, ExportExifMeta } from '../../shared/ipc';

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

/** Build the sharp withExif payload (IFD0 = main image, IFD2 = Exif sub-IFD). */
function buildExif(meta: ExportExifMeta): Record<string, Record<string, string>> {
  const ifd0: Record<string, string> = { Software: 'silverbox' };
  const ifd2: Record<string, string> = {};
  if (meta.cameraMake) ifd0.Make = meta.cameraMake;
  if (meta.cameraModel) ifd0.Model = meta.cameraModel;
  if (meta.timestampIso) {
    const dt = exifDateTime(meta.timestampIso);
    if (dt) {
      ifd0.DateTime = dt;
      ifd2.DateTimeOriginal = dt;
    }
  }
  if (meta.isoSpeed && Number.isFinite(meta.isoSpeed)) ifd2.ISOSpeedRatings = String(Math.round(meta.isoSpeed));
  if (meta.shutter && Number.isFinite(meta.shutter) && meta.shutter > 0) {
    ifd2.ExposureTime = exposureTime(meta.shutter);
  }
  if (meta.aperture && Number.isFinite(meta.aperture) && meta.aperture > 0) {
    ifd2.FNumber = rational(meta.aperture, 10);
  }
  if (meta.focalLength && Number.isFinite(meta.focalLength) && meta.focalLength > 0) {
    ifd2.FocalLength = rational(meta.focalLength, 10);
  }
  return { IFD0: ifd0, IFD2: ifd2 };
}

function buildPipeline(req: ExportEncodeRequest, withExif: boolean): Sharp {
  const { width, height, quality, maxDim } = req;
  let img = sharp(Buffer.from(req.data), { raw: { width, height, channels: 4 }, limitInputPixels: false }).removeAlpha();
  if (maxDim && maxDim > 0 && maxDim < Math.max(width, height)) {
    img = img.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
  }
  if (/\.png$/i.test(req.outPath)) {
    img = img.png();
  } else {
    img = img.jpeg({ quality: Math.min(100, Math.max(1, Math.round(quality))) });
  }
  img = img.withIccProfile('srgb');
  if (withExif && req.meta) img = img.withExif(buildExif(req.meta));
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
    if (!req.meta) throw err;
    // EXIF strings are parsed by libvips at encode time — metadata problems
    // must never sink the export itself.
    console.warn('exportEncode: EXIF embedding failed, retrying without EXIF:', err);
    const info = await buildPipeline(req, false).toFile(req.outPath);
    return { path: req.outPath, width: info.width, height: info.height, bytes: info.size };
  }
}
