/**
 * Default BASE CURVE verify (COLOR.md "default rendering").
 *
 * A fresh ARW open seeds the Develop node's toneCurve.rgb with the
 * camera-matched base curve (baseCurve.ts) — the visible, editable, deletable
 * second stage of the default look (baseline exposure is the first). Runs with
 * SILVERBOX_TEST_BASE_CURVE_DEFAULT=1 so that seeding fires inside the suite;
 * it is suppressed for every other script (so seeding never shifts their
 * fresh-ARW baselines — same mechanism as the lens-profile default).
 *
 * Checks:
 *  1. Fresh ARW open seeds toneCurve.rgb with EXACTLY the shipped points, and
 *     graphDirty stays false (it IS the default look, not an edit).
 *  2. The seeded render's mid-percentile encoded luma lands far closer to the
 *     camera JPEG's than the identity-curve render (>60% closer at p50).
 *  3. JPEG open: identity curve, untouched.
 *  4. Curve Reset restores identity (a darker render); reopening re-seeds.
 *  5. Sidecar round-trip: the curve travels as ordinary tone-curve points and
 *     reopens identical; a sidecar SAVED WITHOUT the curve reopens WITHOUT it
 *     (a restored doc is never re-seeded).
 *  6. Without the env flag (plain SILVERBOX_TEST): a fresh ARW open does NOT
 *     seed — baseline protection for the other 38 scripts.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';
// Re-enable the fresh-ARW base-curve default INSIDE the suite for this script.
process.env.SILVERBOX_TEST_BASE_CURVE_DEFAULT = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const SIDECAR = ARW_PATH + '.silverbox.json';

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

// === flagged run: checks 1–5 =================================================
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '1' }, async ({ page, openImage, devCurve, histP50, resetCurve, pageErrors }) => {
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const saveSidecar = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  // --- 1. fresh open seeds the exact points, graphDirty false ---
  console.log('verify-basecurve (fresh ARW seeds the base curve):');
  await openImage(ARW_PATH);
  const seeded = await devCurve();
  check('fresh ARW seeds toneCurve.rgb with the exact shipped points', pointsEqual(seeded, EXPECTED_POINTS), seeded);
  check('graphDirty stays false (the base curve IS the default look)', (await graphDirty()) === false, await graphDirty());
  const seededP50 = await histP50();

  // --- 4a. Reset restores identity (a darker render) ---
  console.log('verify-basecurve (Reset restores identity):');
  await resetCurve();
  check('Reset restores the identity curve', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  const identityP50 = await histP50();
  check('identity render is darker than the seeded render (p50 lower)', identityP50 < seededP50, { identityP50, seededP50 });

  // --- 4b. reopening re-seeds ---
  await openImage(ARW_PATH);
  check('reopening a fresh ARW re-seeds the base curve', pointsEqual(await devCurve(), EXPECTED_POINTS), await devCurve());

  // --- 3. JPEG open: identity, untouched ---
  console.log('verify-basecurve (JPEG open is untouched):');
  await openImage(JPG_PATH);
  check('JPEG open keeps the identity curve (no base curve)', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  const jpegP50 = await histP50();

  // --- 2. seeded render lands far closer to the JPEG at p50 ---
  console.log('verify-basecurve (seeded render approaches the camera JPEG):');
  const beforeGap = Math.abs(identityP50 - jpegP50);
  const afterGap = Math.abs(seededP50 - jpegP50);
  const shrink = beforeGap > 0 ? 1 - afterGap / beforeGap : 0;
  console.log(
    `  info: p50 — identity ${identityP50}, seeded ${seededP50}, JPEG ${jpegP50} (gap ${beforeGap} → ${afterGap}, ${(shrink * 100).toFixed(0)}% closer)`
  );
  check('seeded p50 is >60% closer to the JPEG than the identity render', shrink > 0.6, { beforeGap, afterGap, shrink });

  // --- 5a. sidecar round-trip: the curve travels + reopens identical ---
  console.log('verify-basecurve (sidecar round-trip):');
  await openImage(ARW_PATH);
  const savedP50 = await histP50();
  await saveSidecar();
  await openImage(ARW_PATH);
  check('saved base curve reopens identical', pointsEqual(await devCurve(), EXPECTED_POINTS), await devCurve());
  // Same curve points ⇒ same render; the p50 is a histogram-bin readout, so
  // allow a 1-bin median-boundary jitter.
  const reopenedP50 = await histP50();
  check('reopened render matches (p50 within 1 bin)', Math.abs(reopenedP50 - savedP50) <= 1, { savedP50, reopenedP50 });

  // --- 5b. a sidecar saved WITHOUT the curve reopens without it (no re-seed) ---
  console.log('verify-basecurve (deleted-curve sidecar is not re-seeded):');
  await resetCurve();
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
