/**
 * Milestone 10 verify: histogram + clipping indicators. Checks the histogram
 * accounts for every pixel, its weighted mean agrees with the GPU readback,
 * and pushing exposure to the extremes lights the highlight/shadow badges.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });

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

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  // the histogram refreshes debounced after each render
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

  console.log('verify-ms10 (histogram accounts for the render):');
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  const hist = await page.evaluate(() => window.__debug.histogramState());
  const sums = ['r', 'g', 'b'].map((c) => hist[c].reduce((a, v) => a + v, 0));
  check(
    'each channel histogram sums to the pixel count',
    sums.every((s) => s === hist.pixels),
    { sums, pixels: hist.pixels }
  );
  const gpuMean = await page.evaluate(() => window.__debug.readbackMean());
  const histMean = (counts) =>
    counts.reduce((a, v, i) => a + v * ((i + 0.5) / hist.bins), 0) / hist.pixels;
  check(
    'histogram-weighted mean agrees with the GPU readback (within 1/64)',
    Math.abs(histMean(hist.r) - gpuMean.r) < 1 / 64 &&
      Math.abs(histMean(hist.g) - gpuMean.g) < 1 / 64 &&
      Math.abs(histMean(hist.b) - gpuMean.b) < 1 / 64,
    { histMean: { r: histMean(hist.r), g: histMean(hist.g), b: histMean(hist.b) }, gpuMean }
  );
  check(
    'histogram canvas is in the inspector',
    (await page.locator('[data-testid="histogram-canvas"]').count()) === 1,
    await page.locator('[data-testid="histogram-canvas"]').count()
  );

  console.log('verify-ms10 (clipping indicators):');
  const baseHighlight = hist.highlightClip;
  const overexposed = await histogramAfter(() =>
    page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 4))
  );
  check('+4 EV clips highlights hard', overexposed.highlightClip > Math.max(0.2, baseHighlight), {
    before: baseHighlight,
    after: overexposed.highlightClip,
  });
  check(
    'highlight badge lights up',
    (await page.locator('[data-testid="clip-highlights"]').getAttribute('class'))?.includes('lit'),
    await page.locator('[data-testid="clip-highlights"]').getAttribute('class')
  );

  const underexposed = await histogramAfter(() =>
    page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', -4))
  );
  check('-4 EV clips shadows', underexposed.shadowClip > overexposed.shadowClip, {
    over: overexposed.shadowClip,
    under: underexposed.shadowClip,
  });
  check(
    'shadow badge lights up',
    (await page.locator('[data-testid="clip-shadows"]').getAttribute('class'))?.includes('lit'),
    await page.locator('[data-testid="clip-shadows"]').getAttribute('class')
  );

  console.log('verify-ms10 (GPU histogram compute matches a JS recomputation, bit-for-bit, on a small crop):');
  // small crop (not the whole frame) so the pixel data crosses the Playwright
  // debug bridge fast — the GPU compute path (statsCrop) and the reference
  // JS loop below both operate on the SAME real pixels (encodedCropForVerify,
  // a verify-only full-frame CPU readback kept for exactly this purpose).
  const outDims = await page.evaluate(() => window.__debug.outputDims());
  const cropW = Math.min(64, outDims.width);
  const cropH = Math.min(64, outDims.height);
  const cx0 = Math.floor((outDims.width - cropW) / 2);
  const cy0 = Math.floor((outDims.height - cropH) / 2);
  const gpuCrop = await page.evaluate(
    ([x0, y0, w, h]) => window.__debug.statsCrop(x0, y0, w, h),
    [cx0, cy0, cropW, cropH]
  );
  const cropPixels = await page.evaluate(
    ([x0, y0, w, h]) => window.__debug.encodedCropForVerify(x0, y0, w, h),
    [cx0, cy0, cropW, cropH]
  );
  // mirrors src/renderer/engine/color/workingSpace.ts's WORKING_LUMA and the
  // OLD CPU histogram loop's exact formula (Math.round, min(255, ...))
  const WORKING_LUMA = [0.2126, 0.7152, 0.0722];
  const expected = {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    luma: new Array(256).fill(0),
    shadow: 0,
    highlight: 0,
  };
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const s = (y * cropW + x) * 4;
      const vr = cropPixels[s];
      const vg = cropPixels[s + 1];
      const vb = cropPixels[s + 2];
      expected.r[vr]++;
      expected.g[vg]++;
      expected.b[vb]++;
      expected.luma[Math.min(255, Math.round(WORKING_LUMA[0] * vr + WORKING_LUMA[1] * vg + WORKING_LUMA[2] * vb))]++;
      if (vr === 0 || vg === 0 || vb === 0) expected.shadow++;
      if (vr === 255 || vg === 255 || vb === 255) expected.highlight++;
    }
  }
  const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  check('GPU histogram r bins match the JS recomputation exactly (crop)', arraysEqual(gpuCrop.r, expected.r), {
    diffAt: gpuCrop.r.findIndex((v, i) => v !== expected.r[i]),
  });
  check('GPU histogram g bins match the JS recomputation exactly (crop)', arraysEqual(gpuCrop.g, expected.g), {
    diffAt: gpuCrop.g.findIndex((v, i) => v !== expected.g[i]),
  });
  check('GPU histogram b bins match the JS recomputation exactly (crop)', arraysEqual(gpuCrop.b, expected.b), {
    diffAt: gpuCrop.b.findIndex((v, i) => v !== expected.b[i]),
  });
  check('GPU histogram luma bins match the JS recomputation exactly (crop)', arraysEqual(gpuCrop.luma, expected.luma), {
    diffAt: gpuCrop.luma.findIndex((v, i) => v !== expected.luma[i]),
  });
  const gpuShadow = Math.round(gpuCrop.shadowClip * gpuCrop.pixels);
  const gpuHighlight = Math.round(gpuCrop.highlightClip * gpuCrop.pixels);
  check(
    'GPU shadow/highlight clip counts match the JS recomputation exactly (crop)',
    gpuShadow === expected.shadow && gpuHighlight === expected.highlight,
    { gpu: { shadow: gpuShadow, highlight: gpuHighlight }, expected: { shadow: expected.shadow, highlight: expected.highlight } }
  );

  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms10-histogram.png') });
  console.log('screenshot: test-artifacts/ms10-histogram.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
