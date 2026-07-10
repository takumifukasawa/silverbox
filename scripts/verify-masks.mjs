/**
 * Masks milestone verify: mask nodes, mask-driven blend, "+ Local
 * Adjustment", named multiple outputs, sidecar schemaVersion 3.
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
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;
const OUT_MAIN = join(projectRoot, 'test-artifacts', 'masks-output-main.jpg');
const OUT_SECOND = join(projectRoot, 'test-artifacts', 'masks-output-second.jpg');

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
  console.log('verify-masks (2. + Local Adjustment: one click, one undo entry, D/M/B wired):');
  const pastBeforeLA = await historyPast();
  await page.locator('[data-testid="add-local-adjustment"]').click();
  check('+ Local Adjustment is exactly one undo entry', (await historyPast()) === pastBeforeLA + 1, {
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
  console.log('verify-masks (8. sidecar v3: save/reload, v2 fixture, unknown-key passthrough):');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const savedRaw = readFileSync(SIDECAR, 'utf8');
  const savedJson = JSON.parse(savedRaw);
  check('saved sidecar is schemaVersion 3', savedJson.schemaVersion === 3, savedJson.schemaVersion);
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

  console.log('verify-masks (8. unknown-key passthrough — wrapper and node level):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH);
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const cleanJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  cleanJson.someFutureWrapperField = 'wrapper-extra';
  const devNodeIdx = cleanJson.graph.nodes.findIndex((n) => n.id === 'dev');
  cleanJson.graph.nodes[devNodeIdx].someFutureNodeField = 'node-extra';
  writeFileSync(SIDECAR, JSON.stringify(cleanJson, null, 2));
  await openAndWait(ARW_PATH);
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
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
