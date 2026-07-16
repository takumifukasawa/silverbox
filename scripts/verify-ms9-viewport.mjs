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
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
ensureTestProjectEnv();
rmLook(ARW_PATH);

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

  console.log('verify-ms9 (round-6: trackpad pinch — ctrlKey wheel — zooms the viewport):');
  // Playwright's page.mouse.wheel() can't set ctrlKey, so dispatch a real
  // WheelEvent by hand — this is exactly how Chromium/Electron represents a
  // macOS trackpad pinch (there's no separate pinch/gesture event).
  const dispatchCtrlWheel = (deltaY) =>
    page.locator('.canvas-viewport').evaluate((el, dy) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: dy,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    }, deltaY);
  const beforePinch = await viewState();
  await dispatchCtrlWheel(-5); // typical single-event pinch deltaY magnitude
  await page.waitForTimeout(30);
  const afterPinch = await viewState();
  check('ctrl+wheel (trackpad pinch) zooms in', afterPinch.scale > beforePinch.scale, {
    before: beforePinch.scale,
    after: afterPinch.scale,
  });

  console.log('verify-ms9 (round-7 UX pack G §2: Space = smooth animated fit/center):');
  // still zoomed in from the pinch section above
  const beforeSpace = await viewState();
  check('setup: currently zoomed in (not already at fit)', beforeSpace.mode !== 'fit', beforeSpace);
  await page.keyboard.press('Space');
  // poll-until, not wall-clock: fitAnimated's FINAL frame sets mode:'fit' with
  // the exact computeFit() result (same as a plain fit() call) — wait for
  // that instead of assuming the ~250ms duration.
  await page.waitForFunction(() => window.__debug.canvasView().mode === 'fit', { timeout: 2_000 });
  const afterSpace = await viewState();
  check('Space lands exactly on the fit target (scale)', Math.abs(afterSpace.scale - fitView.scale) < 1e-6, {
    expected: fitView.scale,
    actual: afterSpace.scale,
  });
  check(
    'Space lands exactly on the fit target (tx/ty)',
    Math.abs(afterSpace.tx - fitView.tx) < 1e-6 && Math.abs(afterSpace.ty - fitView.ty) < 1e-6,
    { expected: { tx: fitView.tx, ty: fitView.ty }, actual: { tx: afterSpace.tx, ty: afterSpace.ty } }
  );

  console.log('verify-ms9 (round-7: a wheel event mid-animation cancels it — a new gesture wins instantly):');
  await page.locator('[data-testid="view-100"]').click(); // back to zoomed in, away from fit
  // The click above focuses the "100%" BUTTON — Space must keep activating a
  // focused button natively (App.tsx's guard), so it wouldn't reach the
  // viewport's fitAnimated at all from here. A plain click on the canvas
  // itself blurs the button back to no-particular-focus (body), same as the
  // double-click earlier in this script.
  await page.mouse.click(cx, cy);
  const beforeSpace2 = await viewState();
  await page.keyboard.press('Space');
  await page.waitForTimeout(30); // interrupt well before the ~250ms animation would finish
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240); // wheel zooms in further — must win instantly
  const rightAfterWheel = await viewState();
  // give a (correctly-cancelled) rAF loop a couple more frames' worth of grace
  // — if it were somehow still running, scale would keep drifting afterward
  await page.waitForTimeout(100);
  const settledAfterWheel = await viewState();
  check(
    'the animation actually stopped (no further drift after the interrupting wheel event)',
    Math.abs(settledAfterWheel.scale - rightAfterWheel.scale) < 1e-9,
    { rightAfterWheel, settledAfterWheel }
  );
  check('the wheel zoom took effect (scale followed the wheel, zoomed in further from 100%)', settledAfterWheel.scale > beforeSpace2.scale, {
    beforeSpace2,
    settledAfterWheel,
  });
  check(
    'the interrupted fit never completed (scale stayed well away from the fit target)',
    Math.abs(settledAfterWheel.scale - fitView.scale) > 0.05,
    { fitScale: fitView.scale, settledAfterWheel }
  );
  check('mode is "free" (not "fit") after a wheel interrupts the animation', settledAfterWheel.mode === 'free', settledAfterWheel);

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
