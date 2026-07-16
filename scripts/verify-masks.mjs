/**
 * Masks milestone verify: mask nodes, mask-driven blend, "+ Local
 * Adjustment", named multiple outputs, sidecar schemaVersion 4 (anchor-space
 * mask/spot coords + the pre-v4 → anchor migration), the LR-style area
 * preview, and the anchor-space "mask stays pinned across a rotation" fix.
 *  1. Baseline: default graph unchanged behavior; GPU==CPU parity.
 *  2. add-local-adjustment: one click ⇒ D/M/B wired as specified, exactly
 *     ONE new history entry; readbackMean unchanged (D identity ⇒ a==b).
 *  3. Masked edit: D's exposure +1.5 ⇒ GPU==CPU within 1/255; center
 *     brightens vs baseline, corner stays near baseline.
 *  4. Radial params: enlarge radius ⇒ corner starts brightening; invert ⇒
 *     center returns near baseline while corners stay bright(er).
 *  7. Undo: one center-drag on the canvas handle = one history entry.
 *  5. Linear mask: swap shape type; gradient direction via top-vs-bottom.
 *  6. Red overlay: canvas-only (screenshot-verified); 'O' toggles it;
 *     readbackMean identical on/off (present-only, never touches readbacks).
 *  8. Sidecar v3: save/reload; inline v2 fixture; unknown-key passthrough.
 *  9. Outputs: second named output wired differently; selector appears;
 *     switching changes readbackMean; export honors the selection.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';
import sharp from 'sharp';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
const GPU_CPU_TOLERANCE = 1 / 255;
const OUT_MAIN = join(projectRoot, 'test-artifacts', 'masks-output-main.jpg');
const OUT_SECOND = join(projectRoot, 'test-artifacts', 'masks-output-second.jpg');

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
mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const edgeList = (g) =>
    g.edges.map((e) => `${e.source}->${e.target}${e.targetHandle ? ':' + e.targetHandle : ''}`).sort();
  const outputDims = () => page.evaluate(() => window.__debug.outputDims());
  const updateNodeParam = (nodeId, key, value) =>
    page.evaluate(([n, k, v]) => window.__debug.updateNodeParam(n, k, v), [nodeId, key, value]);
  const setMaskShape = (nodeId, shape) =>
    page.evaluate(([n, s]) => window.__debug.setMaskShape(n, s), [nodeId, shape]);
  const maskState = (nodeId) => page.evaluate((n) => window.__debug.maskState(n), nodeId ?? null);

  /** Mean brightness (0..1) of a crop of the CURRENT preview's ENCODED output — a real GPU readback, not a lossy screenshot. */
  const regionMean = async (x0, y0, w, h) => {
    const px = await page.evaluate(([x0, y0, w, h]) => window.__debug.encodedCropForVerify(x0, y0, w, h), [x0, y0, w, h]);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += px[i] + px[i + 1] + px[i + 2];
      n++;
    }
    return sum / (n * 3 * 255);
  };

  // ---------------------------------------------------------------------
  console.log('verify-masks (1. baseline: default graph unchanged, GPU==CPU parity):');
  await openAndWait(ARW_PATH);
  const baselineMean = await gpuMean();
  const baselineCpu = await cpuMean();
  check('default plan has a CPU reference', baselineCpu !== null, baselineCpu);
  check('baseline: GPU matches CPU within 1/255', meansMatch(baselineMean, baselineCpu), {
    baselineMean,
    baselineCpu,
  });
  const dims = await outputDims();

  // ---------------------------------------------------------------------
  console.log('verify-masks (2. + Radial (draw-to-create), click-only: one undo entry, D/M/B wired):');
  const pastBeforeLA = await historyPast();
  const gBeforeLA = await graphState();
  const outputBeforeLA = gBeforeLA.nodes.find((n) => n.kind === 'output');
  // "+ Radial" enters draw mode (crosshair cursor); a click with no drag
  // still creates something sane — a default-radius radial at the click
  // point (here, dead center, so downstream sections' cx=cy=0.5 assumptions
  // hold unchanged).
  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  const canvasForLA = page.locator('.canvas-view-canvas');
  await canvasForLA.scrollIntoViewIfNeeded();
  const isPickingCursorLA = await canvasForLA.evaluate((el) => el.classList.contains('canvas-view-canvas--picking'));
  check('draw mode signals with the crosshair cursor class', isPickingCursorLA, isPickingCursorLA);
  const laBox = await canvasForLA.boundingBox();
  await page.mouse.move(laBox.x + laBox.width / 2, laBox.y + laBox.height / 2);
  await page.mouse.down();
  await page.mouse.up(); // no movement — click-only
  check('+ Local Adjustment (draw-to-create) is exactly one undo entry', (await historyPast()) === pastBeforeLA + 1, {
    before: pastBeforeLA,
    after: await historyPast(),
  });
  const gAfterLA = await graphState();
  const edgesLA = edgeList(gAfterLA);
  check(
    'D/M/B wired as specified (source feeds D, M, and blend-a; D feeds blend-b; M feeds blend-mask; blend feeds output)',
    edgesLA.includes('dev->dev-1') &&
      edgesLA.includes('dev->mask-1') &&
      edgesLA.includes('dev->blend-1:a') &&
      edgesLA.includes('dev-1->blend-1:b') &&
      edgesLA.includes('mask-1->blend-1:mask') &&
      edgesLA.includes('blend-1->out'),
    edgesLA
  );
  const maskInspectorVisible = await page
    .locator('.inspector-title', { hasText: 'Mask' })
    .isVisible()
    .catch(() => false);
  check('the new mask node (M) is selected afterwards', maskInspectorVisible, maskInspectorVisible);
  // Layout reads left-to-right: source → (Develop above / Mask below) →
  // Blend → output. Blend takes the output's OLD spot; the output itself
  // shifts right ~200px to make room (previously it landed to the blend's
  // right, reading backwards — see appStore.ts's addLocalAdjustment).
  const devAfterLA = gAfterLA.nodes.find((n) => n.id === 'dev-1');
  const maskAfterLA = gAfterLA.nodes.find((n) => n.id === 'mask-1');
  const blendAfterLA = gAfterLA.nodes.find((n) => n.id === 'blend-1');
  const outputAfterLA = gAfterLA.nodes.find((n) => n.kind === 'output');
  check('blend lands where the output used to be', blendAfterLA.position.x === outputBeforeLA.position.x, {
    blendX: blendAfterLA.position.x,
    outputBeforeX: outputBeforeLA.position.x,
  });
  check('output shifts right of the blend (chain reads left-to-right)', outputAfterLA.position.x > blendAfterLA.position.x, {
    blendX: blendAfterLA.position.x,
    outputX: outputAfterLA.position.x,
  });
  check('Develop sits above the blend', devAfterLA.position.y < blendAfterLA.position.y, {
    devY: devAfterLA.position.y,
    blendY: blendAfterLA.position.y,
  });
  check('Mask sits below the blend', maskAfterLA.position.y > blendAfterLA.position.y, {
    maskY: maskAfterLA.position.y,
    blendY: blendAfterLA.position.y,
  });
  const meanAfterLA = await gpuMean();
  check(
    'D is identity ⇒ a==b ⇒ readbackMean is bit-equal to baseline within 1e-6 regardless of the mask',
    meansMatch(meanAfterLA, baselineMean, 1e-6),
    { baselineMean, meanAfterLA }
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (3. masked edit: GPU==CPU, center brightens, corner stays near baseline):');
  await updateNodeParam('dev-1', 'basic.ev', 1.5);
  const maskedGpu = await gpuMean();
  const maskedCpu = await cpuMean();
  check('analytic mask keeps the CPU reference alive', maskedCpu !== null, maskedCpu);
  check('masked edit: GPU matches CPU within 1/255', meansMatch(maskedGpu, maskedCpu), { maskedGpu, maskedCpu });

  const regionSize = Math.round(Math.min(dims.width, dims.height) * 0.1);
  const centerX0 = Math.round(dims.width / 2 - regionSize / 2);
  const centerY0 = Math.round(dims.height / 2 - regionSize / 2);
  const centerMean = () => regionMean(centerX0, centerY0, regionSize, regionSize);
  const cornerMean = () => regionMean(0, 0, regionSize, regionSize);
  const baselineCenterMean = await regionMean(centerX0, centerY0, regionSize, regionSize); // baseline was before ev+1.5 was applied — recompute against dev-1 at 0
  // recompute the TRUE baseline (pre-edit) region means by temporarily zeroing the edit
  await updateNodeParam('dev-1', 'basic.ev', 0);
  const preEditCenter = await centerMean();
  const preEditCorner = await cornerMean();
  await updateNodeParam('dev-1', 'basic.ev', 1.5);
  const postEditCenter = await centerMean();
  const postEditCorner = await cornerMean();
  check('center region brightens under the masked +1.5EV edit', postEditCenter > preEditCenter + 0.02, {
    preEditCenter,
    postEditCenter,
  });
  check('corner region stays within tolerance of its pre-edit baseline (outside the mask)', Math.abs(postEditCorner - preEditCorner) < 0.01, {
    preEditCorner,
    postEditCorner,
  });
  void baselineCenterMean;

  // ---------------------------------------------------------------------
  console.log('verify-masks (4. radial params: enlarge radius brightens the corner; invert flips it):');
  const radialBefore = await maskState('mask-1');
  await setMaskShape('mask-1', { ...radialBefore.shapes[0], radius: 0.8 });
  const enlargedCorner = await cornerMean();
  check('enlarging the radius makes the corner start brightening', enlargedCorner > postEditCorner + 0.02, {
    postEditCorner,
    enlargedCorner,
  });
  const enlargedCenter = await centerMean();
  await setMaskShape('mask-1', { ...radialBefore.shapes[0], radius: 0.8, invert: true });
  const invertedCenter = await centerMean();
  const invertedCorner = await cornerMean();
  check(
    'inverting returns the center near its pre-edit baseline',
    Math.abs(invertedCenter - preEditCenter) < 0.03,
    { preEditCenter, enlargedCenter, invertedCenter }
  );
  check('inverting keeps the corners brighter than the (now unmasked) center', invertedCorner > invertedCenter, {
    invertedCenter,
    invertedCorner,
  });
  // restore the default centered mask for the following checks
  await setMaskShape('mask-1', { type: 'radial', mode: 'add', cx: 0.5, cy: 0.5, radius: 0.25, feather: 0.5, invert: false });

  // ---------------------------------------------------------------------
  console.log('verify-masks (§5 the mask edit overlay renders the LR-style AREA preview, not just handles):');
  check(
    'a selected radial mask shows a translucent area fill',
    (await page.locator('[data-testid="mask-overlay"] .mask-area-fill').count()) === 1,
    await page.locator('[data-testid="mask-overlay"] .mask-area-fill').count()
  );
  check(
    'a selected radial mask shows the dashed feather circle',
    (await page.locator('[data-testid="mask-overlay"] [data-testid="mask-area-feather"]').count()) === 1,
    await page.locator('[data-testid="mask-overlay"] [data-testid="mask-area-feather"]').count()
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (§1 anchor: a radial mask stays pinned to image content across a rotation):');
  const maskAnchorBefore = (await maskState('mask-1')).shapes[0];
  const meanBeforeMaskRotate = await gpuMean();
  // Rotate 10°: under the OLD output-frame scheme this re-pointed the mask at
  // different content; anchor space stores it relative to the IMAGE, so the
  // stored shape must be byte-identical afterward — that invariance IS the fix.
  await page.evaluate(() =>
    window.__debug.setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 10, orientation: { quarterTurns: 0, flipH: false } })
  );
  await page.waitForTimeout(300);
  const maskAnchorAfter = (await maskState('mask-1')).shapes[0];
  check(
    "rotating the image leaves the mask shape's stored anchor coords byte-identical",
    JSON.stringify(maskAnchorAfter) === JSON.stringify(maskAnchorBefore),
    { maskAnchorBefore, maskAnchorAfter }
  );
  const meanAfterMaskRotate = await gpuMean();
  check(
    'the rotation actually took effect on the render (mean changed)',
    !meansMatch(meanAfterMaskRotate, meanBeforeMaskRotate, 1e-4),
    { meanBeforeMaskRotate, meanAfterMaskRotate }
  );
  check('no page error rendering a mask through a non-identity geometry', pageErrors.length === 0, pageErrors);
  await page.evaluate(() =>
    window.__debug.setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, orientation: { quarterTurns: 0, flipH: false } })
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (7. undo: one center-drag on the canvas handle = one history entry):');
  const centerHandle = page.locator('[data-testid="mask-handle-center"]');
  await centerHandle.scrollIntoViewIfNeeded();
  const chBox = await centerHandle.boundingBox();
  const pastBeforeDrag = await historyPast();
  await page.mouse.move(chBox.x + chBox.width / 2, chBox.y + chBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chBox.x + 20, chBox.y + 15, { steps: 6 });
  await page.mouse.up();
  check('one center-drag = one undo entry', (await historyPast()) === pastBeforeDrag + 1, {
    before: pastBeforeDrag,
    after: await historyPast(),
  });

  console.log('verify-masks (UX pack D round-5: handle affordance — size + cursor legible per handle):');
  const centerCursor = await centerHandle.evaluate((el) => getComputedStyle(el).cursor);
  check('mask center handle cursor is move', centerCursor === 'move', centerCursor);
  // getComputedStyle's width/height reflect the element's own AUTHORED CSS
  // box (20px, round-7 bump from 16px) — getBoundingClientRect() would
  // instead report the SCREEN size after the ancestor .mask-overlay's
  // pan/zoom `transform: scale(view.scale)` is applied, which is unrelated
  // to the affordance size we're checking here.
  const centerVisibleSize = await centerHandle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });
  check('mask center handle visible dot is >=20px (round-7 bump from 16px)', centerVisibleSize.width >= 20 && centerVisibleSize.height >= 20, centerVisibleSize);
  const rimHandle = page.locator('[data-testid="mask-handle-rim"]');
  const rimCursor = await rimHandle.evaluate((el) => getComputedStyle(el).cursor);
  check('mask rim (resize) handle has a resize cursor', rimCursor === 'ew-resize', rimCursor);
  const rimVisibleSize = await rimHandle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });
  check('mask rim handle visible dot is >=20px (round-7 bump from 16px)', rimVisibleSize.width >= 20 && rimVisibleSize.height >= 20, rimVisibleSize);

  // restore the default centered mask before the linear-mask check
  await setMaskShape('mask-1', { type: 'radial', mode: 'add', cx: 0.5, cy: 0.5, radius: 0.25, feather: 0.5, invert: false });

  // ---------------------------------------------------------------------
  console.log('verify-masks (5. linear mask: gradient direction via top-vs-bottom means):');
  await setMaskShape('mask-1', { type: 'linear', mode: 'add', x0: 0.5, y0: 0, x1: 0.5, y1: 1, feather: 0.3, invert: false });
  const stripSize = Math.round(dims.height * 0.08);
  const topMean = await regionMean(0, 0, dims.width, stripSize);
  const bottomMean = await regionMean(0, dims.height - stripSize, dims.width, stripSize);
  check(
    'top-to-bottom linear mask (p0=top) brightens the top strip more than the bottom (masked +1.5EV)',
    topMean > bottomMean + 0.02,
    { topMean, bottomMean }
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (6. red mask-select overlay is canvas-only, toggled by O):');
  const canvas = page.locator('.canvas-view-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const canvasBox = await canvas.boundingBox();
  const clipSize = Math.min(canvasBox.width, canvasBox.height) * 0.15;
  const clip = {
    x: canvasBox.x + canvasBox.width / 2 - clipSize / 2,
    y: canvasBox.y + canvasBox.height / 2 - clipSize / 2,
    width: clipSize,
    height: clipSize,
  };
  const clipMeans = async () => {
    const buf = await page.screenshot({ clip });
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
  };
  const overlayOffMean = await gpuMean();
  const screenshotOff = await clipMeans();
  await page.keyboard.press('o');
  const screenshotOn = await clipMeans();
  const overlayOnMean = await gpuMean();
  const redness = (m) => m.r - (m.g + m.b) / 2;
  check(
    "overlay ON elevates the masked region's red channel vs green/blue, relative to overlay OFF",
    redness(screenshotOn) > redness(screenshotOff) + 0.05,
    { screenshotOff, screenshotOn }
  );
  check('readbackMean is identical with the overlay ON vs OFF (present-only)', meansMatch(overlayOnMean, overlayOffMean, 1e-9), {
    overlayOffMean,
    overlayOnMean,
  });
  await page.keyboard.press('o');
  const screenshotOffAgain = await clipMeans();
  check(
    "pressing O again removes the overlay (back near the OFF screenshot's redness)",
    Math.abs(redness(screenshotOffAgain) - redness(screenshotOff)) < 0.03,
    { screenshotOff, screenshotOffAgain }
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (6b. toolbar mask-overlay-toggle button — discoverable without the shortcut):');
  const overlayToggleBtn = page.locator('[data-testid="mask-overlay-toggle"]');
  check('toggle is enabled while a mask node is selected', await overlayToggleBtn.isEnabled(), await overlayToggleBtn.isEnabled());
  const toggleActive = (btn) => btn.evaluate((el) => el.classList.contains('active'));
  check('toggle starts inactive (overlay off)', (await toggleActive(overlayToggleBtn)) === false, await toggleActive(overlayToggleBtn));
  await overlayToggleBtn.click();
  check('clicking the toolbar toggle marks it active', (await toggleActive(overlayToggleBtn)) === true, await toggleActive(overlayToggleBtn));
  const screenshotToggleOn = await clipMeans();
  check(
    "the toolbar toggle produces the same red overlay as pressing 'O'",
    redness(screenshotToggleOn) > redness(screenshotOff) + 0.05,
    { screenshotOff, screenshotToggleOn }
  );
  await overlayToggleBtn.click();
  check('clicking again turns it back off', (await toggleActive(overlayToggleBtn)) === false, await toggleActive(overlayToggleBtn));

  // ---------------------------------------------------------------------
  console.log(
    'verify-masks (round-7 hand-test fix — "0キーでのオーバーレイは切り替わらないかも？赤のまま": overlay auto-clears off a mask selection; O never gets stuck):'
  );
  // Repro: enable the overlay while mask-1 is selected, then select a
  // DIFFERENT (non-mask) node the way a real user would — selecting it in
  // the node editor. Before this fix the overlay stayed red and 'O' went
  // dead, because the keydown handler required the CURRENT selection to be a
  // mask even just to turn it OFF (appStore.ts's lastMaskOverlaySelection
  // subscribe + App.tsx's 'O' handler are the two-part fix under test).
  // Selection goes through the __debug.selectNode hook rather than clicking
  // the React Flow node's DOM element: NodeEditorPanel's `fitView` only runs
  // once at mount, and by this point in the script the graph has grown
  // enough (masks/spots/outputs from earlier sections) that mask-1/dev-1 can
  // sit outside the panel's current pan/zoom — a real click there is flaky
  // (this is store-level selection, same UI effect either way).
  const selectNode = (id) => page.evaluate((n) => window.__debug.selectNode(n), id);
  await selectNode('mask-1');
  check(
    'mask-1 re-selected (setup)',
    await page.locator('.inspector-title', { hasText: 'Mask' }).isVisible().catch(() => false),
    true
  );
  await page.keyboard.press('o');
  check('overlay is ON with mask-1 selected (setup)', await toggleActive(overlayToggleBtn), await toggleActive(overlayToggleBtn));

  await selectNode('dev-1');
  check(
    'dev-1 re-selected (setup)',
    await page.locator('.inspector-title', { hasText: 'Develop' }).isVisible().catch(() => false),
    true
  );
  check(
    'selecting a non-mask node auto-clears the overlay (was stuck ON before this fix)',
    (await toggleActive(overlayToggleBtn)) === false,
    await toggleActive(overlayToggleBtn)
  );
  const screenshotAfterAutoClear = await clipMeans();
  check(
    'the red overlay is actually gone from the canvas too, not just the button state',
    redness(screenshotAfterAutoClear) < redness(screenshotOff) + 0.05,
    { screenshotOff, screenshotAfterAutoClear }
  );

  // With dev-1 (non-mask) still selected and the overlay already off, 'O'
  // must be a harmless no-op — never re-enabling it (its "turn ON" branch
  // still requires a mask selection) and never getting "stuck" either way.
  await page.keyboard.press('o');
  check(
    "'O' with a non-mask node selected and the overlay already off stays off (no-op, not stuck)",
    (await toggleActive(overlayToggleBtn)) === false,
    await toggleActive(overlayToggleBtn)
  );

  // Same repro via "click the canvas" (the brief's other reported trigger,
  // deselecting to selectedNodeId: null via NodeEditorPanel's onPaneClick) —
  // the pane itself is a fixed background layer regardless of pan/zoom, so a
  // real click is reliable here (unlike the individual node clicks above).
  await selectNode('mask-1');
  await page.keyboard.press('o');
  check('overlay back ON with mask-1 selected (setup)', await toggleActive(overlayToggleBtn), await toggleActive(overlayToggleBtn));
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  check(
    'clicking the empty canvas pane (deselecting) also auto-clears the overlay',
    (await toggleActive(overlayToggleBtn)) === false,
    await toggleActive(overlayToggleBtn)
  );

  // Confirm the fix didn't break the normal path: 'O' still turns the
  // overlay back ON once a mask is (re)selected, and back OFF again.
  await selectNode('mask-1');
  await page.keyboard.press('o');
  check("'O' still turns the overlay ON again once a mask is (re)selected", await toggleActive(overlayToggleBtn), await toggleActive(overlayToggleBtn));
  await page.keyboard.press('o');
  check('overlay left OFF for the sections below', (await toggleActive(overlayToggleBtn)) === false, await toggleActive(overlayToggleBtn));

  // ---------------------------------------------------------------------
  console.log('verify-masks (8. sidecar v3: save/reload, v2 fixture, unknown-key passthrough):');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const savedRaw = readFileSync(SIDECAR, 'utf8');
  const savedJson = JSON.parse(savedRaw);
  check('saved sidecar is schemaVersion 4', savedJson.schemaVersion === 4, savedJson.schemaVersion);
  check(
    "blend's mask edge serializes port:'mask' (not targetHandle)",
    savedJson.graph.edges.some((e) => e.to === 'blend-1' && e.port === 'mask') &&
      !savedJson.graph.edges.some((e) => 'targetHandle' in e),
    savedJson.graph.edges
  );
  check(
    'mask node serializes its mask params',
    savedJson.graph.nodes.find((n) => n.id === 'mask-1')?.mask?.shapes?.[0]?.type === 'linear',
    savedJson.graph.nodes.find((n) => n.id === 'mask-1')
  );

  await openAndWait(ARW_PATH);
  const reloadedGraph = await graphState();
  check(
    'reload restores mask/blend/port edges byte-for-byte',
    JSON.stringify(edgeList(reloadedGraph)) === JSON.stringify(edgesLA),
    { before: edgesLA, after: edgeList(reloadedGraph) }
  );
  const reloadedMask = reloadedGraph.nodes.find((n) => n.id === 'mask-1');
  check("reload restores the mask node's shape type (linear)", reloadedMask?.mask?.shapes?.[0]?.type === 'linear', reloadedMask);

  console.log('verify-masks (8. inline v2 fixture loads correctly):');
  const v2Fixture = JSON.stringify(
    {
      schemaVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      graph: {
        nodes: [
          { id: 'in', type: 'input', position: { x: 20, y: 60 } },
          { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
          { id: 'blend-1', type: 'blend', position: { x: 320, y: 60 }, params: { amount: 0.5 } },
          { id: 'out', type: 'output', position: { x: 420, y: 60 } },
        ],
        edges: [
          { id: 'e0', from: 'in', to: 'dev' },
          { id: 'e1', from: 'in', to: 'blend-1', targetHandle: 'a' },
          { id: 'e2', from: 'dev', to: 'blend-1', targetHandle: 'b' },
          { id: 'e3', from: 'blend-1', to: 'out' },
        ],
      },
    },
    null,
    2
  );
  writeFileSync(SIDECAR, v2Fixture);
  await openAndWait(ARW_PATH);
  const v2Graph = await graphState();
  check(
    "v2 fixture (targetHandle 'a'/'b', no mask/name) loads with its blend wiring intact",
    edgeList(v2Graph).includes('in->blend-1:a') && edgeList(v2Graph).includes('dev->blend-1:b'),
    edgeList(v2Graph)
  );
  check('v2 fixture produced no page errors', pageErrors.length === 0, pageErrors);

  console.log('verify-masks (§1 sidecar v3→v4: pre-v4 mask coords migrate output-frame → anchor space on load):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  // A hand-written v3 fixture with a NON-identity geometry (a plain crop) and
  // an (unconnected) mask node whose coords are in the OLD output frame. On
  // load, migrateCoordsToAnchor converts them using the doc's own geometry +
  // the decoded dims — for a pure crop the math is cx_anchor = cx_out·w + x.
  const CROP = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 };
  const v3Fixture = JSON.stringify(
    {
      schemaVersion: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      graph: {
        nodes: [
          { id: 'in', type: 'input', position: { x: 20, y: 60 }, geometry: { crop: CROP, angle: 0, orientation: { quarterTurns: 0, flipH: false } } },
          { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
          {
            id: 'mask-1',
            type: 'mask',
            position: { x: 220, y: 200 },
            mask: { shapes: [{ type: 'radial', mode: 'add', cx: 0.5, cy: 0.5, radius: 0.25, feather: 0.5, invert: false }] },
          },
          { id: 'out', type: 'output', position: { x: 420, y: 60 } },
        ],
        edges: [
          { id: 'e0', from: 'in', to: 'dev' },
          { id: 'e1', from: 'dev', to: 'out' },
        ],
      },
    },
    null,
    2
  );
  writeFileSync(SIDECAR, v3Fixture);
  await openAndWait(ARW_PATH);
  const migDims = await page.evaluate(() => window.__debug.imageState());
  const W = migDims.width;
  const H = migDims.height;
  const migExpectedCx = 0.5 * CROP.w + CROP.x; // angle 0 ⇒ pure per-axis remap
  const migExpectedCy = 0.5 * CROP.h + CROP.y;
  const migExpectedRadius = (0.25 * Math.max(CROP.w * W, CROP.h * H)) / Math.max(W, H);
  const migrated = (await maskState('mask-1')).shapes[0];
  check('v3 mask cx migrated to anchor space (cx_out·crop.w + crop.x)', Math.abs(migrated.cx - migExpectedCx) < 1e-6, { migrated, migExpectedCx });
  check('v3 mask cy migrated to anchor space (cy_out·crop.h + crop.y)', Math.abs(migrated.cy - migExpectedCy) < 1e-6, { migrated, migExpectedCy });
  check('v3 mask radius migrated by the output→anchor max-dim ratio', Math.abs(migrated.radius - migExpectedRadius) < 1e-6, { migrated, migExpectedRadius });
  // Loading a v3 fixture migrates in memory but does NOT mark the graph dirty
  // (lazy migration — disk stays v3 until the user edits). Dirty it with a
  // benign edit so ⌘S actually writes (and waitForFunction has a real
  // transition to wait for), without touching the mask coords under test.
  await updateNodeParam('dev', 'basic.ev', 0.01);
  await page.waitForFunction(() => window.__debug.graphDirty(), { timeout: 5_000 });
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const v4Saved = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check('re-saving the migrated doc writes schemaVersion 4', v4Saved.schemaVersion === 4, v4Saved.schemaVersion);
  const savedMaskShape = v4Saved.graph.nodes.find((n) => n.id === 'mask-1')?.mask?.shapes?.[0];
  check('v4 sidecar stores the migrated anchor coords verbatim', JSON.stringify(savedMaskShape) === JSON.stringify(migrated), { savedMaskShape, migrated });
  await openAndWait(ARW_PATH);
  const reMigrated = (await maskState('mask-1')).shapes[0];
  check('reloading the v4 sidecar does NOT convert again (v4 round-trips byte-stable)', JSON.stringify(reMigrated) === JSON.stringify(migrated), { migrated, reMigrated });
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

  console.log('verify-masks (8. unknown-key passthrough — wrapper and node level):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH);
  await page.keyboard.press('Meta+s');
  // A fresh open is already graphDirty === false, so waiting on that races
  // the async write (the filmstrip fixture's exact bug) — poll for the FILE.
  for (let i = 0; i < 100 && !existsSync(SIDECAR); i++) await new Promise((r) => setTimeout(r, 100));
  const cleanJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  cleanJson.someFutureWrapperField = 'wrapper-extra';
  const devNodeIdx = cleanJson.graph.nodes.findIndex((n) => n.id === 'dev');
  cleanJson.graph.nodes[devNodeIdx].someFutureNodeField = 'node-extra';
  writeFileSync(SIDECAR, JSON.stringify(cleanJson, null, 2));
  await openAndWait(ARW_PATH);
  const mtimeBeforeResave = statSync(SIDECAR).mtimeMs;
  await page.keyboard.press('Meta+s');
  // same fresh-open race as above — the resave rewrites an EXISTING file, so
  // poll for its mtime to move instead of mere existence
  for (let i = 0; i < 100 && statSync(SIDECAR).mtimeMs === mtimeBeforeResave; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const resavedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check('unknown wrapper-level key survives load+save', resavedJson.someFutureWrapperField === 'wrapper-extra', resavedJson.someFutureWrapperField);
  check(
    'unknown node-level key survives load+save',
    resavedJson.graph.nodes.find((n) => n.id === 'dev')?.someFutureNodeField === 'node-extra',
    resavedJson.graph.nodes.find((n) => n.id === 'dev')
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (9. named outputs: selector, switching, export):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH);
  await updateNodeParam('dev', 'basic.ev', 1.0);
  const meanMainOutput = await gpuMean();
  const selectorVisibleBefore = await page
    .locator('[data-testid="output-selector"]')
    .isVisible()
    .catch(() => false);
  check('output selector is absent with only one output node', !selectorVisibleBefore, selectorVisibleBefore);

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-output"]').click();
  const gWithSecondOutput = await graphState();
  const secondOutputId = gWithSecondOutput.nodes.find((n) => n.kind === 'output' && n.id !== 'out').id;
  await page.locator(`.react-flow__node[data-id="${secondOutputId}"]`).click();
  await page.locator('[data-testid="output-name"]').fill('raw');

  // wire it "before" the Develop adjustment — straight off the input node,
  // so it differs from the primary output (which goes through dev's +1EV)
  const inSourceHandle = page.locator('.react-flow__node[data-id="in"] .react-flow__handle.source');
  const secondTargetHandle = page.locator(`.react-flow__node[data-id="${secondOutputId}"] .react-flow__handle.target`);
  const srcBox = await inSourceHandle.boundingBox();
  const dstBox = await secondTargetHandle.boundingBox();
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const gWired = await graphState();
  check('second output wired directly from input (bypassing Develop)', edgeList(gWired).includes(`in->${secondOutputId}`), edgeList(gWired));

  const selectorVisibleAfter = await page
    .locator('[data-testid="output-selector"]')
    .isVisible()
    .catch(() => false);
  check('output selector appears once a second output node exists', selectorVisibleAfter, selectorVisibleAfter);

  await page.locator('[data-testid="output-selector"]').selectOption(secondOutputId);
  const meanSecondOutput = await gpuMean();
  check(
    'switching the selector changes readbackMean (second output bypasses the +1EV Develop edit)',
    Math.abs(meanSecondOutput.r - meanMainOutput.r) > 0.02,
    { meanMainOutput, meanSecondOutput }
  );

  const exportAndWait = async (path, outputId) => {
    await page.locator('[data-testid="output-selector"]').selectOption(outputId);
    await page.evaluate((p) => window.__debug.exportImageTo(p, { quality: 95 }), path);
    await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
    return page.evaluate(() => window.__debug.exportState());
  };
  const mainExportState = await exportAndWait(OUT_MAIN, 'out');
  const secondExportState = await exportAndWait(OUT_SECOND, secondOutputId);
  check('export (main output) succeeded', mainExportState.status === 'idle', mainExportState);
  check('export (second output) succeeded', secondExportState.status === 'idle', secondExportState);

  const rawMean = async (path) => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    const n = info.width * info.height;
    for (let i = 0; i < n; i++) {
      r += data[i * info.channels];
      g += data[i * info.channels + 1];
      b += data[i * info.channels + 2];
    }
    return (r / n + g / n + b / n) / 3 / 255;
  };
  const mainFileMean = await rawMean(OUT_MAIN);
  const secondFileMean = await rawMean(OUT_SECOND);
  check('export honors the selected output — the two exported files differ', Math.abs(mainFileMean - secondFileMean) > 0.02, {
    mainFileMean,
    secondFileMean,
  });

  // ---------------------------------------------------------------------
  console.log('verify-masks (10. drag-to-create: mousedown/move/up commits a shape matching the drag; Escape cancels):');
  const drawCanvas = page.locator('.canvas-view-canvas');
  await drawCanvas.scrollIntoViewIfNeeded();
  const drawBox = await drawCanvas.boundingBox();
  const nodesBeforeDraw = (await graphState()).nodes.length;

  // Escape cancels cleanly: entering draw mode alone creates nothing, and
  // Escape after a partial drag (mousedown, no mouseup yet) still leaves
  // zero new nodes.
  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  await page.mouse.move(drawBox.x + drawBox.width * 0.3, drawBox.y + drawBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + drawBox.width * 0.4, drawBox.y + drawBox.height * 0.35, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up(); // release after Escape already canceled — must not resurrect a commit
  const nodesAfterEscape = (await graphState()).nodes.length;
  check('Escape cancels draw mode with zero new nodes', nodesAfterEscape === nodesBeforeDraw, {
    nodesBeforeDraw,
    nodesAfterEscape,
  });
  const pickingAfterEscape = await drawCanvas.evaluate((el) => el.classList.contains('canvas-view-canvas--picking'));
  check('Escape exits draw mode (crosshair cursor reverts)', !pickingAfterEscape, pickingAfterEscape);

  // A real drag: mousedown sets the radial center, dragging sets the
  // radius, mouseup commits ONE history entry with shapes[0] matching the
  // drag (within a few px, converting the normalized shape back to canvas px
  // the same way MaskDrawOverlay does). Reset to 'fit' first: earlier mask-
  // handle drags in this suite pan the view (useCanvasViewport's pan-
  // suppression didn't know about .mask-handle — now fixed alongside this
  // feature), so start from a known, centered view instead of depending on
  // whatever pan state prior sections left behind.
  await page.locator('[data-testid="view-fit"]').click();
  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  const pastBeforeDrawDrag = await historyPast();
  const dragBox = await drawCanvas.boundingBox();
  const startX = dragBox.x + dragBox.width * 0.3;
  const startY = dragBox.y + dragBox.height * 0.35;
  const endX = dragBox.x + dragBox.width * 0.45;
  const endY = dragBox.y + dragBox.height * 0.35;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();
  check('drag-to-create is exactly one undo entry', (await historyPast()) === pastBeforeDrawDrag + 1, {
    before: pastBeforeDrawDrag,
    after: await historyPast(),
  });
  const gAfterDrawDrag = await graphState();
  const drawnMask = gAfterDrawDrag.nodes.filter((n) => n.kind === 'mask').at(-1);
  const drawDims = await outputDims();
  const expectedCx = (startX - dragBox.x) / dragBox.width;
  const expectedCy = (startY - dragBox.y) / dragBox.height;
  const expectedRadius =
    Math.hypot((endX - startX) / dragBox.width * drawDims.width, (endY - startY) / dragBox.height * drawDims.height) /
    Math.max(drawDims.width, drawDims.height);
  const shape = drawnMask.mask.shapes[0];
  check(
    "drawn shape's center matches the mousedown point (within a few px)",
    Math.abs(shape.cx - expectedCx) * drawDims.width < 4 && Math.abs(shape.cy - expectedCy) * drawDims.height < 4,
    { expectedCx, expectedCy, actual: { cx: shape.cx, cy: shape.cy }, width: drawDims.width, height: drawDims.height }
  );
  check(
    "drawn shape's radius matches the drag distance (within a few px)",
    Math.abs(shape.radius - expectedRadius) * Math.max(drawDims.width, drawDims.height) < 4,
    { expectedRadius, actualRadius: shape.radius }
  );

  // ---------------------------------------------------------------------
  console.log('verify-masks (§5 the LIVE draw preview shows the affected AREA, not a bare outline):');
  await page.locator('[data-testid="view-fit"]').click();
  const pvBox = await drawCanvas.boundingBox();
  // radial: a translucent fill + a dashed feather circle appear mid-drag
  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  await page.mouse.move(pvBox.x + pvBox.width * 0.4, pvBox.y + pvBox.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(pvBox.x + pvBox.width * 0.55, pvBox.y + pvBox.height * 0.4, { steps: 4 });
  await page.waitForSelector('.mask-draw-overlay [data-testid="mask-area-radial"]', { timeout: 3_000 });
  check(
    'radial draw preview shows a translucent area fill',
    (await page.locator('.mask-draw-overlay .mask-area-fill').count()) === 1,
    await page.locator('.mask-draw-overlay .mask-area-fill').count()
  );
  check(
    'radial draw preview shows a dashed feather circle',
    (await page.locator('.mask-draw-overlay [data-testid="mask-area-feather"]').count()) === 1,
    await page.locator('.mask-draw-overlay [data-testid="mask-area-feather"]').count()
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  // linear: three parallel guide lines + a translucent gradient band mid-drag
  await page.locator('[data-testid="add-local-adjustment-linear"]').click();
  await page.mouse.move(pvBox.x + pvBox.width * 0.3, pvBox.y + pvBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(pvBox.x + pvBox.width * 0.6, pvBox.y + pvBox.height * 0.6, { steps: 4 });
  await page.waitForSelector('.mask-draw-overlay [data-testid="mask-area-linear"]', { timeout: 3_000 });
  check(
    'linear draw preview shows three parallel guide lines (100%/50%/0%)',
    (await page.locator('.mask-draw-overlay .mask-area-line').count()) === 3,
    await page.locator('.mask-draw-overlay .mask-area-line').count()
  );
  check(
    'linear draw preview shows the translucent gradient band',
    (await page.locator('.mask-draw-overlay .mask-area-gradient').count()) === 1,
    await page.locator('.mask-draw-overlay .mask-area-gradient').count()
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();

  check('no page errors across the masks-milestone checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
