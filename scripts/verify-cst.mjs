/**
 * Working-space migration verify: the engine develops in LINEAR Rec.2020 and
 * converts to sRGB only at the exit.
 *
 * Checks: (1) the working-space identity + decode output color are reported;
 * (2) the exit matrix agrees GPU-vs-CPU on the default plan (both paths run
 * WORK_TO_SRGB → sRGB curve); (3) the test ARW has a meaningful out-of-gamut
 * population, proving the wider working space actually carries color a sRGB
 * decode would have clipped at the door (the spike measured 4.45% on full res;
 * the preview is box-downsampled so this asserts a conservative >0.5%);
 * (4) the grayscale view still renders and the histogram still populates.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
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

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  console.log('verify-cst (working-space identity):');
  const info = await page.evaluate(() => window.__debug.workingSpaceInfo());
  check("working space is 'rec2020-linear'", info.id === 'rec2020-linear', info);
  check('decode targets libraw output color 8 (linear Rec.2020)', info.outputColor === 8, info);

  console.log('verify-cst (exit matrix — GPU matches CPU reference):');
  const gpu = await page.evaluate(() => window.__debug.readbackMean());
  const cpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('default plan has a CPU reference', cpu !== null, cpu);
  check('GPU exit matches CPU exit (within 1/255)', meansMatch(gpu, cpu), { gpu, cpu });

  console.log('verify-cst (out-of-gamut population):');
  const oog = await page.evaluate(() => window.__debug.outOfGamutFraction());
  check(
    'test ARW has >0.5% out-of-gamut pixels (wider working space carries clipped color)',
    oog !== null && oog > 0.005,
    { oogFraction: oog }
  );

  console.log('verify-cst (grayscale view + stats):');
  await page.locator('[data-testid="view-grayscale"]').click();
  await page.waitForTimeout(400);
  check('grayscale view renders without a page error', pageErrors.length === 0, pageErrors);
  const hist = await page.evaluate(() => window.__debug.histogramState());
  check('histogram still populates', hist !== null && hist.pixels > 0, hist ? { pixels: hist.pixels } : hist);
  await page.locator('[data-testid="view-grayscale"]').click();
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
