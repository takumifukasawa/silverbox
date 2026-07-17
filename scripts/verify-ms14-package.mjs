/**
 * Milestone 14 verify: packaging. Builds the unsigned mac .app with
 * electron-builder, launches the packaged binary (not the dev harness), and
 * smoke-tests the real product: window title, RAW decode, WebGPU render
 * matching the CPU reference, and the sidecar surface.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
ensureTestProjectEnv();
rmLook(ARW_PATH);
const APP_DIR = join(projectRoot, 'dist', arch() === 'arm64' ? 'mac-arm64' : 'mac');
const EXECUTABLE = join(APP_DIR, 'Silverbox.app', 'Contents', 'MacOS', 'Silverbox');
const GPU_CPU_TOLERANCE = 1 / 255;

// "npm run package" is electron-vite build && electron-builder --dir; split
// so the runner can skip the redundant build (it already built `out/` once
// up front) while electron-builder --dir (the actual thing ms14 verifies)
// always runs. ms14 packages/mutates dist/, so it stays pinned to the
// exclusive serial tail after the parallel pool regardless.
if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}
console.log('packaging…');
execFileSync('npx', ['electron-builder', '--dir'], { cwd: projectRoot, stdio: 'inherit' });

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

check('packaged app bundle exists', existsSync(EXECUTABLE), EXECUTABLE);
if (!existsSync(EXECUTABLE)) {
  console.error('\ncannot launch smoke test without the bundle');
  process.exit(1);
}

const app = await electron.launch({ executablePath: EXECUTABLE });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  console.log('verify-ms14 (packaged smoke test):');
  check('window title is Silverbox', (await page.title()) === 'Silverbox', await page.title());
  check(
    'renderer reports webgpu',
    (await page.evaluate(() => window.__debug?.rendererKind())) === 'webgpu',
    await page.evaluate(() => window.__debug?.rendererKind())
  );

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const state = await page.evaluate(() => window.__debug.imageState());
  // round-11 decode-frame fix: 4580×3050 (raw_inset_crops-clamped), not the
  // old too-large/off-origin 4624×3080 — see librawDecoder.ts's
  // computeCropbox doc comment.
  check('packaged app decodes the ARW', state.fullWidth === 4580 && state.fullHeight === 3050, state);

  const gpu = await page.evaluate(() => window.__debug.readbackMean());
  const cpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check(
    'packaged render matches the CPU reference (within 1/255)',
    gpu &&
      cpu &&
      Math.abs(gpu.r - cpu.r) < GPU_CPU_TOLERANCE &&
      Math.abs(gpu.g - cpu.g) < GPU_CPU_TOLERANCE &&
      Math.abs(gpu.b - cpu.b) < GPU_CPU_TOLERANCE,
    { gpu, cpu }
  );

  // the histogram fills in debounced after the first render
  const histogramAlive = await page
    .waitForSelector('[data-testid="histogram-canvas"]', { timeout: 10_000 })
    .then(() => true, () => false);
  check(
    'node editor and inspector are alive',
    (await page.locator('.react-flow__node').count()) >= 3 && histogramAlive,
    { nodes: await page.locator('.react-flow__node').count(), histogramAlive }
  );

  // sharp is asar-unpacked native code — exporting is exactly what breaks
  // when packaging goes wrong, so smoke-test it in the packaged app
  const outPath = join(tmpdir(), `silverbox-ms14-export-${Date.now()}.jpg`);
  await page.evaluate((p) => window.__debug.exportImageTo(p), outPath);
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  const exportState = await page.evaluate(() => window.__debug.exportState());
  check(
    'packaged app exports a JPEG through sharp',
    exportState.status === 'idle' && existsSync(outPath) && statSync(outPath).size > 500_000,
    { exportState, size: existsSync(outPath) ? statSync(outPath).size : 'missing' }
  );
  if (existsSync(outPath)) unlinkSync(outPath);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
