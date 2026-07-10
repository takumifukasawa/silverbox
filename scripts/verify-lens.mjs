/**
 * Manual lens corrections verify: defaults are identity with a CPU reference
 * (the resample pass adds zero cost when both geometry and lens are
 * untouched — the SAME invariant verify-crop's check 1 guards); distortion
 * bends the corners more than the center (screenshot-region comparison);
 * chromatic aberration shifts the corner's R channel more than its G channel
 * while the center stays ~unaffected; vignetting recovery brightens the
 * corners without moving the center, raising the corner/center ratio; lens +
 * geometry fold into the SAME resample pass (crop still governs outputDims);
 * one slider drag = one undo entry; lens values survive the sidecar.
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
const IDENTITY_LENS = { distortion: 0, caRed: 0, caBlue: 0, vignette: 0 };

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
const meanAbsDiff = (a, b) => (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
const luma = (m) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

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
  const lensState = () => page.evaluate(() => window.__debug.lensState());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const setLens = (lens) => page.evaluate((l) => window.__debug.setLens(l), { ...IDENTITY_LENS, ...lens });
  const setGeometry = (geo) => page.evaluate((g) => window.__debug.setGeometry(g), geo);

  // the histogram refreshes debounced after each render (see ms10) — the
  // same technique verify-effects uses, since lens mutations don't change
  // outputDims (nothing to poll there, unlike verify-crop's geometry checks)
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
  };

  // Output dims are async after a geometry mutation (see verify-crop) —
  // needed only for the lens+geometry combined check.
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
  // decoded with sharp — stats() reads the pre-pipeline input, so the region
  // must be materialized with toBuffer() BEFORE stats() (verify-crop/
  // verify-effects technique)
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
  // center 20%×20% (near-zero radius, ~untouched by any lens correction) vs
  // a corner 15%×15% (near the max normalized radius, where every lens
  // correction is strongest)
  const centerMean = () => regionMean(0.4, 0.4, 0.2, 0.2);
  const cornerMean = () => regionMean(0, 0, 0.15, 0.15);

  console.log('verify-lens (baseline identity):');
  // the canvas starts at the browser's default 300×150 until the first
  // render lands — histogramState() only turns non-null after that render's
  // debounced stats() call, so it is a reliable "first frame is up" signal
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  const baselineDims = await outputDims();
  const baselineMean = await gpuMean();
  const baselineCpu = await cpuMean();
  check('default lens has a CPU reference', baselineCpu !== null, baselineCpu);
  check('defaults: GPU matches CPU reference (within 1/255)', meansMatch(baselineMean, baselineCpu), {
    baselineMean,
    baselineCpu,
  });
  const baselineCenter = await centerMean();
  const baselineCorner = await cornerMean();

  console.log('verify-lens (distortion):');
  await histogramAfter(() => setLens({ distortion: 60 }));
  const distortedCpu = await cpuMean();
  check('distortion +60 plan has no CPU reference (resample, like geometry)', distortedCpu === null, distortedCpu);
  const distortedCenter = await centerMean();
  const distortedCorner = await cornerMean();
  const centerDelta = meanAbsDiff(baselineCenter, distortedCenter);
  const cornerDelta = meanAbsDiff(baselineCorner, distortedCorner);
  check('distortion +60 changes the corner more than the center', cornerDelta > centerDelta, {
    centerDelta,
    cornerDelta,
  });
  await setLens({ distortion: 0 });
  const restoredMean = await gpuMean();
  check('distortion reset restores the baseline render (within 1e-4)', meansMatch(restoredMean, baselineMean, 1e-4), {
    baselineMean,
    restoredMean,
  });

  console.log('verify-lens (chromatic aberration):');
  await histogramAfter(() => setLens({ caRed: 80 }));
  const caCpu = await cpuMean();
  check('CA plan has no CPU reference (resample, like geometry)', caCpu === null, caCpu);
  const caCenter = await centerMean();
  const caCorner = await cornerMean();
  const cornerRShift = Math.abs(caCorner.r - baselineCorner.r);
  const cornerGShift = Math.abs(caCorner.g - baselineCorner.g);
  check('CA red +80 shifts the corner R channel more than the G channel', cornerRShift > cornerGShift, {
    cornerRShift,
    cornerGShift,
  });
  const centerRShift = Math.abs(caCenter.r - baselineCenter.r);
  const centerGShift = Math.abs(caCenter.g - baselineCenter.g);
  check(
    'CA red +80 shifts the center R/G channels ~equally (loose, direction only)',
    Math.abs(centerRShift - centerGShift) < 0.02,
    { centerRShift, centerGShift }
  );
  await setLens({ caRed: 0 });

  console.log('verify-lens (vignetting):');
  await histogramAfter(() => setLens({ vignette: 80 }));
  const vigCpu = await cpuMean();
  check('vignette plan has no CPU reference (resample, like geometry)', vigCpu === null, vigCpu);
  const vigCenter = await centerMean();
  const vigCorner = await cornerMean();
  const baseCornerLuma = luma(baselineCorner);
  const vigCornerLuma = luma(vigCorner);
  const baseCenterLuma = luma(baselineCenter);
  const vigCenterLuma = luma(vigCenter);
  check('vignette 80 raises the corner mean vs baseline', vigCornerLuma > baseCornerLuma, {
    baseCornerLuma,
    vigCornerLuma,
  });
  check('vignette 80 leaves the center mean ~unchanged (within 0.03)', Math.abs(vigCenterLuma - baseCenterLuma) < 0.03, {
    baseCenterLuma,
    vigCenterLuma,
  });
  const baseRatio = baseCornerLuma / baseCenterLuma;
  const vigRatio = vigCornerLuma / vigCenterLuma;
  check('corner/center ratio strictly increases', vigRatio > baseRatio, { baseRatio, vigRatio });
  await setLens({ vignette: 0 });

  console.log('verify-lens (lens + geometry combined):');
  await setLens({ distortion: 40 });
  await setGeometry({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0 });
  const halfW = Math.round(baselineDims.width * 0.5);
  const halfH = Math.round(baselineDims.height * 0.5);
  await waitForOutputDims(halfW, halfH, 1);
  const combinedDims = await outputDims();
  check(
    'crop still halves outputDims with lens active (±1px each axis)',
    Math.abs(combinedDims.width - baselineDims.width / 2) <= 1 && Math.abs(combinedDims.height - baselineDims.height / 2) <= 1,
    { baselineDims, combinedDims }
  );
  check('no page errors from the combined lens+geometry pass', pageErrors.length === 0, pageErrors);
  const combinedCpu = await cpuMean();
  check('lens+geometry combined plan has no CPU reference', combinedCpu === null, combinedCpu);
  await setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 });
  await setLens({ distortion: 0 });
  await waitForOutputDims(baselineDims.width, baselineDims.height);

  console.log('verify-lens (UI: one slider drag = one undo entry):');
  await page.locator('.react-flow__node[data-id="in"]').click();
  const lensSection = page.locator('.inspector-section').filter({ hasText: 'Lens Corrections' }).first();
  check(
    'Lens Corrections section shows the 4 sliders',
    (await lensSection.locator('.param-row').count()) === 4,
    await lensSection.locator('.param-row').count()
  );
  const distortionSlider = lensSection.locator('.param-row').first().locator('input[type="range"]');
  await distortionSlider.scrollIntoViewIfNeeded();
  const box = await distortionSlider.boundingBox();
  const pastBefore = await historyPast();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const draggedDistortion = (await lensState()).distortion;
  check('slider drag sets a positive distortion', draggedDistortion > 0, draggedDistortion);
  check('one slider drag = one undo entry', (await historyPast()) === pastBefore + 1, {
    before: pastBefore,
    after: await historyPast(),
  });
  await setLens({ distortion: 0 });

  console.log('verify-lens (sidecar round-trip):');
  await setLens({ distortion: 35, caRed: -20, caBlue: 15, vignette: 60 });
  const edited = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredLens = await lensState();
  check(
    'reopen restores the lens values',
    restoredLens.distortion === 35 && restoredLens.caRed === -20 && restoredLens.caBlue === 15 && restoredLens.vignette === 60,
    restoredLens
  );
  const restored = await gpuMean();
  check('restored lens renders like before the save', meansMatch(restored, edited), { edited, restored });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
