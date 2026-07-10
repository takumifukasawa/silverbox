/**
 * Effects verify: defaults are a bit-exact pass-through with a CPU reference;
 * dehaze matches the CPU mirror and pushes blacks; vignette matches the CPU
 * mirror and visibly darkens the corners of the on-screen canvas; grain
 * raises high-frequency energy while barely moving the mean and stays in
 * lockstep with the CPU mirror; clarity/texture (spatial, no CPU mirror)
 * raise high-frequency energy; one slider drag = one undo entry; effects
 * values survive the sidecar.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
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

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const sharpness = () => page.evaluate(() => window.__debug.readbackSharpness());
  const setDev = (path, value) =>
    page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);

  // the histogram refreshes debounced after each render (see ms10)
  const histogramAfter = async (mutate) => {
    const before = await page.evaluate(() => window.__debug.histogramState());
    await mutate();
    await page.waitForFunction(
      (prev) => {
        const h = window.__debug.histogramState();
        return h !== null && JSON.stringify(h) !== prev;
      },
      JSON.stringify(before),
      { timeout: 15_000 }
    );
    return page.evaluate(() => window.__debug.histogramState());
  };

  // mean luma of the on-screen canvas's corners vs its center, via a
  // screenshot decoded by sharp (region technique from verify-view)
  const cornerCenterRatio = async () => {
    const buf = await page.locator('.canvas-view-canvas').screenshot();
    const meta = await sharp(buf).metadata();
    const regionLuma = async (left, top, width, height) => {
      // stats() reads the pre-pipeline input, so materialize the crop first
      const region = await sharp(buf).extract({ left, top, width, height }).toBuffer();
      const stats = await sharp(region).stats();
      const [r, g, b] = stats.channels;
      return (0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean) / 255;
    };
    const rw = Math.max(8, Math.floor(meta.width * 0.15));
    const rh = Math.max(8, Math.floor(meta.height * 0.15));
    const corners = [
      await regionLuma(0, 0, rw, rh),
      await regionLuma(meta.width - rw, 0, rw, rh),
      await regionLuma(0, meta.height - rh, rw, rh),
      await regionLuma(meta.width - rw, meta.height - rh, rw, rh),
    ];
    const corner = corners.reduce((a, v) => a + v, 0) / corners.length;
    const cw = Math.max(8, Math.floor(meta.width * 0.2));
    const chh = Math.max(8, Math.floor(meta.height * 0.2));
    const center = await regionLuma(Math.floor((meta.width - cw) / 2), Math.floor((meta.height - chh) / 2), cw, chh);
    return corner / center;
  };

  console.log('verify-effects (defaults = identity with a CPU reference):');
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  const baseline = await gpuMean();
  const baselineSharp = await sharpness();
  const baselineHist = await page.evaluate(() => window.__debug.histogramState());
  const baselineCpu = await cpuMean();
  check('default plan has a CPU reference', baselineCpu !== null, baselineCpu);
  check('defaults: GPU matches CPU reference (within 1/255)', meansMatch(baseline, baselineCpu), {
    baseline,
    baselineCpu,
  });

  console.log('verify-effects (dehaze):');
  const dehazeHist = await histogramAfter(() => setDev('effects.dehaze', 50));
  const dehazed = await gpuMean();
  const dehazedCpu = await cpuMean();
  check('dehaze +50 GPU matches CPU reference (within 1/255)', meansMatch(dehazed, dehazedCpu), {
    dehazed,
    dehazedCpu,
  });
  check('dehaze +50 moves the mean', Math.abs(dehazed.g - baseline.g) > 0.01, {
    baseline: baseline.g,
    dehazed: dehazed.g,
  });
  check('dehaze +50 pushes blacks (shadowClip does not drop)', dehazeHist.shadowClip >= baselineHist.shadowClip, {
    baseline: baselineHist.shadowClip,
    dehazed: dehazeHist.shadowClip,
  });

  console.log('verify-effects (pass-skip identity on reset):');
  await setDev('effects.dehaze', 0);
  const back = await gpuMean();
  check(
    'dehaze reset restores the baseline render (within 1e-4)',
    meansMatch(back, baseline, 1e-4),
    { baseline, back }
  );

  console.log('verify-effects (vignette):');
  const ratioNeutral = await cornerCenterRatio();
  await setDev('effects.vignette', -80);
  const vignetted = await gpuMean();
  const vignettedCpu = await cpuMean();
  check('vignette -80 GPU matches CPU reference (within 1/255)', meansMatch(vignetted, vignettedCpu), {
    vignetted,
    vignettedCpu,
  });
  // the render effect is synchronous with the state change; give one frame
  await page.waitForTimeout(300);
  const ratioVignetted = await cornerCenterRatio();
  check('vignette -80 clearly darkens corners vs center on screen', ratioVignetted < ratioNeutral - 0.1, {
    neutral: ratioNeutral,
    vignetted: ratioVignetted,
  });
  await setDev('effects.vignette', 0);

  console.log('verify-effects (grain):');
  await setDev('effects.grain', 60);
  const grained = await gpuMean();
  const grainedCpu = await cpuMean();
  const grainedSharp = await sharpness();
  check('grain 60 raises luma gradient energy', grainedSharp.luma > baselineSharp.luma * 1.05, {
    baseline: baselineSharp.luma,
    grained: grainedSharp.luma,
  });
  check('grain 60 barely moves the mean (within 0.02)', Math.abs(grained.g - baseline.g) < 0.02, {
    baseline: baseline.g,
    grained: grained.g,
  });
  check('grain 60 GPU matches CPU reference (within 1/255)', meansMatch(grained, grainedCpu), {
    grained,
    grainedCpu,
  });
  await setDev('effects.grain', 0);

  console.log('verify-effects (clarity — spatial, no CPU mirror):');
  await setDev('effects.clarity', 80);
  const claritySharp = await sharpness();
  const clarityCpu = await cpuMean();
  check('clarity plan has no CPU reference (spatial, like Detail)', clarityCpu === null, clarityCpu);
  check('clarity +80 raises luma gradient energy', claritySharp.luma > baselineSharp.luma, {
    baseline: baselineSharp.luma,
    clarity: claritySharp.luma,
  });

  console.log('verify-effects (texture — spatial, no CPU mirror):');
  await setDev('effects.clarity', 0);
  await setDev('effects.texture', 80);
  const textureSharp = await sharpness();
  check('texture +80 raises luma gradient energy', textureSharp.luma > baselineSharp.luma, {
    baseline: baselineSharp.luma,
    texture: textureSharp.luma,
  });
  await setDev('effects.texture', 0);

  console.log('verify-effects (one slider drag = one undo entry):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const effectsSection = page.locator('.inspector-section').filter({ hasText: 'Effects' }).first();
  check(
    'Effects section shows the 7 sliders',
    (await effectsSection.locator('.param-row').count()) === 7,
    await effectsSection.locator('.param-row').count()
  );
  const dehazeSlider = effectsSection.locator('.param-row').first().locator('input[type="range"]');
  // the inspector column scrolls and Effects sits at the bottom — bring the
  // slider into view before reading the bounding box the mouse events use
  await dehazeSlider.scrollIntoViewIfNeeded();
  const box = await dehazeSlider.boundingBox();
  const pastBefore = await page.evaluate(() => window.__debug.historyState().past);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const draggedDehaze = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.effects?.dehaze
  );
  check('slider drag sets a positive dehaze', draggedDehaze > 0, draggedDehaze);
  check(
    'one slider drag = one undo entry',
    (await page.evaluate(() => window.__debug.historyState().past)) === pastBefore + 1,
    { before: pastBefore, after: await page.evaluate(() => window.__debug.historyState().past) }
  );

  console.log('verify-effects (sidecar round-trip):');
  await setDev('effects.dehaze', 30);
  await setDev('effects.clarity', 25);
  await setDev('effects.grain', 20);
  await setDev('effects.vignette', -40);
  const edited = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredEffects = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.effects
  );
  check(
    'reopen restores the effects values',
    restoredEffects &&
      restoredEffects.dehaze === 30 &&
      restoredEffects.clarity === 25 &&
      restoredEffects.grain === 20 &&
      restoredEffects.vignette === -40 &&
      restoredEffects.grainSize === 1.5 &&
      restoredEffects.vignetteMidpoint === 0.5,
    restoredEffects
  );
  const restored = await gpuMean();
  check('restored effects render like before the save', meansMatch(restored, edited), { edited, restored });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
