/**
 * Spec-alignment verify (REBUILD-SPEC MS9): point tone curve. Identity =
 * pass-skip, a midtone lift built by DRAGGING in the editor matches the CPU
 * reference (shared PCHIP LUT), per-channel curves act on their channel,
 * endpoint drags move the black point, double-click deletes, Reset restores
 * identity, one drag = one undo entry, and curves survive the sidecar.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;

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

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const curveOf = (ch) =>
    page.evaluate((c) => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.toneCurve?.[c], ch);
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);

  console.log('verify-tonecurve (editor + drag builds a midtone lift):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const svg = page.locator('[data-testid="curve-editor"]');
  // the toolbar can wrap to multiple rows (export controls), pushing the
  // editor below the fold of the scrolling inspector — mouse coordinates
  // only work on-screen
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  check('curve editor is visible in the Develop panel', !!box, box);
  const pastBefore = await historyPast();
  // click the center of the plot (adds a point at ~128) and drag upward
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - box.height * 0.15, { steps: 6 });
  await page.mouse.up();
  const rgbCurve = await curveOf('rgb');
  check(
    'drag added a lifted midtone point',
    rgbCurve.length === 3 && rgbCurve[1][1] > rgbCurve[1][0],
    rgbCurve
  );
  check('one drag (incl. the add) = one undo entry', (await historyPast()) === pastBefore + 1, {
    before: pastBefore,
    after: await historyPast(),
  });
  const lifted = await gpuMean();
  const liftedCpu = await cpuMean();
  check('lifted curve GPU matches CPU reference (within 1/255)', meansMatch(lifted, liftedCpu), {
    lifted,
    liftedCpu,
  });
  check('midtone lift brightens the image', lifted.g > neutral.g + 0.02, { neutral: neutral.g, lifted: lifted.g });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'tonecurve.png') });

  console.log('verify-tonecurve (undo removes the whole drag):');
  await page.keyboard.press('Meta+z');
  const afterUndo = await gpuMean();
  check('⌘Z restores the identity render', meansMatch(afterUndo, neutral), { neutral, afterUndo });
  await page.keyboard.press('Meta+Shift+z');

  console.log('verify-tonecurve (per-channel red curve):');
  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'r', [
      [0, 40],
      [255, 255],
    ])
  );
  const redLift = await gpuMean();
  const redLiftCpu = await cpuMean();
  check('red curve GPU matches CPU reference (within 1/255)', meansMatch(redLift, redLiftCpu), {
    redLift,
    redLiftCpu,
  });
  check(
    'red black-point lift raises R far more than G',
    redLift.r - redLift.g > neutral.r - neutral.g + 0.02,
    { neutral, redLift }
  );
  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'r', [
      [0, 0],
      [255, 255],
    ])
  );

  console.log('verify-tonecurve (channel tabs, dblclick delete, Reset):');
  await page.locator('[data-testid="curve-tab-rgb"]').click();
  check(
    'non-identity channel shows its dot on the tab',
    (await page.locator('[data-testid="curve-tab-rgb"] .tonecurve-dot').count()) === 1,
    await page.locator('[data-testid="curve-tab-rgb"] .tonecurve-dot').count()
  );
  // double-click the lifted midpoint to delete it
  const cur = await curveOf('rgb');
  const px = box.x + (cur[1][0] / 255) * box.width;
  const py = box.y + (1 - cur[1][1] / 255) * box.height;
  await page.mouse.dblclick(px, py);
  const afterDelete = await curveOf('rgb');
  check('double-click deletes the midpoint', afterDelete.length === 2, afterDelete);

  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'rgb', [
      [0, 30],
      [128, 160],
      [255, 255],
    ])
  );
  await page.locator('[data-testid="curve-reset"]').click();
  const afterReset = await curveOf('rgb');
  check(
    'Reset restores the identity point set',
    afterReset.length === 2 && afterReset[0][1] === 0 && afterReset[1][1] === 255,
    afterReset
  );
  const resetRender = await gpuMean();
  check('reset render equals the neutral render', meansMatch(resetRender, neutral), { neutral, resetRender });

  console.log('verify-tonecurve (sidecar round-trip):');
  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'rgb', [
      [0, 0],
      [96, 150],
      [255, 255],
    ])
  );
  const curved = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredCurve = await curveOf('rgb');
  check('reopen restores the curve points', JSON.stringify(restoredCurve) === '[[0,0],[96,150],[255,255]]',
    restoredCurve);
  const restored = await gpuMean();
  check('restored curve renders like before the save', meansMatch(restored, curved), { curved, restored });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
