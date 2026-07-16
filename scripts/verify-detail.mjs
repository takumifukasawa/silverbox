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
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
rmSidecarSync(SIDECAR, { force: true });
const GPU_CPU_TOLERANCE = 1 / 255;
// GPU-vs-GPU render-equality tolerance (same shader, same uniforms — near
// bit-exact, not the GPU/CPU-reference 1/255 above).
const RENDER_EQUALITY_TOLERANCE = 1e-5;

/**
 * schemaVersion-4 wire wrapper (serializeGraphDoc's shape — see
 * verify-ratings.mjs/verify-cli.mjs precedent) carrying a Develop node whose
 * `detail` is exactly `develop`. Used by the back-compat fixture check below:
 * a `noiseLuminance`/`noiseColor` object that OMITS the new sub-slider
 * fields is exactly what a pre-pack sidecar looked like.
 */
function writeDetailSidecar(develop) {
  const nowIso = new Date().toISOString();
  const wrapper = {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  };
  writeFileSync(SIDECAR, JSON.stringify(wrapper, null, 2) + '\n');
}

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

  console.log('verify-detail (LR six-knob sub-sliders — direction, at fixed amount):');
  // Luminance Detail: higher = smaller range sigma = more structure counts
  // as edge and survives = LESS smoothing = higher luma gradient energy.
  await setDev('detail.noiseLuminance.amount', 100);
  await setDev('detail.noiseLuminance.detail', 0);
  const lumaDetailLow = await sharpness();
  await setDev('detail.noiseLuminance.detail', 100);
  const lumaDetailHigh = await sharpness();
  check('Luminance Detail 100 sharpens more than Detail 0 (less over-smoothing)', lumaDetailHigh.luma > lumaDetailLow.luma, {
    low: lumaDetailLow.luma,
    high: lumaDetailHigh.luma,
  });
  await setDev('detail.noiseLuminance.detail', 50); // back to default

  // Luminance Contrast: re-injects removed high-frequency luma, fighting the
  // "plastic" look — higher contrast raises luma gradient energy back up.
  await setDev('detail.noiseLuminance.contrast', 0);
  const lumaContrastLow = await sharpness();
  await setDev('detail.noiseLuminance.contrast', 100);
  const lumaContrastHigh = await sharpness();
  check('Luminance Contrast 100 raises luma energy vs Contrast 0', lumaContrastHigh.luma > lumaContrastLow.luma, {
    low: lumaContrastLow.luma,
    high: lumaContrastHigh.luma,
  });
  await setDev('detail.noiseLuminance.contrast', 0); // back to default
  await setDev('detail.noiseLuminance.amount', 0);

  // Color Detail: same shape as Luminance Detail but for the chroma pass's
  // luma-edge guard — higher preserves more chroma detail near luma edges.
  await setDev('detail.noiseColor.amount', 100);
  await setDev('detail.noiseColor.detail', 0);
  const colorDetailLow = await sharpness();
  await setDev('detail.noiseColor.detail', 100);
  const colorDetailHigh = await sharpness();
  check('Color Detail 100 preserves more chroma energy than Detail 0', colorDetailHigh.chroma > colorDetailLow.chroma, {
    low: colorDetailLow.chroma,
    high: colorDetailHigh.chroma,
  });
  await setDev('detail.noiseColor.detail', 50); // back to default

  // Color Smoothness: chroma SPATIAL sigma scale — higher averages away
  // larger color blotches, so chroma gradient energy goes DOWN.
  await setDev('detail.noiseColor.smoothness', 0);
  const colorSmoothLow = await sharpness();
  await setDev('detail.noiseColor.smoothness', 100);
  const colorSmoothHigh = await sharpness();
  check('Color Smoothness 100 lowers chroma energy vs Smoothness 0', colorSmoothHigh.chroma < colorSmoothLow.chroma, {
    low: colorSmoothLow.chroma,
    high: colorSmoothHigh.chroma,
  });
  await setDev('detail.noiseColor.smoothness', 50); // back to default
  await setDev('detail.noiseColor.amount', 0);

  console.log('verify-detail (identity: amount 0 ignores sub-slider values regardless of magnitude):');
  await setDev('detail.noiseLuminance.detail', 100);
  await setDev('detail.noiseLuminance.contrast', 100);
  await setDev('detail.noiseColor.detail', 0);
  await setDev('detail.noiseColor.smoothness', 100);
  const extremeSubValues = await gpuMean();
  check('amount 0 + extreme sub-slider values still pass through (mean unchanged)', meansMatch(extremeSubValues, neutral), {
    neutral,
    extremeSubValues,
  });
  // back to the shipped defaults for the rest of the script
  await setDev('detail.noiseLuminance.detail', 50);
  await setDev('detail.noiseLuminance.contrast', 0);
  await setDev('detail.noiseColor.detail', 50);
  await setDev('detail.noiseColor.smoothness', 50);

  console.log('verify-detail (all-zero = exact pass-through):');
  const back = await gpuMean();
  check('zeroed Detail restores the neutral render', meansMatch(back, neutral), { neutral, back });

  console.log('verify-detail (Detail UI rows):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const detailSection = page.locator('.inspector-section').filter({ hasText: 'Detail' }).first();
  await detailSection.scrollIntoViewIfNeeded();
  check(
    'Detail section shows the 9 sliders (3 sharpen + 6 LR six-knob NR) and the resolution hint',
    (await detailSection.locator('.param-row').count()) === 9 &&
      (await detailSection.locator('.detail-hint').count()) === 1,
    await detailSection.locator('.param-row').count()
  );
  for (const testId of [
    'detail-noise-luminance-detail',
    'detail-noise-luminance-contrast',
    'detail-noise-color-detail',
    'detail-noise-color-smoothness',
  ]) {
    check(`${testId} slider is present`, (await detailSection.locator(`[data-testid="${testId}"]`).count()) === 1, testId);
  }

  console.log('verify-detail (back-compat: sidecars without the new sub-slider fields):');
  // A pre-pack sidecar only ever wrote { amount }. mergeDevelopParams' generic
  // deep-merge fills the rest from defaultDevelopParams() — sub-slider
  // defaults (50/0/50/50) — so this must render BYTE-COMPARABLY to an
  // otherwise-identical doc that spells the defaults out explicitly.
  writeDetailSidecar({
    detail: { noiseLuminance: { amount: 60 }, noiseColor: { amount: 70 } },
  });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const prePackMean = await gpuMean();
  const prePackSharp = await sharpness();

  writeDetailSidecar({
    detail: {
      noiseLuminance: { amount: 60, detail: 50, contrast: 0 },
      noiseColor: { amount: 70, detail: 50, smoothness: 50 },
    },
  });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const explicitDefaultsMean = await gpuMean();
  const explicitDefaultsSharp = await sharpness();

  check(
    'sidecar missing the new fields renders identically to one with explicit defaults (mean)',
    meansMatch(prePackMean, explicitDefaultsMean, RENDER_EQUALITY_TOLERANCE),
    { prePackMean, explicitDefaultsMean }
  );
  check(
    'sidecar missing the new fields renders identically to one with explicit defaults (sharpness)',
    Math.abs(prePackSharp.luma - explicitDefaultsSharp.luma) < RENDER_EQUALITY_TOLERANCE &&
      Math.abs(prePackSharp.chroma - explicitDefaultsSharp.chroma) < RENDER_EQUALITY_TOLERANCE,
    { prePackSharp, explicitDefaultsSharp }
  );
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

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
