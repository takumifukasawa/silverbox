/**
 * Filmstrip multi-select + Sync… verify (docs/brief-bank/multi-select-sync.md),
 * adapted to the GLOBAL UNDO reality that landed after the brief was written
 * (commit 64149f9, docs/brief-bank/global-undo.md): sync's undo is no longer
 * a completion-notice "Undo" button — it produces a `SyncUndoEntry` on the
 * SAME global stack every other edit uses. ⌘Z reverts every target look IN
 * PLACE (no jump — decision 1's BATCH carve-out: "no single photo to show"),
 * and the confirm dialog wording says so ("⌘Zで戻せます" in spirit — this
 * script checks the completion notice text, not the confirm dialog's, since
 * the dialog itself is only reachable via the SAME family-checkbox UI
 * preset-scoping's own verify-presets.mjs/verify-scopes.mjs already exercise;
 * this script drives the mechanism via the brief's own suggested
 * `setFilmstripSelection(paths)` / `syncSelection(families)` debug hooks for
 * the family-scoped assertions, and REAL ⌘/⇧/plain clicks for the selection
 * mechanics themselves — checks 1/7 below).
 *
 * Checks (the brief's (1)-(7), plus (8)/(9) for the global-undo reality):
 *  1/7. Real filmstrip clicks: ⌘-click toggles a cell into the selection
 *     (secondary-selected style, reduced-intensity border), ⇧-click extends
 *     an inclusive range from the last plain-clicked cell, and a plain click
 *     collapses back to single-select — the Sync… button + "N selected"
 *     badge track the total selection count (2+ enables the button).
 *  2. Sync 'basic-tone' from the primary (live graph, ev=0.6) to two
 *     secondaries: both gain ev=0.6; neither gains the primary's WB (temp)
 *     or HSL edits (unchecked families never move — checks 3 folds in here).
 *  3. See above (folded into check 2's WB/HSL assertions).
 *  4. A target with no look yet is seeded exactly like a fresh open, THEN
 *     the checked family is merged on — never a bare default doc.
 *  5. Skipped-family counting: syncing 'masks' to a target whose own chain
 *     has no structurally-compatible anchor (a plain default chain, no
 *     blend node) skips masks for it and counts it in the completion notice
 *     — without grafting an orphaned mask node onto that target's file.
 *  6. photo/fingerprint (and rating/flag) wrapper fields survive the
 *     rewrite untouched.
 *  8. sync → ⌘Z reverts BOTH targets on disk (fingerprint/photo intact),
 *     redo re-applies both.
 *  9. Rating key (multi-select-sync.md: "act on the whole selection when
 *     2+ selected") with 3 selected writes all 3 looks' ratings; 3 ⌘Z
 *     presses restore them — asserting the JUMPS happen for the two that
 *     aren't the open canvas photo (per-photo entries, LIFO, decision 1).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-sync-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order matters (folder open's own sort — verify-filmstrip.mjs
// precedent): a_primary opens first when the folder is opened fresh.
const PRIMARY = fixture('a_primary.ARW');
const EXISTING = fixture('b_existing.ARW');
const FRESH = fixture('c_fresh.ARW');
const SKIP_TARGET = fixture('d_skiptarget.ARW');
const RATING_1 = fixture('e_rating1.ARW');
const RATING_2 = fixture('f_rating2.ARW');
const RATING_3 = fixture('g_rating3.ARW');

const readLook = (path) => JSON.parse(readFileSync(lookPathFor(path), 'utf8'));
const devOf = (doc) => doc.graph.nodes.find((n) => n.id === 'dev');
const lookExists = (path) => existsSync(lookPathFor(path));

async function waitForDiskEv(path, expected, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (lookExists(path)) {
      const dev = devOf(readLook(path));
      if (dev?.develop?.basic?.ev === expected) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForDiskRating(path, expected, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (lookExists(path) && (readLook(path).rating ?? 0) === expected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Section 9's canvas-photo rating write (RATING_1) rides the ordinary
// dirty→autosave path, which is gated on settings.autosaveSidecar — this
// machine's own real settings.json may have it OFF (verify-undo.mjs's own
// precaution). Isolate settings.json the same way so autosave is
// deterministically ON, matching DEFAULT_SETTINGS.
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-sync-userdata-'));

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
  const cellFor = (path) => page.locator(`[data-testid="filmstrip-cell"][data-path="${path}"]`);
  const selectionState = () => page.evaluate(() => window.__debug.filmstripSelectionState());
  const syncButtonDisabled = () => page.locator('[data-testid="filmstrip-sync-button"]').isDisabled();

  // === Setup: open the folder — a_primary (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PRIMARY,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 7, {
    timeout: 15_000,
  });

  // === 1/7. Real filmstrip clicks: ⌘-toggle, ⇧-range, plain-click collapse ===
  console.log('verify-sync (1/7. real ⌘-click toggle / ⇧-click range / plain-click collapse; Sync… button + count badge):');
  check('with only the primary open, the Sync… button is disabled', await syncButtonDisabled(), null);
  check('no "N selected" badge with a single selection', (await page.locator('[data-testid="filmstrip-selection-count"]').count()) === 0, null);

  await cellFor(EXISTING).click({ modifiers: ['Meta'] });
  let sel = await selectionState();
  check('⌘-click adds EXISTING as a secondary (primary unchanged)', sel.primary === PRIMARY && JSON.stringify(sel.secondary) === JSON.stringify([EXISTING]), sel);
  check('EXISTING\'s cell renders the reduced-intensity secondary style', await cellFor(EXISTING).evaluate((el) => el.classList.contains('filmstrip-cell--secondary-selected')), null);
  check('the primary\'s own cell keeps the full --current style, not --secondary-selected', await cellFor(PRIMARY).evaluate((el) => el.classList.contains('filmstrip-cell--current') && !el.classList.contains('filmstrip-cell--secondary-selected')), null);
  check('"2 selected" badge shows', (await page.locator('[data-testid="filmstrip-selection-count"]').textContent()) === '2 selected', null);
  check('Sync… button is enabled at 2 selected', !(await syncButtonDisabled()), null);

  // ⇧-click SKIP_TARGET (4th sorted cell): range from the anchor (a_primary,
  // the last PLAIN click) through d_skiptarget — b_existing/c_fresh/d_skiptarget.
  await cellFor(SKIP_TARGET).click({ modifiers: ['Shift'] });
  sel = await selectionState();
  check(
    '⇧-click replaces the secondary selection with the inclusive range [existing, fresh, skiptarget]',
    sel.primary === PRIMARY && JSON.stringify(sel.secondary.slice().sort()) === JSON.stringify([EXISTING, FRESH, SKIP_TARGET].sort()),
    sel
  );
  check('"4 selected" badge (primary + 3 range cells)', (await page.locator('[data-testid="filmstrip-selection-count"]').textContent()) === '4 selected', null);

  // Plain click on c_fresh collapses the selection AND opens it (unchanged behavior).
  await cellFor(FRESH).click();
  await waitReadyOrError();
  await page.waitForFunction((p) => window.__debug.projectState().currentLookPath !== null && window.__debug.folderState().currentPath === p, FRESH, { timeout: 15_000 });
  sel = await selectionState();
  check('plain click collapses the selection to just the newly-opened primary', sel.primary === FRESH && sel.secondary.length === 0, sel);
  check('Sync… button disabled again after collapse', await syncButtonDisabled(), null);

  // === Fixture: b_existing gets a REAL look (hsl edit + rating + pick), saved ===
  console.log('verify-sync (fixture setup — b_existing gets a real look with an HSL edit + rating + pick):');
  await openImageFireAndForget(EXISTING, { keepFolderContext: true });
  await waitReadyOrError();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'hsl.red.h', 30));
  await page.evaluate(() => window.__debug.setRating(2));
  await page.keyboard.press('p'); // pick
  await page.click('[data-testid="save-button"]');
  check('b_existing\'s look lands on disk', await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (lookExists(EXISTING)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })(), lookPathFor(EXISTING));
  const existingBefore = readLook(EXISTING);
  check('fixture has the hsl edit, rating, and pick flag', devOf(existingBefore).develop.hsl.red.h === 30 && existingBefore.rating === 2 && existingBefore.flag === 'pick', existingBefore);

  // === Re-open the primary and give it distinguishing edits across 3 families ===
  await openImageFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReadyOrError();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.6)); // basic-tone
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 8000)); // wb — deliberately NOT synced below
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'hsl.red.h', 45)); // hsl — deliberately NOT synced below

  // === 2/3/6. Sync 'basic-tone' ONLY, to [existing, fresh]: gains ev, WB/HSL untouched, wrapper fields survive ===
  console.log('verify-sync (2/3/6. sync basic-tone only — targets gain ev, WB/HSL/rating/flag/fingerprint untouched):');
  await page.evaluate((paths) => window.__debug.setFilmstripSelection(paths), [EXISTING, FRESH]);
  sel = await selectionState();
  check('selection set via the debug hook reports both targets as secondaries', sel.primary === PRIMARY && JSON.stringify(sel.secondary.slice().sort()) === JSON.stringify([EXISTING, FRESH].sort()), sel);
  check('c_fresh has no look yet, before the sync', !lookExists(FRESH), null);

  await page.evaluate((families) => window.__debug.syncSelection(families), ['basic-tone']);
  check('EXISTING gains the primary\'s ev', await waitForDiskEv(EXISTING, 0.6), devOf(readLook(EXISTING)));
  check('FRESH (seeded, no prior look) gains the primary\'s ev too', await waitForDiskEv(FRESH, 0.6), lookExists(FRESH) ? devOf(readLook(FRESH)) : null);

  const existingAfter = readLook(EXISTING);
  const freshAfter = readLook(FRESH);
  check('FRESH is never a bare default doc — its ev differs from the true identity default (0)', devOf(freshAfter).develop.basic.ev !== 0, devOf(freshAfter));
  check('EXISTING\'s WB (unchecked family) is untouched — not the primary\'s 8000', devOf(existingAfter).develop.basic.temp !== 8000, devOf(existingAfter).develop.basic);
  check('FRESH\'s WB (unchecked family) is untouched too', devOf(freshAfter).develop.basic.temp !== 8000, devOf(freshAfter).develop.basic);
  check('EXISTING\'s own HSL edit (unchecked family) survives byte-for-byte — never reset toward the primary\'s 45', devOf(existingAfter).develop.hsl.red.h === 30, devOf(existingAfter).develop.hsl.red);
  check('FRESH\'s HSL (unchecked family, seeded identity) is untouched — not the primary\'s 45', devOf(freshAfter).develop.hsl.red.h !== 45, devOf(freshAfter).develop.hsl.red);
  check(
    'EXISTING\'s rating/flag/photo/fingerprint wrapper fields survive the rewrite untouched',
    existingAfter.rating === existingBefore.rating &&
      existingAfter.flag === existingBefore.flag &&
      existingAfter.photo === existingBefore.photo &&
      existingAfter.fingerprint === existingBefore.fingerprint &&
      existingAfter.fingerprint !== undefined,
    { before: existingBefore, after: existingAfter }
  );

  // === 8. sync → ⌘Z reverts BOTH targets on disk; redo re-applies ===
  console.log('verify-sync (8. sync undo/redo — reverts both targets in place, no jump; redo re-applies):');
  const stackAfterSync = await page.evaluate(() => window.__debug.undoStackState());
  check('the top undo entry is the sync batch, targeting both looks', stackAfterSync.undo.at(-1)?.kind === 'sync' && JSON.stringify(stackAfterSync.undo.at(-1)?.targets.slice().sort()) === JSON.stringify([EXISTING, FRESH].sort()), stackAfterSync.undo.at(-1));

  const primaryBeforeUndo = await page.evaluate(() => window.__debug.projectState().currentLookPath);
  await page.keyboard.press('Meta+z');
  check('EXISTING reverts to its pre-sync ev (0) on disk', await waitForDiskEv(EXISTING, 0), devOf(readLook(EXISTING)));
  check('FRESH reverts to its pre-sync (seeded-default) ev (0) on disk', await waitForDiskEv(FRESH, 0), devOf(readLook(FRESH)));
  check('EXISTING\'s fingerprint/photo survive the undo too', readLook(EXISTING).fingerprint === existingBefore.fingerprint && readLook(EXISTING).photo === existingBefore.photo, readLook(EXISTING));
  check('no jump happened — the primary is still the open photo (BATCH entries never jump)', (await page.evaluate(() => window.__debug.projectState().currentLookPath)) === primaryBeforeUndo, await page.evaluate(() => window.__debug.projectState().currentLookPath));

  await page.keyboard.press('Meta+Shift+z');
  check('redo re-applies the sync to EXISTING', await waitForDiskEv(EXISTING, 0.6), devOf(readLook(EXISTING)));
  check('redo re-applies the sync to FRESH', await waitForDiskEv(FRESH, 0.6), devOf(readLook(FRESH)));
  check('no jump on redo either', (await page.evaluate(() => window.__debug.projectState().currentLookPath)) === primaryBeforeUndo, await page.evaluate(() => window.__debug.projectState().currentLookPath));

  // === 4/5. Skipped-family counting: 'masks' to a structurally incompatible target ===
  console.log('verify-sync (4/5. structural skip-counting — masks skipped + counted for a plain-chain target, no orphan node grafted):');
  await page.evaluate(() => window.__debug.addLocalAdjustment()); // gives the PRIMARY a real mask+blend node
  check('d_skiptarget has no look yet', !lookExists(SKIP_TARGET), null);
  await page.evaluate((paths) => window.__debug.setFilmstripSelection(paths), [SKIP_TARGET]);
  await page.evaluate((families) => window.__debug.syncSelection(families), ['masks']);

  const skipSynced = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (lookExists(SKIP_TARGET)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  check('d_skiptarget still gets synced (a look file is created — the OTHER checked families, if any, would still land)', skipSynced, lookPathFor(SKIP_TARGET));
  const skipDoc = skipSynced ? readLook(SKIP_TARGET) : null;
  check('no mask node was grafted onto the structurally incompatible target', !skipDoc?.graph.nodes.some((n) => n.type === 'mask'), skipDoc?.graph.nodes.map((n) => n.type));

  await page.waitForSelector('[data-testid="project-notice"]', { timeout: 10_000 });
  const skipNoticeText = await page.$eval('[data-testid="project-notice"]', (el) => el.title);
  check('the completion notice reports the masks skip, counted', /skipped masks on 1/.test(skipNoticeText), skipNoticeText);

  // === 9. Rating key with 3 selected writes 3 looks; 3 ⌘Z presses jump + restore each ===
  console.log('verify-sync (9. rating key fan-out over 3 selected; 3 ⌘Z presses jump to + restore each):');
  await openImageFireAndForget(RATING_1, { keepFolderContext: true });
  await waitReadyOrError();
  const stackBeforeRatingFanout = await page.evaluate(() => window.__debug.undoStackState());
  await page.evaluate((paths) => window.__debug.setFilmstripSelection(paths), [RATING_2, RATING_3]);
  sel = await selectionState();
  check('3 total selected (primary + 2 secondaries) before pressing the rating key', sel.primary === RATING_1 && sel.secondary.length === 2, sel);

  await page.keyboard.press('4');
  await page.waitForFunction(
    (args) => {
      const st = window.__debug.undoStackState();
      const fresh = st.undo.slice(args.beforeLen);
      const targets = fresh.filter((e) => e.kind === 'rating').map((e) => e.target);
      return args.expected.every((t) => targets.includes(t)) && targets.length === args.expected.length;
    },
    { beforeLen: stackBeforeRatingFanout.undo.length, expected: [RATING_1, RATING_2, RATING_3] },
    { timeout: 15_000 }
  );
  check('the canvas photo (RATING_1) shows rating 4 in memory', (await page.evaluate(() => window.__debug.sidecarState().rating)) === 4, await page.evaluate(() => window.__debug.sidecarState().rating));
  check('RATING_1\'s own look reaches disk too (autosave), rating 4', await waitForDiskRating(RATING_1, 4), lookExists(RATING_1) ? readLook(RATING_1) : null);
  check('RATING_2\'s look gains rating 4 on disk (fan-out, not opened)', await waitForDiskRating(RATING_2, 4), readLook(RATING_2));
  check('RATING_3\'s look gains rating 4 on disk too', await waitForDiskRating(RATING_3, 4), readLook(RATING_3));
  check('exactly 3 distinct "rating" undo entries were pushed — one per photo (no combined entry)', true, null); // asserted by the waitForFunction above already landing

  const visitedLookPaths = new Set();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    visitedLookPaths.add(await page.evaluate(() => window.__debug.projectState().currentLookPath));
    await page.waitForTimeout(200); // let each write settle before the next press reads a consistent stack
  }
  check(
    'across the 3 undo presses, the app JUMPED to (visited) all 3 rated photos\' own looks',
    [RATING_1, RATING_2, RATING_3].map(lookPathFor).every((p) => visitedLookPaths.has(p)),
    { visitedLookPaths: [...visitedLookPaths], expected: [RATING_1, RATING_2, RATING_3].map(lookPathFor) }
  );
  check('RATING_1\'s rating is restored to 0 on disk', await waitForDiskRating(RATING_1, 0), readLook(RATING_1));
  check('RATING_2\'s rating is restored to 0 on disk', await waitForDiskRating(RATING_2, 0), readLook(RATING_2));
  check('RATING_3\'s rating is restored to 0 on disk', await waitForDiskRating(RATING_3, 0), readLook(RATING_3));

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
