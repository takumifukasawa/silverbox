import LibRaw from 'libraw-wasm';
import type { CameraColorInfo, DecodedImage, RawDecoder } from './RawDecoder';

/**
 * RAW decoder backed by libraw-wasm (runs in its own Web Worker).
 *
 * Settings: camera as-shot WB baked in (useCameraWb) and 16-bit output, so the
 * white-balance node later applies only a *relative* gain — as-shot Kelvin/Tint
 * is a true identity pass.
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
      // open() transfers the buffer to the worker; `bytes` is detached after this.
      await raw.open(bytes, { useCameraWb: true, outputBps: 16 });

      const meta = await raw.metadata(true);
      if (!meta) throw new Error('libraw: no metadata');
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
