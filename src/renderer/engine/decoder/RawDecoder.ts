/**
 * Decoder-facing types shared by RAW (libraw-wasm) and, later, JPEG input.
 *
 * A decoder turns file bytes into a gamma-encoded 16-bit RGB buffer plus the
 * color metadata needed for white balance math (§7 of the internal spec):
 * as-shot multipliers (camMul) and the camera→XYZ matrix (camXyz).
 */

/** Camera color calibration needed for Kelvin/Tint white balance. */
export interface CameraColorInfo {
  /** As-shot WB multipliers [R, G, B, G2] as reported by the camera. */
  camMul: [number, number, number, number];
  /** Camera-RGB → CIE XYZ matrix; rows are R/G/B/(G2), only the top 3x3 is used. */
  camXyz: number[][];
  /**
   * libraw's own `rgb_cam`: the LITERAL matrix libraw's `convert_to_rgb()`
   * composes with the output-colorspace table to turn the camera-native,
   * as-shot-WB'd, demosaiced RGB into the decoded pixel (→ linear sRGB D65 —
   * see engine/color/dcp/pipeline.ts's `exactCameraFromWorkingMatrix` doc
   * comment for the full derivation/provenance). Absent for inputs libraw
   * didn't expose it for (older builds, some formats); callers fall back to
   * the `camXyz`-based approximation. Only the top 3x3 (R/G/B columns) is
   * used — rows/columns beyond the demosaiced channel count (`colors`,
   * always 3 here) are libraw-internal padding.
   */
  rgbCam?: number[][];
  /** Sensor black level. */
  black: number;
  /** Sensor saturation (white) level. */
  maximum: number;
  /** Native bits per sample of the raw data. */
  rawBps: number;
}

/** Subset of capture metadata we surface in the UI and write to exported JPEGs. */
export interface CaptureInfo {
  cameraMake: string;
  cameraModel: string;
  isoSpeed: number;
  shutter: number;
  aperture: number;
  focalLength: number;
  timestamp?: Date;
}

export interface DecodedImage {
  /** Pixel dimensions after libraw processing (pre-orientation). */
  width: number;
  height: number;
  /** Interleaved RGB, 3 channels. */
  colors: number;
  /** Bits per sample of `data` (16 for RAW path). */
  bits: number;
  /** Gamma-encoded RGB samples, length = width * height * colors. */
  data: Uint16Array;
  /** EXIF orientation code from libraw (`flip`): 0=none, 3=180°, 5=90°CCW, 6=90°CW. */
  flip: number;
  /** Color calibration; absent for inputs without camera color data (e.g. JPEG). */
  color?: CameraColorInfo;
  /**
   * Readout-window origin in physical sensor px — the sensor-frame position of
   * the decoded raster's (0,0) corner, i.e. `[cleft, ctop]` of the
   * camera-recommended crop librawDecoder.ts's computeCropbox retains (the same
   * pre-rotation active-area frame `flip` is applied on top of). Additive
   * field carried for the repair-sheet sensor↔anchor transform
   * (docs/brief-bank/linked-looks-stage-f.md semantic 2 — the §9-4 ⚠️): the
   * rgbCam stage-2 additive pattern, threaded through the worker/IPC boundary.
   * PRESENT for every RAW decode (the camera-recommended crop's [cleft, ctop]
   * when libraw exposed one, else (0,0) — a full active-area decode's corner IS
   * the sensor origin), so it is a stable RAW-only gate. ABSENT only for JPEG,
   * which has no sensor readout window and cannot participate in a repair sheet.
   */
  readoutOrigin?: { x: number; y: number };
  capture: CaptureInfo;
}

export interface RawDecoder {
  /**
   * Decode file bytes into a 16-bit RGB image.
   *
   * NOTE: implementations may transfer `bytes` to a worker (detaching the
   * buffer) — callers must not reuse the buffer after calling decode().
   */
  decode(bytes: Uint8Array<ArrayBuffer>): Promise<DecodedImage>;
}
