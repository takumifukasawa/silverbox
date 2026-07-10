/**
 * Milestone 3 verify: the preview is rendered by WebGPU, and the GPU output
 * matches the CPU reference sRGB encode. Opens the same real ARW + JPEG pair
 * as milestone 2, confirms the ms2 behavior still holds through the new
 * render path, then compares the GPU readback mean against cpuReferenceMean()
 * (exact srgbEncode on the store's linear pixels).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
rmSidecarSync(JPG_PATH + '.silverbox.json', { force: true });

// rgba16float quantizes the linear input (~11-bit mantissa) and the 8-bit
// readback target quantizes the output, so allow 1/255 per channel on means.
const GPU_CPU_TOLERANCE = 1 / 255;

console.log('building…');
execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  check(
    'renderer reports webgpu',
    (await page.evaluate(() => window.__debug?.rendererKind())) === 'webgpu',
    await page.evaluate(() => window.__debug?.rendererKind())
  );

  const openAndWait = async (path) => {
    // fire-and-forget: a page.evaluate that stays in flight across the decode
    // can be killed by a transient execution-context teardown during decode GC
    // (waitForFunction below is resilient to that; a held evaluate is not)
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );
    return page.evaluate(() => window.__debug.imageState());
  };

  const verifyImage = async (label, path) => {
    console.log(`verify-ms3 (${label}):`);
    const state = await openAndWait(path);
    check(`${label} decode succeeds`, state.status === 'ready', state);
    check(
      `${label} preview long edge is 2560`,
      Math.max(state.width, state.height) === 2560,
      { w: state.width, h: state.height }
    );

    // the canvas the GPU renders into must match the preview size
    const out = await page.evaluate(() => window.__debug.outputSize());
    check(
      `${label} canvas matches preview size`,
      out && out.width === state.width && out.height === state.height,
      { out, state }
    );

    const gpuMean = await page.evaluate(() => window.__debug.readbackMean());
    check(
      `${label} display is neither black nor blown out`,
      gpuMean && gpuMean.r > 0.02 && gpuMean.r < 0.98 && gpuMean.g > 0.02 && gpuMean.g < 0.98,
      gpuMean
    );

    const cpuMean = await page.evaluate(() => window.__debug.cpuReferenceMean());
    check(
      `${label} GPU output matches CPU reference encode (mean within 1/255)`,
      gpuMean &&
        cpuMean &&
        Math.abs(gpuMean.r - cpuMean.r) < GPU_CPU_TOLERANCE &&
        Math.abs(gpuMean.g - cpuMean.g) < GPU_CPU_TOLERANCE &&
        Math.abs(gpuMean.b - cpuMean.b) < GPU_CPU_TOLERANCE,
      { gpuMean, cpuMean }
    );

    await page.screenshot({ path: join(projectRoot, 'test-artifacts', `ms3-${label.toLowerCase()}.png`) });
    return gpuMean;
  };

  const rawMean = await verifyImage('RAW', ARW_PATH);
  const jpgMean = await verifyImage('JPEG', JPG_PATH);

  check(
    'RAW and JPEG show the same scene (channel means within 0.25)',
    rawMean &&
      jpgMean &&
      Math.abs(rawMean.r - jpgMean.r) < 0.25 &&
      Math.abs(rawMean.g - jpgMean.g) < 0.25 &&
      Math.abs(rawMean.b - jpgMean.b) < 0.25,
    { rawMean, jpgMean }
  );

  console.log('screenshots: test-artifacts/ms3-raw.png, ms3-jpeg.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
