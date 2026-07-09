/**
 * Video-style scopes: the histogram panel's mode row (Hist / Wave / Parade /
 * Vec). Wave/Parade/Vec draw from GraphRenderer.scopeSamples() — a strided
 * RGB grid of the encoded output — instead of the 256-bin histogram.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

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

  console.log('verify-scopes (default mode):');
  // the histogram panel only mounts once the first debounced stats() lands
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  const initial = await page.evaluate(() => window.__debug.scopeState());
  check('default scope mode is histogram', initial.mode === 'histogram', initial);
  check(
    'histogram canvas is present',
    (await page.locator('[data-testid="histogram-canvas"]').count()) === 1,
    await page.locator('[data-testid="histogram-canvas"]').count()
  );

  console.log('verify-scopes (waveform mode fetches samples):');
  await page.locator('[data-testid="scope-mode-waveform"]').click();
  await page.waitForFunction(
    () => {
      const s = window.__debug.scopeState();
      return s.mode === 'waveform' && s.samples !== null;
    },
    { timeout: 5_000 }
  );
  const waveState = await page.evaluate(() => window.__debug.scopeState());
  check('mode reports waveform', waveState.mode === 'waveform', waveState);
  check('samples cols <= 256', waveState.samples.cols <= 256, waveState.samples);
  check('samples rows <= 144', waveState.samples.rows <= 144, waveState.samples);
  check(
    'sample buffer length is cols*rows*3',
    waveState.samples.length === waveState.samples.cols * waveState.samples.rows * 3,
    waveState.samples
  );

  console.log('verify-scopes (deterministic: +2 EV raises mean luma):');
  const baseLuma = waveState.samples.meanLuma;
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2));
  await page.waitForFunction(
    (prevLuma) => {
      const s = window.__debug.scopeState();
      return s.samples !== null && s.samples.meanLuma > prevLuma + 0.1;
    },
    baseLuma,
    { timeout: 15_000 }
  );
  const brighterState = await page.evaluate(() => window.__debug.scopeState());
  check('+2 EV raises mean luma by > 0.1', brighterState.samples.meanLuma > baseLuma + 0.1, {
    before: baseLuma,
    after: brighterState.samples.meanLuma,
  });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));

  console.log('verify-scopes (parade + vectorscope):');
  await page.locator('[data-testid="scope-mode-parade"]').click();
  await page.waitForFunction(() => window.__debug.scopeState().mode === 'parade', { timeout: 5_000 });
  check(
    'parade mode is reported and the canvas is still rendered',
    (await page.evaluate(() => window.__debug.scopeState())).mode === 'parade' &&
      (await page.locator('[data-testid="histogram-canvas"]').count()) === 1,
    await page.evaluate(() => window.__debug.scopeState())
  );

  await page.locator('[data-testid="scope-mode-vectorscope"]').click();
  await page.waitForFunction(() => window.__debug.scopeState().mode === 'vectorscope', { timeout: 5_000 });
  check(
    'vectorscope mode is reported and the canvas is still rendered',
    (await page.evaluate(() => window.__debug.scopeState())).mode === 'vectorscope' &&
      (await page.locator('[data-testid="histogram-canvas"]').count()) === 1,
    await page.evaluate(() => window.__debug.scopeState())
  );
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'scopes-vectorscope.png') });

  console.log('verify-scopes (back to Hist):');
  await page.locator('[data-testid="scope-mode-histogram"]').click();
  await page.waitForFunction(() => window.__debug.scopeState().mode === 'histogram', { timeout: 5_000 });
  const backState = await page.evaluate(() => window.__debug.scopeState());
  check('mode switches back to histogram', backState.mode === 'histogram', backState);
  check(
    'histogram canvas is still drawn',
    (await page.locator('[data-testid="histogram-canvas"]').count()) === 1,
    await page.locator('[data-testid="histogram-canvas"]').count()
  );
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
