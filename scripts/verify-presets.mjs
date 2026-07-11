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
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  await page.locator('[data-testid="preset-select"]').selectOption({ label: 'My Look' });
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
  await page.locator('[data-testid="preset-select"]').selectOption({ label: 'My/Look' });
  await page.locator('[data-testid="preset-delete"]').click();
  await waitForCondition(() => !existsSync(secondPath));
  check('the file is gone from disk', !existsSync(secondPath), secondPath);
  const optionsAfterDelete = await page.locator('[data-testid="preset-select"] option').allTextContents();
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
  await page.locator('[data-testid="preset-select"]').selectOption({ label: 'Crop Test' });
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
