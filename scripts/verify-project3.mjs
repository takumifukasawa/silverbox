/**
 * Project storage UX pack round 2 verify (docs/brief-bank/project-storage.md
 * item A, filmstrip item B, remove-from-project item C, selection-CSS item
 * D): per-launch quick project + the filmstrip-always-visible/removal
 * follow-ons. A separate script from verify-project.mjs/verify-project2.mjs
 * (which own the ORIGINAL project-storage stages) since this one deliberately
 * exercises the OPPOSITE configuration those rely on — every other script in
 * the suite runs with `SILVERBOX_TEST_PROJECT` set (a PINNED dir, no
 * per-session subdir — see testFlags.projectDirOverride's own doc comment),
 * so proving the per-session dated-subdir behavior needs a script that does
 * NOT set it, with its own `settings.json` pointing `quickProjectDir` at a
 * scratch ROOT instead.
 *
 * Checks:
 *  A1. First quick-project need this session creates `<root>/<date>a`
 *      (today's local date + first free letter) — nothing written to `root`
 *      itself. A later open/drop in the SAME session accumulates into the
 *      SAME subdir (no new dir minted).
 *  A2. Disambiguation: a subdirectory named `<date>a` already existing under
 *      `root` (simulating an earlier session/relaunch) is skipped — the
 *      fresh session mints `<date>b` instead, never reusing it.
 *  A3. Legacy back-compat: a `project.silverbox` sitting directly in `root`
 *      (the pre-round-2 single quick project) is left byte-for-byte
 *      untouched by a fresh session's own subdir creation, and stays
 *      openable as an ordinary project via openProjectByPath(root).
 *  A4. "New Project": closes the current project/photo and resets the
 *      session cache — the NEXT photo open mints yet another fresh dated
 *      subdir with an EMPTY playlist, while the previous session's own
 *      subdir (photos + looks) is left on disk untouched.
 *  A5. testFlags.projectDirOverride still wins outright, used EXACTLY as
 *      given (no subdir) — the lever the rest of the verify suite depends on.
 *  B1. A single standalone photo open (no folder, no keepFolderContext)
 *      shows the filmstrip with exactly 1 cell (folderDir non-null) —
 *      previously this cleared folderDir to null and showed nothing.
 *  C1. Removing a NON-current photo drops it from the playlist without
 *      touching the currently open photo; one undo entry restores it at its
 *      original position; redo re-removes it.
 *  C2. Removing the CURRENTLY OPEN photo (with a remaining neighbor) opens
 *      the nearest surviving neighbor by the strip's own sort order.
 *  C3. Removing every remaining photo (including the current one) falls to
 *      the empty state — project stays active (folderDir non-null,
 *      photoCount 0), nothing crashes; undo restores the rows (no
 *      auto-reopen — a batch entry, same "no jump" shape as sync).
 *  C4. ⌫/Delete with 2+ selected removes the WHOLE selection as ONE undo
 *      entry.
 *  C5. A cell's context-menu "Remove from project" item removes just that
 *      one photo (real right-click + click, not the debug hook).
 *  C6. Never deletes/moves the underlying photo FILE (still readable on disk
 *      after removal).
 *  D1. A secondary-selected cell's border color is the new bright/distinct
 *      value (not the old low-contrast one) — computed style, not just the
 *      class name (the class alone doesn't prove the CSS actually shipped).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

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

// Same local-date recipe main/index.ts's resolveQuickSessionDir handler uses
// — the test needs to predict the SAME string to assert against.
function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
const TODAY = todayLocal();

function writeSettingsJson(userDataDir, quickProjectDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ settingsVersion: 1, quickProjectDir }, null, 2) + '\n',
    'utf8'
  );
}

/** Launch electron with a FRESH userData pointed at `quickProjectDir` as the quick-projects ROOT — deliberately WITHOUT SILVERBOX_TEST_PROJECT (that lever would override this entirely). */
async function launchWithQuickRoot(quickProjectDir, userDataDir) {
  writeSettingsJson(userDataDir, quickProjectDir);
  const env = { ...process.env, SILVERBOX_USER_DATA: userDataDir };
  delete env.SILVERBOX_TEST_PROJECT; // the pool always sets this — this script tests the OPPOSITE configuration
  return electron.launch({ args: [projectRoot], env });
}

const waitReadyOrIdle = (page) =>
  page.waitForFunction(
    () => {
      const s = window.__debug?.imageState();
      return s?.status === 'ready' || s?.status === 'error' || s?.status === 'idle';
    },
    { timeout: 120_000 }
  );
const waitReady = (page) =>
  page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

const openSingle = (page, path, opts) =>
  page.evaluate(({ p, o }) => void window.__openImageByPath(p, o), { p: path, o: opts });

/** Waits for BOTH the authoritative playlist count AND the (async-refreshed) DOM-backing folderEntries to agree on `n` — reading folderState() right after only projectState() settles is a race (refreshPlaylistStatus is a separate, later-resolving async round trip). */
async function waitForPlaylistCount(page, n, timeoutMs = 15_000) {
  await page.waitForFunction(
    (expected) => window.__debug.projectState().photoCount === expected && window.__debug.folderState().entries.length === expected,
    n,
    { timeout: timeoutMs }
  );
}

// ============================================================
// A1/A2/A4/B1/C/D — one continuous session in a fresh quick root
// ============================================================
console.log('verify-project3 (A1/A2/A4/B1/C/D — one continuous quick-project session):');

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-project3-work-'));
const quickRoot = mkdtempSync(join(tmpdir(), 'silverbox-project3-root-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'silverbox-project3-userdata-'));

function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
const P1 = fixture('a_p1.ARW');
const P2 = fixture('b_p2.ARW');
const P3 = fixture('c_p3.ARW');
const P4 = fixture('d_p4.ARW');
const P5 = fixture('e_p5.ARW');
const P6 = fixture('f_p6.ARW');
const P7 = fixture('g_p7.ARW');
const P8 = fixture('h_p8.ARW');

// A2's disambiguation setup: a subdir named `<date>a` ALREADY exists under
// `quickRoot` before the app ever launches (simulating an earlier session
// that used it) — resolveQuickSessionDir must skip straight to `<date>b`.
mkdirSync(join(quickRoot, `${TODAY}a`), { recursive: true });

const app1 = await launchWithQuickRoot(quickRoot, userDataDir);
try {
  const page = await app1.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // === A2 (disambiguation) + A1 (session creation, standalone open) + B1 (filmstrip on single open) ===
  await openSingle(page, P1);
  await waitReady(page);
  const afterP1 = await page.evaluate(() => ({
    project: window.__debug.projectState(),
    folder: window.__debug.folderState(),
    cellCount: document.querySelectorAll('[data-testid="filmstrip-cell"]').length,
  }));
  const expectedSessionDirB = join(quickRoot, `${TODAY}b`);
  check(
    'A2: an already-existing <date>a subdir is skipped — the fresh session mints <date>b',
    afterP1.project.dir === expectedSessionDirB,
    { expected: expectedSessionDirB, actual: afterP1.project.dir }
  );
  check('A1/A3: nothing was written directly to the root (no manifest there)', !existsSync(join(quickRoot, 'project.silverbox')), null);
  check('B1: a standalone single-file open shows the filmstrip (folderDir non-null)', afterP1.folder.dir !== null, afterP1.folder);
  check('B1: exactly 1 cell after the first single-file open', afterP1.cellCount === 1, afterP1);

  // === A1 (cont.): accumulation within the SAME session — more opens land in the SAME subdir ===
  await openSingle(page, P2, { keepFolderContext: true });
  await waitReady(page);
  await openSingle(page, P3, { keepFolderContext: true });
  await waitReady(page);
  await openSingle(page, P4, { keepFolderContext: true });
  await waitReady(page);
  const afterAccum = await page.evaluate(() => window.__debug.projectState());
  check('A1: accumulation stays in the SAME session dir', afterAccum.dir === expectedSessionDirB, afterAccum);
  check('A1: playlist accumulated to 4 photos', afterAccum.photoCount === 4, afterAccum);

  // === C1: remove a NON-current photo (P2) — playlist shrinks, current photo untouched, one undo entry restores it ===
  console.log('verify-project3 (C1 — remove a non-current photo, undo restores it, redo re-removes):');
  const beforeRemoveP2 = await page.evaluate(() => window.__debug.folderState().currentPath);
  await page.evaluate((p) => window.__debug.removeFromProject([p]), P2);
  await waitForPlaylistCount(page, 3);
  const afterRemoveP2 = await page.evaluate(() => ({
    project: window.__debug.projectState(),
    folder: window.__debug.folderState(),
    stack: window.__debug.undoStackState(),
  }));
  check('C1: playlist drops to 3', afterRemoveP2.project.photoCount === 3, afterRemoveP2.project);
  check('C1: P2 is gone from the strip', !afterRemoveP2.folder.entries.some((e) => e.path === P2), afterRemoveP2.folder);
  check('C1: the current photo (P4) is untouched', afterRemoveP2.folder.currentPath === beforeRemoveP2, afterRemoveP2.folder);
  check(
    'C1: top undo entry is a remove-photos batch of 1',
    afterRemoveP2.stack.undo.at(-1)?.kind === 'remove-photos' && afterRemoveP2.stack.undo.at(-1)?.removedCount === 1,
    afterRemoveP2.stack.undo.at(-1)
  );

  await page.keyboard.press('Meta+z');
  await waitForPlaylistCount(page, 4);
  const afterUndoP2 = await page.evaluate(() => ({ project: window.__debug.projectState(), folder: window.__debug.folderState() }));
  check('C1: undo restores P2 to the playlist (back to 4)', afterUndoP2.project.photoCount === 4, afterUndoP2.project);
  check('C1: undo restored P2 specifically', afterUndoP2.folder.entries.some((e) => e.path === P2), afterUndoP2.folder);
  check('C1: undo did not jump — P4 still current', afterUndoP2.folder.currentPath === beforeRemoveP2, afterUndoP2.folder);

  await page.keyboard.press('Meta+Shift+z');
  await waitForPlaylistCount(page, 3);
  const afterRedoP2 = await page.evaluate(() => window.__debug.projectState());
  check('C1: redo re-removes P2 (back to 3)', afterRedoP2.photoCount === 3, afterRedoP2);

  // === C6: the underlying photo FILE was never touched by any of the above ===
  check('C6: P2\'s own file on disk is untouched (never deleted/moved)', existsSync(P2), P2);

  // === C2: remove the CURRENTLY open photo (P4, last sorted) — jumps to nearest remaining neighbor (P3) ===
  console.log('verify-project3 (C2 — removing the current photo opens the nearest remaining neighbor):');
  await page.evaluate((p) => window.__debug.removeFromProject([p]), P4);
  await page.waitForFunction(() => window.__debug.imageState().status === 'ready', { timeout: 120_000 });
  const afterRemoveP4 = await page.evaluate(() => ({ project: window.__debug.projectState(), folder: window.__debug.folderState() }));
  check('C2: playlist drops to 2 (P1, P3 remain)', afterRemoveP4.project.photoCount === 2, afterRemoveP4.project);
  check('C2: the nearest remaining neighbor (P3) is now open', afterRemoveP4.folder.currentPath === P3, afterRemoveP4.folder);

  // === C3: remove EVERY remaining photo (including the current one) — falls to the empty state, project stays active ===
  console.log('verify-project3 (C3 — removing everything falls to the empty state, project stays active):');
  await page.evaluate((paths) => window.__debug.removeFromProject(paths), [P1, P3]);
  await page.waitForFunction(() => window.__debug.imageState().status === 'idle', { timeout: 15_000 });
  const afterRemoveAll = await page.evaluate(() => ({ project: window.__debug.projectState(), folder: window.__debug.folderState(), image: window.__debug.imageState() }));
  check('C3: playlist is empty', afterRemoveAll.project.photoCount === 0, afterRemoveAll.project);
  check('C3: the project itself is still active (folderDir non-null)', afterRemoveAll.folder.dir !== null, afterRemoveAll.folder);
  check('C3: the canvas falls to idle (no photo open)', afterRemoveAll.image.status === 'idle', afterRemoveAll.image);

  await page.keyboard.press('Meta+z');
  await page.waitForFunction((n) => window.__debug.projectState().photoCount === n, 2, { timeout: 15_000 });
  const afterUndoAll = await page.evaluate(() => ({ project: window.__debug.projectState(), image: window.__debug.imageState() }));
  check('C3: undo restores both rows (batch entry, no jump)', afterUndoAll.project.photoCount === 2, afterUndoAll.project);
  check('C3: undo does NOT auto-reopen anything (same "batch never jumps" shape as sync)', afterUndoAll.image.status === 'idle', afterUndoAll.image);

  // === C4: ⌫/Delete with 2+ selected removes the WHOLE selection as ONE undo entry ===
  console.log('verify-project3 (C4 — Delete key with 2+ selected removes the whole selection, one undo entry):');
  await openSingle(page, P5, { keepFolderContext: true });
  await waitReady(page);
  await openSingle(page, P6, { keepFolderContext: true });
  await waitReady(page);
  const stackBeforeDelete = await page.evaluate(() => window.__debug.undoStackState());
  await page.locator(`[data-testid="filmstrip-cell"][data-path="${P5}"]`).click({ modifiers: ['Meta'] });
  const selBeforeDelete = await page.evaluate(() => window.__debug.filmstripSelectionState());
  check('C4: P5 is now a secondary alongside the current P6', selBeforeDelete.primary === P6 && selBeforeDelete.secondary.includes(P5), selBeforeDelete);
  const photoCountBeforeDelete = (await page.evaluate(() => window.__debug.projectState())).photoCount;
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    (n) => window.__debug.undoStackState().undo.length === n,
    stackBeforeDelete.undo.length + 1,
    { timeout: 15_000 }
  );
  await waitForPlaylistCount(page, photoCountBeforeDelete - 2);
  const afterDelete = await page.evaluate(() => ({ project: window.__debug.projectState(), stack: window.__debug.undoStackState(), folder: window.__debug.folderState() }));
  check(
    'C4: exactly ONE new remove-photos entry, batching both P5 and P6',
    afterDelete.stack.undo.at(-1)?.kind === 'remove-photos' && afterDelete.stack.undo.at(-1)?.removedCount === 2,
    afterDelete.stack.undo.at(-1)
  );
  check('C4: both P5 and P6 are gone from the strip', !afterDelete.folder.entries.some((e) => e.path === P5 || e.path === P6), afterDelete.folder);

  // === C5/D1: cell context-menu "Remove from project" (real right-click) + secondary-selected CSS ===
  console.log('verify-project3 (C5 — cell context menu removes just that one photo; D1 — secondary-selected border color):');
  await openSingle(page, P7, { keepFolderContext: true });
  await waitReady(page);
  await openSingle(page, P8, { keepFolderContext: true });
  await waitReady(page);
  // D1 first (before P7's cell is removed by C5 below): ⌘-click P7 as a
  // secondary (P8 is current/primary) and read its COMPUTED border color —
  // proves the CSS actually shipped, not just the class name.
  await page.locator(`[data-testid="filmstrip-cell"][data-path="${P7}"]`).click({ modifiers: ['Meta'] });
  const borderColor = await page
    .locator(`[data-testid="filmstrip-cell"][data-path="${P7}"]`)
    .evaluate((el) => getComputedStyle(el).borderColor);
  check('D1: secondary-selected cell border is the new bright/distinct amber (not the old low-contrast blue)', borderColor === 'rgb(232, 178, 58)', borderColor);
  // Plain click collapses selection back to single before the context-menu check.
  await page.locator(`[data-testid="filmstrip-cell"][data-path="${P8}"]`).click();
  await waitReady(page);

  const projectPhotoCountBeforeMenu = (await page.evaluate(() => window.__debug.projectState())).photoCount;
  await page.locator(`[data-testid="filmstrip-cell"][data-path="${P7}"]`).click({ button: 'right' });
  await page.waitForSelector('[data-testid="filmstrip-cell-menu"]', { timeout: 5_000 });
  await page.locator('[data-testid="filmstrip-cell-menu"] [data-testid="filmstrip-remove-button"]').click();
  await waitForPlaylistCount(page, projectPhotoCountBeforeMenu - 1);
  const afterMenuRemove = await page.evaluate(() => ({ project: window.__debug.projectState(), folder: window.__debug.folderState() }));
  check('C5: the context-menu action removed exactly P7', !afterMenuRemove.folder.entries.some((e) => e.path === P7), afterMenuRemove.folder);
  check('C5: P8 (current, not part of the menu action) is untouched', afterMenuRemove.folder.currentPath === P8, afterMenuRemove.folder);
  check('C6 (cont.): P7\'s file is still on disk after removal', existsSync(P7), P7);

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // === A4: "New Project" — fresh dated subdir, empty playlist, old subdir left on disk untouched ===
  console.log('verify-project3 (A4 — New Project starts a fresh dated subdir with an empty playlist):');
  const oldSessionManifest = join(expectedSessionDirB, 'project.silverbox');
  const oldManifestBefore = existsSync(oldSessionManifest) ? readFileSync(oldSessionManifest, 'utf8') : null;
  await page.evaluate(() => window.__newProject());
  await waitReadyOrIdle(page);
  const afterNewProject = await page.evaluate(() => ({ project: window.__debug.projectState(), image: window.__debug.imageState(), folder: window.__debug.folderState() }));
  check('A4: no project active immediately after New Project', afterNewProject.project.dir === null, afterNewProject.project);
  check('A4: the canvas is idle', afterNewProject.image.status === 'idle', afterNewProject.image);
  check('A4: the filmstrip is hidden (no project active)', afterNewProject.folder.dir === null, afterNewProject.folder);

  await openSingle(page, fixture('i_afternewproject.ARW'));
  await waitReady(page);
  const afterNewProjectOpen = await page.evaluate(() => window.__debug.projectState());
  const expectedSessionDirC = join(quickRoot, `${TODAY}c`);
  check('A4: the NEXT photo open mints yet another fresh dated subdir', afterNewProjectOpen.dir === expectedSessionDirC, { expected: expectedSessionDirC, actual: afterNewProjectOpen.dir });
  check('A4: that new session starts with an EMPTY-then-1 playlist (not inheriting the old session)', afterNewProjectOpen.photoCount === 1, afterNewProjectOpen);
  check(
    'A4: the OLD session subdir is left on disk, untouched (its manifest unchanged)',
    existsSync(oldSessionManifest) && readFileSync(oldSessionManifest, 'utf8') === oldManifestBefore,
    { oldSessionManifest }
  );

  check('no page errors across the whole session', pageErrors.length === 0, pageErrors);
} finally {
  await app1.close();
}
rmSync(workDir, { recursive: true, force: true });
rmSync(quickRoot, { recursive: true, force: true });
rmSync(userDataDir, { recursive: true, force: true });

// ============================================================
// A3 — legacy project.silverbox sitting directly in the root: untouched, still openable
// ============================================================
console.log('verify-project3 (A3 — a legacy project.silverbox in the root is untouched, still openable):');

const legacyRoot = mkdtempSync(join(tmpdir(), 'silverbox-project3-legacy-'));
const legacyUserData = mkdtempSync(join(tmpdir(), 'silverbox-project3-legacy-userdata-'));
const legacyWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-project3-legacy-work-'));
const legacyPhoto = join(legacyWorkDir, 'legacy_photo.ARW');
linkSync(ARW_PATH, legacyPhoto);
const legacyManifestText = JSON.stringify(
  { schemaVersion: 1, name: 'Legacy Quick', photos: [{ path: legacyPhoto, look: 'legacy_photo.ARW.json' }] },
  null,
  2
) + '\n';
writeFileSync(join(legacyRoot, 'project.silverbox'), legacyManifestText, 'utf8');

const app2 = await launchWithQuickRoot(legacyRoot, legacyUserData);
try {
  const page = await app2.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const freshPhoto = join(legacyWorkDir, 'fresh_after_legacy.ARW');
  linkSync(ARW_PATH, freshPhoto);
  await openSingle(page, freshPhoto);
  await waitReady(page);
  const afterFreshOpen = await page.evaluate(() => window.__debug.projectState());
  const expectedLegacySessionDir = join(legacyRoot, `${TODAY}a`);
  check(
    'A3: a fresh session under a legacy-manifest root mints its OWN dated subdir, not the root itself',
    afterFreshOpen.dir === expectedLegacySessionDir,
    { expected: expectedLegacySessionDir, actual: afterFreshOpen.dir }
  );
  check(
    'A3: the legacy manifest sitting in the root is byte-for-byte untouched',
    readFileSync(join(legacyRoot, 'project.silverbox'), 'utf8') === legacyManifestText,
    null
  );

  const opened = await page.evaluate((dir) => window.__openProjectByPath(dir).then(() => window.__debug.projectState()), legacyRoot);
  check('A3: the legacy root is still openable as an ordinary project', opened.dir === legacyRoot && opened.name === 'Legacy Quick', opened);
  check('A3: it shows the legacy manifest\'s own original photo', opened.photoCount === 1, opened);
} finally {
  await app2.close();
}
rmSync(legacyRoot, { recursive: true, force: true });
rmSync(legacyUserData, { recursive: true, force: true });
rmSync(legacyWorkDir, { recursive: true, force: true });

// ============================================================
// A5 — testFlags.projectDirOverride still wins outright, used EXACTLY as given
// ============================================================
console.log('verify-project3 (A5 — SILVERBOX_TEST_PROJECT still pins the dir exactly, no subdir):');

const overrideDir = mkdtempSync(join(tmpdir(), 'silverbox-project3-override-'));
const overrideUserData = mkdtempSync(join(tmpdir(), 'silverbox-project3-override-userdata-'));
const overrideWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-project3-override-work-'));
mkdirSync(join(overrideDir, 'looks'), { recursive: true });
const overridePhoto = join(overrideWorkDir, 'override_photo.ARW');
linkSync(ARW_PATH, overridePhoto);

const app3 = await electron.launch({
  args: [projectRoot],
  env: { ...process.env, SILVERBOX_USER_DATA: overrideUserData, SILVERBOX_TEST_PROJECT: overrideDir },
});
try {
  const page = await app3.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  await openSingle(page, overridePhoto);
  await waitReady(page);
  const state = await page.evaluate(() => window.__debug.projectState());
  check('A5: projectDirOverride is used EXACTLY as given — no dated subdir appended', state.dir === overrideDir, { expected: overrideDir, actual: state.dir });
} finally {
  await app3.close();
}
rmSync(overrideDir, { recursive: true, force: true });
rmSync(overrideUserData, { recursive: true, force: true });
rmSync(overrideWorkDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
