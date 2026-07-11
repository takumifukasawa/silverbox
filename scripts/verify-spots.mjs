/**
 * Spot removal verify (task #50): manual clone-circle spots, non-destructive
 * list, spatial (no CPU mirror) engine wiring.
 *  1. Identity: fresh open, toggle spot mode on/off with no spots ⇒
 *     readbackMean bit-identical to baseline; graph unchanged.
 *  2. Scripted create: drag from a dark region (dst) to a bright region
 *     (src) with a generous radius ⇒ the dst region's mean moves toward the
 *     src region's PRE-EDIT mean, the src region itself stays unchanged,
 *     exactly ONE undo entry for the whole gesture (auto-insert + spot). A
 *     mid-drag Escape first proves the gesture cancels cleanly (no node).
 *  3. ⌘Z removes both the spot AND the auto-inserted node (one entry);
 *     ⌘⇧Z (redo) restores both.
 *  4. Move dst handle by drag ⇒ spots[0].dx/dy change by the expected
 *     normalized delta, one undo entry.
 *  5. Delete selected spot via Backspace; clear-all via the inspector.
 *  6. Sidecar round-trip: save, reopen, spots list byte-equal, render mean
 *     equal.
 *  7. Cap: programmatically set 32 spots (setSpots debug hook), then a UI
 *     drag for a 33rd shows the toolbar cap notice and leaves the list at 32.
 *  8. Empty-list node present ⇒ still bit-exact identity (pass not emitted).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const TIGHT_TOLERANCE = 1e-6;

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

const meansMatch = (a, b, tol) => a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const outputDims = () => page.evaluate(() => window.__debug.outputDims());
  const canvasView = () => page.evaluate(() => window.__debug.canvasView());
  const spotsState = (nodeId) => page.evaluate((n) => window.__debug.spotsState(n), nodeId ?? null);
  const setSpots = (nodeId, spots) => page.evaluate(([n, sp]) => window.__debug.setSpots(n, sp), [nodeId, spots]);
  const activeSpotsNodeId = () => page.evaluate(() => window.__debug.activeSpotsNodeId());
  const spotState = () => page.evaluate(() => window.__debug.spotState());
  const setSpotBrushRadius = (r) => page.evaluate((v) => window.__debug.setSpotBrushRadius(v), r);
  // Playwright's locator.fill() applies stricter step-precision validation
  // than the browser itself for this slider's 0.001 step (rejects some
  // otherwise-valid values as "Malformed value") — set the value through the
  // native input value setter and dispatch a bubbling 'input' event instead,
  // which is what a real drag fires and React's onChange listens for.
  const setRangeValue = (testId, value) =>
    page.locator(`[data-testid="${testId}"]`).evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  const edgeList = (g) => g.edges.map((e) => `${e.source}->${e.target}${e.targetHandle ? ':' + e.targetHandle : ''}`).sort();

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

  // Idempotent — spotMode is a toggle button, so blindly clicking it would
  // flip OFF a mode that's already on (spot mode deliberately stays ON after
  // committing a spot, unlike mask-draw's single-shot mode, so several of
  // these checks run back-to-back with it already active).
  const setSpotModeUi = async (want) => {
    const current = await page.evaluate(() => window.__debug.spotState().mode);
    if (current !== want) await page.locator('[data-testid="spots-toggle"]').click();
  };

  // ---------------------------------------------------------------------
  console.log('verify-spots (1. identity: toggle spot mode on/off with no spots, GPU bit-identical, graph unchanged):');
  await openAndWait(ARW_PATH);
  const baselineMean = await gpuMean();
  const baselineGraph = await graphState();
  await setSpotModeUi(true);
  const canvasForPicking = page.locator('.canvas-view-canvas');
  await canvasForPicking.scrollIntoViewIfNeeded();
  const isPickingCursor = await canvasForPicking.evaluate((el) => el.classList.contains('canvas-view-canvas--picking'));
  check('spot mode signals with the crosshair cursor class', isPickingCursor, isPickingCursor);
  await setSpotModeUi(false);
  const afterToggleMean = await gpuMean();
  const afterToggleGraph = await graphState();
  check('toggling spot mode on/off with no spots leaves readbackMean bit-identical', meansMatch(afterToggleMean, baselineMean, TIGHT_TOLERANCE), {
    baselineMean,
    afterToggleMean,
  });
  check('toggling spot mode never touches the graph', JSON.stringify(edgeList(afterToggleGraph)) === JSON.stringify(edgeList(baselineGraph)) && afterToggleGraph.nodes.length === baselineGraph.nodes.length, {
    before: baselineGraph.nodes.length,
    after: afterToggleGraph.nodes.length,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (locate a dark region and a bright region, spatially separated, via an in-page grid scan):');
  const halves = await page.evaluate((gridSize) => {
    const img = window.__debug.imageForVerify();
    if (!img) return null;
    const { data, width, height } = img;
    const srgbEncode1 = (v) => {
      const c = Math.min(Math.max(v, 0), 1);
      return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    };
    const scanRegion = (rx0, ry0, rw, rh) => {
      const cw = Math.max(1, Math.floor(rw / gridSize));
      const ch = Math.max(1, Math.floor(rh / gridSize));
      const cells = [];
      for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
          const x0 = rx0 + gx * cw;
          const y0 = ry0 + gy * ch;
          const strideX = Math.max(1, Math.floor(cw / 16));
          const strideY = Math.max(1, Math.floor(ch / 16));
          let sum = 0;
          let n = 0;
          for (let y = y0; y < y0 + ch; y += strideY) {
            for (let x = x0; x < x0 + cw; x += strideX) {
              const idx = (y * width + x) * 4;
              sum += srgbEncode1(data[idx]) + srgbEncode1(data[idx + 1]) + srgbEncode1(data[idx + 2]);
              n++;
            }
          }
          cells.push({ x0, y0, w: cw, h: ch, mean: n > 0 ? sum / (n * 3) : 0 });
        }
      }
      return cells;
    };
    const halfW = Math.floor(width / 2);
    return { width, height, leftCells: scanRegion(0, 0, halfW, height), rightCells: scanRegion(halfW, 0, width - halfW, height) };
  }, 6);
  check('imageForVerify() produced usable grid stats', halves !== null && halves.leftCells.length === 36 && halves.rightCells.length === 36, halves && { l: halves.leftCells.length, r: halves.rightCells.length });
  const avg = (cells) => cells.reduce((a, c) => a + c.mean, 0) / cells.length;
  const leftAvg = avg(halves.leftCells);
  const rightAvg = avg(halves.rightCells);
  // pick the dst (dark) cell from whichever half is dimmer overall, and the
  // src (bright) cell from the other half — guarantees both a meaningful
  // contrast AND spatial separation (opposite halves) so the generous clone
  // radius in check 2 can never bridge dst and src.
  const darkHalf = leftAvg <= rightAvg ? halves.leftCells : halves.rightCells;
  const brightHalf = leftAvg <= rightAvg ? halves.rightCells : halves.leftCells;
  const darkCell = [...darkHalf].sort((a, b) => a.mean - b.mean)[0];
  const brightCell = [...brightHalf].sort((a, b) => b.mean - a.mean)[0];
  console.log(`  dark cell:   mean=${darkCell.mean.toFixed(3)} at (${darkCell.x0},${darkCell.y0})`);
  console.log(`  bright cell: mean=${brightCell.mean.toFixed(3)} at (${brightCell.x0},${brightCell.y0})`);
  check('bright region is meaningfully brighter than the dark region', brightCell.mean > darkCell.mean + 0.05, {
    darkMean: darkCell.mean,
    brightMean: brightCell.mean,
  });
  const dstNorm = { x: (darkCell.x0 + darkCell.w / 2) / halves.width, y: (darkCell.y0 + darkCell.h / 2) / halves.height };
  const srcNorm = { x: (brightCell.x0 + brightCell.w / 2) / halves.width, y: (brightCell.y0 + brightCell.h / 2) / halves.height };
  const preDstMean = await regionMean(darkCell.x0, darkCell.y0, darkCell.w, darkCell.h);
  const preSrcMean = await regionMean(brightCell.x0, brightCell.y0, brightCell.w, brightCell.h);

  // ---------------------------------------------------------------------
  console.log('verify-spots (2. scripted create: Escape cancels cleanly, then a real drag commits one spot):');
  const nodesBeforeCreate = (await graphState()).nodes.length;
  await setSpotModeUi(true);
  await setSpotBrushRadius(0.12); // generous — comfortably covers a whole grid cell
  const canvas = page.locator('.canvas-view-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const canvasBox = await canvas.boundingBox();
  const toScreen = (norm) => ({ x: canvasBox.x + norm.x * canvasBox.width, y: canvasBox.y + norm.y * canvasBox.height });
  const dstScreen = toScreen(dstNorm);
  const srcScreen = toScreen(srcNorm);

  // Escape mid-drag cancels cleanly — zero new nodes.
  await page.mouse.move(dstScreen.x, dstScreen.y);
  await page.mouse.down();
  await page.mouse.move((dstScreen.x + srcScreen.x) / 2, (dstScreen.y + srcScreen.y) / 2, { steps: 3 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const nodesAfterEscape = (await graphState()).nodes.length;
  check('Escape mid-drag cancels the gesture with zero new nodes', nodesAfterEscape === nodesBeforeCreate, {
    nodesBeforeCreate,
    nodesAfterEscape,
  });
  const pickingAfterEscape = await canvas.evaluate((el) => el.classList.contains('canvas-view-canvas--picking'));
  check('Escape exits spot mode (crosshair cursor reverts)', !pickingAfterEscape, pickingAfterEscape);

  // The real gesture: mousedown = dst, drag to src, mouseup commits.
  await setSpotModeUi(true);
  await setSpotBrushRadius(0.12);
  const pastBeforeCreate = await historyPast();
  await page.mouse.move(dstScreen.x, dstScreen.y);
  await page.mouse.down();
  await page.mouse.move(srcScreen.x, srcScreen.y, { steps: 8 });
  await page.mouse.up();
  check('create-by-drag is exactly ONE undo entry (auto-insert + spot)', (await historyPast()) === pastBeforeCreate + 1, {
    before: pastBeforeCreate,
    after: await historyPast(),
  });
  const gAfterCreate = await graphState();
  const spotsNode = gAfterCreate.nodes.find((n) => n.kind === 'spots');
  check('a spots node was auto-inserted', !!spotsNode, spotsNode);
  const spotsNodeId = spotsNode.id;
  const inputNode = gAfterCreate.nodes.find((n) => n.kind === 'input');
  const edges = edgeList(gAfterCreate);
  check('spots node wired right after input (input→spots→…)', edges.includes(`${inputNode.id}->${spotsNodeId}`), edges);
  check('spots node holds exactly one spot', spotsNode.spots?.spots?.length === 1, spotsNode.spots);

  const postDstMean = await regionMean(darkCell.x0, darkCell.y0, darkCell.w, darkCell.h);
  const postSrcMean = await regionMean(brightCell.x0, brightCell.y0, brightCell.w, brightCell.h);
  check('dst region mean moved toward the src region pre-edit mean', Math.abs(postDstMean - preSrcMean) < Math.abs(preDstMean - preSrcMean), {
    preDstMean,
    preSrcMean,
    postDstMean,
  });
  check('dst region brightened meaningfully', postDstMean > preDstMean + 0.05, { preDstMean, postDstMean });
  check('src region itself is unchanged', Math.abs(postSrcMean - preSrcMean) < 0.01, { preSrcMean, postSrcMean });
  const meanAfterCreate = await gpuMean();

  // ---------------------------------------------------------------------
  console.log('verify-spots (3. undo removes both the spot AND the auto-inserted node; redo restores):');
  await page.keyboard.press('Meta+z');
  const gAfterUndo = await graphState();
  check('undo removes the auto-inserted spots node', !gAfterUndo.nodes.some((n) => n.kind === 'spots'), gAfterUndo.nodes.map((n) => n.kind));
  check('undo restores the original edges', JSON.stringify(edgeList(gAfterUndo)) === JSON.stringify(edgeList(baselineGraph)), {
    before: edgeList(baselineGraph),
    after: edgeList(gAfterUndo),
  });
  const meanAfterUndo = await gpuMean();
  check('undo restores the pre-spot readbackMean', meansMatch(meanAfterUndo, baselineMean, TIGHT_TOLERANCE), {
    baselineMean,
    meanAfterUndo,
  });

  await page.keyboard.press('Meta+Shift+z');
  const gAfterRedo = await graphState();
  check('redo restores the spots node and its wiring', JSON.stringify(edgeList(gAfterRedo)) === JSON.stringify(edgeList(gAfterCreate)), {
    before: edgeList(gAfterCreate),
    after: edgeList(gAfterRedo),
  });
  const redoneSpots = gAfterRedo.nodes.find((n) => n.id === spotsNodeId);
  check('redo restores the spot itself', redoneSpots?.spots?.spots?.length === 1, redoneSpots?.spots);
  const meanAfterRedo = await gpuMean();
  check('redo restores the post-spot readbackMean', meansMatch(meanAfterRedo, meanAfterCreate, TIGHT_TOLERANCE), {
    meanAfterCreate,
    meanAfterRedo,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (4. move dst handle by drag: expected normalized delta, one undo entry):');
  await setSpotModeUi(true);
  const dstHandle = page.locator('[data-testid="spot-handle-dst-0"]');
  await dstHandle.scrollIntoViewIfNeeded();
  const dhBox = await dstHandle.boundingBox();
  const view = await canvasView();
  const dimsNow = await outputDims();
  const spotsBeforeDrag = await spotsState(spotsNodeId);
  const spotBeforeDrag = spotsBeforeDrag.spots[0];
  const pastBeforeDrag = await historyPast();
  const dragDx = 24;
  const dragDy = -16;
  await page.mouse.move(dhBox.x + dhBox.width / 2, dhBox.y + dhBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dhBox.x + dhBox.width / 2 + dragDx, dhBox.y + dhBox.height / 2 + dragDy, { steps: 6 });
  await page.mouse.up();
  check('dragging the dst handle is exactly one undo entry', (await historyPast()) === pastBeforeDrag + 1, {
    before: pastBeforeDrag,
    after: await historyPast(),
  });
  const spotsAfterDrag = await spotsState(spotsNodeId);
  const spotAfterDrag = spotsAfterDrag.spots[0];
  const expectedDx = dragDx / view.scale / dimsNow.width;
  const expectedDy = dragDy / view.scale / dimsNow.height;
  check('spots[0].dx moved by the expected normalized delta', Math.abs(spotAfterDrag.dx - (spotBeforeDrag.dx + expectedDx)) < 0.01, {
    before: spotBeforeDrag.dx,
    after: spotAfterDrag.dx,
    expectedDelta: expectedDx,
  });
  check('spots[0].dy moved by the expected normalized delta', Math.abs(spotAfterDrag.dy - (spotBeforeDrag.dy + expectedDy)) < 0.01, {
    before: spotBeforeDrag.dy,
    after: spotAfterDrag.dy,
    expectedDelta: expectedDy,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (UX pack D round-5: selected-spot SLIDER resize — LR "resize the selected heal circle" behavior):');
  // spot 0 is still selected from section 4's dst-handle drag; geometry is
  // still identity here (the §1 anchor rotate check runs later in this
  // file), so anchor radius == output radius exactly.
  check('spot 0 is selected heading into the slider check', (await spotState()).selectedIndex === 0, (await spotState()).selectedIndex);
  const sliderLabelText = await page.locator('[data-testid="spot-controls"] label').innerText();
  check('slider label reads "Spot radius" while a spot is selected (legible state, not just "Brush radius")', sliderLabelText.includes('Spot radius'), sliderLabelText);
  const brushRadiusBeforeSlider = (await spotState()).brushRadius;
  const anchorRadiusBeforeSlider = (await spotsState(spotsNodeId)).spots[0].radius;
  const pastBeforeSlider = await historyPast();
  const slider = page.locator('[data-testid="spot-radius-slider"]');
  await slider.scrollIntoViewIfNeeded();
  // Three ticks of ONE slider session (mirrors CropOverlay's angle-slider
  // coalescing pattern) should land as exactly one undo entry.
  await setRangeValue('spot-radius-slider', 0.09);
  await setRangeValue('spot-radius-slider', 0.1);
  await setRangeValue('spot-radius-slider', 0.11);
  const anchorRadiusAfterSlider = (await spotsState(spotsNodeId)).spots[0].radius;
  check('slider tick moved spots[0].radius (anchor space, identity geometry ⇒ equals the output-space slider value)', Math.abs(anchorRadiusAfterSlider - 0.11) < 0.005, {
    before: anchorRadiusBeforeSlider,
    after: anchorRadiusAfterSlider,
  });
  check('three slider ticks in one session coalesce into ONE undo entry', (await historyPast()) === pastBeforeSlider + 1, {
    before: pastBeforeSlider,
    after: await historyPast(),
  });
  const brushRadiusAfterSlider = (await spotState()).brushRadius;
  check('brushRadius (next-spot size) is untouched while the slider edits a selection', brushRadiusAfterSlider === brushRadiusBeforeSlider, {
    brushRadiusBeforeSlider,
    brushRadiusAfterSlider,
  });

  // Clear the selection (toggling spot mode off/on resets selectedSpotIndex
  // — appStore.ts's setSpotMode — and remounts SpotOverlay, so its slider
  // session ref starts fresh too) and confirm the slider reverts to
  // controlling the NEXT-spot brush radius, exactly as before this feature.
  await setSpotModeUi(false);
  await setSpotModeUi(true);
  check('no selection after the mode toggle', (await spotState()).selectedIndex === null, (await spotState()).selectedIndex);
  const noSelLabelText = await page.locator('[data-testid="spot-controls"] label').innerText();
  check('slider label reverts to "Brush radius" with nothing selected', noSelLabelText.includes('Brush radius'), noSelLabelText);
  const anchorRadiusBeforeNoSelSlider = (await spotsState(spotsNodeId)).spots[0].radius;
  await setRangeValue('spot-radius-slider', 0.05);
  const brushRadiusAfterNoSelSlider = (await spotState()).brushRadius;
  check('with nothing selected, the slider only moves spotState().brushRadius', Math.abs(brushRadiusAfterNoSelSlider - 0.05) < 0.005, brushRadiusAfterNoSelSlider);
  const anchorRadiusAfterNoSelSlider = (await spotsState(spotsNodeId)).spots[0].radius;
  check('spots[0].radius is untouched by the no-selection slider', anchorRadiusAfterNoSelSlider === anchorRadiusBeforeNoSelSlider, {
    anchorRadiusBeforeNoSelSlider,
    anchorRadiusAfterNoSelSlider,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (UX pack D round-5: selected-spot WHEEL resize mirrors the slider rule):');
  // Re-select spot 0 via a plain click (no drag) on its dst handle.
  const dstHandleForWheel = page.locator('[data-testid="spot-handle-dst-0"]');
  const dhwBox = await dstHandleForWheel.boundingBox();
  await page.mouse.move(dhwBox.x + dhwBox.width / 2, dhwBox.y + dhwBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  check('re-selected spot 0 via a plain click', (await spotState()).selectedIndex === 0, (await spotState()).selectedIndex);

  const anchorRadiusBeforeWheel = (await spotsState(spotsNodeId)).spots[0].radius;
  const pastBeforeWheel = await historyPast();
  await page.mouse.wheel(0, -80);
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(50);
  const anchorRadiusAfterWheel = (await spotsState(spotsNodeId)).spots[0].radius;
  check('wheel resized spots[0].radius while selected (mirrors the slider rule)', anchorRadiusAfterWheel !== anchorRadiusBeforeWheel, {
    before: anchorRadiusBeforeWheel,
    after: anchorRadiusAfterWheel,
  });
  check('two quick wheel ticks coalesce into ONE undo entry (idle-timeout session)', (await historyPast()) === pastBeforeWheel + 1, {
    before: pastBeforeWheel,
    after: await historyPast(),
  });

  // Clear the selection again and confirm the wheel reverts to brushRadius.
  // setSpotModeUi clicks the toolbar toggle, which leaves the mouse hovering
  // that button rather than the canvas — move it back over the canvas
  // viewport first, or the wheel event never reaches CanvasView's listener.
  await setSpotModeUi(false);
  await setSpotModeUi(true);
  await page.mouse.move(dhwBox.x + dhwBox.width / 2, dhwBox.y + dhwBox.height / 2);
  const brushRadiusBeforeNoSelWheel = (await spotState()).brushRadius;
  const anchorRadiusBeforeNoSelWheel = (await spotsState(spotsNodeId)).spots[0].radius;
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(50);
  const brushRadiusAfterNoSelWheel = (await spotState()).brushRadius;
  check('with nothing selected, wheel only moves spotState().brushRadius', brushRadiusAfterNoSelWheel !== brushRadiusBeforeNoSelWheel, {
    before: brushRadiusBeforeNoSelWheel,
    after: brushRadiusAfterNoSelWheel,
  });
  const anchorRadiusAfterNoSelWheel = (await spotsState(spotsNodeId)).spots[0].radius;
  check('spots[0].radius is untouched by the no-selection wheel', anchorRadiusAfterNoSelWheel === anchorRadiusBeforeNoSelWheel, {
    anchorRadiusBeforeNoSelWheel,
    anchorRadiusAfterNoSelWheel,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (round-6: ctrl+wheel (trackpad pinch) zooms even while spot mode owns the plain wheel):');
  // Playwright's page.mouse.wheel() can't set ctrlKey, so dispatch a real
  // WheelEvent — the same technique verify-ms9-viewport.mjs uses to
  // reproduce a macOS trackpad pinch in Chromium/Electron.
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
  const scaleBeforePinch = (await canvasView()).scale;
  const brushRadiusBeforePinch = (await spotState()).brushRadius;
  await dispatchCtrlWheel(-5);
  await page.waitForTimeout(30);
  const scaleAfterPinch = (await canvasView()).scale;
  const brushRadiusAfterPinch = (await spotState()).brushRadius;
  check('ctrl+wheel changes canvasView().scale while spot mode is active', scaleAfterPinch !== scaleBeforePinch, {
    scaleBeforePinch,
    scaleAfterPinch,
  });
  check(
    "ctrl+wheel does NOT touch spotState().brushRadius (spot mode's own wheel listener ignores ctrlKey)",
    brushRadiusAfterPinch === brushRadiusBeforePinch,
    { brushRadiusBeforePinch, brushRadiusAfterPinch }
  );

  // ---------------------------------------------------------------------
  console.log('verify-spots (5. delete selected spot via Backspace; clear-all via the inspector):');
  // Click (no drag) selects the spot without mutating the graph.
  const dstHandleForSelect = page.locator('[data-testid="spot-handle-dst-0"]');
  const dhBox2 = await dstHandleForSelect.boundingBox();
  await page.mouse.move(dhBox2.x + dhBox2.width / 2, dhBox2.y + dhBox2.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const selectedAfterClick = (await spotState()).selectedIndex;
  check('clicking a spot handle selects it (no drag, no graph mutation)', selectedAfterClick === 0, selectedAfterClick);
  const pastBeforeDelete = await historyPast();
  await page.keyboard.press('Backspace');
  check('Backspace removes the selected spot — one undo entry', (await historyPast()) === pastBeforeDelete + 1, {
    before: pastBeforeDelete,
    after: await historyPast(),
  });
  const afterDelete = await spotsState(spotsNodeId);
  check('the spots list is now empty, node still present', afterDelete !== null && afterDelete.spots.length === 0, afterDelete);
  const gAfterDelete = await graphState();
  check('Backspace does NOT remove the spots node itself (only the spot)', gAfterDelete.nodes.some((n) => n.id === spotsNodeId), gAfterDelete.nodes.map((n) => n.id));

  // seed a couple of spots directly (bypassing the UI) to exercise "clear all"
  await setSpots(spotsNodeId, [
    { dx: 0.3, dy: 0.3, sx: 0.6, sy: 0.3, radius: 0.05, feather: 0.3 },
    { dx: 0.7, dy: 0.7, sx: 0.4, sy: 0.7, radius: 0.05, feather: 0.3 },
  ]);
  check('setSpots seeded two spots', (await spotsState(spotsNodeId)).spots.length === 2, await spotsState(spotsNodeId));
  const clearAllBtn = page.locator('[data-testid="spots-clear-all"]');
  check('"Clear all" is enabled with spots present', await clearAllBtn.isEnabled(), await clearAllBtn.isEnabled());
  await clearAllBtn.click();
  const afterClearAll = await spotsState(spotsNodeId);
  check('"Clear all" empties the list — node still present', afterClearAll !== null && afterClearAll.spots.length === 0, afterClearAll);

  // ---------------------------------------------------------------------
  console.log('verify-spots (8. empty-list node present ⇒ still bit-exact identity, pass not emitted):');
  const meanWithEmptySpotsNode = await gpuMean();
  check('an empty-list spots node is a bit-exact pass-through', meansMatch(meanWithEmptySpotsNode, baselineMean, TIGHT_TOLERANCE), {
    baselineMean,
    meanWithEmptySpotsNode,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (§1 anchor: a spot stays pinned to image content across a rotation):');
  // Recreate a single healing spot over the SAME dark region the scan found
  // (identity geometry ⇒ anchor coords == the output-frame coords used above).
  await setSpots(spotsNodeId, [{ dx: dstNorm.x, dy: dstNorm.y, sx: srcNorm.x, sy: srcNorm.y, radius: 0.12, feather: 0.3 }]);
  await page.waitForTimeout(200);
  const healedDstIdentity = await regionMean(darkCell.x0, darkCell.y0, darkCell.w, darkCell.h);
  check('spot heals the dark region at identity geometry', healedDstIdentity > preDstMean + 0.05, {
    preDstMean,
    healedDstIdentity,
  });
  const anchorBeforeRotate = (await spotsState(spotsNodeId)).spots[0];
  const meanBeforeRotate = await gpuMean();
  // Rotate 10°. Under the OLD output-frame scheme this re-normalized the spot
  // against the post-geometry frame, dragging it off its blemish (the user's
  // repro). Anchor space stores coords relative to the IMAGE, so a geometry
  // change must leave spots[0] byte-identical — that invariance IS the fix.
  await page.evaluate(() =>
    window.__debug.setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 10, orientation: { quarterTurns: 0, flipH: false } })
  );
  await page.waitForTimeout(300);
  const anchorAfterRotate = (await spotsState(spotsNodeId)).spots[0];
  check(
    "rotating the image leaves the spot's stored anchor coords byte-identical (pinned to image content, not the crop)",
    JSON.stringify(anchorAfterRotate) === JSON.stringify(anchorBeforeRotate),
    { anchorBeforeRotate, anchorAfterRotate }
  );
  const meanAfterRotate = await gpuMean();
  check(
    'the rotation actually took effect on the render (mean changed — proving geometry applied, not ignored)',
    !meansMatch(meanAfterRotate, meanBeforeRotate, 1e-4),
    { meanBeforeRotate, meanAfterRotate }
  );
  check('no page error rendering a spot through a non-identity geometry', pageErrors.length === 0, pageErrors);
  // reset geometry + clear the probe spot before the round-trip section below
  await page.evaluate(() =>
    window.__debug.setGeometry({ crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, orientation: { quarterTurns: 0, flipH: false } })
  );
  await setSpots(spotsNodeId, []);

  // ---------------------------------------------------------------------
  console.log('verify-spots (6. sidecar round-trip: save, reopen, spots list byte-equal, render mean equal):');
  const roundTripSpots = [
    { dx: 0.25, dy: 0.35, sx: 0.55, sy: 0.4, radius: 0.06, feather: 0.3 },
    { dx: 0.65, dy: 0.6, sx: 0.3, sy: 0.65, radius: 0.04, feather: 0.3 },
  ];
  await setSpots(spotsNodeId, roundTripSpots);
  const meanBeforeSave = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check('saved sidecar is schemaVersion 4', savedJson.schemaVersion === 4, savedJson.schemaVersion);
  const savedSpotsNode = savedJson.graph.nodes.find((n) => n.id === spotsNodeId);
  check("saved sidecar carries the spots node's type and list", savedSpotsNode?.type === 'spots' && savedSpotsNode?.spots?.spots?.length === 2, savedSpotsNode);

  await openAndWait(ARW_PATH);
  const reloadedSpots = await spotsState(spotsNodeId);
  check('reloaded spots list is byte-equal to what was saved', JSON.stringify(reloadedSpots?.spots) === JSON.stringify(roundTripSpots), {
    saved: roundTripSpots,
    reloaded: reloadedSpots?.spots,
  });
  const meanAfterReload = await gpuMean();
  check('reloaded render mean matches the pre-save mean', meansMatch(meanAfterReload, meanBeforeSave, TIGHT_TOLERANCE), {
    meanBeforeSave,
    meanAfterReload,
  });

  // ---------------------------------------------------------------------
  console.log('verify-spots (7. cap: 32 spots via setSpots, a 33rd via UI shows the toolbar notice and is refused):');
  const capSpots = Array.from({ length: 32 }, (_, i) => ({
    dx: 0.05 + (i % 8) * 0.11,
    dy: 0.05 + Math.floor(i / 8) * 0.11,
    sx: 0.9,
    sy: 0.9,
    radius: 0.01,
    feather: 0.3,
  }));
  await setSpots(spotsNodeId, capSpots);
  const cappedState = await spotsState(spotsNodeId);
  check('setSpots accepted exactly 32 spots', cappedState.spots.length === 32, cappedState.spots.length);

  await setSpotModeUi(true);
  await setSpotBrushRadius(0.02);
  const canvasForCap = page.locator('.canvas-view-canvas');
  await canvasForCap.scrollIntoViewIfNeeded();
  const capCanvasBox = await canvasForCap.boundingBox();
  await page.mouse.move(capCanvasBox.x + capCanvasBox.width * 0.15, capCanvasBox.y + capCanvasBox.height * 0.85);
  await page.mouse.down();
  await page.mouse.move(capCanvasBox.x + capCanvasBox.width * 0.2, capCanvasBox.y + capCanvasBox.height * 0.85, { steps: 4 });
  await page.mouse.up();
  const capNotice = (await spotState()).capNotice;
  check('a 33rd add shows the toolbar cap notice', typeof capNotice === 'string' && capNotice.includes('32'), capNotice);
  const capNoticeVisible = await page.locator('[data-testid="spots-cap-notice"]').isVisible().catch(() => false);
  check('the cap notice is visible in the toolbar', capNoticeVisible, capNoticeVisible);
  const listAfterCapAttempt = await spotsState(spotsNodeId);
  check('the list is unchanged at 32 after the refused add', listAfterCapAttempt.spots.length === 32, listAfterCapAttempt.spots.length);

  console.log('verify-spots (active-chain targeting: activeSpotsNodeId resolves to the same node):');
  check('activeSpotsNodeId() resolves to the spots node', (await activeSpotsNodeId()) === spotsNodeId, await activeSpotsNodeId());

  // ---------------------------------------------------------------------
  console.log('verify-spots (modal tools are mutually exclusive — one canvas tool at a time):');
  // spot mode is currently ON (cap section above); activating crop must turn it off
  const isActive = (testid) =>
    page.locator(`[data-testid="${testid}"]`).evaluate((el) => el.classList.contains('active'));
  await page.locator('[data-testid="crop-toggle"]').click();
  check('activating crop deactivates spot mode', !(await spotState()).mode && (await isActive('crop-toggle')), {
    spotMode: (await spotState()).mode,
    crop: await isActive('crop-toggle'),
  });
  await page.locator('[data-testid="spots-toggle"]').click();
  check('activating spots deactivates crop mode', (await spotState()).mode && !(await isActive('crop-toggle')), {
    spotMode: (await spotState()).mode,
    crop: await isActive('crop-toggle'),
  });
  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  check(
    'activating mask draw deactivates spot mode',
    !(await spotState()).mode && (await isActive('add-local-adjustment-radial')),
    { spotMode: (await spotState()).mode, radial: await isActive('add-local-adjustment-radial') }
  );
  await page.keyboard.press('Escape');

  check('no page errors across the spots verify checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
