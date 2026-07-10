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
