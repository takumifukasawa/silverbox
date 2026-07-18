import { describe, expect, it } from 'vitest';
import {
  BRADFORD_D50_TO_D65,
  BRADFORD_D65_TO_D50,
  mulMat3Mat3,
  mulMat3Vec3,
  REC2020_TO_XYZ_D65,
  XYZ_D65_TO_REC2020,
  type Mat3,
  type Vec3,
} from './matrices';
import {
  approxCameraFromWorkingMatrix,
  cameraFromWorkingMatrix,
  cameraNativeFromWorking,
  evalToneCurve,
  exactCameraFromWorkingMatrix,
  hsvToRgb,
  illuminantFraction,
  lookupTable,
  rgbToHsv,
} from './pipeline';
import { SRGB_TO_WORK } from '../workingSpace';
import { DcpParseError, parseDcp } from './parser';
import type { HueSatTable, ParsedDcp } from './parser';

const IDENTITY: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function approxEqMat(m: readonly (readonly number[])[], tol = 1e-4): void {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(m[i]![j]! - IDENTITY[i]![j]!)).toBeLessThan(tol);
}

describe('dcp matrices', () => {
  it('REC2020<->XYZ(D65) are exact inverses', () => {
    approxEqMat(mulMat3Mat3(REC2020_TO_XYZ_D65, XYZ_D65_TO_REC2020));
  });
  it('Bradford D65<->D50 are exact inverses', () => {
    approxEqMat(mulMat3Mat3(BRADFORD_D65_TO_D50, BRADFORD_D50_TO_D65));
  });
  it('a Rec.2020 neutral round-trips through the whole camera<->working chain unchanged', () => {
    // [1,1,1] in working-linear is D65 white; XYZ(D65)->Bradford->D50->back->D65->Rec2020 should return [1,1,1].
    const xyz65 = mulMat3Vec3(REC2020_TO_XYZ_D65, [1, 1, 1]);
    const xyz50 = mulMat3Vec3(BRADFORD_D65_TO_D50, xyz65);
    const back65 = mulMat3Vec3(BRADFORD_D50_TO_D65, xyz50);
    const rec = mulMat3Vec3(XYZ_D65_TO_REC2020, back65);
    for (const c of rec) expect(Math.abs(c - 1)).toBeLessThan(1e-4);
  });
});

describe('dcp camera-native reconstruction (Stage 2)', () => {
  // OUR own synthetic "rgb_cam" (camera(WB'd)-native -> sRGB D65) — invertible,
  // not the identity, so the round trip genuinely exercises matrix inversion.
  const SYNTH_RGB_CAM: Mat3 = [
    [1.62, -0.48, -0.06],
    [-0.1, 1.4, -0.18],
    [0.02, -0.32, 1.62],
  ];
  const SYNTH_CAM_XYZ: Mat3 = [
    [0.9, -0.2, 0.05],
    [-0.15, 1.1, 0.03],
    [0.02, -0.25, 1.05],
  ];

  it('a known camera-native RGB pushed through a known rgb_cam round-trips exactly via exactCameraFromWorkingMatrix', () => {
    const cameraRgb: Vec3 = [0.42, 0.55, 0.3];
    // Simulate exactly what libraw's convert_to_rgb() + our decoder produce
    // (pipeline.ts's own doc comment derives this from LibRaw's cam_xyz_coeff):
    // workingRgb = SRGB_TO_WORK · rgb_cam · cameraRgb.
    const camSrgb = mulMat3Vec3(SYNTH_RGB_CAM, cameraRgb);
    const workingRgb = mulMat3Vec3(SRGB_TO_WORK as unknown as Mat3, camSrgb);
    const matrix = exactCameraFromWorkingMatrix(SYNTH_RGB_CAM);
    const recovered = cameraNativeFromWorking(workingRgb, matrix);
    // Tolerance set by SRGB_TO_WORK's own stored precision (6 decimal places,
    // ~1e-6 rounding), not by the reconstruction math itself (which is a
    // plain double-precision matrix inverse/compose) — still 100x tighter
    // than the engine's 1/255 GPU-vs-CPU parity gate.
    for (let i = 0; i < 3; i++) expect(Math.abs(recovered[i]! - cameraRgb[i]!)).toBeLessThan(1e-5);
  });

  it('approxCameraFromWorkingMatrix matches the documented Stage-1 formula (camXyz · REC2020_TO_XYZ_D65)', () => {
    const matrix = approxCameraFromWorkingMatrix(SYNTH_CAM_XYZ);
    const reference = mulMat3Mat3(SYNTH_CAM_XYZ, REC2020_TO_XYZ_D65);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(matrix[i]![j]! - reference[i]![j]!)).toBeLessThan(1e-12);
  });

  it('cameraFromWorkingMatrix picks the exact route when rgbCam is present, else the approx fallback', () => {
    const exact = cameraFromWorkingMatrix(SYNTH_RGB_CAM, SYNTH_CAM_XYZ);
    const exactRef = exactCameraFromWorkingMatrix(SYNTH_RGB_CAM);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(exact[i]![j]! - exactRef[i]![j]!)).toBeLessThan(1e-12);

    const approx = cameraFromWorkingMatrix(null, SYNTH_CAM_XYZ);
    const approxRef = approxCameraFromWorkingMatrix(SYNTH_CAM_XYZ);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(approx[i]![j]! - approxRef[i]![j]!)).toBeLessThan(1e-12);
  });
});

describe('dcp HSV', () => {
  it('rgbToHsv/hsvToRgb round-trip (V unclamped)', () => {
    for (const rgb of [
      [0.5, 0.2, 0.1],
      [1.4, 0.3, 0.9], // >1 highlight — must survive round-trip
      [0.2, 0.2, 0.2], // gray: hue is irrelevant, sat 0
    ] as const) {
      const [h, s, v] = rgbToHsv(rgb);
      const back = hsvToRgb([h, s, v]);
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i]! - rgb[i]!)).toBeLessThan(1e-6);
    }
  });
  it('a pure red has hue 0, full saturation', () => {
    const [h, s, v] = rgbToHsv([1, 0, 0]);
    expect(h).toBe(0);
    expect(s).toBe(1);
    expect(v).toBe(1);
  });
});

describe('dcp table lookup', () => {
  it('reads a node exactly at its own grid coordinate (2×2×1 table)', () => {
    // dims [hue=2, sat=2, val=1] — value axis collapsed (the spec's documented special case).
    const table: HueSatTable = {
      dims: [2, 2, 1],
      data: Float32Array.from([
        // h=0,s=0: hueShift=10, satScale=1, valScale=1
        10, 1, 1,
        // h=0,s=1
        0, 1.2, 1,
        // h=1 (=180deg), s=0
        -5, 1, 0.9,
        // h=1, s=1
        0, 1, 1,
      ]),
    };
    const [dh, sScale] = lookupTable(table, 0, 0, 0.5);
    expect(dh).toBeCloseTo(10, 5);
    expect(sScale).toBeCloseTo(1, 5);
    const [dh2, sScale2, vScale2] = lookupTable(table, 180, 0, 0.5);
    expect(dh2).toBeCloseTo(-5, 5);
    expect(sScale2).toBeCloseTo(1, 5);
    expect(vScale2).toBeCloseTo(0.9, 5);
  });

  it('interpolates halfway between two hue nodes', () => {
    const table: HueSatTable = {
      dims: [2, 1, 1],
      data: Float32Array.from([0, 1, 1, 10, 1, 1]),
    };
    const [dh] = lookupTable(table, 90, 0, 0.5); // halfway between hue node 0 (0°) and node 1 (180°)
    expect(dh).toBeCloseTo(5, 5);
  });
});

describe('dcp tone curve', () => {
  it('piecewise-linear evaluation matches hand-computed midpoints', () => {
    const points: [number, number][] = [
      [0, 0],
      [0.5, 0.6],
      [1, 1],
    ];
    expect(evalToneCurve(points, 0)).toBeCloseTo(0, 6);
    expect(evalToneCurve(points, 0.25)).toBeCloseTo(0.3, 6);
    expect(evalToneCurve(points, 0.5)).toBeCloseTo(0.6, 6);
    expect(evalToneCurve(points, 0.75)).toBeCloseTo(0.8, 6);
    expect(evalToneCurve(points, 1)).toBeCloseTo(1, 6);
  });
});

describe('dcp illuminant interpolation', () => {
  const base: ParsedDcp = {
    uniqueCameraModel: 'Test',
    profileName: null,
    calibrationIlluminant1: 17, // StdA, 2856K
    calibrationIlluminant2: 21, // D65, 6504K
    colorMatrix1: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    colorMatrix2: null,
    forwardMatrix1: null,
    forwardMatrix2: null,
    hueSatMap1: null,
    hueSatMap2: null,
    hueSatMapEncoding: 'linear',
    lookTable: null,
    lookTableEncoding: 'linear',
    toneCurve: null,
    baselineExposureOffset: 0,
  };
  it('is 0 at illuminant1 CCT, 1 at illuminant2 CCT, clamped beyond', () => {
    expect(illuminantFraction(base, 2856)).toBeCloseTo(0, 3);
    expect(illuminantFraction(base, 6504)).toBeCloseTo(1, 3);
    expect(illuminantFraction(base, 20000)).toBe(1);
    expect(illuminantFraction(base, 1000)).toBe(0);
  });
  it('is 0 when CalibrationIlluminant2 is absent (single-illuminant profile)', () => {
    expect(illuminantFraction({ ...base, calibrationIlluminant2: null }, 6504)).toBe(0);
  });
});

describe('dcp parser errors', () => {
  it('rejects a buffer with the wrong byte-order mark', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([0x58, 0x58, 0x52, 0x43]);
    expect(() => parseDcp(buf)).toThrow(DcpParseError);
  });
  it('rejects a plain TIFF (magic 42, not the DCP "RC" marker) with an actionable message', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint8(0, 0x49);
    view.setUint8(1, 0x49);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    expect(() => parseDcp(buf, 'photo.dng')).toThrow(/plain TIFF\/DNG, not a DCP/);
  });
  it('rejects a truncated file', () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([0x49, 0x49, 0x52, 0x43]);
    expect(() => parseDcp(buf)).toThrow(DcpParseError);
  });
});
