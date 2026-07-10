/**
 * Spec-alignment verify (REBUILD-SPEC MS11): Detail (sharpen + NR). All-zero
 * = exact pass-through; sharpening raises the high-frequency energy of the
 * render, masking restrains it, luminance NR lowers it and color NR lowers
 * the chroma energy specifically (all strict inequalities — the renders are
 * deterministic); the export path runs the kernels at full resolution.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
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

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const neutralSharp = await page.evaluate(() => window.__debug.readbackSharpness());
  const setDev = (path, value) =>
    page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const sharpness = () => page.evaluate(() => window.__debug.readbackSharpness());

  console.log('verify-detail (sharpen raises high-frequency energy):');
  await setDev('detail.sharpen.amount', 100);
  const sharpened = await sharpness();
  check('sharpen 100 raises luma gradient energy', sharpened.luma > neutralSharp.luma * 1.1, {
    neutral: neutralSharp.luma,
    sharpened: sharpened.luma,
  });
  const sharpenedMean = await gpuMean();
  check('sharpening barely moves the global mean', Math.abs(sharpenedMean.g - neutral.g) < 0.01, {
    neutral: neutral.g,
    sharpened: sharpenedMean.g,
  });

  console.log('verify-detail (masking restrains flat-area sharpening):');
  await setDev('detail.sharpen.masking', 100);
  const masked = await sharpness();
  check('masking 100 sharpens less than masking 0', masked.luma < sharpened.luma, {
    unmasked: sharpened.luma,
    masked: masked.luma,
  });
  check('masked sharpening still sharpens vs neutral', masked.luma > neutralSharp.luma, {
    neutral: neutralSharp.luma,
    masked: masked.luma,
  });
  await setDev('detail.sharpen.masking', 0);
  await setDev('detail.sharpen.amount', 0);

  console.log('verify-detail (noise reduction):');
  await setDev('detail.noiseLuminance.amount', 100);
  const lumaNr = await sharpness();
  check('luminance NR lowers luma gradient energy', lumaNr.luma < neutralSharp.luma * 0.9, {
    neutral: neutralSharp.luma,
    nr: lumaNr.luma,
  });
  await setDev('detail.noiseLuminance.amount', 0);
  await setDev('detail.noiseColor.amount', 100);
  const colorNr = await sharpness();
  check('color NR lowers chroma gradient energy', colorNr.chroma < neutralSharp.chroma * 0.9, {
    neutral: neutralSharp.chroma,
    nr: colorNr.chroma,
  });
  check('color NR leaves luma detail mostly alone', colorNr.luma > neutralSharp.luma * 0.95, {
    neutral: neutralSharp.luma,
    nr: colorNr.luma,
  });
  await setDev('detail.noiseColor.amount', 0);

  console.log('verify-detail (all-zero = exact pass-through):');
  const back = await gpuMean();
  check('zeroed Detail restores the neutral render', meansMatch(back, neutral), { neutral, back });

  console.log('verify-detail (Detail UI rows):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const detailSection = page.locator('.inspector-section').filter({ hasText: 'Detail' }).first();
  check(
    'Detail section shows the 5 sliders and the resolution hint',
    (await detailSection.locator('.param-row').count()) === 5 &&
      (await detailSection.locator('.detail-hint').count()) === 1,
    await detailSection.locator('.param-row').count()
  );

  console.log('verify-detail (export runs the kernels at full resolution):');
  await setDev('detail.sharpen.amount', 80);
  await setDev('detail.noiseLuminance.amount', 40);
  const outPath = join(tmpdir(), `silverbox-detail-export-${Date.now()}.jpg`);
  await page.evaluate((p) => window.__debug.exportImageTo(p), outPath);
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  const exportState = await page.evaluate(() => window.__debug.exportState());
  check(
    'export with Detail active completes',
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
