/**
 * Apply-preset-to-selection verify (docs/brief-bank/apply-preset-to-selection.md,
 * linked-looks stage A): the one-shot no-asset batch case of linked-looks.md
 * §6 — apply a saved preset to EVERY photo in the filmstrip selection
 * (primary + secondaries) as ONE undoable gesture, no apply-time dialog (the
 * preset's own saved `includes` governs). Composes syncSelection's
 * target-iteration/batch-undo/look-file-write pattern with applyPreset's
 * preset-parse/includes/merge path (appStore.ts's applyPresetToSelection).
 *
 * Checks (the brief's own (1)-(4)):
 *  1. Save a preset from the primary with basic-tone + spots checked (hsl
 *     deliberately left OUT); select primary + 2 targets; apply-to-selection
 *     via the REAL "apply to selection" button (visible-path principle) —
 *     all 3 look files (including the PRIMARY's own, flushed immediately)
 *     carry the preset's basic-tone value; a target pre-edited with its OWN
 *     hsl value keeps it untouched (unchecked family, never reset).
 *  2. Structural case: the same preset's `spots` family grafts a real spots
 *     node (with the primary's actual spot data) onto BOTH targets, neither
 *     of which had a spots node before — the seeded-fresh target (no prior
 *     look at all) proves the graft rides the same "seed like a fresh open,
 *     then merge" path syncSelection uses for a target with nothing on disk.
 *  3. ONE ⌘Z reverts all 3 (primary included — a same-path reopen, not a
 *     navigation jump) byte-identically to their pre-apply state; ⌘⇧Z
 *     (redo) re-applies all 3.
 *  4. With only the primary open (no secondary selection), the "apply to
 *     selection" affordance doesn't even render — the ordinary Apply button
 *     behaves exactly like today's single-photo applyPreset (a
 *     'preset-apply' undo entry, not a 'sync' batch entry; the other two
 *     photos' look files are untouched).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, readLook } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-preset-selection-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order (folder open's own sort — verify-filmstrip.mjs
// precedent): a_primary opens first when the folder is opened fresh.
const PRIMARY = fixture('a_primary.ARW');
const TARGET1 = fixture('b_target1.ARW'); // gets a REAL pre-existing look with its own hsl edit
const TARGET2 = fixture('c_target2.ARW'); // never opened before the batch apply — no look at all

const lookExists = (path) => existsSync(lookPathFor(path));
// On-disk look docs are wrapped ({ schemaVersion, graph: { nodes, edges }, … }
// — serializeGraphDoc/parseGraphDoc's own shape); window.__debug.graphState()
// returns the plain in-memory GraphDoc directly (no wrapper) — two different
// shapes, two small helpers, so a mix-up throws immediately instead of
// silently reading the wrong thing.
const devOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.id === 'dev').develop;
const spotsNodeOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.type === 'spots');
const devOfGraph = (graph) => graph.nodes.find((n) => n.id === 'dev').develop;

async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-preset-selection-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReadyOrError = () =>
    page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );
  const openImageFireAndForget = (path, opts) =>
    page.evaluate(({ p, o }) => void window.__openImageByPath(p, o), { p: path, o: opts });
  const openFolderFireAndForget = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const undoStackState = () => page.evaluate(() => window.__debug.undoStackState());
  const selectionState = () => page.evaluate(() => window.__debug.filmstripSelectionState());
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);

  const openPresetsMenu = async () => {
    if ((await page.locator('[data-testid="presets-menu"]').count()) === 0) {
      await page.locator('[data-testid="presets-button"]').click();
      await page.waitForSelector('[data-testid="presets-menu"]', { timeout: 5_000 });
    }
  };
  const presetRow = (name) => page.locator('[data-testid="preset-row"]').filter({ hasText: name });
  const selectPresetRow = (name) => presetRow(name).click();

  const ALL_FAMILY_IDS = ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail', 'geometry', 'spots', 'masks', 'custom-nodes'];
  const setFamilyCheckboxes = async (idsToCheck) => {
    const want = new Set(idsToCheck);
    for (const id of ALL_FAMILY_IDS) {
      const checkbox = page.locator(`[data-testid="family-scope-checkbox-${id}"] input[type="checkbox"]`);
      if (want.has(id)) await checkbox.check();
      else await checkbox.uncheck();
    }
  };
  const saveWithFamilies = async (name, families) => {
    await page.locator('[data-testid="preset-save-name"]').fill(name);
    await page.locator('[data-testid="preset-save"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
    await setFamilyCheckboxes(families);
    await page.locator('[data-testid="family-scope-confirm"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });
  };

  // === Setup: open the folder — a_primary (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PRIMARY,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 3, { timeout: 15_000 });

  // === Fixture: b_target1 gets a REAL pre-existing look with its own hsl edit (the family the preset will NOT touch) ===
  console.log('verify-preset-selection (fixture setup — b_target1 gets a real look with a hsl edit, unchecked family):');
  await openImageFireAndForget(TARGET1, { keepFolderContext: true });
  await waitReadyOrError();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'hsl.red.h', 20));
  await page.click('[data-testid="save-button"]');
  check(
    'b_target1 look lands on disk',
    await waitFor(() => lookExists(TARGET1)),
    lookPathFor(TARGET1)
  );
  const target1Before = readLook(TARGET1);
  check('fixture has the hsl edit', devOf(target1Before).hsl.red.h === 20, devOf(target1Before).hsl.red);
  check('c_target2 has no look at all yet (never opened)', !lookExists(TARGET2), null);

  // === Re-open the primary: ev=0.6 (basic-tone) + one real spot, THEN save a scoped preset (basic-tone + spots, hsl left OUT) ===
  console.log('verify-preset-selection (setup — primary gets ev=0.6 + a real spot, saved as a scoped preset):');
  await openImageFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReadyOrError();
  // The canvas briefly exists geometrically but doesn't accept pointer
  // events right after a photo switch (a real repro during this script's
  // own development — `elementFromPoint` returned the wrapper pane, not the
  // canvas, for ~a few hundred ms after reopening); wait for the histogram
  // (proof a real render completed) plus a short settle before driving the
  // spot-drag gesture below.
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.6));

  await page.evaluate(() => window.__debug.setSpotBrushRadius(0.12));
  await page.locator('[data-testid="spots-toggle"]').click();
  const canvas = page.locator('.canvas-view-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const dst = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
  const src = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.3 };
  await page.mouse.move(dst.x, dst.y);
  await page.mouse.down();
  await page.mouse.move(src.x, src.y, { steps: 8 });
  await page.mouse.up();
  const gAfterSpot = await graphState();
  check('primary gained a real spots node with one spot', gAfterSpot.nodes.some((n) => n.kind === 'spots'), gAfterSpot.nodes.map((n) => n.kind));

  await openPresetsMenu();
  await saveWithFamilies('Selection Test', ['basic-tone', 'spots']);
  await waitFor(() => page.evaluate(() => window.__debug.presetsState().some((p) => p.name === 'Selection Test')));

  // Decoys, AFTER the preset was captured: ev drifts to 0.9 (must be pulled
  // back to 0.6 by the batch apply below), hsl to 77 (unchecked family — must
  // survive the apply untouched, same as target1's own hsl edit).
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.9));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'hsl.red.h', 77));
  const primaryBeforeApply = await graphState();
  check('primary setup: ev drifted to 0.9, hsl to 77, spot still present', devOfGraph(primaryBeforeApply).basic.ev === 0.9 && devOfGraph(primaryBeforeApply).hsl.red.h === 77 && primaryBeforeApply.nodes.some((n) => n.kind === 'spots'), devOfGraph(primaryBeforeApply));

  // ---------------------------------------------------------------------
  console.log('verify-preset-selection (1/2. select all 3, click the REAL "apply to selection" button — basic-tone lands, hsl survives, spots grafts):');
  await setSelection([TARGET1, TARGET2]);
  const sel = await selectionState();
  check('all 3 selected (primary + 2 secondaries)', sel.primary === PRIMARY && sel.secondary.length === 2, sel);

  await selectPresetRow('Selection Test');
  const applySelectionButton = page.locator('[data-testid="preset-apply-selection"]');
  await applySelectionButton.scrollIntoViewIfNeeded();
  check('the button is visible with the target-count label (visible-path principle)', (await applySelectionButton.textContent()) === '選択中の3枚に適用', await applySelectionButton.textContent());
  check('the button is enabled (a preset row is selected, 2+ are selected)', !(await applySelectionButton.isDisabled()), null);

  const stackBeforeApply = await undoStackState();
  await applySelectionButton.click();

  check('c_target2 (seeded fresh) gains a look file', await waitFor(() => lookExists(TARGET2)), lookPathFor(TARGET2));
  await waitFor(async () => {
    const st = await undoStackState();
    return st.undo.length === stackBeforeApply.undo.length + 1;
  });

  // primary flushed to disk immediately (flush discipline — no waiting on the 1s autosave debounce)
  check('primary\'s OWN look file carries ev=0.6 (pulled back from the 0.9 decoy)', await waitFor(() => lookExists(PRIMARY) && devOf(readLook(PRIMARY)).basic.ev === 0.6), lookExists(PRIMARY) ? devOf(readLook(PRIMARY)).basic : null);
  const primaryAfter = readLook(PRIMARY);
  check('primary\'s hsl decoy (unchecked family) survives untouched at 77', devOf(primaryAfter).hsl.red.h === 77, devOf(primaryAfter).hsl.red);
  check('primary still carries its own spot', spotsNodeOf(primaryAfter)?.spots?.spots?.length === 1, spotsNodeOf(primaryAfter));

  check('target1 gains ev=0.6 (basic-tone)', devOf(readLook(TARGET1)).basic.ev === 0.6, devOf(readLook(TARGET1)).basic);
  check('target1\'s OWN hsl edit (unchecked family) survives untouched at 20 — never reset toward the preset', devOf(readLook(TARGET1)).hsl.red.h === 20, devOf(readLook(TARGET1)).hsl.red);
  const target1Spot = spotsNodeOf(readLook(TARGET1))?.spots?.spots?.[0];
  const primarySpot = spotsNodeOf(primaryAfter)?.spots?.spots?.[0];
  check('target1 (had NO spots node) gets the primary\'s spot grafted', JSON.stringify(target1Spot) === JSON.stringify(primarySpot), { primarySpot, target1Spot });

  check('target2 (seeded fresh, no prior look) gains ev=0.6 too', devOf(readLook(TARGET2)).basic.ev === 0.6, devOf(readLook(TARGET2)).basic);
  check('target2\'s hsl (seeded identity, unchecked family) is untouched — not the decoy 77', devOf(readLook(TARGET2)).hsl.red.h !== 77, devOf(readLook(TARGET2)).hsl.red);
  const target2Spot = spotsNodeOf(readLook(TARGET2))?.spots?.spots?.[0];
  check('target2 (seeded fresh, no spots node either) also gets the primary\'s spot grafted', JSON.stringify(target2Spot) === JSON.stringify(primarySpot), { primarySpot, target2Spot });

  const stackAfterApply = await undoStackState();
  const topEntry = stackAfterApply.undo.at(-1);
  check(
    'the top undo entry is ONE sync batch, targeting all 3 (primary included)',
    topEntry?.kind === 'sync' && JSON.stringify(topEntry.targets.slice().sort()) === JSON.stringify([PRIMARY, TARGET1, TARGET2].sort()),
    topEntry
  );

  // ---------------------------------------------------------------------
  console.log('verify-preset-selection (3. ONE ⌘Z reverts all 3 (primary included, no navigation jump); ⌘⇧Z redoes):');
  const openPathBeforeUndo = await page.evaluate(() => window.__debug.projectState().currentLookPath);
  await page.keyboard.press('Meta+z');
  await waitFor(async () => {
    if (!lookExists(PRIMARY)) return false;
    return devOf(readLook(PRIMARY)).basic.ev === 0.9;
  });
  // The reopen-if-currently-open reload (case 'sync' in undo()) is a
  // separate async step after the disk write settles — wait for the LIVE
  // graph to catch up too, not just disk.
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 0.9);
  check('primary reverts to its pre-apply ev (0.9) on disk', devOf(readLook(PRIMARY)).basic.ev === 0.9, devOf(readLook(PRIMARY)).basic);
  check('primary reverts in-memory too (live graph, not just disk)', devOfGraph(await graphState()).basic.ev === 0.9, devOfGraph(await graphState()).basic);
  check('target1 reverts to its pre-apply ev (0, the default)', devOf(readLook(TARGET1)).basic.ev === 0, devOf(readLook(TARGET1)).basic);
  check('target1\'s own hsl edit still intact after the revert', devOf(readLook(TARGET1)).hsl.red.h === 20, devOf(readLook(TARGET1)).hsl.red);
  check('target2 reverts to its pre-apply (seeded-default) ev (0) on disk', devOf(readLook(TARGET2)).basic.ev === 0, devOf(readLook(TARGET2)).basic);
  check(
    'no navigation jump happened — the same photo is still open (a same-path reopen, not a jump to a different photo)',
    (await page.evaluate(() => window.__debug.projectState().currentLookPath)) === openPathBeforeUndo,
    await page.evaluate(() => window.__debug.projectState().currentLookPath)
  );

  await page.keyboard.press('Meta+Shift+z');
  // All 3 targets are written sequentially inside the SAME applySyncEntryGraphs
  // call redo() awaits — wait for all of them, not just the primary, before
  // asserting any of the three.
  await waitFor(
    () =>
      lookExists(PRIMARY) &&
      devOf(readLook(PRIMARY)).basic.ev === 0.6 &&
      devOf(readLook(TARGET1)).basic.ev === 0.6 &&
      devOf(readLook(TARGET2)).basic.ev === 0.6
  );
  check('redo re-applies to primary (ev=0.6 again)', devOf(readLook(PRIMARY)).basic.ev === 0.6, devOf(readLook(PRIMARY)).basic);
  check('redo re-applies to target1 (ev=0.6 again)', devOf(readLook(TARGET1)).basic.ev === 0.6, devOf(readLook(TARGET1)).basic);
  check('redo re-applies to target2 (ev=0.6 again)', devOf(readLook(TARGET2)).basic.ev === 0.6, devOf(readLook(TARGET2)).basic);

  // ---------------------------------------------------------------------
  console.log('verify-preset-selection (4. 1-photo selection: no batch entry regression, identical to today\'s applyPreset):');
  await setSelection([]);
  const selAfterClear = await selectionState();
  check('back down to just the primary selected', selAfterClear.primary === PRIMARY && selAfterClear.secondary.length === 0, selAfterClear);
  check(
    'the "apply to selection" affordance does not even render with <2 selected',
    (await page.locator('[data-testid="preset-apply-selection"]').count()) === 0,
    await page.locator('[data-testid="preset-apply-selection"]').count()
  );

  const target1Snapshot = readFileSync(lookPathFor(TARGET1), 'utf8');
  const target2Snapshot = readFileSync(lookPathFor(TARGET2), 'utf8');

  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.1)); // move primary off 0.6, so the single apply below is observable (pushes its own 'photo-edit' entry, captured in the baseline below)
  const stackBeforeSingleApply = await undoStackState();
  await page.locator('[data-testid="preset-apply"]').click();
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 0.6);

  const stackAfterSingleApply = await undoStackState();
  const singleTopEntry = stackAfterSingleApply.undo.at(-1);
  check(
    'the single-photo Apply pushed a plain "preset-apply" entry, NOT a "sync" batch',
    singleTopEntry?.kind === 'preset-apply' && singleTopEntry.target === PRIMARY,
    singleTopEntry
  );
  check('exactly one new undo entry (no extra batch bookkeeping)', stackAfterSingleApply.undo.length === stackBeforeSingleApply.undo.length + 1, {
    before: stackBeforeSingleApply.undo.length,
    after: stackAfterSingleApply.undo.length,
  });
  check('target1\'s look file is byte-identical — untouched by the single-photo apply', readFileSync(lookPathFor(TARGET1), 'utf8') === target1Snapshot, null);
  check('target2\'s look file is byte-identical — untouched by the single-photo apply', readFileSync(lookPathFor(TARGET2), 'utf8') === target2Snapshot, null);

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

rmSync(workDir, { recursive: true, force: true });
if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
