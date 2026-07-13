/**
 * Node bypass toggle verify (Resolve's "mute" for our graph,
 * docs/feature-gap-analysis.md category B): `GraphNode.disabled` on every
 * 1-in/1-out chain kind (ops, custom, Develop, mask, spots, external) plus
 * blend, driven via plain `m` or the node body's bypass button. Round-11 fix
 * pack item 1 ("⌘Dはもはやいらなくない？（むしろUEだと複製のコマンドに見えるし）") removed
 * ⌘D entirely — it now does nothing at all, left unbound (reserved; may
 * later become duplicate-node) — `m` (round-9 fix pack item 1) is the only
 * bypass accelerator left.
 *
 *  1. Op node bypass: the render is bit-comparable to the node never having
 *     existed; re-enabling restores the edited render; GPU==CPU parity holds
 *     throughout (the mechanism reuses buildPlan's existing identity-resolve
 *     path, so nothing about CPU-mirror availability changes).
 *  2. UI wiring: the bypass button (data-testid node-bypass-<id>) toggles it,
 *     the node body gets the muted/struck class, and disabling ITS OWN node
 *     produces the same rendered content as its upstream ancestor (proven via
 *     inspect mode, which resolves through the identical buildPlan/nodeSteps
 *     machinery the thumbnail batch does) — one undo entry per toggle either
 *     way (button or `m`).
 *  3. Plain `m` toggles the selected node; non-bypassable kinds (input/
 *     output/image) never get the toggle — no button rendered, `m` is a
 *     no-op, and the store action itself guards against being called on them
 *     directly.
 *  3b. ⌘D is UNBOUND (round-11 fix pack item 1): pressing it with any
 *     bypassable node selected does nothing at all — no disabled flag, no
 *     undo entry.
 *  4. Blend disabled resolves to its 'a' input — bit-exact match of the
 *     graph's ORIGINAL (pre-local-adjustment) render, regardless of what its
 *     'b'/mask branches are doing.
 *  5. A disabled MASK node makes the consuming blend act as if the mask edge
 *     were never wired — the masked edit becomes a plain UNIFORM mix (the
 *     corner starts moving with the edit, not just the center); re-enabling
 *     restores the masked-only effect; GPU==CPU parity holds (the mask's own
 *     spatial step is skipped entirely once its edge is treated as absent).
 *  6. Tool-mode stays usable on a disabled node: disabling the active spots
 *     node while spot mode is open leaves spot mode on and still editable
 *     (store-level); disabling a selected mask node leaves its on-canvas
 *     handles visible and draggable. The render simply ignores the node
 *     either way (least-surprising choice — editing a bypassed node's
 *     content is legal, it just doesn't show up until re-enabled).
 *  7. Sidecar: `disabled: true` round-trips; re-enabling omits the key
 *     entirely (same "identity ⇒ not serialized" convention as mask/spots/
 *     export overrides).
 *  8. LUT export: a disabled node's own edit never appears in the exported
 *     LUT (falls out of buildPlan — the node is never even a plan step), and
 *     its skipped-ops report stays empty (nothing to report — there was
 *     never a problematic step to skip in the first place).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;
const ARTIFACTS = join(projectRoot, 'test-artifacts');
const LUT_BASELINE = join(ARTIFACTS, 'bypass-lut-baseline');
const LUT_ACTIVE = join(ARTIFACTS, 'bypass-lut-active');
const LUT_DISABLED = join(ARTIFACTS, 'bypass-lut-disabled');

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
mkdirSync(ARTIFACTS, { recursive: true });

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
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const updateNodeParam = (nodeId, key, value) =>
    page.evaluate(([n, k, v]) => window.__debug.updateNodeParam(n, k, v), [nodeId, key, value]);
  const toggleDisabled = (nodeId) => page.evaluate((n) => window.__debug.toggleNodeDisabled(n), nodeId);
  const selectNode = (id) => page.evaluate((n) => window.__debug.selectNode(n), id);
  const isNodeDisabled = async (nodeId) => {
    const g = await graphState();
    return g.nodes.find((n) => n.id === nodeId)?.disabled === true;
  };
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

  await openAndWait(ARW_PATH);

  // ---------------------------------------------------------------------
  console.log('verify-bypass (1. op node bypass = bit-exact identity; re-enable restores; GPU==CPU parity throughout):');
  const baselineMean = await gpuMean();
  const baselineCpu = await cpuMean();
  check('baseline: GPU matches CPU within 1/255', meansMatch(baselineMean, baselineCpu), { baselineMean, baselineCpu });

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-brightness"]').click();
  const gWithBrightness = await graphState();
  const brightId = gWithBrightness.nodes.find((n) => n.kind === 'brightness').id;
  await updateNodeParam(brightId, 'amount', 45);
  const editedMean = await gpuMean();
  check('the edit actually changes the render', !meansMatch(editedMean, baselineMean, 0.01), { baselineMean, editedMean });

  await toggleDisabled(brightId);
  check('toggleNodeDisabled sets disabled:true on the node', await isNodeDisabled(brightId), await graphState());
  const bypassedMean = await gpuMean();
  const bypassedCpu = await cpuMean();
  check(
    'bypassed op node: render is bit-exact vs the node never having existed (1e-6)',
    meansMatch(bypassedMean, baselineMean, 1e-6),
    { baselineMean, bypassedMean }
  );
  check('a bypassed op node keeps the CPU reference alive (no spatial step introduced)', bypassedCpu !== null, bypassedCpu);
  check('bypassed: GPU matches CPU within 1/255', meansMatch(bypassedMean, bypassedCpu), { bypassedMean, bypassedCpu });

  await toggleDisabled(brightId);
  check('toggling again clears disabled', !(await isNodeDisabled(brightId)), await graphState());
  const restoredMean = await gpuMean();
  check('re-enabling restores the edited render bit-exactly (1e-6)', meansMatch(restoredMean, editedMean, 1e-6), {
    editedMean,
    restoredMean,
  });

  // ---------------------------------------------------------------------
  console.log('verify-bypass (2. UI wiring: bypass button + muted class + one undo entry + thumbnail==ancestor):');
  const bypassBtn = page.locator(`.react-flow__node[data-id="${brightId}"] [data-testid="node-bypass-${brightId}"]`);
  await bypassBtn.scrollIntoViewIfNeeded();
  const pastBeforeClick = await historyPast();
  await bypassBtn.click();
  check('clicking the bypass button sets disabled', await isNodeDisabled(brightId), await graphState());
  check('the button click is exactly one undo entry', (await historyPast()) === pastBeforeClick + 1, {
    before: pastBeforeClick,
    after: await historyPast(),
  });
  const nodeBox = page.locator(`.react-flow__node[data-id="${brightId}"] .op-node`);
  check('the node body gets the muted class', await nodeBox.evaluate((el) => el.classList.contains('op-node--disabled')), true);
  check(
    'the bypass button itself shows the active state',
    await bypassBtn.evaluate((el) => el.classList.contains('op-node-bypass--active')),
    true
  );

  // Thumbnail-equivalence: inspecting the bypassed node and inspecting its
  // upstream ancestor ('dev') must render bit-identical output — both
  // resolve to the SAME buildPlan step index (nodeSteps), the exact
  // mechanism the node-editor thumbnail batch itself keys off (see
  // RenderPlan.nodeSteps' doc comment). This is the same proof technique
  // verify-nodepreview.mjs uses for "inspect == a rewired doc's readback".
  await page.locator(`.react-flow__node[data-id="${brightId}"] [data-testid="node-inspect-${brightId}"]`).click();
  await page.waitForFunction((id) => window.__debug.inspectState() === id, brightId, { timeout: 5_000 });
  const inspectBypassedMean = await gpuMean();
  await page.locator(`.react-flow__node[data-id="${brightId}"] [data-testid="node-inspect-${brightId}"]`).click();
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  const inspectAncestorMean = await gpuMean();
  await page.keyboard.press('Escape');
  check(
    "a bypassed node's own resolved output matches its upstream ancestor's (same nodeSteps index -> same thumbnail content)",
    meansMatch(inspectBypassedMean, inspectAncestorMean, 1e-6),
    { inspectBypassedMean, inspectAncestorMean }
  );

  // re-enable for the next sections
  await bypassBtn.click();
  check('re-enabled via the button', !(await isNodeDisabled(brightId)), await graphState());

  // ---------------------------------------------------------------------
  console.log('verify-bypass (3. plain `m` toggles the selection; non-bypassable kinds (input/output/image) are no-ops):');
  await selectNode(brightId);
  const pastBeforeM = await historyPast();
  await page.keyboard.press('m');
  check('`m` with a bypassable node selected sets disabled', await isNodeDisabled(brightId), await graphState());
  check('`m` is exactly one undo entry', (await historyPast()) === pastBeforeM + 1, {
    before: pastBeforeM,
    after: await historyPast(),
  });
  await page.keyboard.press('m');
  check('`m` again clears disabled', !(await isNodeDisabled(brightId)), await graphState());

  await selectNode('in');
  const pastBeforeInputM = await historyPast();
  await page.keyboard.press('m');
  check("`m` with the 'input' node selected is a no-op (still no disabled key, no history entry)", (await historyPast()) === pastBeforeInputM, {
    before: pastBeforeInputM,
    after: await historyPast(),
  });
  check("'input' node never gets a disabled key", (await graphState()).nodes.find((n) => n.id === 'in')?.disabled === undefined, await graphState());
  check(
    "the input node body renders no bypass button at all",
    (await page.locator('.react-flow__node[data-id="in"] [data-testid="node-bypass-in"]').count()) === 0,
    await page.locator('.react-flow__node[data-id="in"] [data-testid="node-bypass-in"]').count()
  );

  // ---------------------------------------------------------------------
  console.log('verify-bypass (3b. ⌘D is UNBOUND — round-11 fix pack item 1: pressing it does nothing at all):');
  await selectNode(brightId);
  const pastBeforeCmdD = await historyPast();
  await page.keyboard.press('Meta+d');
  check('⌘D with a bypassable node selected leaves disabled unset', !(await isNodeDisabled(brightId)), await graphState());
  check('⌘D adds no undo entry (fully unbound, not just a no-op toggle)', (await historyPast()) === pastBeforeCmdD, {
    before: pastBeforeCmdD,
    after: await historyPast(),
  });

  await selectNode('out');
  const pastBeforeOutputCmdD = await historyPast();
  await page.keyboard.press('Meta+d');
  check("⌘D with the 'output' node selected is (still) a no-op (unbound key + non-bypassable kind, both apply)", (await historyPast()) === pastBeforeOutputCmdD, {
    before: pastBeforeOutputCmdD,
    after: await historyPast(),
  });
  await page.evaluate(() => window.__debug.toggleNodeDisabled('out'));
  check("direct toggleNodeDisabled('out') store-level guard: still no disabled key", (await graphState()).nodes.find((n) => n.id === 'out')?.disabled === undefined, await graphState());

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-image"]').click();
  const gWithImage = await graphState();
  const imageId = gWithImage.nodes.find((n) => n.kind === 'image').id;
  await page.evaluate((id) => window.__debug.toggleNodeDisabled(id), imageId);
  check("direct toggleNodeDisabled on an 'image' node is a no-op (image is a source, not bypassable)", (await graphState()).nodes.find((n) => n.id === imageId)?.disabled === undefined, await graphState());
  check(
    'the image node body renders no bypass button at all',
    (await page.locator(`.react-flow__node[data-id="${imageId}"] [data-testid="node-bypass-${imageId}"]`).count()) === 0,
    await page.locator(`.react-flow__node[data-id="${imageId}"] [data-testid="node-bypass-${imageId}"]`).count()
  );
  await selectNode(imageId);
  await page.locator('[data-testid="delete-node-button"]').click();
  await selectNode(brightId);
  await page.locator('[data-testid="delete-node-button"]').click();

  // ---------------------------------------------------------------------
  console.log('verify-bypass (4. + Local Adjustment fixture (fresh graph): blend disabled resolves to its \'a\' input):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH);
  const meanBeforeLA = await gpuMean();

  await page.locator('[data-testid="add-local-adjustment-radial"]').click();
  const canvas = page.locator('.canvas-view-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up(); // click-only = default-radius radial at center
  const gAfterLA = await graphState();
  const dev1 = gAfterLA.nodes.find((n) => n.id === 'dev-1').id;
  const mask1 = gAfterLA.nodes.find((n) => n.id === 'mask-1').id;
  const blend1 = gAfterLA.nodes.find((n) => n.id === 'blend-1').id;
  await updateNodeParam(dev1, 'basic.ev', 1.5);
  const meanWithLA = await gpuMean();
  check('setup sanity: the masked edit changes the render', !meansMatch(meanWithLA, meanBeforeLA, 0.005), {
    meanBeforeLA,
    meanWithLA,
  });

  await toggleDisabled(blend1);
  check('blend node disabled', await isNodeDisabled(blend1), await graphState());
  const meanBlendBypassed = await gpuMean();
  check(
    "a disabled blend resolves to its 'a' input bit-exactly — matches the pre-local-adjustment render regardless of dev-1/mask-1 (1e-6)",
    meansMatch(meanBlendBypassed, meanBeforeLA, 1e-6),
    { meanBeforeLA, meanBlendBypassed }
  );
  await toggleDisabled(blend1);
  check('re-enabling the blend restores the masked-edit render (1e-6)', meansMatch(await gpuMean(), meanWithLA, 1e-6), {
    meanWithLA,
    restored: await gpuMean(),
  });

  // ---------------------------------------------------------------------
  console.log('verify-bypass (5. disabled MASK node -> consuming blend treats the edge as absent (uniform mix, not just centered)):');
  const dims = await page.evaluate(() => window.__debug.outputDims());
  const regionSize = Math.round(Math.min(dims.width, dims.height) * 0.1);
  const cx0 = Math.round(dims.width / 2 - regionSize / 2);
  const cy0 = Math.round(dims.height / 2 - regionSize / 2);
  const centerMean = () => regionMean(cx0, cy0, regionSize, regionSize);
  const cornerMean = () => regionMean(0, 0, regionSize, regionSize);

  await updateNodeParam(dev1, 'basic.ev', 0);
  const preEditCenter = await centerMean();
  const preEditCorner = await cornerMean();
  await updateNodeParam(dev1, 'basic.ev', 1.5);
  const maskedCenter = await centerMean();
  const maskedCorner = await cornerMean();
  check('mask active: center brightens under the edit', maskedCenter > preEditCenter + 0.02, { preEditCenter, maskedCenter });
  check('mask active: corner stays near its pre-edit baseline', Math.abs(maskedCorner - preEditCorner) < 0.01, {
    preEditCorner,
    maskedCorner,
  });

  await toggleDisabled(mask1);
  check('mask node disabled', await isNodeDisabled(mask1), await graphState());
  const uniformCorner = await cornerMean();
  const uniformCenter = await centerMean();
  check(
    'mask disabled: the corner NOW also brightens (edge treated as absent -> uniform mix, not restricted to the masked area)',
    uniformCorner > preEditCorner + 0.02,
    { preEditCorner, uniformCorner }
  );
  check(
    'mask disabled: center and corner move by roughly the same amount (a genuinely uniform factor, not a differently-shaped mask)',
    Math.abs(uniformCenter - preEditCenter - (uniformCorner - preEditCorner)) < 0.03,
    { centerDelta: uniformCenter - preEditCenter, cornerDelta: uniformCorner - preEditCorner }
  );
  const maskBypassedCpu = await cpuMean();
  check('mask disabled: CPU reference stays available (no spatial mask step in the plan at all)', maskBypassedCpu !== null, maskBypassedCpu);
  check('mask disabled: GPU matches CPU within 1/255', meansMatch(await gpuMean(), maskBypassedCpu), {
    gpu: await gpuMean(),
    cpu: maskBypassedCpu,
  });

  await toggleDisabled(mask1);
  const restoredCorner = await cornerMean();
  check('re-enabling the mask restores the corner near its pre-edit baseline', Math.abs(restoredCorner - preEditCorner) < 0.01, {
    preEditCorner,
    restoredCorner,
  });

  // ---------------------------------------------------------------------
  console.log('verify-bypass (6. tool-mode stays usable on a disabled node — least-surprising behavior):');
  await page.locator('[data-testid="view-fit"]').click(); // known, centered view before boundingBox-driven dragging (masks-verify's own caution)
  const centerHandle = page.locator('[data-testid="mask-handle-center"]');
  await selectNode(mask1);
  await toggleDisabled(mask1);
  check('mask-1 is disabled for this check', await isNodeDisabled(mask1), await graphState());
  check('its on-canvas handles are still visible while disabled', await centerHandle.isVisible().catch(() => false), true);
  const shapeBeforeDrag = (await graphState()).nodes.find((n) => n.id === mask1).mask.shapes[0];
  await centerHandle.scrollIntoViewIfNeeded();
  const chBox = await centerHandle.boundingBox();
  await page.mouse.move(chBox.x + chBox.width / 2, chBox.y + chBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chBox.x + 15, chBox.y + 10, { steps: 4 });
  await page.mouse.up();
  const shapeAfterDrag = (await graphState()).nodes.find((n) => n.id === mask1).mask.shapes[0];
  check(
    'a disabled mask node is still editable (dragging its handle actually moves the stored shape)',
    JSON.stringify(shapeAfterDrag) !== JSON.stringify(shapeBeforeDrag),
    { shapeBeforeDrag, shapeAfterDrag }
  );
  check('editing a disabled mask node does not itself re-enable it', await isNodeDisabled(mask1), await graphState());
  // Restore the EXACT pre-drag shape before re-enabling — this section only
  // proves editability works while disabled, not a real edit; every mean
  // comparison below (meanWithLA) assumes mask-1's shape is back to what it
  // was when meanWithLA was captured (masks-verify's own "restore the
  // default centered mask for the following checks" convention).
  await page.evaluate(([n, s]) => window.__debug.setMaskShape(n, s), [mask1, shapeBeforeDrag]);
  await toggleDisabled(mask1); // re-enable, leave a sane state for what follows

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-spots"]').click();
  const activeSpotsId = await page.evaluate(() => window.__debug.activeSpotsNodeId());
  check('a fresh spots node with zero spots is bit-exact identity already', meansMatch(await gpuMean(), meanWithLA, 1e-6), {
    meanWithLA,
    withEmptySpots: await gpuMean(),
  });
  await page.locator('[data-testid="spots-toggle"]').click();
  check('spot mode is on', (await page.evaluate(() => window.__debug.spotState())).mode, await page.evaluate(() => window.__debug.spotState()));
  await toggleDisabled(activeSpotsId);
  check('spot mode stays open after disabling the active spots node (tool does not force-close)', (await page.evaluate(() => window.__debug.spotState())).mode, await page.evaluate(() => window.__debug.spotState()));
  await page.evaluate(
    (id) => window.__debug.setSpots(id, [{ dx: 0.5, dy: 0.5, sx: 0.6, sy: 0.6, radius: 0.05, feather: 0.5 }]),
    activeSpotsId
  );
  const spotsAfterEdit = (await graphState()).nodes.find((n) => n.id === activeSpotsId).spots.spots;
  check('a spot can still be added to a disabled spots node (editable, just not rendered)', spotsAfterEdit.length === 1, spotsAfterEdit);
  check(
    "the render still ignores the disabled spots node's content (bit-exact vs the pre-spots render)",
    meansMatch(await gpuMean(), meanWithLA, 1e-6),
    { meanWithLA, withSpotAdded: await gpuMean() }
  );
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------------
  console.log('verify-bypass (7. sidecar: disabled:true round-trips; re-enabling omits the key entirely):');
  await toggleDisabled(dev1);
  check('dev-1 disabled for the sidecar check', await isNodeDisabled(dev1), await graphState());
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const savedDev1 = savedJson.graph.nodes.find((n) => n.id === 'dev-1');
  check('disabled:true is written to the sidecar', savedDev1?.disabled === true, savedDev1);

  await toggleDisabled(dev1);
  check('dev-1 re-enabled', !(await isNodeDisabled(dev1)), await graphState());
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const resavedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const resavedDev1 = resavedJson.graph.nodes.find((n) => n.id === 'dev-1');
  check("re-enabling omits the 'disabled' key entirely (not disabled:false)", !('disabled' in resavedDev1), resavedDev1);

  await openAndWait(ARW_PATH);
  const reloadedDev1 = (await graphState()).nodes.find((n) => n.id === 'dev-1');
  // NOTE: graphState() returns the SANITIZED in-memory node, where
  // parseGraphDoc's `n.disabled = n.disabled ? true : undefined` (same
  // "assign undefined rather than delete" convention as `name`/`export`
  // elsewhere in graphDoc.ts) leaves `disabled` as an own property valued
  // `undefined` — `'disabled' in obj` is therefore NOT the right test here
  // (unlike the raw-JSON-file checks above, where the key is genuinely
  // absent from the bytes); `=== undefined` is what "absent" means in-memory.
  check("reload confirms the enabled state round-tripped (no stray disabled:true)", reloadedDev1?.disabled === undefined, reloadedDev1?.disabled);

  // ---------------------------------------------------------------------
  console.log('verify-bypass (8. LUT export: a disabled node never shows up in the plan at all — falls out of buildPlan):');
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH);
  const exportLutAndWait = async (basePath) => {
    await page.evaluate((p) => window.__debug.exportLutTo(p), basePath);
    await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 120_000 });
    return { state: await page.evaluate(() => window.__debug.exportState()), info: await page.evaluate(() => window.__debug.exportLutState()) };
  };
  // exportLut's `name` (and thus the .cube's TITLE line) is derived from the
  // EXPORT PATH's own basename (appStore.ts's exportLut), which necessarily
  // differs across LUT_BASELINE/LUT_ACTIVE/LUT_DISABLED — strip it before
  // comparing cube text so only the actual lattice DATA is under test.
  const stripTitle = (text) => text.replace(/^TITLE ".*"$/m, 'TITLE');

  const baselineLut = await exportLutAndWait(LUT_BASELINE);
  check('baseline LUT export succeeds', baselineLut.state.status === 'idle', baselineLut.state);
  const baselineCubeText = readFileSync(LUT_BASELINE + '.cube', 'utf8');

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-brightness"]').click();
  const gWithBrightness2 = await graphState();
  const bright2 = gWithBrightness2.nodes.find((n) => n.kind === 'brightness').id;
  await updateNodeParam(bright2, 'amount', 60);
  const activeLut = await exportLutAndWait(LUT_ACTIVE);
  check('active (non-identity) LUT export succeeds with nothing skipped (brightness is a plain color op)', activeLut.state.status === 'idle' && activeLut.info?.skipped.length === 0, activeLut.info);
  const activeCubeText = readFileSync(LUT_ACTIVE + '.cube', 'utf8');
  check('the active edit actually changes the exported LUT', stripTitle(activeCubeText) !== stripTitle(baselineCubeText), null);

  await toggleDisabled(bright2);
  const disabledLut = await exportLutAndWait(LUT_DISABLED);
  check(
    'disabled node: LUT export still succeeds with nothing skipped (never a problematic step to report — it was never a step at all)',
    disabledLut.state.status === 'idle' && disabledLut.info?.skipped.length === 0,
    disabledLut.info
  );
  const disabledCubeText = readFileSync(LUT_DISABLED + '.cube', 'utf8');
  check(
    "a disabled node's LUT matches the baseline identity export byte-for-byte, aside from the TITLE line (buildPlan already resolved it away)",
    stripTitle(disabledCubeText) === stripTitle(baselineCubeText),
    { matches: stripTitle(disabledCubeText) === stripTitle(baselineCubeText) }
  );

  check('no page errors across the node-bypass checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
