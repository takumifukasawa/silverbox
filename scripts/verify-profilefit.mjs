/**
 * Fitted camera PROFILE verify (docs/brief-bank/profile-fit.md; COLOR.md
 * "Default rendering").
 *
 * The profile is a fitted residual 3D transform (engine/color/profileFit.ts)
 * applied FIRST in the Develop chain, amount 0..100, seeded to 100 on fresh
 * RAW opens under the default-look gate (rides SILVERBOX_TEST_BASE_CURVE_DEFAULT
 * like the base curve). This proves: the 17³ storage-buffer trilinear GPU pass
 * mirrors the CPU (1/255), the amount slider dials identity → T, the identity
 * invariant (amount 0 = bit-exact no-op) holds, and the seeding gate/JPEG/
 * restored-doc rules match the base curve.
 *
 * Checks:
 *  1. GPU/CPU parity at amount 100 and 50 (the trilinear-mirror proof), with
 *     the profile the ONLY active Develop op.
 *  2. Identity invariant: amount 0 render == the neutral (no-profile) render,
 *     bit-exact.
 *  3. The slider dials: amount 100 moves the render off neutral; amount 50
 *     moves it LESS than 100 (monotone blend).
 *  4. Seeding (flagged): a fresh ARW seeds develop.profile.amount 100,
 *     graphDirty false; a JPEG stays 0; a sidecar round-trips (saved-with →
 *     reopens with 100; saved-without → not re-seeded).
 *  5. Unflagged (plain SILVERBOX_TEST): a fresh ARW is NOT seeded — baseline
 *     protection for the other scripts.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const SIDECAR = ARW_PATH + '.silverbox.json';

const GPU_CPU_TOLERANCE = 1 / 255;

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
const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const meanDist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

async function withApp(env, fn) {
  const app = await electron.launch({ args: [projectRoot], env: { ...process.env, ...env } });
  try {
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.waitForSelector('.app-layout', { timeout: 15_000 });
    const openImage = async (p) => {
      await page.evaluate((path) => void window.__openImageByPath(path), p);
      await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    };
    const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
    const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
    const setAmount = (v) => page.evaluate((amt) => window.__debug.updateNodeParam('dev', 'profile.amount', amt), v);
    const profileAmount = () =>
      page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.develop?.profile?.amount ?? null);
    // wait for the GPU readback to settle to a fresh value after a param change
    const settledGpuMean = async (prev) => {
      for (let i = 0; i < 20; i++) {
        const cur = await gpuMean();
        if (cur && (!prev || meanDist(cur, prev) > 1e-6)) return cur;
        await new Promise((r) => setTimeout(r, 200));
      }
      return gpuMean();
    };
    await fn({ page, openImage, gpuMean, cpuMean, setAmount, profileAmount, settledGpuMean, pageErrors });
  } finally {
    await app.close();
  }
}

// === parity + slider run (plain SILVERBOX_TEST: no seeding, drive by hand) ====
console.log('verify-profilefit (GPU/CPU parity + slider):');
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '' }, async ({ openImage, gpuMean, cpuMean, setAmount, settledGpuMean, pageErrors }) => {
  await openImage(ARW_PATH);
  // profile is the ONLY active Develop op (nothing else seeded under the plain
  // flag), so the render stays CPU-referenceable.
  const neutral = await gpuMean();

  await setAmount(100);
  const gpu100 = await settledGpuMean(neutral);
  const cpu100 = await cpuMean();
  check('amount 100: GPU matches CPU reference (within 1/255)', meansMatch(gpu100, cpu100), { gpu100, cpu100 });
  check('amount 100 moves the render off neutral (profile has an effect)', meanDist(gpu100, neutral) > 0.002, {
    dist: meanDist(gpu100, neutral),
  });

  await setAmount(50);
  const gpu50 = await settledGpuMean(gpu100);
  const cpu50 = await cpuMean();
  check('amount 50: GPU matches CPU reference (within 1/255)', meansMatch(gpu50, cpu50), { gpu50, cpu50 });
  check('amount 50 moves LESS than amount 100 (the slider dials)', meanDist(gpu50, neutral) < meanDist(gpu100, neutral), {
    d50: meanDist(gpu50, neutral),
    d100: meanDist(gpu100, neutral),
  });

  await setAmount(0);
  const gpu0 = await settledGpuMean(gpu50);
  check('amount 0 is a bit-exact no-op (== neutral render)', meansMatch(gpu0, neutral, 1e-6), { gpu0, neutral });

  check('no page errors in the parity run', pageErrors.length === 0, pageErrors);
});

// === seeding run (flagged: profile seeding fires like the base curve) =========
console.log('\nverify-profilefit (fresh RAW seeds amount 100):');
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '1' }, async ({ page, openImage, profileAmount, pageErrors }) => {
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const saveSidecar = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  await openImage(ARW_PATH);
  check('fresh ARW seeds develop.profile.amount = 100', (await profileAmount()) === 100, await profileAmount());
  check('graphDirty stays false (the profile IS the default look)', (await graphDirty()) === false, await graphDirty());

  // JPEG: no profile
  await openImage(JPG_PATH);
  check('JPEG open keeps profile amount 0 (no default-look profile)', (await profileAmount()) === 0, await profileAmount());

  // sidecar round-trip: saved-with reopens with 100
  await openImage(ARW_PATH);
  await saveSidecar();
  await openImage(ARW_PATH);
  check('saved profile reopens at amount 100', (await profileAmount()) === 100, await profileAmount());

  // saved-without (amount 0) is not re-seeded
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'profile.amount', 0));
  check('graphDirty true after removing the profile (a real edit)', (await graphDirty()) === true, await graphDirty());
  await saveSidecar();
  await openImage(ARW_PATH);
  check('a restored doc with profile removed is NOT re-seeded', (await profileAmount()) === 0, await profileAmount());
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

  check('no page errors in the seeding run', pageErrors.length === 0, pageErrors);
});

// === unflagged run: no seeding ===============================================
console.log('\nverify-profilefit (no flag → no seeding):');
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
await withApp({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '' }, async ({ openImage, profileAmount, pageErrors }) => {
  await openImage(ARW_PATH);
  check('without the flag, a fresh ARW is NOT seeded (amount 0)', (await profileAmount()) === 0, await profileAmount());
  check('no page errors in the unflagged run', pageErrors.length === 0, pageErrors);
});

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
