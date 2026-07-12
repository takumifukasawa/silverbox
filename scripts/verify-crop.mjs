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

  console.log('verify-crop (UX pack D round-5: handle affordance — size + per-handle resize cursor):');
  const seCursor = await handle.evaluate((el) => getComputedStyle(el).cursor);
  check('SE corner handle cursor is nwse-resize (the cursor says what the drag will do)', seCursor === 'nwse-resize', seCursor);
  // getComputedStyle's width/height reflect the element's own AUTHORED CSS
  // box (20px, round-7 bump from 16px) — getBoundingClientRect() would
  // instead report the SCREEN size after the ancestor .crop-overlay's
  // pan/zoom `transform: scale(view.scale)` is applied, which is unrelated
  // to the affordance size we're checking here.
  const seVisibleSize = await handle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });
  check('SE corner handle visible dot is >=20px (round-7 bump from 16px)', seVisibleSize.width >= 20 && seVisibleSize.height >= 20, seVisibleSize);
  const nCursor = await page.locator('[data-testid="crop-handle-n"]').evaluate((el) => getComputedStyle(el).cursor);
  check('N edge handle cursor is ns-resize', nCursor === 'ns-resize', nCursor);
  const eCursor = await page.locator('[data-testid="crop-handle-e"]').evaluate((el) => getComputedStyle(el).cursor);
  check('E edge handle cursor is ew-resize', eCursor === 'ew-resize', eCursor);
  const cropRectCursor = await page.locator('[data-testid="crop-rect"]').evaluate((el) => getComputedStyle(el).cursor);
  check('crop-rect body cursor is move', cropRectCursor === 'move', cropRectCursor);

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

  console.log('verify-crop (LR-style rotate: auto-zoom, no void, screen-constant, reversible):');
  // Plain-JS mirror of RESAMPLE_SHADER's rotate + its inverse map, so the
  // no-void invariant is re-derived here independently of the app's own
  // cropFit.ts. A rotated-plane point p is void-free iff its source
  // q = rot(p − O, −a) + O lands inside [0,W]×[0,H].
  const rot = (vx, vy, a) => {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return [vx * c + vy * s, -vx * s + vy * c];
  };
  // returns the worst out-of-bounds excess (px) over the 4 crop-rect corners;
  // ≤ tol ⇒ void-free. W,H = oriented frame dims (orientation is identity here,
  // so the baseline outputDims are exactly W×H).
  const worstVoid = (crop, angleDeg, W, H) => {
    const a = (angleDeg * Math.PI) / 180;
    const Ox = W / 2;
    const Oy = H / 2;
    const corners = [
      [crop.x, crop.y],
      [crop.x + crop.w, crop.y],
      [crop.x + crop.w, crop.y + crop.h],
      [crop.x, crop.y + crop.h],
    ];
    let worst = 0;
    for (const [nx, ny] of corners) {
      const [qx, qy] = rot(nx * W - Ox, ny * H - Oy, -a);
      const sx = qx + Ox;
      const sy = qy + Oy;
      worst = Math.max(worst, -sx, sx - W, -sy, sy - H);
    }
    return worst;
  };

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
  const rzCx = rzBox.x + rzBox.width / 2;
  const rzCy = rzBox.y + rzBox.height / 2;
  await page.mouse.move(rzCx, rzCy);
  await page.mouse.down();
  // sweep the SE rotate zone around the crop rect's center to build an angle
  await page.mouse.move(rzCx + 10, rzCy + 60, { steps: 8 });
  await page.mouse.up();

  const geomAfterRotate = await geometryState();
  const rectBoxAfterRotate = await cropRect.boundingBox();
  check('outside-corner drag changed the angle', geomAfterRotate.angle !== geomBeforeRotate.angle, {
    before: geomBeforeRotate.angle,
    after: geomAfterRotate.angle,
  });
  check('outside-corner rotate drag is exactly one undo entry', (await historyPast()) === pastBeforeRotate + 1, {
    before: pastBeforeRotate,
    after: await historyPast(),
  });
  // No-void invariant: after the drag, all 4 crop-rect corners map into the
  // source box (re-derived here in plain JS, not read back from the app).
  const voidExcess = worstVoid(geomAfterRotate.crop, geomAfterRotate.angle, baselineDims.width, baselineDims.height);
  check('no-void: all 4 crop-rect corners map inside the source frame', voidExcess <= 1, {
    voidExcess,
    crop: geomAfterRotate.crop,
    angle: geomAfterRotate.angle,
  });
  // Screen constancy: with the view auto-zoom compensation, the crop rect's
  // on-screen bounding box is unchanged through the whole rotate drag.
  check(
    "the crop rect's on-screen box is pixel-stable through the rotate drag (auto-zoom compensation)",
    Math.abs(rectBoxAfterRotate.x - rectBoxBeforeRotate.x) < 1.5 &&
      Math.abs(rectBoxAfterRotate.y - rectBoxBeforeRotate.y) < 1.5 &&
      Math.abs(rectBoxAfterRotate.width - rectBoxBeforeRotate.width) < 1.5 &&
      Math.abs(rectBoxAfterRotate.height - rectBoxBeforeRotate.height) < 1.5,
    { rectBoxBeforeRotate, rectBoxAfterRotate }
  );
  // the box being unrotated (not skewed) is the real "axis-aligned" claim —
  // assert the overlay's computed transform has no rotation/skew component
  const cropOverlayTransform = await page.locator('[data-testid="crop-overlay"]').evaluate((el) => getComputedStyle(el).transform);
  check(
    'the crop-overlay element itself carries only translate+uniform-scale (no rotation matrix component)',
    /^matrix\(([-\d.e]+), 0, 0, \1,/.test(cropOverlayTransform),
    cropOverlayTransform
  );

  // ±45° clamp still holds via this new gesture too (existing invariant, not loosened)
  await page.mouse.move(rzCx, rzCy);
  await page.mouse.down();
  await page.mouse.move(rzCx - 400, rzCy + 400, { steps: 10 });
  await page.mouse.up();
  const geomClamped = await geometryState();
  check('the ±45° clamp still holds via the outside-corner gesture', Math.abs(geomClamped.angle) <= 45, geomClamped);

  console.log('verify-crop (rotate reversibility: sweep out and back within one drag):');
  // reset to a known full crop + angle 0, staying in crop mode
  await page.locator('[data-testid="crop-reset"]').click();
  const geomBeforeRev = await geometryState();
  const relRotateZone = page.locator('[data-testid="crop-rotate-se"]');
  const relBox = await relRotateZone.boundingBox();
  const relCx = relBox.x + relBox.width / 2;
  const relCy = relBox.y + relBox.height / 2;
  // one drag: sweep out to build an angle, then back to the exact start point
  await page.mouse.move(relCx, relCy);
  await page.mouse.down();
  await page.mouse.move(relCx + 20, relCy + 80, { steps: 8 });
  await page.mouse.move(relCx, relCy, { steps: 8 });
  await page.mouse.up();
  const geomAfterRev = await geometryState();
  check(
    'sweeping the angle out and back restores the pre-drag crop (each of x/y/w/h within 1e-3)',
    Math.abs(geomAfterRev.crop.x - geomBeforeRev.crop.x) < 1e-3 &&
      Math.abs(geomAfterRev.crop.y - geomBeforeRev.crop.y) < 1e-3 &&
      Math.abs(geomAfterRev.crop.w - geomBeforeRev.crop.w) < 1e-3 &&
      Math.abs(geomAfterRev.crop.h - geomBeforeRev.crop.h) < 1e-3,
    { before: geomBeforeRev.crop, after: geomAfterRev.crop }
  );
  check(
    'sweeping the angle out and back restores the pre-drag angle (within 0.5°)',
    Math.abs(geomAfterRev.angle - geomBeforeRev.angle) < 0.5,
    { before: geomBeforeRev.angle, after: geomAfterRev.angle }
  );

  console.log('verify-crop (angle slider keeps the no-void invariant too):');
  await page.locator('[data-testid="crop-reset"]').click();
  // drive the actual slider (onAngleChange path), not the debug hook
  await page.locator('[data-testid="crop-angle-slider"]').fill('30');
  const geomSlider = await geometryState();
  check('slider reached a large angle on a full crop', Math.abs(geomSlider.angle - 30) < 0.5, geomSlider);
  const sliderVoid = worstVoid(geomSlider.crop, geomSlider.angle, baselineDims.width, baselineDims.height);
  check('no-void holds via the slider path too', sliderVoid <= 1, {
    sliderVoid,
    crop: geomSlider.crop,
    angle: geomSlider.angle,
  });

  console.log('verify-crop (containment: the rect cannot be dragged/resized into the rotation void):');
  // still at the slider's 30° — the valid area is the tilted source rect
  const rectBoxC = await page.locator('[data-testid="crop-rect"]').boundingBox();
  // MOVE: grab the rect body and shove it far past the top-left corner
  await page.mouse.move(rectBoxC.x + rectBoxC.width / 2, rectBoxC.y + rectBoxC.height / 2);
  await page.mouse.down();
  await page.mouse.move(rectBoxC.x + rectBoxC.width / 2 - 900, rectBoxC.y + rectBoxC.height / 2 - 700, { steps: 6 });
  await page.mouse.up();
  const geomMoved = await geometryState();
  const movedVoid = worstVoid(geomMoved.crop, geomMoved.angle, baselineDims.width, baselineDims.height);
  check('a move drag slides along the tilted boundary — no void enters the rect', movedVoid <= 1, {
    movedVoid,
    crop: geomMoved.crop,
  });
  // RESIZE: drag the NW handle far outward — growth must stop at the boundary
  const nwBox = await page.locator('[data-testid="crop-handle-nw"]').boundingBox();
  await page.mouse.move(nwBox.x + nwBox.width / 2, nwBox.y + nwBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nwBox.x + nwBox.width / 2 - 900, nwBox.y + nwBox.height / 2 - 700, { steps: 6 });
  await page.mouse.up();
  const geomResized = await geometryState();
  const resizedVoid = worstVoid(geomResized.crop, geomResized.angle, baselineDims.width, baselineDims.height);
  check('a resize drag stops at the tilted boundary — no void enters the rect', resizedVoid <= 1, {
    resizedVoid,
    crop: geomResized.crop,
  });
  check(
    'the resize did actually grow the rect toward the boundary (constraint is a stop, not a freeze)',
    geomResized.crop.w > geomMoved.crop.w - 1e-6 && geomResized.crop.h > geomMoved.crop.h - 1e-6,
    { before: geomMoved.crop, after: geomResized.crop }
  );

  console.log('verify-crop (LR-style grids: thirds always in crop mode, fine grid while rotating):');
  await page.locator('[data-testid="crop-reset"]').click();
  check(
    'rule-of-thirds grid is visible at rest in crop mode (no drag in flight)',
    (await page.locator('[data-testid="crop-grid-thirds"]').count()) === 1 &&
      (await page.locator('[data-testid="crop-grid-fine"]').count()) === 0,
    {
      thirds: await page.locator('[data-testid="crop-grid-thirds"]').count(),
      fine: await page.locator('[data-testid="crop-grid-fine"]').count(),
    }
  );
  const gridRz = await page.locator('[data-testid="crop-rotate-se"]').boundingBox();
  await page.mouse.move(gridRz.x + gridRz.width / 2, gridRz.y + gridRz.height / 2);
  await page.mouse.down();
  await page.mouse.move(gridRz.x + gridRz.width / 2 + 5, gridRz.y + gridRz.height / 2 + 15, { steps: 3 });
  check(
    'a rotate drag swaps in the fine straighten grid mid-drag',
    (await page.locator('[data-testid="crop-grid-fine"]').count()) === 1 &&
      (await page.locator('[data-testid="crop-grid-thirds"]').count()) === 0,
    {
      thirds: await page.locator('[data-testid="crop-grid-thirds"]').count(),
      fine: await page.locator('[data-testid="crop-grid-fine"]').count(),
    }
  );
  await page.mouse.up();
  check(
    'releasing the rotate drag restores the thirds grid',
    (await page.locator('[data-testid="crop-grid-thirds"]').count()) === 1 &&
      (await page.locator('[data-testid="crop-grid-fine"]').count()) === 0,
    {
      thirds: await page.locator('[data-testid="crop-grid-thirds"]').count(),
      fine: await page.locator('[data-testid="crop-grid-fine"]').count(),
    }
  );

  await page.locator('[data-testid="crop-reset"]').click();
  await page.locator('[data-testid="crop-done"]').click();
  await waitForOutputDims(baselineDims.width, baselineDims.height);

  console.log('verify-crop (rotation void renders BLACK, not clamp-smeared edge texels):');
  // Full crop + a committed angle leaves void wedges at the output corners
  // (the unconstrained debug-hook path, exactly what hand-written sidecars
  // can contain). RESAMPLE must cut those to black — before this check the
  // sampler's clamp addressing smeared the border pixels across the wedge.
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 10 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);
  const cornerPx = await page.evaluate(([w, h]) => window.__debug.encodedCropForVerify(0, 0, 4, 4), [
    baselineDims.width,
    baselineDims.height,
  ]);
  const cornerMax = Math.max(...cornerPx.filter((_, i) => i % 4 !== 3)); // ignore alpha
  check('a 4×4 corner probe inside the rotation void is pure black', cornerMax === 0, { cornerMax });
  const centerPx = await page.evaluate(
    ([w, h]) => window.__debug.encodedCropForVerify(Math.floor(w / 2), Math.floor(h / 2), 4, 4),
    [baselineDims.width, baselineDims.height]
  );
  const centerMax = Math.max(...centerPx.filter((_, i) => i % 4 !== 3));
  check('the image center still renders real (non-black) pixels', centerMax > 0, { centerMax });
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 });

  console.log('verify-crop (round-6: anchored resize clamp — E handle stops at the frame edge instead of shoving the LEFT side):');
  await setGeometry({ crop: { x: 0.6, y: 0.3, w: 0.3, h: 0.3 }, angle: 0 });
  await waitForOutputDims(Math.round(baselineDims.width * 0.3), Math.round(baselineDims.height * 0.3), 1);
  await page.locator('[data-testid="crop-toggle"]').click();
  await page.waitForSelector('[data-testid="crop-overlay"]', { timeout: 5_000 });

  const geomBeforeE = await geometryState();
  const eHandle = page.locator('[data-testid="crop-handle-e"]');
  await eHandle.scrollIntoViewIfNeeded();
  const eBox = await eHandle.boundingBox();
  await page.mouse.move(eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(eBox.x + 900, eBox.y, { steps: 6 }); // drag far past the right edge
  await page.mouse.up();
  const geomAfterE = await geometryState();
  check('E-handle drag past the right edge leaves x unchanged (left edge never moves)', Math.abs(geomAfterE.crop.x - geomBeforeE.crop.x) < 1e-9, {
    before: geomBeforeE.crop.x,
    after: geomAfterE.crop.x,
  });
  check(
    'E-handle drag caps w at exactly 1 - x (right edge stops at the frame boundary)',
    Math.abs(geomAfterE.crop.w - (1 - geomAfterE.crop.x)) < 1e-6,
    geomAfterE.crop
  );

  console.log('verify-crop (round-6: W handle pins the RIGHT edge instead of shoving it):');
  // Still inside crop mode (never exited after the E-handle section above) —
  // crop mode previews the FULL frame regardless of the committed crop (see
  // the component doc comment), so outputDims does NOT track this setGeometry
  // call; only geometryState() does. Don't waitForOutputDims here.
  await setGeometry({ crop: { x: 0.1, y: 0.3, w: 0.3, h: 0.3 }, angle: 0 });
  const geomBeforeW = await geometryState();
  const rightEdgeBeforeW = geomBeforeW.crop.x + geomBeforeW.crop.w;
  const wHandle = page.locator('[data-testid="crop-handle-w"]');
  await wHandle.scrollIntoViewIfNeeded();
  const wBox = await wHandle.boundingBox();
  await page.mouse.move(wBox.x + wBox.width / 2, wBox.y + wBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(wBox.x - 900, wBox.y, { steps: 6 }); // drag far past the left edge
  await page.mouse.up();
  const geomAfterW = await geometryState();
  const rightEdgeAfterW = geomAfterW.crop.x + geomAfterW.crop.w;
  check('W-handle drag past the left edge pins the right edge (x+w unchanged)', Math.abs(rightEdgeAfterW - rightEdgeBeforeW) < 1e-6, {
    before: rightEdgeBeforeW,
    after: rightEdgeAfterW,
  });
  check('W-handle drag stops at x = 0 (never shoves the right edge along with it)', Math.abs(geomAfterW.crop.x) < 1e-9, geomAfterW.crop);

  console.log('verify-crop (round-6: corner + ratio-lock resize clamp — the driven axis cannot push past its own anchor):');
  await page.locator('[data-testid="crop-ratio"]').selectOption('1:1');
  // Same crop-mode caveat as the W-handle section above: no waitForOutputDims.
  await setGeometry({ crop: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, angle: 0 });
  const geomBeforeSE = await geometryState();
  const seHandle2 = page.locator('[data-testid="crop-handle-se"]');
  await seHandle2.scrollIntoViewIfNeeded();
  const seBox2 = await seHandle2.boundingBox();
  await page.mouse.move(seBox2.x + seBox2.width / 2, seBox2.y + seBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(seBox2.x + 900, seBox2.y + 900, { steps: 6 }); // drag far past both edges
  await page.mouse.up();
  const geomAfterSE = await geometryState();
  check('SE corner + ratio lock: x unchanged (west edge never shoved)', Math.abs(geomAfterSE.crop.x - geomBeforeSE.crop.x) < 1e-9, geomAfterSE.crop);
  check('SE corner + ratio lock: y unchanged (north edge never shoved)', Math.abs(geomAfterSE.crop.y - geomBeforeSE.crop.y) < 1e-9, geomAfterSE.crop);
  check(
    'SE corner + ratio lock: rect stays inside the frame ([0,1] on both axes)',
    geomAfterSE.crop.x + geomAfterSE.crop.w <= 1 + 1e-6 && geomAfterSE.crop.y + geomAfterSE.crop.h <= 1 + 1e-6,
    geomAfterSE.crop
  );
  const seOutputAr = (geomAfterSE.crop.w * baselineDims.width) / (geomAfterSE.crop.h * baselineDims.height);
  check('SE corner + ratio lock: aspect ratio survived the clamp (output w/h ≈ 1:1)', Math.abs(seOutputAr - 1) < 0.02, {
    crop: geomAfterSE.crop,
    seOutputAr,
  });

  console.log('verify-crop (round-6: rotate zones show a permanent glyph affordance, not just an invisible hit zone):');
  check('4 rotate-zone glyphs render in crop mode', (await page.locator('[data-testid="crop-rotate-glyph"]').count()) === 4, {
    count: await page.locator('[data-testid="crop-rotate-glyph"]').count(),
  });
  console.log('verify-crop (round-7: rotate glyph doubled — user hand-test "回転のアイコンが小さすぎる"):');
  const rotateGlyphSize = await page
    .locator('[data-testid="crop-rotate-glyph"]')
    .first()
    .evaluate((el) => ({ width: el.getAttribute('width'), height: el.getAttribute('height') }));
  check(
    'rotate glyph visual size is >=24px (round-7 bump from 14px)',
    Number(rotateGlyphSize.width) >= 24 && Number(rotateGlyphSize.height) >= 24,
    rotateGlyphSize
  );
  const rotateZoneSize = await page.locator('[data-testid="crop-rotate-se"]').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });
  check(
    "rotate zone's own hitbox grew to at least fit the bigger glyph (hover area matches what's visible)",
    rotateZoneSize.width >= Number(rotateGlyphSize.width) && rotateZoneSize.height >= Number(rotateGlyphSize.height),
    { rotateZoneSize, rotateGlyphSize }
  );

  console.log(
    'verify-crop (round-7: overlap investigation — SE corner handle vs SE rotate zone at the MIN-size crop rect):'
  );
  // GEOMETRY_MIN_CROP_SIZE (graphDoc.ts) is 0.05 — the smallest legal crop,
  // and where the round-7 handle/rotate-zone size bumps are most likely to
  // collide on screen. The DOM elements' own boxes (handle 20px, zone 32px,
  // both anchored on the SAME corner point) DO overlap here by design — the
  // rotate zone renders first (underneath) and the resize handle on top (see
  // CropOverlay.tsx's paint-order comment), so overlap is resolved by
  // z-order, not avoided. What actually matters for usability is that (a)
  // the handle's own center is still reachable and still resizes, and (b)
  // the zone's outer edge (away from the corner) is still reachable and
  // still rotates — both checked directly below rather than just inspecting
  // the boxes.
  const MIN_CROP = 0.05;
  await page.locator('[data-testid="crop-ratio"]').selectOption('free');
  await setGeometry({ crop: { x: 0.475, y: 0.475, w: MIN_CROP, h: MIN_CROP }, angle: 0 });
  const seHandleBoxMin = await page.locator('[data-testid="crop-handle-se"]').boundingBox();
  const seZoneBoxMin = await page.locator('[data-testid="crop-rotate-se"]').boundingBox();
  const overlaps = (a, b) => !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
  console.log(`  (info) SE handle/zone element boxes overlap at the min-size crop rect: ${overlaps(seHandleBoxMin, seZoneBoxMin)}`);

  const geomBeforeMinDrag = await geometryState();
  await page.mouse.move(seHandleBoxMin.x + seHandleBoxMin.width / 2, seHandleBoxMin.y + seHandleBoxMin.height / 2);
  await page.mouse.down();
  await page.mouse.move(seHandleBoxMin.x + seHandleBoxMin.width / 2 + 40, seHandleBoxMin.y + seHandleBoxMin.height / 2 + 30, {
    steps: 6,
  });
  await page.mouse.up();
  const geomAfterMinDrag = await geometryState();
  check(
    'at the min-size crop rect, dragging the SE handle CENTER still resizes (the overlapping rotate zone does not swallow it)',
    geomAfterMinDrag.crop.w !== geomBeforeMinDrag.crop.w && geomAfterMinDrag.angle === geomBeforeMinDrag.angle,
    { before: geomBeforeMinDrag, after: geomAfterMinDrag }
  );

  // re-seed the min rect (the resize drag above changed it) and confirm the
  // rotate zone's OUTER edge (away from the corner, where it can't be
  // confused with the handle) is still reachable.
  await setGeometry({ crop: { x: 0.475, y: 0.475, w: MIN_CROP, h: MIN_CROP }, angle: 0 });
  const seZoneBoxMin2 = await page.locator('[data-testid="crop-rotate-se"]').boundingBox();
  await page.mouse.move(seZoneBoxMin2.x + seZoneBoxMin2.width - 3, seZoneBoxMin2.y + seZoneBoxMin2.height - 3);
  await page.mouse.down();
  await page.mouse.move(seZoneBoxMin2.x + seZoneBoxMin2.width + 20, seZoneBoxMin2.y + seZoneBoxMin2.height - 30, { steps: 6 });
  await page.mouse.up();
  const geomAfterMinRotate = await geometryState();
  check(
    "at the min-size crop rect, dragging the rotate zone's OUTER edge still rotates",
    geomAfterMinRotate.angle !== 0,
    geomAfterMinRotate
  );

  // restore Free ratio + identity, exit crop mode — back to baseline for the sections below
  await page.locator('[data-testid="crop-ratio"]').selectOption('free');
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
