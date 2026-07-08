/**
 * Milestone 12 verify: tone curve op. Defaults are identity, lights/shadows
 * moves match the CPU reference, the effect lands in the intended tonal
 * region, and the inspector shows the curve preview.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = 'test-assets/test.ARW';
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

const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());

  console.log('verify-ms12 (identity default):');
  await page.locator('.node-editor-toolbar select').selectOption('tonecurve');
  await page.locator('.node-editor-toolbar button').click();
  check(
    'tone curve node shows sliders and the curve preview',
    (await page.locator('.inspector-title').textContent()) === 'Tone Curve' &&
      (await page.locator('[data-testid="curve-preview"]').count()) === 1 &&
      (await page.locator('.inspector input[type="range"]').count()) === 4,
    await page.locator('.inspector-title').textContent()
  );
  const identity = await page.evaluate(() => window.__debug.readbackMean());
  check('all-zero curve is identity', meansMatch(identity, neutral), { neutral, identity });

  console.log('verify-ms12 (lights +0.8 vs CPU reference):');
  await page.evaluate(() => window.__debug.updateNodeParam('tonecurve-1', 'lights', 0.8));
  const lightsGpu = await page.evaluate(() => window.__debug.readbackMean());
  const lightsCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('lights GPU matches CPU reference (within 1/255)', meansMatch(lightsGpu, lightsCpu), {
    lightsGpu,
    lightsCpu,
  });
  check('raising lights brightens the image', lightsGpu.g > neutral.g + 0.02, {
    neutral: neutral.g,
    lights: lightsGpu.g,
  });

  console.log('verify-ms12 (shadows −0.8 vs CPU reference):');
  await page.evaluate(() => window.__debug.updateNodeParam('tonecurve-1', 'lights', 0));
  await page.evaluate(() => window.__debug.updateNodeParam('tonecurve-1', 'shadows', -0.8));
  const shadowsGpu = await page.evaluate(() => window.__debug.readbackMean());
  const shadowsCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('shadows GPU matches CPU reference (within 1/255)', meansMatch(shadowsGpu, shadowsCpu), {
    shadowsGpu,
    shadowsCpu,
  });
  check('crushing shadows darkens the image', shadowsGpu.g < neutral.g - 0.01, {
    neutral: neutral.g,
    shadows: shadowsGpu.g,
  });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms12-tonecurve.png') });
  console.log('screenshot: test-artifacts/ms12-tonecurve.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
