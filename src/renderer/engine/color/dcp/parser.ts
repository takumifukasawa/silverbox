/**
 * DCP (DNG Camera Profile) parser — turns raw file bytes into a typed
 * `ParsedDcp`, or throws `DcpParseError` with an actionable message. Reads,
 * at minimum, the tags docs/brief-bank/dcp-profile.md's Stage-1 brief lists:
 * UniqueCameraModel, ProfileName, CalibrationIlluminant1/2, ColorMatrix1/2,
 * ForwardMatrix1/2, the HueSatMap trio, the LookTable trio, ProfileToneCurve,
 * BaselineExposureOffset.
 *
 * What's REQUIRED vs optional, per the DNG spec's own precedence rules:
 *  - UniqueCameraModel, CalibrationIlluminant1/2, ColorMatrix1: required —
 *    without these there is no way to map camera RGB to XYZ at all.
 *  - ColorMatrix2/ForwardMatrix1/2: optional, but at least one matrix per
 *    illuminant slot is needed for the two-point interpolation (see
 *    pipeline.ts) — a single-illuminant profile (ColorMatrix2 absent) is
 *    accepted and simply doesn't interpolate (both anchors read the same
 *    matrix).
 *  - HueSatMap / LookTable: independently optional (a profile may ship
 *    neither, either, or both — confirmed on real Sony ILCE-7CM2 profiles:
 *    the "Camera Vivid/Neutral/…" family ships ONLY a LookTable + ToneCurve,
 *    no HueSatMap at all).
 *  - ProfileToneCurve / BaselineExposureOffset: optional; absent tone curve
 *    = identity (linear pass), absent baseline exposure = 0 EV.
 */
import { DcpParseError, readDcpIfd0, type TiffIfd } from './tiffReader';
import * as TAG from './tiffTags';

export type Mat3Flat = readonly [number, number, number, number, number, number, number, number, number];

export interface HueSatTable {
  /** [hueDivisions, satDivisions, valDivisions] — valDivisions === 1 is the documented 2D special case (pipeline.ts skips the value axis entirely). */
  dims: readonly [number, number, number];
  /** Flat [h][s][v][3] array (hueShift-degrees, satScale, valScale) triples, row-major h-major/s/v-minor — see pipeline.ts's lookup indexing. */
  data: Float32Array;
}

export interface ToneCurve {
  /** (x,y) control points in [0,1], STRICTLY increasing x (validated at parse time) — spline/PCHIP evaluated in pipeline.ts. */
  points: readonly (readonly [number, number])[];
}

export interface ParsedDcp {
  uniqueCameraModel: string;
  profileName: string | null;
  calibrationIlluminant1: number;
  calibrationIlluminant2: number | null;
  colorMatrix1: Mat3Flat;
  colorMatrix2: Mat3Flat | null;
  forwardMatrix1: Mat3Flat | null;
  forwardMatrix2: Mat3Flat | null;
  hueSatMap1: HueSatTable | null;
  hueSatMap2: HueSatTable | null;
  /** 'sRGB' encodes the VALUE lookup coordinate through the sRGB OETF before indexing (DNG spec's ProfileHueSatMapEncoding); default 'linear'. */
  hueSatMapEncoding: 'linear' | 'sRGB';
  lookTable: HueSatTable | null;
  lookTableEncoding: 'linear' | 'sRGB';
  toneCurve: ToneCurve | null;
  /** EV gain (2^offset applied at the end of the pipeline); 0 when absent. */
  baselineExposureOffset: number;
}

function readMat3(ifd: TiffIfd, tag: number, name: string): Mat3Flat {
  const v = ifd.rationals(tag, name);
  if (v.length !== 9) throw new DcpParseError(`${name} has ${v.length} values, expected 9 (a 3×3 matrix)`);
  return v as unknown as Mat3Flat;
}

function readMat3Opt(ifd: TiffIfd, tag: number, name: string): Mat3Flat | null {
  if (!ifd.has(tag)) return null;
  return readMat3(ifd, tag, name);
}

function readHueSatTable(ifd: TiffIfd, dimsTag: number, dataTag: number, dimsName: string, dataName: string): HueSatTable | null {
  if (!ifd.has(dataTag)) return null;
  const dims = ifd.ints(dimsTag, dimsName);
  if (dims.length !== 3) throw new DcpParseError(`${dimsName} has ${dims.length} values, expected 3 ([hue, sat, val] divisions)`);
  const [h, s, v] = dims as [number, number, number];
  if (h < 1 || s < 1 || v < 1) throw new DcpParseError(`${dimsName} has a non-positive division count (${h}, ${s}, ${v})`);
  const expected = h * s * v * 3;
  const data = ifd.floats(dataTag, dataName);
  if (data.length !== expected) {
    throw new DcpParseError(`${dataName} has ${data.length} values, expected ${expected} (${h}×${s}×${v}×3 from ${dimsName})`);
  }
  return { dims: [h, s, v], data: Float32Array.from(data) };
}

function readEncoding(ifd: TiffIfd, tag: number, name: string): 'linear' | 'sRGB' {
  if (!ifd.has(tag)) return 'linear';
  const v = ifd.ints(tag, name);
  const code = v[0] ?? 0;
  if (code !== 0 && code !== 1) throw new DcpParseError(`${name} has an unknown encoding code ${code} (expected 0=linear or 1=sRGB)`);
  return code === 1 ? 'sRGB' : 'linear';
}

function readToneCurve(ifd: TiffIfd): ToneCurve | null {
  if (!ifd.has(TAG.TAG_PROFILE_TONE_CURVE)) return null;
  const flat = ifd.floats(TAG.TAG_PROFILE_TONE_CURVE, 'ProfileToneCurve');
  if (flat.length < 4 || flat.length % 2 !== 0) {
    throw new DcpParseError(`ProfileToneCurve has ${flat.length} values, expected an even count ≥4 (x,y pairs)`);
  }
  const points: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) points.push([flat[i]!, flat[i + 1]!]);
  for (let i = 1; i < points.length; i++) {
    if (points[i]![0] <= points[i - 1]![0]) throw new DcpParseError('ProfileToneCurve x values must be strictly increasing');
  }
  if (points[0]![0] < 0 || points[points.length - 1]![0] > 1) {
    throw new DcpParseError('ProfileToneCurve x values must lie in [0,1]');
  }
  return { points };
}

/** Parse a DCP file's bytes. `sourcePath` is used only to make error messages actionable (e.g. "bad-file.dcp is not a DCP: …"). */
export function parseDcp(buf: ArrayBuffer, sourcePath?: string): ParsedDcp {
  const ifd = readDcpIfd0(buf, sourcePath);
  const where = sourcePath ? ` (${sourcePath})` : '';

  const uniqueCameraModel = ifd.ascii(TAG.TAG_UNIQUE_CAMERA_MODEL, 'UniqueCameraModel');
  if (!uniqueCameraModel) throw new DcpParseError(`file${where} has an empty UniqueCameraModel`);
  const profileName = ifd.asciiOpt(TAG.TAG_PROFILE_NAME, 'ProfileName');

  const illum1Raw = ifd.ints(TAG.TAG_CALIBRATION_ILLUMINANT_1, 'CalibrationIlluminant1');
  const calibrationIlluminant1 = illum1Raw[0] ?? 0;
  if (calibrationIlluminant1 === 0) throw new DcpParseError(`file${where} has CalibrationIlluminant1 = 0 (Unknown) — not a usable profile`);
  const illum2Raw = ifd.intOpt(TAG.TAG_CALIBRATION_ILLUMINANT_2, 'CalibrationIlluminant2');
  const calibrationIlluminant2 = illum2Raw ? (illum2Raw[0] ?? null) : null;

  const colorMatrix1 = readMat3(ifd, TAG.TAG_COLOR_MATRIX_1, 'ColorMatrix1');
  const colorMatrix2 = readMat3Opt(ifd, TAG.TAG_COLOR_MATRIX_2, 'ColorMatrix2');
  const forwardMatrix1 = readMat3Opt(ifd, TAG.TAG_FORWARD_MATRIX_1, 'ForwardMatrix1');
  const forwardMatrix2 = readMat3Opt(ifd, TAG.TAG_FORWARD_MATRIX_2, 'ForwardMatrix2');

  const hueSatMap1 = readHueSatTable(
    ifd,
    TAG.TAG_PROFILE_HUE_SAT_MAP_DIMS,
    TAG.TAG_PROFILE_HUE_SAT_MAP_DATA_1,
    'ProfileHueSatMapDims',
    'ProfileHueSatMapData1'
  );
  const hueSatMap2 = hueSatMap1
    ? readHueSatTable(ifd, TAG.TAG_PROFILE_HUE_SAT_MAP_DIMS, TAG.TAG_PROFILE_HUE_SAT_MAP_DATA_2, 'ProfileHueSatMapDims', 'ProfileHueSatMapData2')
    : null;
  const hueSatMapEncoding = readEncoding(ifd, TAG.TAG_PROFILE_HUE_SAT_MAP_ENCODING, 'ProfileHueSatMapEncoding');

  const lookTable = readHueSatTable(
    ifd,
    TAG.TAG_PROFILE_LOOK_TABLE_DIMS,
    TAG.TAG_PROFILE_LOOK_TABLE_DATA,
    'ProfileLookTableDims',
    'ProfileLookTableData'
  );
  const lookTableEncoding = readEncoding(ifd, TAG.TAG_PROFILE_LOOK_TABLE_ENCODING, 'ProfileLookTableEncoding');

  const toneCurve = readToneCurve(ifd);

  const baselineRaw = ifd.rationalOpt(TAG.TAG_BASELINE_EXPOSURE_OFFSET, 'BaselineExposureOffset');
  const baselineExposureOffset = baselineRaw ? (baselineRaw[0] ?? 0) : 0;

  return {
    uniqueCameraModel,
    profileName,
    calibrationIlluminant1,
    calibrationIlluminant2,
    colorMatrix1,
    colorMatrix2,
    forwardMatrix1,
    forwardMatrix2,
    hueSatMap1,
    hueSatMap2,
    hueSatMapEncoding,
    lookTable,
    lookTableEncoding,
    toneCurve,
    baselineExposureOffset,
  };
}

export { DcpParseError } from './tiffReader';
