/**
 * DCP camera-profile loading verify (docs/brief-bank/dcp-profile.md, Stage 1:
 * engine + CLI + minimal UI).
 *
 * Fixture: scripts/fixtures/build-dcp-fixture.mjs hand-rolls a MINIMAL,
 * spec-conformant DCP (tiny synthetic tables — the brief's own suggested
 * 2×2×1 HueSatMap shape, plus a 1×1×1 LookTable, a 3-point ToneCurve, and a
 * BaselineExposureOffset) — OUR data, zero Adobe content (the brief's hard
 * legal line). See that file's doc comment for exactly what's in it and why.
 *
 * Like verify-sidecar-spec.mjs, the pure engine/color/dcp/ module (parser +
 * pipeline math) is bundled straight from TS source via esbuild and imported
 * under plain Node — no Electron needed for checks 1-3 below. Check 4 spawns
 * the real headless CLI (verify-cli.mjs's own idiom) since it exercises the
 * actual render pipeline (buildPlan → compileDevelop → the shared
 * PROFILE_WGSL/profileResidual trilinear pair the DCP lattice rides).
 *
 * Checks:
 *  1. Parser round-trip: every tag the fixture carries comes back from
 *     parseDcp() exactly as written (matrices, illuminants, HueSatMap/
 *     LookTable dims+data, ToneCurve points, BaselineExposureOffset).
 *  2. Golden math: renderDcpPixel() on a known input triplet matches an
 *     INDEPENDENTLY re-transcribed reference implementation of the same
 *     documented formulas (matrix chain, HSV, trilinear table lookup, tone
 *     curve, baseline gain) — see this file's own `referenceRenderDcpPixel`,
 *     written from the spec description, not copied from pipeline.ts. Also
 *     checks the illuminant-interpolation fraction lands exactly at the
 *     chosen asShotTempK (mired-halfway between the fixture's two
 *     illuminants → fraction 0.5, hand-checkable) and that changing it to
 *     the two anchors reproduces each illuminant's own HueSatMap exactly.
 *  2b. Camera-native reconstruction (Stage 2 — see dcp-profile.md's status
 *     block): a synthetic camera-native RGB pushed FORWARD through a known
 *     `rgb_cam` (simulating exactly what libraw's own convert_to_rgb() would
 *     have produced as our decoded working-space pixel) round-trips EXACTLY
 *     back through `exactCameraFromWorkingMatrix`'s inverse; the `camXyz`
 *     fallback route (`approxCameraFromWorkingMatrix`) and the picker
 *     (`cameraFromWorkingMatrix`) are checked against each other too.
 *  3. Malformed-file error paths: a plain TIFF/DNG (magic 42, no "RC"
 *     marker), a truncated file, and a bad byte-order mark all throw
 *     DcpParseError with an actionable message.
 *  4. CLI render: profile.source='dcp' at amount 100 differs measurably from
 *     BOTH the bypass (no profile) render and the builtin-lattice render at
 *     the same amount (proving DCP mode executes a genuinely different
 *     transform, not a silent fallback); amount 0 is a BIT-EXACT no-op,
 *     identical to bypass, regardless of source (the identity invariant).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';
import { buildFixtureDcp, buildPlainTiffBytes, buildTruncatedDcpBytes } from './fixtures/build-dcp-fixture.mjs';
import { seedLibraryDir } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SRC_ARW = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

// --- bundle the pure engine/color/dcp/ module straight from TS source ------
async function bundleToTempModule(relSrcPath, workDir) {
  const result = await build({
    entryPoints: [join(projectRoot, relSrcPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  const outPath = join(workDir, 'dcp.bundle.mjs');
  writeFileSync(outPath, result.outputFiles[0].text, 'utf8');
  return import(pathToFileURL(outPath).href);
}

const bundleWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-dcp-bundle-'));
let dcp;
try {
  dcp = await bundleToTempModule('src/renderer/engine/color/dcp/index.ts', bundleWorkDir);
  check('bundled engine/color/dcp/index.ts via esbuild and imported it under plain Node', true, null);
} catch (err) {
  check('bundled engine/color/dcp/index.ts via esbuild and imported it', false, String(err.stack ?? err));
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} finally {
  rmSync(bundleWorkDir, { recursive: true, force: true });
}

const {
  parseDcp,
  DcpParseError,
  renderDcpPixel,
  illuminantFraction,
  REC2020_TO_XYZ_D65,
  exactCameraFromWorkingMatrix,
  approxCameraFromWorkingMatrix,
  cameraFromWorkingMatrix,
  mulMat3Mat3,
} = dcp;

const IDENTITY_MAT3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// === 1. parser round-trip on the fixture ====================================
console.log('verify-dcp (parser round-trip on the fixture):');
const fixtureBytes = buildFixtureDcp();
const fixtureAb = fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength);
let parsed;
try {
  parsed = parseDcp(fixtureAb, 'silverbox-test.dcp');
  check('parseDcp accepts the fixture without throwing', true, null);
} catch (err) {
  check('parseDcp accepts the fixture without throwing', false, String(err.message ?? err));
}
if (parsed) {
  check('UniqueCameraModel round-trips', parsed.uniqueCameraModel === 'Silverbox Test Cam', parsed.uniqueCameraModel);
  check('ProfileName round-trips', parsed.profileName === 'Silverbox Test', parsed.profileName);
  check('CalibrationIlluminant1/2 round-trip', parsed.calibrationIlluminant1 === 17 && parsed.calibrationIlluminant2 === 21, {
    i1: parsed.calibrationIlluminant1,
    i2: parsed.calibrationIlluminant2,
  });
  const isIdentity3x3 = (m) => m && m.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-5);
  check('ColorMatrix1 round-trips as identity', isIdentity3x3(parsed.colorMatrix1), parsed.colorMatrix1);
  check('ForwardMatrix1/2 round-trip as identity', isIdentity3x3(parsed.forwardMatrix1) && isIdentity3x3(parsed.forwardMatrix2), {
    fm1: parsed.forwardMatrix1,
    fm2: parsed.forwardMatrix2,
  });
  check(
    'ProfileHueSatMapDims round-trips as [2,2,1]',
    parsed.hueSatMap1.dims[0] === 2 && parsed.hueSatMap1.dims[1] === 2 && parsed.hueSatMap1.dims[2] === 1,
    parsed.hueSatMap1.dims
  );
  const hsm1Node0 = Array.from(parsed.hueSatMap1.data.slice(0, 3));
  const hsm2Node0 = Array.from(parsed.hueSatMap2.data.slice(0, 3));
  check('ProfileHueSatMapData1 node (h=0,s=0) round-trips exactly', hsm1Node0.every((v, i) => Math.abs(v - [15, 1.1, 0.95][i]) < 1e-5), hsm1Node0);
  check('ProfileHueSatMapData2 node (h=0,s=0) round-trips exactly', hsm2Node0.every((v, i) => Math.abs(v - [25, 1.2, 0.9][i]) < 1e-5), hsm2Node0);
  check('ProfileHueSatMapEncoding defaults to linear (tag absent)', parsed.hueSatMapEncoding === 'linear', parsed.hueSatMapEncoding);
  check(
    'ProfileLookTableDims round-trips as the single-cell [1,1,1] special case',
    parsed.lookTable.dims[0] === 1 && parsed.lookTable.dims[1] === 1 && parsed.lookTable.dims[2] === 1,
    parsed.lookTable.dims
  );
  const ltData = Array.from(parsed.lookTable.data);
  check('ProfileLookTableData round-trips exactly', ltData.every((v, i) => Math.abs(v - [-5, 1.0, 1.02][i]) < 1e-5), ltData);
  check(
    'ProfileToneCurve round-trips as 3 (x,y) points',
    parsed.toneCurve.points.length === 3 &&
      parsed.toneCurve.points.every((p, i) => Math.abs(p[0] - [0, 0.5, 1][i]) < 1e-6 && Math.abs(p[1] - [0, 0.6, 1][i]) < 1e-6),
    parsed.toneCurve.points
  );
  check('BaselineExposureOffset round-trips as 0.25', Math.abs(parsed.baselineExposureOffset - 0.25) < 1e-5, parsed.baselineExposureOffset);
}

// === 2. golden math ==========================================================
console.log('\nverify-dcp (golden math vs an independent reference implementation):');

// asShotTempK chosen so the illuminant-interpolation fraction is EXACTLY 0.5
// (mired-halfway between the fixture's CalibrationIlluminant1=17/StdA=2856K
// and CalibrationIlluminant2=21/D65=6504K) — a hand-checkable value: mired1 =
// 1e6/2856, mired2 = 1e6/6504, asShotTempK = 1e6/((mired1+mired2)/2).
const MIRED1 = 1e6 / 2856;
const MIRED2 = 1e6 / 6504;
const HALFWAY_TEMP_K = 1e6 / ((MIRED1 + MIRED2) / 2);
check(
  'illuminantFraction lands exactly at 0.5 for the mired-halfway temperature',
  Math.abs(illuminantFraction(parsed, HALFWAY_TEMP_K) - 0.5) < 1e-9,
  illuminantFraction(parsed, HALFWAY_TEMP_K)
);
check('illuminantFraction is 0 exactly at illuminant1\'s own CCT (2856K)', illuminantFraction(parsed, 2856) === 0, illuminantFraction(parsed, 2856));
check('illuminantFraction is 1 exactly at illuminant2\'s own CCT (6504K)', illuminantFraction(parsed, 6504) === 1, illuminantFraction(parsed, 6504));

/**
 * Independent reference re-implementation of the documented pipeline
 * (dcp/pipeline.ts's own doc comment enumerates the same 10 stages) —
 * transcribed from the spec description directly in THIS file, not copied
 * from production source, so agreement is a genuine cross-check (it would
 * catch a wrong tag number, a transposed matrix, a wrong hue-wrap direction,
 * an off-by-one table index, …) rather than a tautology.
 */
function mulMV(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
const PROPHOTO_TO_XYZ_D50_REF = [
  [0.7977605, 0.1351858, 0.0313493],
  [0.2880711, 0.7118432, 0.0000857],
  [0.0, 0.0, 0.8251046],
];
const XYZ_D50_TO_PROPHOTO_REF = [
  [1.345799, -0.2555801, -0.0511063],
  [-0.5446225, 1.5082327, 0.020536],
  [0.0, 0.0, 1.2119675],
];
const BRADFORD_D50_TO_D65_REF = [
  [0.9554734, -0.0230985, 0.0632592],
  [-0.0283697, 1.0099954, 0.0210414],
  [0.012314, -0.0205076, 1.3303659],
];
const XYZ_D65_TO_REC2020_REF = [
  [1.7166512, -0.3556708, -0.2533663],
  [-0.6666844, 1.6164812, 0.0157685],
  [0.0176399, -0.0427706, 0.9421031],
];
function srgbEncodeRef(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function srgbDecodeRef(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function rgbToHsvRef([r, g, b]) {
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max > 0 ? delta / max : 0;
  let h;
  if (delta === 0) h = 0;
  else if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;
  return [h, Math.min(Math.max(s, 0), 1), v];
}
function hsvToRgbRef([h, s, v]) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1, g1, b1;
  if (hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  return [r1 + m, g1 + m, b1 + m];
}
function lookupTableRef(table, hueDeg, sat, vCoord) {
  const [H, S, V] = table.dims;
  const hueStep = 360 / H;
  const hf = ((((hueDeg % 360) + 360) % 360) / hueStep) % H;
  const hi0 = Math.floor(hf) % H;
  const hi1 = (hi0 + 1) % H;
  const hFrac = H > 1 ? hf - Math.floor(hf) : 0;
  const sClamped = Math.min(Math.max(sat, 0), 1);
  const sf = S > 1 ? sClamped * (S - 1) : 0;
  const si0 = S > 1 ? Math.min(S - 2, Math.floor(sf)) : 0;
  const si1 = S > 1 ? si0 + 1 : 0;
  const sFrac = S > 1 ? sf - si0 : 0;
  const vClamped = Math.min(Math.max(vCoord, 0), 1);
  const vf = V > 1 ? vClamped * (V - 1) : 0;
  const vi0 = V > 1 ? Math.min(V - 2, Math.floor(vf)) : 0;
  const vi1 = V > 1 ? vi0 + 1 : 0;
  const vFrac = V > 1 ? vf - vi0 : 0;
  const at = (hi, si, vi) => {
    const idx = ((hi * S + si) * V + vi) * 3;
    return [table.data[idx], table.data[idx + 1], table.data[idx + 2]];
  };
  let dh = 0,
    ds = 0,
    dv = 0;
  for (let a = 0; a < 2; a++) {
    const hi = a === 0 ? hi0 : hi1;
    const wh = a === 0 ? 1 - hFrac : hFrac;
    if (wh === 0) continue;
    for (let b = 0; b < 2; b++) {
      const si = b === 0 ? si0 : si1;
      const ws = b === 0 ? 1 - sFrac : sFrac;
      if (ws === 0) continue;
      for (let c = 0; c < 2; c++) {
        const vi = c === 0 ? vi0 : vi1;
        const wv = c === 0 ? 1 - vFrac : vFrac;
        if (wv === 0) continue;
        const w = wh * ws * wv;
        const [th, ts, tv] = at(hi, si, vi);
        dh += w * th;
        ds += w * ts;
        dv += w * tv;
      }
    }
  }
  return [dh, ds, dv];
}
function valueLookupCoordRef(v, encoding) {
  const c = Math.min(Math.max(v, 0), 1);
  return encoding === 'sRGB' ? srgbEncodeRef(c) : c;
}
function evalCurveRef(points, x) {
  const first = points[0];
  const last = points[points.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i];
    if (x <= p1[0]) {
      const p0 = points[i - 1];
      const f = (x - p0[0]) / (p1[0] - p0[0]);
      return p0[1] + (p1[1] - p0[1]) * f;
    }
  }
  return last[1];
}
function referenceRenderDcpPixel(d, workingRgb, cameraFromWorking, asShotTempK) {
  const cct1 = 2856; // StdA — the fixture's own CalibrationIlluminant1
  const cct2 = 6504; // D65 — CalibrationIlluminant2
  const mired1 = 1e6 / cct1;
  const mired2 = 1e6 / cct2;
  const miredShot = 1e6 / asShotTempK;
  const fraction = Math.min(1, Math.max(0, (miredShot - mired1) / (mired2 - mired1)));
  const lerp = (a, b, t) => a + (b - a) * t;
  const fm1 = d.forwardMatrix1;
  const fm2 = d.forwardMatrix2 ?? fm1;
  const fmFlat = fm1.map((v, i) => lerp(v, fm2[i], fraction));
  const camToXyz = [
    [fmFlat[0], fmFlat[1], fmFlat[2]],
    [fmFlat[3], fmFlat[4], fmFlat[5]],
    [fmFlat[6], fmFlat[7], fmFlat[8]],
  ];
  // camera-native reconstruction is now a single precomposed matrix — see
  // pipeline.ts's cameraNativeFromWorking (this golden-math check passes
  // IDENTITY below, same no-op trick as before, just one step instead of two).
  const cameraRgb = mulMV(cameraFromWorking, workingRgb);
  const xyzD50 = mulMV(camToXyz, cameraRgb);
  const prophotoLin = mulMV(XYZ_D50_TO_PROPHOTO_REF, xyzD50);
  let [h, s, v] = rgbToHsvRef(prophotoLin);
  if (d.hueSatMap1) {
    let table = d.hueSatMap1;
    if (d.hueSatMap2) {
      const a = d.hueSatMap1;
      const b = d.hueSatMap2;
      const data = new Float32Array(a.data.length);
      for (let i = 0; i < data.length; i++) data[i] = lerp(a.data[i], b.data[i], fraction);
      table = { dims: a.dims, data };
    }
    const vCoord = valueLookupCoordRef(v, d.hueSatMapEncoding);
    const [dh, sScale, vScale] = lookupTableRef(table, h, s, vCoord);
    h = ((h + dh) % 360 + 360) % 360;
    s = Math.min(Math.max(s * sScale, 0), 1);
    v = v * vScale;
  }
  if (d.lookTable) {
    const vCoord = valueLookupCoordRef(v, d.lookTableEncoding);
    const [dh, sScale, vScale] = lookupTableRef(d.lookTable, h, s, vCoord);
    h = ((h + dh) % 360 + 360) % 360;
    s = Math.min(Math.max(s * sScale, 0), 1);
    v = v * vScale;
  }
  let rgbAdjusted = hsvToRgbRef([h, s, v]);
  if (d.toneCurve) {
    rgbAdjusted = rgbAdjusted.map((c) => srgbDecodeRef(evalCurveRef(d.toneCurve.points, srgbEncodeRef(Math.min(Math.max(c, 0), 1)))));
  }
  const xyzD50Out = mulMV(PROPHOTO_TO_XYZ_D50_REF, rgbAdjusted);
  const xyzD65Out = mulMV(BRADFORD_D50_TO_D65_REF, xyzD50Out);
  const workingOut = mulMV(XYZ_D65_TO_REC2020_REF, xyzD65Out);
  const gain = Math.pow(2, d.baselineExposureOffset);
  return workingOut.map((c) => c * gain);
}

// The test input: cameraFromWorking = IDENTITY makes cameraNativeFromWorking a
// pure pass-through (cameraRgb === workingRgb to float precision) — this
// sidesteps needing a plausible synthetic camera matrix while still exercising
// the real reconstruction code path (a plain mat×vec through production code),
// not skipping it. The reconstruction MATH itself (rgb_cam inversion) is
// checked independently in section 2b below.
const TEST_WORKING_RGB = [0.6, 0.35, 0.2];
const golden = referenceRenderDcpPixel(parsed, TEST_WORKING_RGB, IDENTITY_MAT3, HALFWAY_TEMP_K);
const actual = renderDcpPixel(parsed, TEST_WORKING_RGB, IDENTITY_MAT3, HALFWAY_TEMP_K);
const maxAbsDiff = Math.max(...golden.map((v, i) => Math.abs(v - actual[i])));
check('renderDcpPixel matches the independent reference within 1e-6', maxAbsDiff < 1e-6, { golden, actual, maxAbsDiff });
check('the DCP pipeline actually moves the pixel (not an accidental identity)', maxAbsDiff >= 0 && Math.max(...actual.map((v, i) => Math.abs(v - TEST_WORKING_RGB[i]))) > 0.05, {
  actual,
  input: TEST_WORKING_RGB,
});

// === 2b. camera-native reconstruction (Stage 2 exactness) ===================
console.log('\nverify-dcp (Stage 2: exact rgb_cam-based camera-native reconstruction):');

// A synthetic, well-conditioned "rgb_cam" (camera(WB'd)-native -> sRGB D65) —
// OUR own numbers (no Adobe content), just needs to be invertible and not the
// identity, so the round trip genuinely exercises matrix inversion + compose.
const SYNTH_RGB_CAM = [
  [1.62, -0.48, -0.06],
  [-0.1, 1.4, -0.18],
  [0.02, -0.32, 1.62],
];
// sRGB(linear D65) -> Rec.2020(linear D65) — engine/color/workingSpace.ts's
// SRGB_TO_WORK, transcribed here (this script bundles engine/color/dcp/ only,
// not workingSpace.ts) purely to CONSTRUCT the forward simulation below (what
// libraw + our decoder would have produced); the inversion under test is 100%
// production code (exactCameraFromWorkingMatrix), so this transcription isn't
// part of what's being verified, only of the fixture setup.
const SRGB_TO_WORK_REF = [
  [0.627409, 0.32926, 0.043272],
  [0.069125, 0.919549, 0.011321],
  [0.016423, 0.088048, 0.895617],
];
const SYNTH_CAMERA_RGB = [0.42, 0.55, 0.3]; // a plausible camera-native, as-shot-WB'd triplet
// Simulate exactly what libraw's convert_to_rgb() + our decoder would hand
// back: workingRgb = SRGB_TO_WORK · rgb_cam · cameraRgb (pipeline.ts's own
// doc comment derives this composition from LibRaw's cam_xyz_coeff).
const simulatedWorkingRgb = mulMV(SRGB_TO_WORK_REF, mulMV(SYNTH_RGB_CAM, SYNTH_CAMERA_RGB));
const exactMatrix = exactCameraFromWorkingMatrix(SYNTH_RGB_CAM);
const recoveredCameraRgb = mulMV(exactMatrix, simulatedWorkingRgb);
const reconstructDiff = Math.max(...recoveredCameraRgb.map((v, i) => Math.abs(v - SYNTH_CAMERA_RGB[i])));
// Tolerance set by SRGB_TO_WORK_REF's own stored precision (6 decimal places),
// not by the reconstruction math (a plain double-precision matrix inverse) —
// still 100x tighter than the engine's 1/255 GPU-vs-CPU parity gate.
check(
  'a known camera-native RGB pushed through a known rgb_cam round-trips exactly via exactCameraFromWorkingMatrix',
  reconstructDiff < 1e-5,
  { recoveredCameraRgb, expected: SYNTH_CAMERA_RGB, reconstructDiff }
);

// Fallback path (no rgb_cam — e.g. JPEG, or an older decoder build): the
// approx route must still be the documented Stage-1 formula, and the picker
// must select exact/approx correctly by rgbCam's presence.
const SYNTH_CAM_XYZ = [
  [0.9, -0.2, 0.05],
  [-0.15, 1.1, 0.03],
  [0.02, -0.25, 1.05],
];
const approxMatrix = approxCameraFromWorkingMatrix(SYNTH_CAM_XYZ);
const approxRef = mulMat3Mat3(SYNTH_CAM_XYZ, REC2020_TO_XYZ_D65);
const approxDiff = Math.max(...approxMatrix.flat().map((v, i) => Math.abs(v - approxRef.flat()[i])));
check('approxCameraFromWorkingMatrix matches camXyz · REC2020_TO_XYZ_D65 (the documented Stage-1 formula)', approxDiff < 1e-12, {
  approxMatrix,
  approxRef,
  approxDiff,
});

const pickedExact = cameraFromWorkingMatrix(SYNTH_RGB_CAM, SYNTH_CAM_XYZ);
const pickedExactDiff = Math.max(...pickedExact.flat().map((v, i) => Math.abs(v - exactMatrix.flat()[i])));
check('cameraFromWorkingMatrix picks the exact route when rgbCam is present', pickedExactDiff < 1e-12, { pickedExactDiff });

const pickedApprox = cameraFromWorkingMatrix(null, SYNTH_CAM_XYZ);
const pickedApproxDiff = Math.max(...pickedApprox.flat().map((v, i) => Math.abs(v - approxMatrix.flat()[i])));
check('cameraFromWorkingMatrix falls back to the approx route when rgbCam is null', pickedApproxDiff < 1e-12, { pickedApproxDiff });

// === 3. malformed-file error paths ==========================================
console.log('\nverify-dcp (malformed-file error paths):');
const asAb = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
try {
  parseDcp(asAb(buildPlainTiffBytes()), 'photo.dng');
  check('a plain TIFF/DNG throws DcpParseError', false, 'did not throw');
} catch (err) {
  check('a plain TIFF/DNG throws DcpParseError with an actionable message', err instanceof DcpParseError && /plain TIFF\/DNG, not a DCP/.test(err.message), String(err));
}
try {
  parseDcp(asAb(buildTruncatedDcpBytes()), 'broken.dcp');
  check('a truncated DCP throws DcpParseError', false, 'did not throw');
} catch (err) {
  check('a truncated DCP throws DcpParseError', err instanceof DcpParseError, String(err));
}
try {
  const bad = Buffer.from([0x58, 0x58, 0x52, 0x43, 0, 0, 0, 0]);
  parseDcp(asAb(bad), 'garbage.bin');
  check('a bad byte-order mark throws DcpParseError', false, 'did not throw');
} catch (err) {
  check('a bad byte-order mark throws DcpParseError', err instanceof DcpParseError, String(err));
}
try {
  parseDcp(asAb(Buffer.alloc(2)), 'tiny.bin');
  check('a too-small buffer throws DcpParseError', false, 'did not throw');
} catch (err) {
  check('a too-small buffer throws DcpParseError', err instanceof DcpParseError, String(err));
}

// === 4. CLI render: dcp mode vs builtin vs bypass ===========================
console.log('\nverify-dcp (CLI render: dcp differs from builtin/bypass; amount 0 = bypass):');

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-dcp-cli-'));
const outDir = join(workDir, 'out');
mkdirSync(outDir, { recursive: true });
const fixturePath = join(workDir, 'silverbox-test.dcp');
writeFileSync(fixturePath, buildFixtureDcp());
const arwPath = join(workDir, 'DSC-DCP.ARW');
linkSync(SRC_ARW, arwPath);
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-dcp-userdata-'));
// The visible library (docs/brief-bank/linked-looks-stage-e.md) — see
// verify-cli.mjs's own identical comment: an isolated libraryDir keeps a
// standalone run off the real ~/Silverbox/Library.
if (ownUserData) seedLibraryDir(userDataDir);

const nowIso = () => new Date().toISOString();
function simpleLook(develop) {
  return {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 } },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, ...(develop ? { develop } : {}) },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
}
function writeVariantSidecar(name, develop) {
  const path = join(workDir, `${name}.ARW`);
  linkSync(SRC_ARW, path);
  const { nodes, edges } = simpleLook(develop);
  writeFileSync(path + '.silverbox.json', JSON.stringify({ schemaVersion: 4, createdAt: nowIso(), graph: { nodes, edges } }, null, 2) + '\n');
  return path;
}

const bypassPath = writeVariantSidecar('bypass', undefined); // no `develop` key at all = identity
const dcpAmount100Path = writeVariantSidecar('dcp100', { profile: { amount: 100, source: 'dcp', dcpPath: fixturePath } });
const dcpAmount0Path = writeVariantSidecar('dcp0', { profile: { amount: 0, source: 'dcp', dcpPath: fixturePath } });
const builtinAmount100Path = writeVariantSidecar('builtin100', { profile: { amount: 100, source: 'builtin' } });

const electronBin = join(projectRoot, 'node_modules', '.bin', 'electron');
function runCli(inputs) {
  return spawnSync(electronBin, [projectRoot, '--render', '--out', outDir, ...inputs], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 180_000,
  });
}
const render = runCli([bypassPath, dcpAmount100Path, dcpAmount0Path, builtinAmount100Path]);
check('CLI render exits 0', render.status === 0, { status: render.status, stderr: render.stderr });

async function rawBytesOf(path) {
  return sharp(path).raw().toBuffer();
}
async function meanAbsDiff(pathA, pathB) {
  const [a, b] = await Promise.all([rawBytesOf(pathA), rawBytesOf(pathB)]);
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

if (render.status === 0) {
  const bypassOut = join(outDir, 'bypass.jpg');
  const dcp100Out = join(outDir, 'dcp100.jpg');
  const dcp0Out = join(outDir, 'dcp0.jpg');
  const builtin100Out = join(outDir, 'builtin100.jpg');
  const allExist = [bypassOut, dcp100Out, dcp0Out, builtin100Out].every(existsSync);
  check('every expected output file exists', allExist, { bypassOut, dcp100Out, dcp0Out, builtin100Out });
  if (allExist) {
    const dBypassVsDcp0 = await meanAbsDiff(bypassOut, dcp0Out);
    check('amount 0 (dcp source) is a bit-exact no-op — identical to bypass', dBypassVsDcp0 === 0, dBypassVsDcp0);

    const dBypassVsDcp100 = await meanAbsDiff(bypassOut, dcp100Out);
    check('amount 100 (dcp source) differs measurably from bypass', dBypassVsDcp100 > 0.002, dBypassVsDcp100);

    const dDcp100VsBuiltin100 = await meanAbsDiff(dcp100Out, builtin100Out);
    check(
      'dcp mode at amount 100 differs from builtin mode at amount 100 (genuinely different transforms, not a fallback)',
      dDcp100VsBuiltin100 > 0.002,
      dDcp100VsBuiltin100
    );
  }
}

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
