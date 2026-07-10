/**
 * Spec-alignment verify (REBUILD-SPEC MS8): white balance. As-shot CCT/tint
 * estimated from cam_mul/cam_xyz (DSC02993 → 3535 K / +5), as-shot values =
 * exact pass-through, warm/cool and green/magenta directions behave, GPU
 * matches the CPU reference, atomic WB ≡ Develop WB, values survive the
 * sidecar, and the JPG fallback model lands near D65.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
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

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const setDev = (path, value) =>
    page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);

  console.log('verify-wb (as-shot estimation):');
  await openAndWait(ARW_PATH);
  const wb = await page.evaluate(() => window.__debug.wbState());
  check('as-shot for DSC02993 is 3535 K / +5', wb.asShot.temp === 3535 && wb.asShot.tint === 5, wb);
  const devWb = await page.evaluate(() => {
    const b = window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic;
    return { temp: b?.temp, tint: b?.tint };
  });
  check('Develop basic resolves the as-shot placeholder', devWb.temp === 3535 && devWb.tint === 5, devWb);
  const neutral = await gpuMean();
  const neutralCpu = await cpuMean();
  check('as-shot WB is an exact pass-through (CPU = raw pixels)', meansMatch(neutral, neutralCpu), {
    neutral,
    neutralCpu,
  });

  console.log('verify-wb (directions + CPU reference):');
  await setDev('basic.temp', wb.asShot.temp + 2000);
  const warm = await gpuMean();
  const warmCpu = await cpuMean();
  check('warmer temp GPU matches CPU reference (within 1/255)', meansMatch(warm, warmCpu), { warm, warmCpu });
  check('raising temp warms the image (R up, B down)', warm.r > neutral.r + 0.005 && warm.b < neutral.b - 0.005, {
    neutral,
    warm,
  });
  await setDev('basic.temp', wb.asShot.temp - 1000);
  const cool = await gpuMean();
  check('lowering temp cools the image (B up)', cool.b > neutral.b + 0.005, { neutral, cool });
  await setDev('basic.temp', wb.asShot.temp);

  await setDev('basic.tint', wb.asShot.tint + 100);
  const magenta = await gpuMean();
  const magentaCpu = await cpuMean();
  check('tint GPU matches CPU reference (within 1/255)', meansMatch(magenta, magentaCpu), {
    magenta,
    magentaCpu,
  });
  check(
    'positive tint pushes magenta (G down vs R/B)',
    magenta.g - neutral.g < ((magenta.r - neutral.r) + (magenta.b - neutral.b)) / 2 - 0.002,
    { neutral, magenta }
  );

  console.log('verify-wb (atomic ≡ Develop):');
  const devWarm = warm;
  await setDev('basic.tint', wb.asShot.tint);
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-whitebalance"]').click();
  const atomicId = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.kind === 'whitebalance')?.id
  );
  const atomicDefaults = await page.evaluate(
    (id) => window.__debug.graphState().nodes.find((n) => n.id === id)?.params,
    atomicId
  );
  check('fresh WB atomic starts at as-shot (= identity)', atomicDefaults.temp === 3535 && atomicDefaults.tint === 5,
    atomicDefaults);
  const withAtomicIdentity = await gpuMean();
  check('as-shot atomic is a pass-through', meansMatch(withAtomicIdentity, neutral), {
    neutral,
    withAtomicIdentity,
  });
  await page.evaluate(([id, t]) => window.__debug.updateNodeParam(id, 'temp', t), [atomicId, wb.asShot.temp + 2000]);
  const atomicWarm = await gpuMean();
  check('atomic WB matches Develop WB at the same temp', meansMatch(atomicWarm, devWarm, 1e-6), {
    devWarm,
    atomicWarm,
  });
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'temp', 3535), atomicId);

  console.log('verify-wb (sidecar round-trip with absolute Kelvin):');
  await setDev('basic.temp', 5000);
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const warmSaved = await gpuMean();
  await openAndWait(ARW_PATH);
  const restoredWb = await page.evaluate(() => {
    const b = window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic;
    return { temp: b?.temp, tint: b?.tint };
  });
  check('reopen restores the absolute temp', restoredWb.temp === 5000, restoredWb);
  const restored = await gpuMean();
  check('restored WB renders like before the save', meansMatch(restored, warmSaved), { warmSaved, restored });

  console.log('verify-wb (JPG fallback model):');
  await openAndWait(JPG_PATH);
  const jpgWb = await page.evaluate(() => window.__debug.wbState());
  check(
    'JPG (no cam_mul/cam_xyz) lands near D65 (6200–6800 K, small tint)',
    jpgWb.asShot.temp > 6200 && jpgWb.asShot.temp < 6800 && Math.abs(jpgWb.asShot.tint) <= 15,
    jpgWb
  );
  const jpgNeutral = await gpuMean();
  const jpgCpu = await cpuMean();
  check('JPG as-shot is a pass-through too', meansMatch(jpgNeutral, jpgCpu), { jpgNeutral, jpgCpu });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
