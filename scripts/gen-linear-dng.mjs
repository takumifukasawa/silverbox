#!/usr/bin/env node
/**
 * Synthetic Linear DNG writer — docs/research/local-adaptive-tone.md §5.0
 * ("合成 Linear DNG を作る"): ordinary RAWs contaminate the Highlights/
 * Shadows identification experiments (demosaic / highlight-recovery / CA /
 * lens corrections all touch the pixels before we get to measure anything),
 * so the E1/E2/E4/E5/E6 harness needs its own demosaiced, 1-sample-per-
 * pixel-per-channel LINEAR test patterns that both Lightroom Classic and
 * silverbox's own libraw-wasm decoder accept as a real camera file.
 *
 * Pure Node, no new deps: hand-assembles a baseline-TIFF container via
 * scripts/lib/tiffWriter.mjs and writes the small set of DNG tags a
 * PhotometricInterpretation=34892 (LinearRaw) reader actually needs.
 *
 * Color-matrix choice (§5.0 point 1's "identity or sRGB D65" — this file
 * uses sRGB/D65, not identity): ColorMatrix1 is DNG's XYZ→camera-native
 * matrix, so setting it to XYZ_to_sRGB(D65) makes "camera native" ≡ linear
 * sRGB-primaries RGB, and CalibrationIlluminant1=D65 matches AsShotNeutral=
 * [1,1,1] (as-shot already neutral, WB a no-op). For an ACHROMATIC input
 * (R=G=B=v, which every experiment generator in gen-tone-experiments.mjs
 * produces — see local-adaptive-tone.md §5.0 point 6's "keeps luminance
 * analysis clean" constraint), v·(1,1,1) is exactly the D65 white LOCUS in
 * both the sRGB-primaries and Rec.2020-primaries spaces (both are D65-
 * referenced), so camera→XYZ→working-space round-trips gray values back to
 * v·(1,1,1) up to matrix/quantization rounding — regardless of which
 * D65-referenced RGB working space the reader targets. An identity
 * ColorMatrix1 (XYZ≡camera-native literally) does NOT have this property
 * (X=Y=Z=v is not the D65 white point), so it was rejected: it would leave
 * a synthetic gray patch with R≠G≠B after decode, defeating the "achromatic
 * in, achromatic out" measurement requirement. scripts/verify-lineardng.mjs
 * measures the actual round-trip gain/tolerance empirically rather than
 * assuming it — see that script's own header comment.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTiff, TYPE, toRational } from './lib/tiffWriter.mjs';

/** DNG's own `1.4.0.0` version tag — the minimum version that defines PhotometricInterpretation=34892 (LinearRaw) and ProfileToneCurve/DefaultBlackRender semantics we rely on. */
const DNG_VERSION = [1, 4, 0, 0];

/** XYZ(D65) → sRGB-primaries linear RGB — see this file's header comment for why sRGB/D65 (not identity) is the right ColorMatrix1 choice for achromatic-preserving synthetic files. Bruce Lindbloom's standard sRGB matrix, inverted. */
const XYZ_TO_SRGB_D65 = [
  [3.2404542, -1.537139, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

/** DNG CalibrationIlluminant tag value for "D65" (TIFF/EP LightSource enumeration). */
const CALIBRATION_ILLUMINANT_D65 = 21;

/**
 * Write a Linear DNG. `generator(x, y) -> number | [r,g,b]` returns LINEAR
 * scene-referred value(s) in [0,1] (mapped internally to the 0..65535
 * 16-bit range); a plain number is broadcast to all `samplesPerPixel`
 * channels (the common case — every experiment here is achromatic).
 */
export function writeLinearDng(
  filePath,
  { width, height, generator, samplesPerPixel = 3, uniqueCameraModel = 'Silverbox Synthetic LinearRaw' }
) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`writeLinearDng: bad width ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`writeLinearDng: bad height ${height}`);
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3) throw new Error(`writeLinearDng: samplesPerPixel must be 1 or 3, got ${samplesPerPixel}`);

  const pixelData = Buffer.alloc(width * height * samplesPerPixel * 2);
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = generator(x, y);
      const channels = Array.isArray(v) ? v : new Array(samplesPerPixel).fill(v);
      if (channels.length !== samplesPerPixel) {
        throw new Error(`writeLinearDng: generator(${x},${y}) returned ${channels.length} channels, expected ${samplesPerPixel}`);
      }
      for (let c = 0; c < samplesPerPixel; c++) {
        const clamped = Math.min(1, Math.max(0, channels[c]));
        pixelData.writeUInt16LE(Math.round(clamped * 65535), o);
        o += 2;
      }
    }
  }

  const colorMatrixValues = XYZ_TO_SRGB_D65.flat().map((v) => toRational(v));
  const asShotNeutral = new Array(samplesPerPixel).fill([1, 1]);
  const whiteLevel = new Array(samplesPerPixel).fill(65535);
  const blackLevel = new Array(samplesPerPixel).fill(0);

  const entries = [
    // --- baseline TIFF ---
    { tag: 254, type: TYPE.LONG, values: [0] }, // NewSubfileType: 0 = main image
    { tag: 256, type: TYPE.LONG, values: [width] }, // ImageWidth
    { tag: 257, type: TYPE.LONG, values: [height] }, // ImageLength
    { tag: 258, type: TYPE.SHORT, values: new Array(samplesPerPixel).fill(16) }, // BitsPerSample
    { tag: 259, type: TYPE.SHORT, values: [1] }, // Compression: none
    { tag: 262, type: TYPE.SHORT, values: [34892] }, // PhotometricInterpretation: LinearRaw
    { tag: 271, type: TYPE.ASCII, values: 'Silverbox' }, // Make
    { tag: 272, type: TYPE.ASCII, values: uniqueCameraModel }, // Model
    { tag: 274, type: TYPE.SHORT, values: [1] }, // Orientation: normal
    { tag: 277, type: TYPE.SHORT, values: [samplesPerPixel] }, // SamplesPerPixel
    { tag: 278, type: TYPE.LONG, values: [height] }, // RowsPerStrip: one strip, full image
    { tag: 284, type: TYPE.SHORT, values: [1] }, // PlanarConfiguration: chunky
    { tag: 305, type: TYPE.ASCII, values: 'silverbox gen-linear-dng.mjs' }, // Software
    { tag: 339, type: TYPE.SHORT, values: new Array(samplesPerPixel).fill(1) }, // SampleFormat: unsigned integer

    // --- DNG-specific (minimal, spec §8 "Required tags" superset for LinearRaw) ---
    { tag: 50706, type: TYPE.BYTE, values: DNG_VERSION }, // DNGVersion
    { tag: 50707, type: TYPE.BYTE, values: DNG_VERSION }, // DNGBackwardVersion
    { tag: 50708, type: TYPE.ASCII, values: uniqueCameraModel }, // UniqueCameraModel
    { tag: 50721, type: TYPE.SRATIONAL, values: colorMatrixValues }, // ColorMatrix1 (XYZ(D65)->camera-native — see header comment)
    { tag: 50778, type: TYPE.SHORT, values: [CALIBRATION_ILLUMINANT_D65] }, // CalibrationIlluminant1
    { tag: 50728, type: TYPE.RATIONAL, values: asShotNeutral }, // AsShotNeutral: already neutral, WB no-op
    { tag: 50730, type: TYPE.SRATIONAL, values: [toRational(0)] }, // BaselineExposure: 0 EV
    { tag: 50717, type: TYPE.SHORT, values: whiteLevel }, // WhiteLevel: full 16-bit range
    { tag: 50714, type: TYPE.LONG, values: blackLevel }, // BlackLevel: 0
    { tag: 50719, type: TYPE.LONG, values: [0, 0] }, // DefaultCropOrigin
    { tag: 50720, type: TYPE.LONG, values: [width, height] }, // DefaultCropSize
    { tag: 50829, type: TYPE.LONG, values: [0, 0, height, width] }, // ActiveArea: top,left,bottom,right
    { tag: 50940, type: TYPE.FLOAT, values: [0, 0, 1, 1] }, // ProfileToneCurve: identity (linear), 2 points
    { tag: 51110, type: TYPE.LONG, values: [1] }, // DefaultBlackRender: 1 = None (no auto black-point guessing)
  ];

  const buf = buildTiff({ entries, pixelData });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return { width, height, samplesPerPixel, bytes: buf.length };
}

// Direct-run smoke test: `node scripts/gen-linear-dng.mjs [out.dng] [width] [height] [value0to1]`
// writes one uniform-gray Linear DNG — a manual sanity check independent of
// scripts/verify-lineardng.mjs's own (automated) round-trip assertions.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [outPath = 'scratch-linear.dng', widthArg = '256', heightArg = '256', valueArg = '0.18'] = process.argv.slice(2);
  const width = Number(widthArg);
  const height = Number(heightArg);
  const value = Number(valueArg);
  const result = writeLinearDng(outPath, { width, height, generator: () => value });
  console.log(`wrote ${outPath}: ${result.width}x${result.height}, ${result.samplesPerPixel} spp, ${result.bytes} bytes, uniform value ${value}`);
}
