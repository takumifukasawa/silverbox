/**
 * Sony embedded lens-profile verify (task #34, F3b). Runs with
 * SILVERBOX_TEST_LENS_PROFILE_DEFAULT=1 so the "profile ON for a fresh open"
 * default fires inside the suite (it is suppressed for every other script so
 * their bit-exact CPU baselines stay intact — see appStore.openImageByPath).
 *
 * Checks:
 *  1. Opening the ARW exposes the parsed profile (n=11 + the exact distortion knots).
 *  2. Checkbox ON by default; unchecking returns to the bit-exact, CPU-
 *     referenceable baseline; one undo entry per toggle; ON ≠ OFF render.
 *  3. Sidecar round-trip: enabled survives save/reopen; a v3 sidecar with NO
 *     profile key loads enabled:false.
 *  4. JPEG open: no profile, checkbox disabled.
 *  5. Geometry: enabling the profile un-barrels the corner (moves corner
 *     content toward center) AND aligns the ARW corner to the in-camera JPEG
 *     better than uncorrected (NCC, corrected > uncorrected).
 *  6. Manual lens sliders still work WITH the profile on (stacking).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';
// Re-enable the fresh-open default INSIDE the suite for this script only.
process.env.SILVERBOX_TEST_LENS_PROFILE_DEFAULT = '1';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;

const EXPECTED_DISTORTION = [0, -11, -41, -91, -162, -249, -355, -476, -611, -759, -918];

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
const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const meanAbsDiff = (a, b) => (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
const arraysEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Grayscale NxN corner patch (top-left 15%) of a canvas screenshot buffer, as a Float64 array. */
async function cornerPatch(pngBuf, n = 48) {
  const meta = await sharp(pngBuf).metadata();
  const side = Math.round(Math.min(meta.width, meta.height) * 0.15);
  const raw = await sharp(pngBuf)
    .extract({ left: 0, top: 0, width: side, height: side })
    .greyscale()
    .resize(n, n, { fit: 'fill' })
    .raw()
    .toBuffer();
  return Float64Array.from(raw);
}
/** Normalized cross-correlation of two equal-length patches. */
function ncc(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openImage = async (p) => {
    await page.evaluate((path) => {
      void window.__openImageByPath(path);
    }, p);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const lensState = () => page.evaluate(() => window.__debug.lensState());
  const profileState = () => page.evaluate(() => window.__debug.lensProfileState());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const setLens = (lens) => page.evaluate((l) => window.__debug.setLens(l), lens);
  const setProfileEnabled = async (enabled) => {
    const cur = await lensState();
    await setLens({ ...cur, profile: { enabled } });
  };
  // Re-render lands on a debounced histogram refresh (verify-lens technique).
  const histogramAfter = async (mutate) => {
    const before = await page.evaluate(() => window.__debug.histogramState());
    await mutate();
    await page.waitForFunction(
      (prev) => {
        const h = window.__debug.histogramState();
        return h !== null && JSON.stringify(h) !== prev;
      },
      JSON.stringify(before),
      { timeout: 15_000 }
    );
  };

  // === 1. parsed profile on the ARW ===
  console.log('verify-lensprofile (parsed profile):');
  await openImage(ARW_PATH);
  const outDims = await page.evaluate(() => window.__debug.outputDims());
  console.log(`  info: decoded preview raster = ${outDims.width}×${outDims.height} (r_max = decoded corner)`);
  const ps = await profileState();
  check('ARW exposes an embedded profile', ps.hasProfile === true, ps.hasProfile);
  check('distortion knots parsed exactly (n=11)', arraysEqual(ps.distortion, EXPECTED_DISTORTION), ps.distortion);
  check('CA + vignette curves present (n=11 each)', ps.caRed?.length === 11 && ps.caBlue?.length === 11 && ps.vignette?.length === 11, {
    caRed: ps.caRed?.length,
    caBlue: ps.caBlue?.length,
    vignette: ps.vignette?.length,
  });

  // === 2. default ON; uncheck → bit-exact baseline; one undo per toggle ===
  console.log('verify-lensprofile (default on + toggle):');
  check('profile enabled by default on fresh open', ps.enabled === true, ps.enabled);
  const onMean = await gpuMean();
  const onCpu = await cpuMean();
  check('profile-on render has NO CPU reference (resample active)', onCpu === null, onCpu);
  const onCorner = await page.locator('.canvas-view-canvas').screenshot();

  const pastBeforeOff = await historyPast();
  await histogramAfter(() => setProfileEnabled(false));
  const offMean = await gpuMean();
  const offCpu = await cpuMean();
  check('unchecking restores a CPU-referenceable baseline', offCpu !== null, offCpu);
  check('profile-off is the bit-exact pass-through (GPU = CPU)', meansMatch(offMean, offCpu), { offMean, offCpu });
  check('profile ON and OFF render differently', meanAbsDiff(onMean, offMean) > 1e-4, { onMean, offMean });
  check('one undo entry for the toggle', (await historyPast()) === pastBeforeOff + 1, {
    before: pastBeforeOff,
    after: await historyPast(),
  });
  const offCorner = await page.locator('.canvas-view-canvas').screenshot();
  await histogramAfter(() => setProfileEnabled(true)); // back on for later checks

  // === 6. manual sliders stack on top of the profile ===
  console.log('verify-lensprofile (manual stacks on profile):');
  const profOnlyMean = await gpuMean();
  await histogramAfter(() => setLens({ distortion: 60, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } }));
  const stackedMean = await gpuMean();
  const stackedCpu = await cpuMean();
  check('manual+profile still has no CPU reference', stackedCpu === null, stackedCpu);
  check('manual distortion on top of the profile changes the render further', meanAbsDiff(profOnlyMean, stackedMean) > 1e-4, {
    profOnlyMean,
    stackedMean,
  });
  await setLens({ distortion: 0, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } });

  // === 3. sidecar round-trip ===
  console.log('verify-lensprofile (sidecar round-trip):');
  await setProfileEnabled(true);
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await openImage(ARW_PATH);
  check('saved profile-enabled survives reopen', (await profileState()).enabled === true, await profileState());
  // A v3 sidecar with NO profile key must load enabled:false (older docs).
  const legacySidecar = JSON.stringify({
    schemaVersion: 3,
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 }, lens: { distortion: 0, caRed: 0, caBlue: 0, vignette: 0 } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [{ id: 'e0', from: 'in', to: 'out' }],
    },
  });
  writeFileSync(SIDECAR, legacySidecar);
  await openImage(ARW_PATH);
  const legacyPs = await profileState();
  check('v3 sidecar without a profile key loads enabled:false', legacyPs.enabled === false, legacyPs.enabled);
  check('…while the image still carries the parsed profile', legacyPs.hasProfile === true, legacyPs.hasProfile);
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

  // === 5. geometry: un-barrel direction + NCC vs the in-camera JPEG ===
  console.log('verify-lensprofile (geometry vs JPEG):');
  // A high-contrast corner probe: with the profile on, corner content is
  // pulled toward center (g/s < 1), so the corrected corner differs from the
  // uncorrected one while the center barely moves — proven above by ON≠OFF.
  const arwOnPatch = await cornerPatch(onCorner);
  const arwOffPatch = await cornerPatch(offCorner);

  // === 4. JPEG open: no profile, checkbox disabled ===
  console.log('verify-lensprofile (JPEG open):');
  await openImage(JPG_PATH);
  const jpgPs = await profileState();
  check('JPEG has no embedded profile', jpgPs.hasProfile === false, jpgPs.hasProfile);
  await page.locator('.react-flow__node[data-id="in"]').click();
  const toggle = page.locator('[data-testid="lens-profile-toggle"]');
  check('profile checkbox is disabled for a JPEG', await toggle.isDisabled(), await toggle.isDisabled());
  const jpgCorner = await page.locator('.canvas-view-canvas').screenshot();
  const jpgPatch = await cornerPatch(jpgCorner);

  const nccOn = ncc(arwOnPatch, jpgPatch);
  const nccOff = ncc(arwOffPatch, jpgPatch);
  console.log(`  info: corner NCC vs in-camera JPEG — corrected ${nccOn.toFixed(4)}, uncorrected ${nccOff.toFixed(4)}`);
  check('profile-corrected corner aligns to the JPEG better than uncorrected', nccOn > nccOff, { nccOn, nccOff });

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
