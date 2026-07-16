/**
 * Develop presets verify (task #37): a preset is a WHOLE LOOK — the entire
 * develop graph — persisted as an individual JSON file under
 * `<userData>/presets/`, text-first and git-shareable (ROADMAP.md
 * "Presets"). Saving/applying runs through the exact
 * copyDevelopSettings/pasteDevelopSettings code path (appStore.ts's
 * captureLook/applyLook) — a preset IS "a named, persisted develop
 * clipboard".
 *
 *  1. Edited graph → save preset via the UI → file exists with
 *     presetVersion/name/look keys.
 *  2. Reset (reopen fresh) → apply the preset via the UI → GPU readbackMean
 *     equals the edited render within 1/255, and the apply is exactly ONE
 *     undo entry.
 *  3. ⌘Z after apply restores the pre-apply render.
 *  4. Unknown top-level field survives a re-save through the UI (DESIGN §9).
 *  5. Slug collision: two DIFFERENT preset names that sanitize to the same
 *     slug disambiguate into two files.
 *  6. Delete via the UI removes the file and the select entry.
 *  7. Geometry independence: a preset saved with an active crop does not
 *     carry it — applying never touches the input node's geometry.
 *  8. A malformed .json in the presets dir is skipped, never breaking the
 *     list for the valid presets alongside it.
 *  9. Update (round-7 UX pack G §3): overwrites the SAME preset file with
 *     the current look — name/slug/createdAt preserved, content/mtime
 *     changed — and a later re-apply after reset picks up the update.
 * 10. Hover preview (round-7 UX pack G §4): hovering a preset row previews
 *     its look on the canvas without touching graphState()/historyState()/
 *     graphDirty; mouseleave restores the baseline render; hover-then-apply
 *     matches a plain apply's render.
 *
 * The preset list is a plain row list (data-testid="preset-row"), not a
 * native <select> — real DOM rows are what make the hover preview possible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
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

/** Same sanitization family as appStore.ts's slugifyPresetName — used here only to predict the filename a UI save will land at. */
function slugify(name) {
  return name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

async function waitForCondition(fn, timeoutMs = 10_000, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// reuse the runner's assignment when present (parallel run); otherwise mint
// our own, standalone-run temp dir and own its cleanup — same pattern as
// verify-exportsettings.mjs (presets live under the same userData dir).
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-presets-verify-'));
process.env.SILVERBOX_USER_DATA = userDataDir;

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const realUserData = await app.evaluate(({ app }) => app.getPath('userData'));
  check(
    'Electron actually honored SILVERBOX_USER_DATA (isolated from the real presets dir)',
    basename(realUserData) === basename(userDataDir),
    { realUserData, userDataDir }
  );
  const presetsDir = join(realUserData, 'presets');

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };

  // Presets persist independently of any one image's develop settings, and
  // the sidecar/autosave machinery is orthogonal to this feature — disable
  // autosave so "reopen the image" always yields the clean default graph
  // (no debounced write can race a reopen and reintroduce the edits).
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: false }));

  await openAndWait(ARW_PATH);

  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const historyState = () => page.evaluate(() => window.__debug.historyState());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const geometryState = () => page.evaluate(() => window.__debug.geometryState());
  const presetsState = () => page.evaluate(() => window.__debug.presetsState());

  const openPresetsMenu = async () => {
    if ((await page.locator('[data-testid="presets-menu"]').count()) === 0) {
      await page.locator('[data-testid="presets-button"]').click();
      await page.waitForSelector('[data-testid="presets-menu"]', { timeout: 5_000 });
    }
  };

  /** Close the menu via its own click-away backdrop (section 10's hover preview leaves it open — reset-all's setup below needs the toolbar's "Add node" button reachable). */
  const closePresetsMenu = async () => {
    if ((await page.locator('[data-testid="presets-menu"]').count()) > 0) {
      await page.locator('.add-node-menu-backdrop').click();
      await page.waitForSelector('[data-testid="presets-menu"]', { state: 'detached', timeout: 5_000 });
    }
  };

  /** Row locator by exact display name (rows replaced the native <select> — round-7 UX pack G §4). */
  const presetRow = (name) => page.locator('[data-testid="preset-row"]').filter({ hasText: name });
  /** Click (= select, same as choosing an <option> used to) the row with this display name. */
  const selectPresetRow = (name) => presetRow(name).click();

  // ---------------------------------------------------------------------
  console.log('verify-presets (1. edited graph -> save preset via the UI -> file exists):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.6));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 25));
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-exposure"]').click();
  const gAfterAdd = await graphState();
  const extraNode = gAfterAdd.nodes.find((n) => n.kind === 'exposure');
  check('an extra op node landed in the graph', !!extraNode, gAfterAdd.nodes.map((n) => n.kind));
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'ev', 0.3), extraNode.id);

  const editedMean = await gpuMean();
  const editedGraph = await graphState();

  await openPresetsMenu();
  await page.locator('[data-testid="preset-save-name"]').fill('My Look');
  await page.locator('[data-testid="preset-save"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.presetsState().some((p) => p.name === 'My Look')));

  const myLookSlug = slugify('My Look');
  const myLookPath = join(presetsDir, `${myLookSlug}.json`);
  check('the preset file exists on disk', existsSync(myLookPath), myLookPath);
  const myLookOnDisk = existsSync(myLookPath) ? JSON.parse(readFileSync(myLookPath, 'utf8')) : null;
  check(
    'the file has presetVersion/name/look keys',
    myLookOnDisk?.presetVersion === 1 && myLookOnDisk?.name === 'My Look' && typeof myLookOnDisk?.look === 'object',
    myLookOnDisk
  );
  check(
    'the look embeds the edited develop params + the extra op node',
    myLookOnDisk?.look?.graph?.nodes?.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.6 &&
      myLookOnDisk?.look?.graph?.nodes?.some((n) => n.type === 'exposure'),
    myLookOnDisk?.look?.graph?.nodes
  );
  check(
    'presetsState() (the store, backing the UI select) lists it too',
    (await presetsState()).some((p) => p.name === 'My Look' && p.slug === myLookSlug),
    await presetsState()
  );

  // ---------------------------------------------------------------------
  console.log('verify-presets (2. reset + apply via the UI -> readbackMean matches, ONE undo entry):');
  await openAndWait(ARW_PATH); // no sidecar, autosave off -> fresh default graph, empty history
  check('reopen reset the graph to the default (no extra node)', (await graphState()).nodes.length === 3, await graphState());
  check('history is empty right after reopening', JSON.stringify(await historyState()) === '{"past":0,"future":0}', await historyState());
  const beforeApplyMean = await gpuMean();

  await openPresetsMenu();
  await selectPresetRow('My Look');
  await page.locator('[data-testid="preset-apply"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 4));

  const gAfterApply = await graphState();
  check(
    'applying restored the extra op node + develop edits',
    gAfterApply.nodes.length === 4 &&
      gAfterApply.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.6 &&
      gAfterApply.nodes.find((n) => n.id === 'dev')?.develop?.basic?.contrast === 25,
    gAfterApply.nodes
  );
  const appliedMean = await gpuMean();
  check('readbackMean after applying matches the render right after the original edits (within 1/255)', meansMatch(appliedMean, editedMean), {
    appliedMean,
    editedMean,
  });
  const historyAfterApply = await historyState();
  check('applying is exactly ONE undo entry', historyAfterApply.past === 1 && historyAfterApply.future === 0, historyAfterApply);

  // ---------------------------------------------------------------------
  console.log('verify-presets (3. Cmd+Z after apply restores the pre-apply render):');
  await page.keyboard.press('Meta+z');
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 3));
  const meanAfterUndo = await gpuMean();
  check('undo restores the pre-apply render (within 1/255)', meansMatch(meanAfterUndo, beforeApplyMean), {
    meanAfterUndo,
    beforeApplyMean,
  });
  check('undo also rolled back the history counters', JSON.stringify(await historyState()) === '{"past":0,"future":1}', await historyState());

  // redo back to the applied state so subsequent sections see a consistent baseline
  await page.keyboard.press('Meta+Shift+z');
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 4));

  // ---------------------------------------------------------------------
  console.log('verify-presets (4. unknown top-level field survives a re-save through the UI):');
  const beforeInjection = JSON.parse(readFileSync(myLookPath, 'utf8'));
  writeFileSync(
    myLookPath,
    JSON.stringify({ ...beforeInjection, futureFeature: { some: 'newer-build-only data' } }, null, 2) + '\n'
  );
  await openPresetsMenu();
  await page.locator('[data-testid="preset-save-name"]').fill('My Look');
  await page.locator('[data-testid="preset-save"]').click();
  const survived = await waitForCondition(() => {
    if (!existsSync(myLookPath)) return false;
    const onDisk = JSON.parse(readFileSync(myLookPath, 'utf8'));
    return JSON.stringify(onDisk.futureFeature) === JSON.stringify({ some: 'newer-build-only data' });
  });
  check('unknown top-level field survives the update round-trip (DESIGN §9)', survived, JSON.parse(readFileSync(myLookPath, 'utf8')));
  check(
    'the re-save still wrote the CURRENT graph (not the stale injected one)',
    JSON.parse(readFileSync(myLookPath, 'utf8')).look.graph.nodes.length === 4,
    JSON.parse(readFileSync(myLookPath, 'utf8')).look.graph.nodes
  );

  // ---------------------------------------------------------------------
  console.log('verify-presets (5. slug collision: two different names sanitizing to the same slug disambiguate):');
  await page.locator('[data-testid="preset-save-name"]').fill('My/Look');
  await page.locator('[data-testid="preset-save"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.presetsState().some((p) => p.name === 'My/Look')));

  const collidedSlug = slugify('My/Look'); // "My-Look" — already owned by the DIFFERENTLY-named "My Look"
  check('the base slugs actually collide (test setup sanity)', collidedSlug === myLookSlug, { collidedSlug, myLookSlug });
  const secondPath = join(presetsDir, `${myLookSlug}-2.json`);
  check('a second, disambiguated file was created', existsSync(secondPath), secondPath);
  check('the original "My Look" file is untouched by name (still at its own slug)', existsSync(myLookPath), myLookPath);
  const secondOnDisk = existsSync(secondPath) ? JSON.parse(readFileSync(secondPath, 'utf8')) : null;
  check('the disambiguated file carries the second preset\'s own name', secondOnDisk?.name === 'My/Look', secondOnDisk);

  // ---------------------------------------------------------------------
  console.log('verify-presets (6. delete via the UI removes the file and the select entry):');
  await selectPresetRow('My/Look');
  await page.locator('[data-testid="preset-delete"]').click();
  await waitForCondition(() => !existsSync(secondPath));
  check('the file is gone from disk', !existsSync(secondPath), secondPath);
  const optionsAfterDelete = await page.locator('[data-testid="preset-row"]').allTextContents();
  check('the deleted preset no longer appears in the select', !optionsAfterDelete.includes('My/Look'), optionsAfterDelete);
  check('"My Look" (the other, differently-named preset) is unaffected', existsSync(myLookPath), myLookPath);

  // ---------------------------------------------------------------------
  console.log('verify-presets (7. geometry independence: a preset never carries the crop):');
  await openAndWait(ARW_PATH); // fresh default graph + identity geometry
  const identityGeometry = await geometryState();
  check('reopened image starts with identity geometry', identityGeometry.crop.w === 1 && identityGeometry.crop.h === 1, identityGeometry);

  await page.evaluate(() =>
    window.__debug.setGeometry({ crop: { x: 0.1, y: 0.15, w: 0.5, h: 0.6 }, angle: 7, orientation: { quarterTurns: 0, flipH: false } })
  );
  const croppedGeometry = await geometryState();
  check('the crop actually took effect (setup)', croppedGeometry.crop.w === 0.5 && croppedGeometry.angle === 7, croppedGeometry);

  await openPresetsMenu();
  await page.locator('[data-testid="preset-save-name"]').fill('Crop Test');
  await page.locator('[data-testid="preset-save"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.presetsState().some((p) => p.name === 'Crop Test')));

  await openAndWait(ARW_PATH); // reopen: back to identity geometry, empty history
  const geometryBeforeApply = await geometryState();
  check('reopening reset the geometry back to identity', geometryBeforeApply.crop.w === 1 && geometryBeforeApply.angle === 0, geometryBeforeApply);

  await openPresetsMenu();
  await selectPresetRow('Crop Test');
  await page.locator('[data-testid="preset-apply"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.historyState().past === 1));
  const geometryAfterApply = await geometryState();
  check(
    'applying the preset left the input node\'s geometry untouched (still identity, NOT the crop active when it was saved)',
    geometryAfterApply.crop.w === 1 && geometryAfterApply.crop.h === 1 && geometryAfterApply.angle === 0,
    geometryAfterApply
  );

  // ---------------------------------------------------------------------
  console.log('verify-presets (8. a malformed preset file does not break listing):');
  mkdirSync(presetsDir, { recursive: true });
  writeFileSync(join(presetsDir, 'broken.json'), '{ this is not valid json');
  const listAfterMalformed = await page.evaluate(() => window.silverbox.presetsList());
  check(
    'listing resolves without throwing and still includes the valid presets',
    listAfterMalformed.some((p) => p.name === 'My Look') && listAfterMalformed.some((p) => p.name === 'Crop Test'),
    listAfterMalformed
  );
  check(
    'the malformed entry is skipped, not surfaced as a (broken) preset',
    !listAfterMalformed.some((p) => p.slug === 'broken'),
    listAfterMalformed
  );
  check('the malformed file itself is left untouched on disk', existsSync(join(presetsDir, 'broken.json')), true);

  // ---------------------------------------------------------------------
  console.log('verify-presets (9. Update: overwrites the SAME preset — name/slug/createdAt preserved, content/mtime changed):');
  await openAndWait(ARW_PATH); // fresh default graph
  await openPresetsMenu();
  await selectPresetRow('My Look');
  await page.locator('[data-testid="preset-apply"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 4));

  const beforeUpdateOnDisk = JSON.parse(readFileSync(myLookPath, 'utf8'));
  const mtimeBeforeUpdate = statSync(myLookPath).mtimeMs;
  // tweak a develop param post-apply, then overwrite via Update (not Save —
  // Update is the button under test, separate from the name-based Save flow)
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.9));
  await new Promise((resolve) => setTimeout(resolve, 20)); // let mtime clock tick past beforeUpdateOnDisk's

  await page.locator('[data-testid="preset-update"]').click();
  await waitForCondition(() => {
    if (!existsSync(myLookPath)) return false;
    const onDisk = JSON.parse(readFileSync(myLookPath, 'utf8'));
    return onDisk.look.graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.9;
  });
  const afterUpdateOnDisk = JSON.parse(readFileSync(myLookPath, 'utf8'));
  check(
    'Update wrote the tweak to the SAME file',
    afterUpdateOnDisk.look.graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.9,
    afterUpdateOnDisk.look.graph.nodes
  );
  check('Update preserved the preset name', afterUpdateOnDisk.name === beforeUpdateOnDisk.name, {
    before: beforeUpdateOnDisk.name,
    after: afterUpdateOnDisk.name,
  });
  check('Update preserved createdAt', afterUpdateOnDisk.createdAt === beforeUpdateOnDisk.createdAt, {
    before: beforeUpdateOnDisk.createdAt,
    after: afterUpdateOnDisk.createdAt,
  });
  check('Update kept the same slug (still the one file on disk)', existsSync(myLookPath), myLookPath);
  const mtimeAfterUpdate = statSync(myLookPath).mtimeMs;
  check('the file was actually rewritten (mtime advanced)', mtimeAfterUpdate > mtimeBeforeUpdate, {
    mtimeBeforeUpdate,
    mtimeAfterUpdate,
  });

  await openAndWait(ARW_PATH); // reset, then re-apply from a clean session
  await openPresetsMenu();
  await selectPresetRow('My Look');
  await page.locator('[data-testid="preset-apply"]').click();
  await waitForCondition(() =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.9)
  );
  const reappliedGraph = await graphState();
  check(
    're-applying after reset picks up the update (the tweak really is in the preset file, not just in-memory)',
    reappliedGraph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.9,
    reappliedGraph.nodes
  );

  // ---------------------------------------------------------------------
  console.log('verify-presets (10. hover preview: LR-style, no doc mutation):');
  await openAndWait(ARW_PATH); // fresh default graph, empty history, autosave off
  const baselineMeanHover = await gpuMean();
  const baselineGraphHover = await graphState();
  const baselineHistoryHover = await historyState();

  await openPresetsMenu();
  const myLookRow = presetRow('My Look');
  await myLookRow.scrollIntoViewIfNeeded();
  await myLookRow.hover(); // real mouseenter, not a synthetic dispatch
  const changedFromBaseline = (m) =>
    Math.abs(m.r - baselineMeanHover.r) > 1e-3 || Math.abs(m.g - baselineMeanHover.g) > 1e-3 || Math.abs(m.b - baselineMeanHover.b) > 1e-3;
  // the preview is debounced ~120ms (see PresetsMenu.tsx) — poll for the
  // render to actually change rather than racing a fixed sleep against it
  await waitForCondition(async () => changedFromBaseline(await gpuMean()));
  const hoverMean = await gpuMean();
  check('hovering a preset row previews its look (readbackMean changed)', changedFromBaseline(hoverMean), {
    baselineMeanHover,
    hoverMean,
  });
  check('hover preview does not mutate graphState()', JSON.stringify(await graphState()) === JSON.stringify(baselineGraphHover), {
    before: baselineGraphHover,
    after: await graphState(),
  });
  check(
    'hover preview pushes no history entry',
    JSON.stringify(await historyState()) === JSON.stringify(baselineHistoryHover),
    await historyState()
  );
  check('hover preview does not mark the doc dirty', (await page.evaluate(() => window.__debug.graphDirty())) === false, {
    graphDirty: await page.evaluate(() => window.__debug.graphDirty()),
  });

  // mouseleave restores the real (untouched) doc's render
  await page.mouse.move(0, 0);
  await waitForCondition(async () => {
    const m = await gpuMean();
    return Math.abs(m.r - baselineMeanHover.r) < 1e-4 && Math.abs(m.g - baselineMeanHover.g) < 1e-4 && Math.abs(m.b - baselineMeanHover.b) < 1e-4;
  });
  const afterLeaveMean = await gpuMean();
  check('mouseleave restores the baseline render (within 1e-4)', meansMatch(afterLeaveMean, baselineMeanHover, 1e-4), {
    baselineMeanHover,
    afterLeaveMean,
  });

  // hover-then-apply must equal a plain apply's render (same merge helper —
  // see appStore.ts's mergeLookWithCurrentGeometry)
  await myLookRow.hover();
  await waitForCondition(async () => {
    const m = await gpuMean();
    return Math.abs(m.r - hoverMean.r) < 1e-4 && Math.abs(m.g - hoverMean.g) < 1e-4 && Math.abs(m.b - hoverMean.b) < 1e-4;
  });
  await selectPresetRow('My Look'); // click also selects it, same as before
  await page.locator('[data-testid="preset-apply"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 4));
  const appliedAfterHoverMean = await gpuMean();
  check('hover-then-apply matches the hover preview render (within 1e-4)', meansMatch(appliedAfterHoverMean, hoverMean, 1e-4), {
    hoverMean,
    appliedAfterHoverMean,
  });

  // ---------------------------------------------------------------------
  // 11. "Reset all edits" (round-8 NG fix pack item 2; round-11 fix pack item
  // 2 moved the button itself out of this Presets menu into the toolbar's
  // whole-photo action group — "presetsの中にあるべきじゃない気がする" — but the
  // underlying resetAllEdits action/behavior is unchanged and this is still
  // the closest existing look-family script to exercise it from, rather than
  // a whole new verify script for one toolbar button). The reference graph is
  // captured from a REAL fresh open in this same session (not hand-built) —
  // under the flags THIS script runs under (no lensProfileAutoDefault/
  // baseCurveDefault/forceDefaults opt-in), seedDefaultLook's only
  // unconditional work is resolving the as-shot WB placeholder, so this is
  // exactly "the plain doc" the brief describes.
  console.log('verify-presets (11. Reset all edits: graph equals a fresh-open default, ONE undo entry, undo restores everything, rating preserved):');
  await closePresetsMenu(); // section 10's hover preview leaves it open
  await openAndWait(ARW_PATH); // fresh default graph, empty history, autosave off
  const freshOpenReferenceGraph = await graphState();
  check(
    'fresh-open reference is the plain 3-node doc (no opt-in default-look flags under this suite)',
    freshOpenReferenceGraph.nodes.length === 3,
    freshOpenReferenceGraph.nodes.map((n) => n.kind)
  );

  // rating BEFORE editing — proves reset-all preserves it (metadata, not look)
  await page.keyboard.press('4');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 4, { timeout: 5_000 });

  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.5));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', -15));
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-exposure"]').click();
  const gBeforeResetAll = await graphState();
  const resetTestExtraNode = gBeforeResetAll.nodes.find((n) => n.kind === 'exposure');
  check('setup: an extra op node landed before reset-all', !!resetTestExtraNode, gBeforeResetAll.nodes.map((n) => n.kind));
  const beforeResetAllMean = await gpuMean();
  const historyBeforeResetAll = await historyState();

  // Round-11: the button now lives in the toolbar, not this menu — no
  // openPresetsMenu() needed to reach it.
  await page.locator('[data-testid="toolbar-reset-all"]').click();
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 3));

  const gAfterResetAll = await graphState();
  check(
    'reset-all reproduces the fresh-open reference graph exactly (dropped the extra node + edits)',
    JSON.stringify(gAfterResetAll) === JSON.stringify(freshOpenReferenceGraph),
    { gAfterResetAll, freshOpenReferenceGraph }
  );
  const historyAfterResetAll = await historyState();
  check(
    'reset-all is exactly ONE undo entry',
    historyAfterResetAll.past === historyBeforeResetAll.past + 1 && historyAfterResetAll.future === 0,
    { historyBeforeResetAll, historyAfterResetAll }
  );
  check(
    'reset-all preserved the rating (metadata, not look)',
    (await page.evaluate(() => window.__debug.sidecarState().rating)) === 4,
    await page.evaluate(() => window.__debug.sidecarState())
  );

  await page.keyboard.press('Meta+z');
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 4));
  const gAfterUndoResetAll = await graphState();
  check(
    '⌘Z after reset-all restores everything, including the added node',
    JSON.stringify(gAfterUndoResetAll) === JSON.stringify(gBeforeResetAll),
    { gAfterUndoResetAll, gBeforeResetAll }
  );
  const meanAfterUndoResetAll = await gpuMean();
  check('⌘Z after reset-all restores the pre-reset render (within 1/255)', meansMatch(meanAfterUndoResetAll, beforeResetAllMean), {
    meanAfterUndoResetAll,
    beforeResetAllMean,
  });

  // redo back to the reset state, then prove the ⇧⌘R accelerator (App.tsx)
  // fires the exact same action as the menu button
  await page.keyboard.press('Meta+Shift+z');
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.length === 3));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.1));
  await page.keyboard.press('Meta+Shift+r');
  await waitForCondition(() => page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0));
  const gAfterShortcutReset = await graphState();
  check(
    '⇧⌘R reproduces the same fresh-open reference graph as the menu button',
    JSON.stringify(gAfterShortcutReset) === JSON.stringify(freshOpenReferenceGraph),
    { gAfterShortcutReset, freshOpenReferenceGraph }
  );

  check('no page errors across the presets checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
