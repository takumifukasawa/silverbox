/**
 * Milestone 9 verify: canvas zoom/pan. Fit by default (image fully inside the
 * viewport), 100% button gives 1:1 device pixels, double-click toggles,
 * wheel zooms around the cursor, drag pans, Fit restores.
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

  const viewState = () => page.evaluate(() => window.__debug.canvasView());
  const viewportBox = () => page.locator('.canvas-viewport').boundingBox();

  console.log('verify-ms9 (fit by default):');
  const fitView = await viewState();
  const img = await page.evaluate(() => window.__debug.imageState());
  const box = await viewportBox();
  check('opens in fit mode', fitView.mode === 'fit', fitView);
  check(
    'fit scale makes the long edge fill the viewport',
    Math.abs(Math.min(box.width / img.width, box.height / img.height) - fitView.scale) < 0.01,
    { fitView, box, img: { w: img.width, h: img.height } }
  );

  console.log('verify-ms9 (100% and Fit buttons):');
  await page.locator('[data-testid="view-100"]').click();
  const oneToOne = await viewState();
  check('100% sets scale to one device pixel per image pixel', Math.abs(oneToOne.scale - 1 / oneToOne.dpr) < 1e-6, oneToOne);
  check(
    'zoom readout says 100%',
    (await page.locator('[data-testid="zoom-readout"]').textContent()) === '100%',
    await page.locator('[data-testid="zoom-readout"]').textContent()
  );
  await page.locator('[data-testid="view-fit"]').click();
  check('Fit returns to fit mode', (await viewState()).mode === 'fit', await viewState());

  console.log('verify-ms9 (double-click resets to fit):');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.locator('[data-testid="view-100"]').click();
  await page.mouse.dblclick(cx, cy);
  check('double-click resets to fit', (await viewState()).mode === 'fit', await viewState());

  console.log('verify-ms9 (wheel zoom + drag pan):');
  const beforeWheel = await viewState();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  const afterWheel = await viewState();
  check('wheel up zooms in', afterWheel.scale > beforeWheel.scale, { before: beforeWheel.scale, after: afterWheel.scale });

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 40, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await viewState();
  check(
    'drag pans the view by the pointer delta',
    Math.abs(afterDrag.tx - afterWheel.tx - 80) < 2 && Math.abs(afterDrag.ty - afterWheel.ty - 40) < 2,
    { afterWheel, afterDrag }
  );

  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms9-zoom.png') });
  console.log('screenshot: test-artifacts/ms9-zoom.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
