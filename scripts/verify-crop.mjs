/**
 * Crop + straighten verify: defaults are identity with a CPU reference (the
 * geometry pass adds zero cost when untouched); a 50%×50% center crop halves
 * outputDims, drops the CPU reference (spatial resample, no mirror — same
 * rule as Detail/clarity), and matches a screenshot-derived mean of the SAME
 * center region taken before cropping; straighten (angle) returns outputDims
 * to baseline (crop stays full) and changes the render, restoring exactly on
 * reset; one crop-handle drag = one undo entry; geometry survives the
 * sidecar; export crops the full-resolution render by the same fraction.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const OUT_JPG = join(projectRoot, 'test-artifacts', 'crop-export.jpg');
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
if (existsSync(OUT_JPG)) unlinkSync(OUT_JPG);
mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const outputDims = () => page.evaluate(() => window.__debug.outputDims());
  const geometryState = () => page.evaluate(() => window.__debug.geometryState());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const setGeometry = (geo) => page.evaluate((g) => window.__debug.setGeometry(g), geo);

  // The preview render (and the canvas resize that follows it) is async —
  // poll outputDims() until it matches what a given geometry mutation should
  // produce, instead of racing a fixed sleep against React's effect.
  const waitForOutputDims = (w, h, tol = 0) =>
    page.waitForFunction(
      ({ w, h, tol }) => {
        const d = window.__debug.outputDims();
        return !!d && Math.abs(d.width - w) <= tol && Math.abs(d.height - h) <= tol;
      },
      { w, h, tol },
      { timeout: 15_000 }
    );

  // mean of a normalized rect on the on-screen canvas via a screenshot,
  // decoded with sharp — stats() reads the pre-pipeline input, so the crop
  // must be materialized with toBuffer() BEFORE stats() (same technique as
  // verify-effects's cornerCenterRatio)
  const regionMean = async (x, y, w, h) => {
    const buf = await page.locator('.canvas-view-canvas').screenshot();
    const meta = await sharp(buf).metadata();
    const left = Math.round(meta.width * x);
    const top = Math.round(meta.height * y);
    const width = Math.max(1, Math.round(meta.width * w));
    const height = Math.max(1, Math.round(meta.height * h));
    const region = await sharp(buf)
      .extract({ left, top, width: Math.min(width, meta.width - left), height: Math.min(height, meta.height - top) })
      .toBuffer();
    const stats = await sharp(region).stats();
    const [r, g, b] = stats.channels;
    return { r: r.mean / 255, g: g.mean / 255, b: b.mean / 255 };
  };

  console.log('verify-crop (baseline identity):');
  // the canvas starts at the browser's default 300×150 until the first
  // render lands — histogramState() only turns non-null after that render's
  // debounced stats() call, so it is a reliable "first frame is up" signal
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  const baselineDims = await outputDims();
  const baselineMean = await gpuMean();
  const baselineCpu = await cpuMean();
  check('default geometry has a CPU reference', baselineCpu !== null, baselineCpu);
  check('defaults: GPU matches CPU reference (within 1/255)', meansMatch(baselineMean, baselineCpu), {
    baselineMean,
    baselineCpu,
  });

  console.log('verify-crop (central-region baseline, screenshot-derived):');
  const baselineCentral = await regionMean(0.25, 0.25, 0.5, 0.5);

  console.log('verify-crop (crop to the center 50%×50%):');
  await setGeometry({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0 });
  const halfW = Math.round(baselineDims.width * 0.5);
  const halfH = Math.round(baselineDims.height * 0.5);
  await waitForOutputDims(halfW, halfH, 1);
  const croppedDims = await outputDims();
  check(
    'crop halves outputDims (±1px each axis)',
    Math.abs(croppedDims.width - baselineDims.width / 2) <= 1 && Math.abs(croppedDims.height - baselineDims.height / 2) <= 1,
    { baselineDims, croppedDims }
  );
  const croppedCpu = await cpuMean();
  check('cropped plan has no CPU reference (geometry, like spatial ops)', croppedCpu === null, croppedCpu);
  const croppedMean = await gpuMean();
  check(
    'cropped readback matches the pre-crop central-region screenshot mean (within 0.03)',
    meansMatch(croppedMean, baselineCentral, 0.03),
    { croppedMean, baselineCentral }
  );
  check('no page errors from the crop pass', pageErrors.length === 0, pageErrors);

  console.log('verify-crop (straighten — angle only):');
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 10 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  const angledDims = await outputDims();
  check(
    'full crop + angle returns outputDims to baseline',
    angledDims.width === baselineDims.width && angledDims.height === baselineDims.height,
    { baselineDims, angledDims }
  );
  const angledMean = await gpuMean();
  check(
    'angle 10 changes the render vs baseline',
    Math.abs(angledMean.r - baselineMean.r) > 1e-3 ||
      Math.abs(angledMean.g - baselineMean.g) > 1e-3 ||
      Math.abs(angledMean.b - baselineMean.b) > 1e-3,
    { baselineMean, angledMean }
  );
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  const restoredMean = await gpuMean();
  check('identity restores the baseline render (within 1e-4)', meansMatch(restoredMean, baselineMean, 1e-4), {
    baselineMean,
    restoredMean,
  });

  console.log('verify-crop (UI: drag a corner handle = one undo entry):');
  await page.locator('[data-testid="crop-toggle"]').click();
  await page.waitForSelector('[data-testid="crop-overlay"]', { timeout: 5_000 });
  // crop mode previews the full (uncropped) straightened frame regardless of
  // the committed crop, so entering it never changes outputDims
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  const geomBeforeDrag = await geometryState();
  const pastBeforeDrag = await historyPast();
  const handle = page.locator('[data-testid="crop-handle-se"]');
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y - 90, { steps: 6 }); // drag SE corner inward: shrinks the rect
  await page.mouse.up();
  const geomAfterDrag = await geometryState();
  check('drag changed geometryState', JSON.stringify(geomAfterDrag) !== JSON.stringify(geomBeforeDrag), {
    geomBeforeDrag,
    geomAfterDrag,
  });
  check('one drag = one undo entry', (await historyPast()) === pastBeforeDrag + 1, {
    before: pastBeforeDrag,
    after: await historyPast(),
  });
  const draggedW = Math.round(baselineDims.width * geomAfterDrag.crop.w);
  const draggedH = Math.round(baselineDims.height * geomAfterDrag.crop.h);
  await page.locator('[data-testid="crop-done"]').click();
  await waitForOutputDims(draggedW, draggedH, 1);
  const dimsAfterDone = await outputDims();
  check(
    'exiting crop mode applies the smaller committed crop',
    dimsAfterDone.width < baselineDims.width && dimsAfterDone.height < baselineDims.height,
    { baselineDims, dimsAfterDone }
  );
  await page.keyboard.press('Meta+z');
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  const dimsAfterUndo = await outputDims();
  check(
    '⌘Z restores the previous outputDims',
    dimsAfterUndo.width === baselineDims.width && dimsAfterUndo.height === baselineDims.height,
    { baselineDims, dimsAfterUndo }
  );

  console.log('verify-crop (LR-style rotate: drag OUTSIDE a corner changes angle, one undo entry, crop box stays axis-aligned):');
  // Fresh, known geometry + a fresh crop-mode entry (the previous section
  // left crop mode via "Done"), so this test doesn't depend on the dragged
  // crop rect from the section above.
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  await page.locator('[data-testid="crop-toggle"]').click();
  await page.waitForSelector('[data-testid="crop-overlay"]', { timeout: 5_000 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);

  const cropRect = page.locator('[data-testid="crop-rect"]');
  const rectBoxBeforeRotate = await cropRect.boundingBox();
  const geomBeforeRotate = await geometryState();
  const pastBeforeRotate = await historyPast();

  const rotateZone = page.locator('[data-testid="crop-rotate-se"]');
  await rotateZone.scrollIntoViewIfNeeded();
  const rzBox = await rotateZone.boundingBox();
  await page.mouse.move(rzBox.x + rzBox.width / 2, rzBox.y + rzBox.height / 2);
  await page.mouse.down();
  // sweep the SE rotate zone further out and down — an angular drag around
  // the crop rect's own center, not merely a radial one
  await page.mouse.move(rzBox.x + rzBox.width / 2 + 10, rzBox.y + rzBox.height / 2 + 40, { steps: 8 });
  await page.mouse.up();

  const geomAfterRotate = await geometryState();
  const rectBoxAfterRotate = await cropRect.boundingBox();
  check('outside-corner drag changed the angle (crop rect x/y/w/h untouched)', geomAfterRotate.angle !== geomBeforeRotate.angle, {
    before: geomBeforeRotate,
    after: geomAfterRotate,
  });
  check(
    "rotating left the crop rect's x/y/w/h exactly as committed (only angle moved)",
    geomAfterRotate.crop.x === geomBeforeRotate.crop.x &&
      geomAfterRotate.crop.y === geomBeforeRotate.crop.y &&
      geomAfterRotate.crop.w === geomBeforeRotate.crop.w &&
      geomAfterRotate.crop.h === geomBeforeRotate.crop.h,
    { before: geomBeforeRotate.crop, after: geomAfterRotate.crop }
  );
  check('outside-corner rotate drag is exactly one undo entry', (await historyPast()) === pastBeforeRotate + 1, {
    before: pastBeforeRotate,
    after: await historyPast(),
  });
  check(
    "the crop rect's on-screen box stays axis-aligned and in the SAME place while rotating (its bounding box is unchanged)",
    Math.abs(rectBoxAfterRotate.x - rectBoxBeforeRotate.x) < 1 &&
      Math.abs(rectBoxAfterRotate.y - rectBoxBeforeRotate.y) < 1 &&
      Math.abs(rectBoxAfterRotate.width - rectBoxBeforeRotate.width) < 1 &&
      Math.abs(rectBoxAfterRotate.height - rectBoxBeforeRotate.height) < 1,
    { rectBoxBeforeRotate, rectBoxAfterRotate }
  );
  // the box being unrotated (not just unmoved) is the real "axis-aligned"
  // claim — assert the actual computed transform has no skew/rotate component
  const cropOverlayTransform = await page.locator('[data-testid="crop-overlay"]').evaluate((el) => getComputedStyle(el).transform);
  check(
    'the crop-overlay element itself carries only translate+uniform-scale (no rotation matrix component)',
    /^matrix\(([-\d.e]+), 0, 0, \1,/.test(cropOverlayTransform),
    cropOverlayTransform
  );

  // ±45° clamp still holds via this new gesture too (existing invariant, not loosened)
  await page.mouse.move(rzBox.x + rzBox.width / 2, rzBox.y + rzBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rzBox.x + rzBox.width / 2 - 400, rzBox.y + rzBox.height / 2 + 400, { steps: 10 });
  await page.mouse.up();
  const geomClamped = await geometryState();
  check('the ±45° clamp still holds via the outside-corner gesture', Math.abs(geomClamped.angle) <= 45, geomClamped);

  await page.locator('[data-testid="crop-reset"]').click();
  await page.locator('[data-testid="crop-done"]').click();
  await waitForOutputDims(baselineDims.width, baselineDims.height);

  console.log('verify-crop (sidecar round-trip):');
  await setGeometry({ crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }, angle: 7.5 });
  const sidecarW = Math.round(baselineDims.width * 0.6);
  const sidecarH = Math.round(baselineDims.height * 0.5);
  await waitForOutputDims(sidecarW, sidecarH, 1);
  const savedDims = await outputDims();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const reopenedGeometry = await geometryState();
  check(
    'reopen restores the geometry values',
    reopenedGeometry.crop.x === 0.1 &&
      reopenedGeometry.crop.y === 0.2 &&
      reopenedGeometry.crop.w === 0.6 &&
      reopenedGeometry.crop.h === 0.5 &&
      reopenedGeometry.angle === 7.5,
    reopenedGeometry
  );
  await waitForOutputDims(savedDims.width, savedDims.height);
  const reopenedDims = await outputDims();
  check(
    'reopen outputDims match the saved crop',
    reopenedDims.width === savedDims.width && reopenedDims.height === savedDims.height,
    { savedDims, reopenedDims }
  );

  console.log('verify-crop (export honors the crop):');
  await setGeometry({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0 });
  const img = await page.evaluate(() => window.__debug.imageState());
  const expectedW = Math.round(0.5 * img.fullWidth);
  const expectedH = Math.round(0.5 * img.fullHeight);
  await page.evaluate((p) => window.__debug.exportImageTo(p), OUT_JPG);
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  const exportState = await page.evaluate(() => window.__debug.exportState());
  check('export completes without error', exportState.status === 'idle', exportState);
  const exported = await sharp(OUT_JPG).metadata();
  check('exported dims ≈ 0.5× full-res dims', exported.width === expectedW && exported.height === expectedH, {
    expected: { w: expectedW, h: expectedH },
    actual: { w: exported.width, h: exported.height },
  });
  check(
    'exported aspect ratio matches the crop aspect (within rounding)',
    Math.abs(exported.width / exported.height - expectedW / expectedH) < 0.01,
    { ratio: exported.width / exported.height, expectedRatio: expectedW / expectedH }
  );
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
