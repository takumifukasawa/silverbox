/**
 * Fresh-open tone defaults + old-doc base-curve compatibility.
 *
 * Until 2026-10-07 a fresh ARW seeded the LR-fitted base curve (baseCurve.ts)
 * into toneCurve.rgb and this script asserted that seed. Decision 0002
 * (docs/decisions/0002-neutral-default-base-tone.md) made fresh opens
 * neutral, so the contract this script guards changed:
 *
 *  1. Fresh ARW open (SILVERBOX_TEST_BASE_CURVE_DEFAULT=1 opts into the real
 *     fresh-open defaults): identity toneCurve.rgb, graphDirty false, and the
 *     RAW corrections still seeded (sharpen 40/1.0/0, color NR 25/50/50).
 *  2. JPEG open: identity curve, sharpen/NR 0.
 *  3. OLD-DOC compatibility: a sidecar carrying the pre-0002 seeded points
 *     (A7C2_BASE_CURVE) reopens with exactly those points and the same
 *     render — old photos never change look.
 *  4. Curve Reset restores identity; a restored doc without the curve is not
 *     re-seeded.
 *  5. Without the env flag (plain SILVERBOX_TEST): nothing is seeded.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';
// Re-enable the fresh-ARW base-curve default INSIDE the suite for this script.
process.env.SILVERBOX_TEST_BASE_CURVE_DEFAULT = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);

// The shipped points are the source of truth — read the a7C II curve straight
// from baseCurve.ts so a refit that changes the constant never has to touch
// this script.
const baseCurveSrc = readFileSync(join(projectRoot, 'src', 'renderer', 'engine', 'color', 'baseCurve.ts'), 'utf8');
const curveMatch = baseCurveSrc.match(/A7C2_BASE_CURVE[^=]*=\s*(\[[\s\S]*?\]);/);
const EXPECTED_POINTS = JSON.parse(curveMatch[1].replace(/,(\s*[\]])/g, '$1'));

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};
const pointsEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

async function withApp(env, fn) {
  const app = await electron.launch({ args: [projectRoot], env: { ...process.env, ...env } });
  try {
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.waitForSelector('.app-layout', { timeout: 15_000 });
    const openImage = async (p) => {
      await page.evaluate((path) => {
        void window.__openImageByPath(path);
      }, p);
      await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
      await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
    };
    const devCurve = () =>
      page.evaluate(() => {
        const dev = window.__debug.graphState().nodes.find((n) => n.kind === 'Develop');
        return dev?.develop?.toneCurve?.rgb ?? null;
      });
    const devId = () =>
      page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.id ?? null);
    // p50 of the encoded-output LUMA histogram (reflects the full render,
    // including the seeded tone curve).
    const histP50Once = () =>
      page.evaluate(() => {
        const h = window.__debug.histogramState();
        if (!h) return null;
        const target = h.pixels * 0.5;
        let cum = 0;
        for (let i = 0; i < h.luma.length; i++) {
          cum += h.luma[i];
          if (cum >= target) return i;
        }
        return h.luma.length - 1;
      });
    // The histogram is a DEBOUNCED post-render stats readback, and
    // histogramState() !== null right after an open is satisfiable by the
    // PREVIOUS image's stale data — a single read can race the settle (the
    // LR-refit curve surfaced this: savedP50 caught a mid-settle value that
    // the old curve's numbers happened to mask). Sample until two
    // consecutive reads 400ms apart agree.
    const histP50 = async () => {
      let prev = await histP50Once();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const cur = await histP50Once();
        if (cur !== null && cur === prev) return cur;
        prev = cur;
      }
      return prev;
    };
    // Mirror the tone-curve editor's Reset button (commit(identityCurvePoints)).
    const resetCurve = async () => {
      const id = await devId();
      const before = await page.evaluate(() => window.__debug.histogramState());
      await page.evaluate((nid) => window.__debug.setToneCurvePoints(nid, 'rgb', [[0, 0], [255, 255]]), id);
      await page.waitForFunction(
        (prev) => {
          const h = window.__debug.histogramState();
          return h !== null && JSON.stringify(h) !== prev;
        },
        JSON.stringify(before),
        { timeout: 15_000 }
      );
    };
    await fn({ page, openImage, devCurve, devId, histP50, resetCurve, pageErrors });
  } finally {
    await app.close();
  }
}

const IDENTITY = [[0, 0], [255, 255]];

// === flagged run: checks 1–4 =================================================
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '1' }, async ({ page, openImage, devCurve, devId, histP50, resetCurve, pageErrors }) => {
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const saveSidecar = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  // --- 1. fresh open is neutral; RAW corrections still seeded ---
  console.log('verify-basecurve (fresh ARW: neutral tone, corrections seeded):');
  await openImage(ARW_PATH);
  check('fresh ARW keeps toneCurve.rgb at identity (decision 0002)', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  check('graphDirty stays false on a fresh open', (await graphDirty()) === false, await graphDirty());
  const seededDetail = await page.evaluate(() => {
    const dev = window.__debug.graphState().nodes.find((n) => n.kind === 'Develop');
    return dev?.develop?.detail ?? null;
  });
  check(
    'fresh ARW seeds default sharpening 40/1.0/0 (LR RAW default)',
    seededDetail && seededDetail.sharpen.amount === 40 && seededDetail.sharpen.radius === 1.0 && seededDetail.sharpen.masking === 0,
    seededDetail?.sharpen
  );
  check(
    'fresh ARW seeds default color NR 25/50/50 (LR RAW default), luminance NR untouched',
    seededDetail &&
      seededDetail.noiseColor.amount === 25 &&
      seededDetail.noiseColor.detail === 50 &&
      seededDetail.noiseColor.smoothness === 50 &&
      seededDetail.noiseLuminance.amount === 0,
    seededDetail
  );

  // --- 2. JPEG open: identity, untouched ---
  console.log('verify-basecurve (JPEG open is untouched):');
  await openImage(JPG_PATH);
  check('JPEG open keeps the identity curve', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  const jpegDetail = await page.evaluate(() => {
    const dev = window.__debug.graphState().nodes.find((n) => n.kind === 'Develop');
    return dev?.develop?.detail ?? null;
  });
  check('JPEG open keeps sharpening at 0 (in-camera JPEGs are pre-sharpened)', jpegDetail?.sharpen?.amount === 0, jpegDetail?.sharpen);
  check('JPEG open keeps color NR at 0', jpegDetail?.noiseColor?.amount === 0, jpegDetail?.noiseColor);

  // --- 3. old-doc compatibility: pre-0002 seeded points survive a round-trip ---
  console.log('verify-basecurve (old doc with the pre-0002 seed reopens unchanged):');
  await openImage(ARW_PATH);
  await page.evaluate(([id, pts]) => window.__debug.setToneCurvePoints(id, 'rgb', pts), [await devId(), EXPECTED_POINTS]);
  check('the old seed points took', pointsEqual(await devCurve(), EXPECTED_POINTS), await devCurve());
  const savedP50 = await histP50();
  await saveSidecar();
  await openImage(ARW_PATH);
  check('old seed points reopen identical (never re-seeded, never flattened)', pointsEqual(await devCurve(), EXPECTED_POINTS), await devCurve());
  const reopenedP50 = await histP50();
  check('reopened render matches (p50 within 1 bin)', Math.abs(reopenedP50 - savedP50) <= 1, { savedP50, reopenedP50 });

  // --- 4. Reset → identity; a restored doc without the curve is not re-seeded ---
  console.log('verify-basecurve (Reset + no re-seed):');
  await resetCurve();
  check('Reset restores the identity curve', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  check('identity render is darker than the old-seed render (p50 lower)', (await histP50()) < savedP50, { savedP50 });
  check('graphDirty true after removing the curve (a real edit)', (await graphDirty()) === true, await graphDirty());
  await saveSidecar();
  await openImage(ARW_PATH);
  check('a restored doc without the curve is NOT re-seeded', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

  check('no page errors across the flagged run', pageErrors.length === 0, pageErrors);
});

// === unflagged run: check 6 ==================================================
// Plain SILVERBOX_TEST (no base-curve flag) — the seeding must NOT fire, so the
// other 38 scripts keep their untouched fresh-ARW baselines.
console.log('verify-basecurve (no flag → no seeding):');
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '' }, async ({ openImage, devCurve, pageErrors }) => {
  await openImage(ARW_PATH);
  check('without the flag, a fresh ARW is NOT seeded (identity curve)', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  check('no page errors in the unflagged run', pageErrors.length === 0, pageErrors);
});

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
