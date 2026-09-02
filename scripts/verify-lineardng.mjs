/**
 * Self-verification for the Linear DNG writer (scripts/gen-linear-dng.mjs)
 * behind docs/research/local-adaptive-tone.md §5.0's synthetic test-image
 * harness: generates a few known patterns (uniform gray, a linear gradient,
 * a hard step edge), decodes each through silverbox's OWN libraw-wasm decode
 * path (the same path the app uses on a real RAW), and asserts the decoded
 * linear values match the values the generator wrote, within a measured
 * tolerance.
 *
 * STANDALONE — deliberately NOT registered as `verify:lineardng` in
 * package.json / the verify chain yet (per the brief: this is step ① of a
 * multi-step program, run by hand until the LR side of the harness is also
 * validated).
 *
 * What has to be neutralized to get a clean pass-through read (see this
 * script's own comments at each step for the file:line evidence):
 *  1. `settings.baselineExposureEV` (shared/ipc.ts DEFAULT_SETTINGS, default
 *     0.5 EV) is applied UNCONDITIONALLY at decode time
 *     (decodeWorker.ts's linearizeRgb16/baselineExposureGain), before the
 *     develop graph even exists — camera-agnostic, always on. Set to 0 via
 *     `window.__debug.updateSettings` BEFORE the first open (settings apply
 *     on the NEXT decode, same as verify-autotone.mjs's own note).
 *  2. The Develop node's default-look seeding (camera-matched base curve /
 *     builtin profile / RAW sharpen+color-NR — appStore.ts's fresh-RAW-open
 *     block) is ALREADY suppressed under `SILVERBOX_TEST=1` unless a script
 *     opts back in via testFlags (baseCurveDefault/forceDefaults/
 *     lensProfileAutoDefault) — this script does NOT opt in, so the Develop
 *     node stays at its untouched, bit-exact-identity defaults (ev=0,
 *     toneCurve=identity, profile.amount=0, sharpen/noiseColor.amount=0).
 *  3. White balance is identity regardless of the DNG's AsShotNeutral/cam_mul
 *     (default temp/tint always resolve to the as-shot gain, [1,1,1]) — no
 *     action needed.
 *  4. Lens-profile correction stays disabled (no `image.profile` — that's a
 *     Sony-specific embedded-spline field libraw only parses from real Sony
 *     ARWs) — no action needed.
 *
 * What's NOT neutralized (measured instead): libraw's own camera→XYZ→
 * working-space color conversion, driven by our DNG's ColorMatrix1/
 * CalibrationIlluminant1/AsShotNeutral tags (see gen-linear-dng.mjs's header
 * comment for why those are set to XYZ_to_sRGB(D65), not identity). Every
 * test image here is achromatic (R=G=B), so this conversion's residual
 * error shows up as a per-channel gray-preservation error (R,G,B diverging
 * after decode) — measured below and confirmed exact (< 0.005 absolute,
 * every case).
 *
 * ★ A REAL, MEASURED decode-path transform this script found and had to
 * account for (not assumed going in — see the PR/session report for the
 * derivation): decodeWorker.ts's `linearizeRgb16` inverts libraw's 16-bit
 * output with the exact sRGB EOTF (its own doc comment: "Interleaved RGB u16
 * (gamma) → linear RGBA f32 ... inverted by the exact sRGB [decode]"), on
 * the assumption libraw's `outputColor:8` 16-bit output is sRGB-gamma-
 * encoded. For THIS Linear DNG (PhotometricInterpretation=34892) input,
 * libraw's actual 16-bit output curve measures as the classic Rec.709 OETF
 * (`1.099·v^0.45 − 0.099`, toe `4.5·v` below 0.018 — dcraw/libraw's
 * historical DEFAULT gamma curve, gamm=[0.45,4.5,…]), not sRGB's
 * (2.4/1.055/12.92/0.055) curve — a genuine mismatch between what libraw
 * emits and what decodeWorker assumes, for THIS code path. Composing the two
 * (`srgbDecode(rec709Encode(v))`, see `expectedDecoded` below) predicts every
 * measured value here to within ~0.002 (see the two uniform patches, whose
 * readbackLinearMean() precision — rgba16float, no 8-bit quantization —
 * pins it to ~0.0001). Whether real (Bayer CFA) ARW decodes hit the SAME
 * libraw code path (and thus the same mismatch, just unnoticed because a
 * real photo has no perfectly flat region to reveal it, or masked by the
 * seeded base-curve/profile this script deliberately suppresses) or a
 * DIFFERENT one is genuinely unknown from this script alone — flagged in
 * the session report as the single most fragile/highest-value-to-follow-up
 * finding here, NOT something this script (or gen-linear-dng.mjs) attempts
 * to fix. Every value-matching assertion below therefore checks against
 * `expectedDecoded(generatedValue)`, not the raw generated value.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { writeLinearDng } from './gen-linear-dng.mjs';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
ensureTestProjectEnv();

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

// Standard IEC 61966-2-1 sRGB EOTF (verify-side math only, to interpret
// encodedCropForVerify's 0-255 bytes — mirrors fit-base-curve.mjs's own
// srgbDecode, NOT a copy of the app's engine/color/srgb.ts, which this
// script never touches).
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
// Classic Rec.709 OETF (dcraw/libraw's historical default output gamma,
// gamm=[0.45,4.5,…]) — the measured shape of libraw's actual 16-bit output
// curve for this Linear DNG input (see this file's header comment).
const rec709Encode = (v) => (v < 0.018 ? 4.5 * v : 1.099 * Math.pow(v, 0.45) - 0.099);
// What decodeWorker.ts's srgbDecode-based linearize step recovers when fed
// libraw's actual (Rec.709-shaped, not sRGB-shaped) output — the measured
// decode-path transform every check below compares against.
const expectedDecoded = (v) => srgbDecode(rec709Encode(v));

// --- generate the known-pattern fixtures -----------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-lineardng-'));

const UNIFORM_SIZE = 256;
const uniform18 = join(workDir, 'uniform18.dng');
const uniform50 = join(workDir, 'uniform50.dng');
writeLinearDng(uniform18, { width: UNIFORM_SIZE, height: UNIFORM_SIZE, generator: () => 0.18 });
writeLinearDng(uniform50, { width: UNIFORM_SIZE, height: UNIFORM_SIZE, generator: () => 0.5 });

const GRADIENT_W = 512;
const GRADIENT_H = 64;
const gradient = join(workDir, 'gradient.dng');
writeLinearDng(gradient, { width: GRADIENT_W, height: GRADIENT_H, generator: (x) => x / (GRADIENT_W - 1) });
const GRADIENT_SAMPLE_XS = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(f * (GRADIENT_W - 1)));

const EDGE_W = 512;
const EDGE_H = 512;
const EDGE_X = EDGE_W / 2;
const EDGE_DARK = 0.1;
const EDGE_LIGHT = 0.4;
const stepEdge = join(workDir, 'stepedge.dng');
writeLinearDng(stepEdge, { width: EDGE_W, height: EDGE_H, generator: (x) => (x < EDGE_X ? EDGE_DARK : EDGE_LIGHT) });

// --- launch the app ----------------------------------------------------
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-lineardng-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReadyOrError = () =>
    page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 60_000 }
    );
  const openImageAndWait = async (path) => {
    // fire-and-forget: never await __openImageByPath itself (its execution
    // context can be torn down mid-decode — ms2's own caution, followed by
    // every verify script in this repo).
    await page.evaluate((p) => void window.__openImageByPath(p), path);
    await waitReadyOrError();
  };
  const imageState = () => page.evaluate(() => window.__debug.imageState());
  const readbackLinearMean = () => page.evaluate(() => window.__debug.readbackLinearMean());
  const readbackMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuReferenceMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const encodedCrop = (x0, y0, w, h) => page.evaluate(([x0, y0, w, h]) => window.__debug.encodedCropForVerify(x0, y0, w, h), [x0, y0, w, h]);
  const encodedCropLinearMean = async (x0, y0, w, h) => {
    const px = await encodedCrop(x0, y0, w, h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += srgbDecode(px[i] / 255);
      g += srgbDecode(px[i + 1] / 255);
      b += srgbDecode(px[i + 2] / 255);
      n++;
    }
    return { r: r / n, g: g / n, b: b / n };
  };

  // --- neutralize baselineExposureEV before ANY decode --------------------
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  const defaultEV = await page.evaluate(() => window.__debug.settingsState().baselineExposureEV);
  await page.evaluate(() => window.__debug.updateSettings({ baselineExposureEV: 0 }));
  const evAfterReset = await page.evaluate(() => window.__debug.settingsState().baselineExposureEV);
  check('baselineExposureEV neutralized to 0 before first open', evAfterReset === 0, { defaultEV, evAfterReset });

  const devOf = (graph) => graph.nodes.find((n) => n.id === 'dev').develop;

  // =========================================================================
  console.log('verify-lineardng (1. uniform 18%/50% gray — dims/orientation, identity Develop chain, gray-preservation, measured round-trip gain):');

  await openImageAndWait(uniform18);
  const state18 = await imageState();
  check('uniform18: dims survive (fullWidth/fullHeight match the written DNG)', state18.fullWidth === UNIFORM_SIZE && state18.fullHeight === UNIFORM_SIZE, state18);
  check('uniform18: no rotation/orientation surprise (flip=0)', state18.flip === 0, state18);

  const dev18 = devOf(await graphState());
  check(
    'fresh open under SILVERBOX_TEST: Develop node is untouched (basic-tone all zero, profile/sharpen/noiseColor amount 0)',
    dev18.basic.ev === 0 && dev18.basic.contrast === 0 && dev18.profile.amount === 0 && dev18.detail.sharpen.amount === 0 && dev18.detail.noiseColor.amount === 0,
    dev18
  );

  const lin18 = await readbackLinearMean();
  const gpu18 = await readbackMean();
  const cpu18 = await cpuReferenceMean();
  check('GPU encoded mean matches CPU reference within 1/255 (identity chain, sanity check)', cpu18 !== null && Math.abs(gpu18.r - cpu18.r) < 1 / 255 && Math.abs(gpu18.g - cpu18.g) < 1 / 255 && Math.abs(gpu18.b - cpu18.b) < 1 / 255, {
    gpu18,
    cpu18,
  });

  const expected18 = expectedDecoded(0.18);
  check(
    `uniform18: decoded linear mean matches expectedDecoded(0.18)=${expected18.toFixed(5)} within 0.002 (rgba16float precision — this is the tightest check in the file, and pins the measured decode-path transform)`,
    Math.abs(lin18.r - expected18) < 0.002,
    { generated: 0.18, decoded: lin18, expected: expected18 }
  );
  check('uniform18: R/G/B stay equal after decode (achromatic in -> achromatic out, no color cast from ColorMatrix1)', Math.abs(lin18.r - lin18.g) < 0.005 && Math.abs(lin18.r - lin18.b) < 0.005, lin18);

  await openImageAndWait(uniform50);
  const lin50 = await readbackLinearMean();
  const expected50 = expectedDecoded(0.5);
  check(`uniform50: decoded linear mean matches expectedDecoded(0.5)=${expected50.toFixed(5)} within 0.002`, Math.abs(lin50.r - expected50) < 0.002, { generated: 0.5, decoded: lin50, expected: expected50 });
  check('uniform50: R/G/B stay equal after decode', Math.abs(lin50.r - lin50.g) < 0.005 && Math.abs(lin50.r - lin50.b) < 0.005, lin50);

  // =========================================================================
  console.log('verify-lineardng (2. linear gradient — shape survives across 5 sample columns):');

  await openImageAndWait(gradient);
  const stateGrad = await imageState();
  check('gradient: dims survive', stateGrad.fullWidth === GRADIENT_W && stateGrad.fullHeight === GRADIENT_H, stateGrad);

  const SAMPLE_W = 4;
  const SAMPLE_H = 16;
  const gradResults = [];
  for (const x of GRADIENT_SAMPLE_XS) {
    const x0 = Math.max(0, Math.min(GRADIENT_W - SAMPLE_W, x - SAMPLE_W / 2));
    const y0 = (GRADIENT_H - SAMPLE_H) / 2;
    const decodedLinear = await encodedCropLinearMean(x0, y0, SAMPLE_W, SAMPLE_H);
    const generatedValue = x / (GRADIENT_W - 1);
    const expected = expectedDecoded(generatedValue);
    gradResults.push({ x, generatedValue, expected, decodedLinear });
    check(`gradient column x=${x}: decoded value ≈ expectedDecoded(${generatedValue.toFixed(3)})=${expected.toFixed(3)} (±0.01 absolute, 8-bit-quantized regional readback)`, Math.abs(decodedLinear.r - expected) < 0.01, {
      generatedValue,
      expected,
      decodedLinear,
    });
  }
  const monotonic = gradResults.every((r, i) => i === 0 || r.decodedLinear.r >= gradResults[i - 1].decodedLinear.r - 0.005);
  check('gradient: decoded values are monotonically increasing across the 5 sample columns', monotonic, gradResults.map((r) => r.decodedLinear.r));

  // =========================================================================
  console.log('verify-lineardng (3. hard step edge — dark/light plateaus match, no halo/overshoot from an identity chain):');

  await openImageAndWait(stepEdge);
  const stateEdge = await imageState();
  check('stepedge: dims survive', stateEdge.fullWidth === EDGE_W && stateEdge.fullHeight === EDGE_H, stateEdge);

  const REGION_W = 128;
  const REGION_H = 128;
  const y0 = (EDGE_H - REGION_H) / 2;
  const expectedDark = expectedDecoded(EDGE_DARK);
  const expectedLight = expectedDecoded(EDGE_LIGHT);
  const darkRegion = await encodedCropLinearMean(32, y0, REGION_W, REGION_H); // well inside the dark (left) side
  const lightRegion = await encodedCropLinearMean(EDGE_W - REGION_W - 32, y0, REGION_W, REGION_H); // well inside the light (right) side
  check(`stepedge: dark-side region ≈ expectedDecoded(${EDGE_DARK})=${expectedDark.toFixed(3)} (±0.01)`, Math.abs(darkRegion.r - expectedDark) < 0.01, { expected: expectedDark, decoded: darkRegion });
  check(`stepedge: light-side region ≈ expectedDecoded(${EDGE_LIGHT})=${expectedLight.toFixed(3)} (±0.01)`, Math.abs(lightRegion.r - expectedLight) < 0.01, { expected: expectedLight, decoded: lightRegion });
  // An identity Develop chain (no spatial ops active) cannot introduce halo —
  // this is really re-confirming the neutralization above, not testing LLF
  // behavior (there is none yet). A narrow strip straddling the edge should
  // land near the two plateaus' midpoint, never overshoot past either one.
  const straddle = await encodedCropLinearMean(EDGE_X - 8, y0, 16, REGION_H);
  check('stepedge: a strip straddling the edge stays between the two plateaus (no overshoot — proves the identity chain introduces no halo of its own)', straddle.r >= expectedDark - 0.01 && straddle.r <= expectedLight + 0.01, {
    straddle,
    expectedDark,
    expectedLight,
  });

  console.log('');
  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
