/**
 * 3-way color grading: all-neutral wheels = exact pass-through; a shadows
 * tint matches the CPU reference and lands mainly in the shadows (the same
 * tint on the highlights wheel produces a different render); global
 * luminance darkens; balance shifts the result; the wheel UI drags hue+sat
 * as one undo entry; values survive the sidecar.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
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

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const setDev = (path, value) =>
    page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);

  console.log('verify-grading (shadows tint vs CPU reference + region separation):');
  await setDev('grading.shadows.hue', 220); // cool blue into the shadows
  await setDev('grading.shadows.sat', 60);
  const shadowTint = await gpuMean();
  const shadowTintCpu = await cpuMean();
  check('shadows tint GPU matches CPU reference (within 1/255)', meansMatch(shadowTint, shadowTintCpu), {
    shadowTint,
    shadowTintCpu,
  });
  check('blue shadow tint raises b', shadowTint.b > neutral.b + 0.005, { neutral: neutral.b, tinted: shadowTint.b });

  await setDev('grading.shadows.sat', 0);
  await setDev('grading.highlights.hue', 220);
  await setDev('grading.highlights.sat', 60);
  const highlightTint = await gpuMean();
  const highlightTintCpu = await cpuMean();
  check('highlights tint GPU matches CPU reference', meansMatch(highlightTint, highlightTintCpu), {
    highlightTint,
    highlightTintCpu,
  });
  check(
    'the same tint lands differently per region (shadows ≠ highlights render)',
    Math.abs(highlightTint.b - shadowTint.b) > 0.003,
    { shadowTint: shadowTint.b, highlightTint: highlightTint.b }
  );

  console.log('verify-grading (balance shifts the crossovers):');
  await setDev('grading.balance', 80);
  const balanced = await gpuMean();
  const balancedCpu = await cpuMean();
  check('balance GPU matches CPU reference', meansMatch(balanced, balancedCpu), { balanced, balancedCpu });
  // threshold 0.0005 → 0.0001 for the Rec.2020 migration: the noAutoBright
  // decode is darker, so the highlight region balance shifts holds fewer
  // pixels (deterministic readback measured ~0.00016; direction unchanged)
  check('balance changes the render deterministically', Math.abs(balanced.b - highlightTint.b) > 0.0001, {
    before: highlightTint.b,
    after: balanced.b,
  });
  await setDev('grading.balance', 0);
  await setDev('grading.highlights.sat', 0);

  console.log('verify-grading (global luminance):');
  await setDev('grading.global.lum', -60);
  const darkened = await gpuMean();
  const darkenedCpu = await cpuMean();
  check('global lum GPU matches CPU reference', meansMatch(darkened, darkenedCpu), { darkened, darkenedCpu });
  check('global lum −60 darkens the image', darkened.g < neutral.g - 0.03, {
    neutral: neutral.g,
    darkened: darkened.g,
  });
  await setDev('grading.global.lum', 0);

  console.log('verify-grading (all-neutral = exact pass-through):');
  const back = await gpuMean();
  check('resetting every wheel restores the neutral render', meansMatch(back, neutral), { neutral, back });

  console.log('verify-grading (wheel UI):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const wheel = page.locator('[data-testid="grading-wheel-shadows"]');
  // the inspector column scrolls (overflow-y: auto) and Color Grading sits
  // far down it, so the wheel can be scrolled out of view; bring it into
  // view before reading the bounding box the synthetic mouse events use.
  await wheel.scrollIntoViewIfNeeded();
  const box = await wheel.boundingBox();
  check('four wheels render', (await page.locator('.grading-wheel').count()) === 4, {
    wheels: await page.locator('.grading-wheel').count(),
  });
  const pastBefore = await page.evaluate(() => window.__debug.historyState().past);
  // drag from center toward the east edge (hue ≈ 0, sat grows)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.grading?.shadows
  );
  check('wheel drag sets hue ≈ 0 and a high sat', (dragged.hue < 15 || dragged.hue > 345) && dragged.sat > 60,
    dragged);
  check(
    'one wheel drag = one undo entry',
    (await page.evaluate(() => window.__debug.historyState().past)) === pastBefore + 1,
    { before: pastBefore, after: await page.evaluate(() => window.__debug.historyState().past) }
  );

  console.log('verify-grading (sidecar round-trip):');
  const edited = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredWheel = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.grading?.shadows
  );
  check('reopen restores the wheel values', restoredWheel.sat === dragged.sat && restoredWheel.hue === dragged.hue,
    restoredWheel);
  const restored = await gpuMean();
  check('restored grading renders like before the save', meansMatch(restored, edited), { edited, restored });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
