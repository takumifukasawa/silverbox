/**
 * Pick/reject flag verify (docs/brief-bank/reject-flag.md): `flag: 'pick' |
 * 'reject'` lives on the sidecar WRAPPER (metadata about the PHOTO, next to
 * `rating`) — an axis independent of rating (rejecting a photo never clears
 * its stars, and vice versa). LR muscle memory keys `p`/`x`/`u` (pick/reject/
 * unflag) act on the CANVAS photo only (multi-select flagging is deferred
 * until multi-select itself exists — see the brief's scope note); the
 * underlying store action (`setFlag`) takes an EXPLICIT look path rather than
 * reaching for "the current photo" internally, so a later multi-select
 * fan-out can call it per selected photo without any change to its
 * signature — section 6 below exercises exactly that seam directly. Global-
 * undo (docs/brief-bank/global-undo.md, decision 2) put flag IN the undoable
 * scope for the CANVAS-photo path: setFlag pushes a `'flag'` entry onto the
 * SAME global stack every graph edit uses — this supersedes an earlier
 * "flags never undo" contract this file used to check.
 *
 * Checks:
 *  1. A fresh open (no sidecar) is unflagged (null), sidecarState() reflects
 *     it — p/x/u were audited against the round-8-13 keyboard map (App.tsx's
 *     own doc comment on the p/x/u handler) before landing, so this script
 *     doesn't re-litigate that; it exercises the bindings themselves.
 *  2. p/x/u set/clear the flag; marks graphDirty AND pushes exactly one undo
 *     entry per real change (global-undo decision 2 — see appStore.ts's
 *     setFlag); independent of rating (setting a rating doesn't touch the
 *     flag and vice versa, and rejecting doesn't clear the rating).
 *  2b. Toolbar flag glyph (UX pack, hand-test 2026-07-17 item 3): reflects
 *     none/pick/reject next to the rating stars, and clicking it cycles
 *     none→pick→reject→none (the same setFlag call p/x/u drive) — each click
 *     is its own undo entry too, same as the keys.
 *  3. isTextEntry guards it: a focused text input swallows p/x/u.
 *  4. Autosave writes it to disk (absent when unflagged — identity-omission,
 *     never a written `flag: null`); it survives a fresh reopen; an explicit
 *     ⌘S also persists a flag-only change.
 *  5. Hot-reload: an external sidecar edit that changes ONLY `flag` still
 *     auto-reloads on a clean session.
 *  6. The "not hardwired to current photo" seam: appStore's setFlag, called
 *     with an EXPLICIT look path that is NOT the open canvas photo, flags
 *     that OTHER photo directly on disk (creating a fresh minimal look when
 *     none exists yet, preserving an existing look's other fields when one
 *     does) — without touching the canvas photo's own in-memory flag at all.
 *  7. Filmstrip: rejected cells dim their thumbnail + show a ⨯ glyph, picks
 *     show a ⚑ glyph; the flag filter's three segments (All/Hide rejected/
 *     Picks only) compose by AND with the pre-existing ★n+ filter.
 *  8. Old sidecars with no `flag` key at all still parse (schemaVersion 4,
 *     unrelated to this pack, asserted once for completeness).
 *  9. Headless CLI `--skip-rejected`: skips flagged-reject inputs for BOTH
 *     `--render` and `--check` (unlike `--min-rating`, which `--check`
 *     rejects outright) as `{input,status:"skipped-rejected"}`, NEVER as a
 *     failure; its ABSENCE changes nothing (an existing script's output must
 *     not change just because a user flagged photos in the GUI); rejected
 *     together with `--diff`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, resetTestProject, writeLookFixture } from './lib/testProject.mjs';

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

// === Fixtures: one hardlink for the app-driven checks (sections 1-5) ===
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-flags-'));
const arwMain = join(workDir, 'flags-main.ARW');
linkSync(ARW_PATH, arwMain);
// project-storage migration: an interactive open's flag lives in the active
// test project's looks/, not next to the photo — see
// scripts/lib/testProject.mjs's doc comment for the no-collision assumption
// this basename-keyed path relies on (arwMain's basename is unique here).
const sidecarMain = lookPathFor(arwMain);

/** Atomic external rewrite (verify-hotreload.mjs's own atomicWrite pattern) — simulates an AI/editor touching the sidecar out from under the running app. */
function atomicWrite(path, content) {
  const tmp = `${path}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function externalWriteFlag(flag) {
  const doc = JSON.parse(readFileSync(sidecarMain, 'utf8'));
  if (flag) doc.flag = flag;
  else delete doc.flag;
  atomicWrite(sidecarMain, JSON.stringify(doc, null, 2) + '\n');
}

function readDiskFlag(path = sidecarMain) {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc.flag === 'pick' || doc.flag === 'reject' ? doc.flag : null;
  } catch {
    return null;
  }
}

/**
 * Poll the FILE's own parsed content, never `graphDirty === false` alone: a
 * fresh/already-clean doc's graphDirty is ALREADY false before any write
 * happens, so waiting on that flag races the async sidecar write (see
 * verify-filmstrip.mjs's own fix for this exact class of bug, reused by
 * verify-ratings.mjs). Polling what autosave actually produces on disk has
 * no such race.
 */
async function waitForDiskFlag(expected, path = sidecarMain, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readDiskFlag(path) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** schemaVersion-4 wire wrapper carrying `rating`/`flag` — the exact shape serializeGraphDoc writes (graphDoc.ts). */
function wrapper({ rating = 0, flag } = {}) {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(rating > 0 ? { rating } : {}),
    ...(flag ? { flag } : {}),
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  };
}

/**
 * CLI fixture (section 8 ONLY): the headless `--render`/`--check
 * --skip-rejected` CLI still reads the LEGACY adjacent sidecar
 * (`legacySidecarOnly` in appStore.ts's openImageByPath — project-aware CLI
 * resolution is a stage-2 item, same known limitation `--min-rating`'s own
 * verify-ratings.mjs already documents), so this fixture must stay next to
 * the image, unlike every interactive-open fixture in this file.
 */
function writeFlagSidecar(path, flag) {
  writeFileSync(path + '.silverbox.json', JSON.stringify(wrapper({ flag }), null, 2) + '\n');
}

/** Interactive-open fixture (section 6, the filmstrip test): lands in the active project's looks/, matching what a real folder-open + look read actually does. */
function writeFlagLook(path, opts) {
  writeLookFixture(path, wrapper(opts));
}

function cleanupMain() {
  if (existsSync(sidecarMain)) unlinkSync(sidecarMain);
  rmSync(workDir, { recursive: true, force: true });
}

const app = await electron.launch({ args: [projectRoot] });
let folderDir = null;
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
  const openImageFireAndForget = (path) =>
    page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);

  const flagState = () => page.evaluate(() => window.__debug.sidecarState().flag);
  const ratingState = () => page.evaluate(() => window.__debug.sidecarState().rating);
  const dirty = () => page.evaluate(() => window.__debug.graphDirty());
  const historyState = () => page.evaluate(() => window.__debug.historyState());
  const hotReload = () => page.evaluate(() => window.__debug.hotReloadState());
  const currentLookPath = () => page.evaluate(() => window.__debug.projectState().currentLookPath);

  await openImageFireAndForget(arwMain);
  await waitReadyOrError();
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  // === 1. Fresh open is unflagged ===
  console.log('verify-flags (1. a fresh open — no sidecar — is unflagged):');
  check('fresh open has flag null', (await flagState()) === null, await flagState());

  // === 2. p/x/u set/clear the flag; marks dirty; ONE undo entry per change; independent of rating ===
  console.log('verify-flags (2. p/x/u set/clear the flag; marks the doc dirty; each change is its own undo entry; independent of rating):');
  const histBefore = await historyState();
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'pick', { timeout: 5_000 });
  check('pressing p sets flag to pick', (await flagState()) === 'pick', await flagState());
  check('flag edit marks graphDirty', (await dirty()) === true, await dirty());

  await page.keyboard.press('x');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'reject', { timeout: 5_000 });
  check('pressing x changes flag to reject', (await flagState()) === 'reject', await flagState());

  await page.keyboard.press('u');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  check('pressing u clears the flag', (await flagState()) === null, await flagState());

  const histAfterFlagEdits = await historyState();
  check(
    // Global-undo (docs/brief-bank/global-undo.md, decision 2): flag is now
    // IN the undoable scope — each of the 3 real changes above (pick, reject,
    // unflag) pushes its own 'flag' undo entry (supersedes the old "flags
    // never undo" contract this check used to assert the opposite of).
    'each of the 3 flag edits above pushed its own undo entry',
    histAfterFlagEdits.past === histBefore.past + 3 && histAfterFlagEdits.future === 0,
    { histBefore, histAfterFlagEdits }
  );

  // Independent axes (LR-consistent): rejecting doesn't touch rating, rating doesn't touch flag.
  await page.keyboard.press('3');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 3, { timeout: 5_000 });
  await page.keyboard.press('x');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'reject', { timeout: 5_000 });
  check('rejecting a photo does not clear its rating', (await ratingState()) === 3, await ratingState());
  await page.keyboard.press('0');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 0, { timeout: 5_000 });
  check('clearing the rating does not clear the flag', (await flagState()) === 'reject', await flagState());

  // === 2b. Toolbar flag glyph — reflects state, click cycles none→pick→reject→none ===
  console.log('verify-flags (2b. the toolbar flag glyph reflects state and its click cycles pick/reject/none):');
  const toolbarFlagAttr = () => page.$eval('[data-testid="toolbar-flag"]', (el) => el.dataset.flag);
  check('toolbar flag glyph shows "reject" (state carried over from the p/x/u checks above)', (await toolbarFlagAttr()) === 'reject', await toolbarFlagAttr());

  await page.keyboard.press('u');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  check('toolbar flag glyph shows "none" once unflagged', (await toolbarFlagAttr()) === 'none', await toolbarFlagAttr());

  const histBeforeToolbarFlag = await historyState();
  await page.locator('[data-testid="toolbar-flag"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'pick', { timeout: 5_000 });
  check('clicking the toolbar flag glyph (none) sets pick', (await flagState()) === 'pick', await flagState());
  check('toolbar reflects pick after the click', (await toolbarFlagAttr()) === 'pick', await toolbarFlagAttr());

  await page.locator('[data-testid="toolbar-flag"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'reject', { timeout: 5_000 });
  check('clicking again (pick) advances to reject', (await flagState()) === 'reject', await flagState());
  check('toolbar reflects reject after the click', (await toolbarFlagAttr()) === 'reject', await toolbarFlagAttr());

  await page.locator('[data-testid="toolbar-flag"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  check('clicking again (reject) cycles back to none', (await flagState()) === null, await flagState());
  check('toolbar reflects none after the click', (await toolbarFlagAttr()) === 'none', await toolbarFlagAttr());

  const histAfterToolbarFlag = await historyState();
  check(
    'each toolbar flag click pushed its own undo entry too (same undoable-metadata semantics as p/x/u — global-undo decision 2)',
    histAfterToolbarFlag.past === histBeforeToolbarFlag.past + 3 && histAfterToolbarFlag.future === 0,
    { histBeforeToolbarFlag, histAfterToolbarFlag }
  );

  // restore 'reject' for the sections below, which assume it (via the 'x'
  // key rather than another toolbar click — keeps both input paths exercised
  // across the file, same as verify-ratings.mjs's own 2b does).
  await page.keyboard.press('x');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'reject', { timeout: 5_000 });

  // === 3. isTextEntry guard ===
  console.log('verify-flags (3. p/x/u are ignored while a text input is focused):');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-testid', 'flags-verify-text-probe');
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('flag unaffected while a text input is focused', (await flagState()) === 'reject', await flagState());
  await page.evaluate(() => document.querySelector('[data-testid="flags-verify-text-probe"]')?.remove());

  // === 4. Autosave persists it; survives reopen; explicit ⌘S also persists it ===
  console.log('verify-flags (4. autosave writes the flag to disk; survives a fresh reopen; ⌘S also persists it):');
  check('autosave eventually writes flag "reject" to disk', await waitForDiskFlag('reject'), readDiskFlag());

  await openImageFireAndForget(arwMain);
  await waitReadyOrError();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'reject', { timeout: 10_000 });
  check('flag survives a fresh reopen (restored from the sidecar)', (await flagState()) === 'reject', await flagState());

  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'pick', { timeout: 5_000 });
  check('graphDirty true right after a flag-only edit', (await dirty()) === true, await dirty());
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('flag "pick" is on disk right after an explicit ⌘S', readDiskFlag() === 'pick', readDiskFlag());

  await page.keyboard.press('u');
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const rawAfterUnflag = JSON.parse(readFileSync(sidecarMain, 'utf8'));
  check(
    'clearing the flag omits the key entirely on disk (identity-omission, never `flag: null`)',
    !('flag' in rawAfterUnflag),
    rawAfterUnflag
  );

  // === 5. Hot-reload: an external flag-only edit auto-reloads on a clean session ===
  console.log('verify-flags (5. hot-reload: an external flag-only edit auto-reloads on a clean session):');
  check('session is clean before the external edit', (await dirty()) === false, await dirty());
  const histBeforeHotReload = await historyState();
  externalWriteFlag('pick');
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'reloaded', { timeout: 5_000 });
  check('flag updates from the external, flag-only edit', (await flagState()) === 'pick', await flagState());
  const histAfterHotReload = await historyState();
  check(
    'the hot-reload itself is still exactly ONE history entry (the whole-graph swap every hot-reload does — not special to flags)',
    histAfterHotReload.past === histBeforeHotReload.past + 1,
    { histBeforeHotReload, histAfterHotReload }
  );

  // === 6. The "not hardwired to current photo" seam: setFlag on an EXPLICIT
  // look path that is NOT the open canvas photo ===
  console.log('verify-flags (6. setFlag takes an explicit look path — the seam a future multi-select fan-out will use):');
  const otherArw = join(workDir, 'flags-other.ARW');
  linkSync(ARW_PATH, otherArw);
  const otherLookPath = lookPathFor(otherArw);
  check('the other photo has no look yet', !existsSync(otherLookPath), otherLookPath);

  const myLookPath = await currentLookPath();
  const flagBeforeOtherWrite = await flagState();
  // page.evaluate awaits the returned Promise itself (setFlag's disk
  // read-patch-write is real IPC round trips) — no separate settle wait
  // needed, the write is done by the time this resolves.
  await page.evaluate((p) => window.__debug.setFlag(p, 'reject'), otherLookPath);
  check(
    'setFlag on a DIFFERENT look path creates a fresh minimal look carrying just the flag',
    readDiskFlag(otherLookPath) === 'reject',
    readDiskFlag(otherLookPath)
  );
  check(
    "the canvas photo's own in-memory flag is untouched by flagging a DIFFERENT photo",
    (await flagState()) === flagBeforeOtherWrite,
    { before: flagBeforeOtherWrite, after: await flagState() }
  );
  check("the canvas photo's own look path is unaffected too", (await currentLookPath()) === myLookPath, await currentLookPath());

  // Re-flagging that SAME other look (now that it exists) preserves its other fields.
  const otherDocBefore = JSON.parse(readFileSync(otherLookPath, 'utf8'));
  await page.evaluate((p) => window.__debug.setFlag(p, 'pick'), otherLookPath);
  const otherDocAfter = JSON.parse(readFileSync(otherLookPath, 'utf8'));
  check('re-flagging an EXISTING look changes only `flag`', otherDocAfter.flag === 'pick', otherDocAfter.flag);
  check(
    'the rest of that look (createdAt) survives the re-flag untouched',
    otherDocAfter.createdAt === otherDocBefore.createdAt,
    { before: otherDocBefore.createdAt, after: otherDocAfter.createdAt }
  );

  check('no page errors across the app-driven sections', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

cleanupMain();

// === 7. Filmstrip: dim + glyph per flag, the flag filter composes with ★n+ ===
//
// Project-storage migration: the playlist ACCUMULATES across opens within
// one session — a fresh app + resetTestProject() wipe gives this section its
// own clean playlist, exactly like verify-ratings.mjs's own section 6.
console.log('verify-flags (7. filmstrip: dimmed/glyphed cells per flag + the flag filter, composing with ★n+):');
resetTestProject();
folderDir = mkdtempSync(join(tmpdir(), 'silverbox-flags-folder-'));
const cellUnflagged = join(folderDir, 'a_unflagged.ARW');
const cellPickLow = join(folderDir, 'b_pick_low.ARW'); // pick, rating 2
const cellPickHigh = join(folderDir, 'c_pick_high.ARW'); // pick, rating 4
const cellReject = join(folderDir, 'd_reject.ARW'); // reject, rating 4 (still keeps its stars — independent axes)
linkSync(ARW_PATH, cellUnflagged);
linkSync(ARW_PATH, cellPickLow);
linkSync(ARW_PATH, cellPickHigh);
linkSync(ARW_PATH, cellReject);
writeFlagLook(cellPickLow, { flag: 'pick', rating: 2 });
writeFlagLook(cellPickHigh, { flag: 'pick', rating: 4 });
writeFlagLook(cellReject, { flag: 'reject', rating: 4 });

const folderApp = await electron.launch({ args: [projectRoot] });
try {
  const page = await folderApp.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  const openFolderFireAndForget = (dir) =>
    page.evaluate((d) => {
      void window.__openFolderByPath(d);
    }, dir);

  await openFolderFireAndForget(folderDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    cellUnflagged,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, {
    timeout: 15_000,
  });
  // Thumbnails load lazily (IntersectionObserver, thumbnailCache.ts) — the
  // dimming check below reads the thumbnail's OWN class, so it must wait for
  // the <img> to actually mount first (verify-filmstrip.mjs's own precedent),
  // not just the cell count above.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-thumb"]').length === 4, {
    timeout: 15_000,
  });

  const folderFlags = await page.evaluate(() =>
    window.__debug.folderState().entries.map((e) => ({ path: e.path, flag: e.flag, rating: e.rating }))
  );
  check(
    "the project's per-photo look read reports the right flag for each entry (unflagged = null)",
    folderFlags.find((e) => e.path === cellUnflagged)?.flag === null &&
      folderFlags.find((e) => e.path === cellPickLow)?.flag === 'pick' &&
      folderFlags.find((e) => e.path === cellPickHigh)?.flag === 'pick' &&
      folderFlags.find((e) => e.path === cellReject)?.flag === 'reject',
    folderFlags
  );
  check(
    "the rejected cell's own RATING still comes through (independent axes — rejecting doesn't hide the rating read)",
    folderFlags.find((e) => e.path === cellReject)?.rating === 4,
    folderFlags
  );

  const cellDom = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="filmstrip-cell"]')].map((c) => {
      const flagEl = c.querySelector('[data-testid="filmstrip-flag"]');
      const thumbEl = c.querySelector('[data-testid="filmstrip-thumb"]');
      return {
        path: c.dataset.path,
        flag: flagEl?.dataset.flag ?? null,
        glyph: flagEl?.textContent ?? '',
        thumbDimmed: thumbEl?.classList.contains('filmstrip-thumb--rejected') ?? false,
      };
    })
  );
  check('the unflagged cell shows no flag glyph at all', cellDom.find((c) => c.path === cellUnflagged)?.flag === null, cellDom);
  check(
    'a picked cell shows the pick glyph, not dimmed',
    cellDom.find((c) => c.path === cellPickHigh)?.flag === 'pick' &&
      cellDom.find((c) => c.path === cellPickHigh)?.glyph === '⚑' &&
      cellDom.find((c) => c.path === cellPickHigh)?.thumbDimmed === false,
    cellDom
  );
  check(
    'a rejected cell shows the reject glyph AND its thumbnail is dimmed (opacity class on the thumb, not the cell border)',
    cellDom.find((c) => c.path === cellReject)?.flag === 'reject' &&
      cellDom.find((c) => c.path === cellReject)?.glyph === '⨯' &&
      cellDom.find((c) => c.path === cellReject)?.thumbDimmed === true,
    cellDom
  );

  // Flag filter alone: "Hide rejected" removes exactly the rejected cell.
  const flagFilterSelect = page.locator('[data-testid="filmstrip-flag-filter"]');
  await flagFilterSelect.selectOption('hideRejected');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 3, {
    timeout: 5_000,
  });
  const hideRejectedPaths = (await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path))).sort();
  check(
    '"Hide rejected" narrows the strip to the 3 non-rejected cells',
    JSON.stringify(hideRejectedPaths) === JSON.stringify([cellUnflagged, cellPickLow, cellPickHigh].sort()),
    hideRejectedPaths
  );

  // Flag filter alone: "Picks only" shows exactly the 2 picked cells.
  await flagFilterSelect.selectOption('picksOnly');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 2, {
    timeout: 5_000,
  });
  const picksOnlyPaths = (await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path))).sort();
  check(
    '"Picks only" narrows the strip to the 2 picked cells',
    JSON.stringify(picksOnlyPaths) === JSON.stringify([cellPickLow, cellPickHigh].sort()),
    picksOnlyPaths
  );

  // Composition (AND) with the pre-existing ★n+ filter: "Picks only" + ★3+ narrows further to just the 4-star pick.
  const ratingFilterSelect = page.locator('[data-testid="filmstrip-rating-filter"]');
  await ratingFilterSelect.selectOption('3');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 1, {
    timeout: 5_000,
  });
  const composedPaths = await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path));
  check(
    '"Picks only" AND "★3+" compose: only the 4-star pick remains (the 2-star pick is filtered out by rating)',
    JSON.stringify(composedPaths) === JSON.stringify([cellPickHigh]),
    composedPaths
  );

  // Back to "All"/"All" shows every cell again.
  await ratingFilterSelect.selectOption('0');
  await flagFilterSelect.selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, {
    timeout: 5_000,
  });
  check('back to "All"/"All" shows every cell again', true, null);
} finally {
  await folderApp.close();
}

if (folderDir) rmSync(folderDir, { recursive: true, force: true });
resetTestProject();

// === 8. Old sidecars with no `flag` key parse fine (unrelated to this pack, asserted once) ===
console.log('verify-flags (8. a schemaVersion-4 sidecar with no `flag` key parses fine):');
const noFlagWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-flags-legacy-'));
try {
  const legacyArw = join(noFlagWorkDir, 'legacy.ARW');
  linkSync(ARW_PATH, legacyArw);
  writeFlagSidecar(legacyArw, undefined); // no `flag` key at all
  const raw = JSON.parse(readFileSync(legacyArw + '.silverbox.json', 'utf8'));
  check('the fixture sidecar genuinely has no `flag` key', !('flag' in raw), raw);

  const legacyApp = await electron.launch({ args: [projectRoot] });
  try {
    const page = await legacyApp.firstWindow();
    await page.waitForSelector('.app-layout', { timeout: 15_000 });
    await page.evaluate((p) => {
      void window.__openImageByPath(p, { keepFolderContext: false });
    }, legacyArw);
    await page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );
    const status = await page.evaluate(() => window.__debug.imageState().status);
    check('a flag-less legacy sidecar still opens cleanly', status === 'ready', status);
    const flag = await page.evaluate(() => window.__debug.sidecarState().flag);
    check('its flag reads back as null (absent, not a parse error)', flag === null, flag);
  } finally {
    await legacyApp.close();
  }
} finally {
  rmSync(noFlagWorkDir, { recursive: true, force: true });
}

// === 9. Headless CLI --skip-rejected: skips flagged-reject inputs for both
// --render and --check, never as a failure; its absence changes nothing ===
console.log('verify-flags (9. CLI --skip-rejected skips rejected inputs for --render AND --check, without failing the batch):');
const cliWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-flags-cli-'));
const cliOutDir = join(cliWorkDir, 'out');
mkdirSync(cliOutDir, { recursive: true });
const ownCliUserData = !process.env.SILVERBOX_USER_DATA;
const cliUserData = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-flags-cli-userdata-'));
const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

function cliLink(name) {
  const dst = join(cliWorkDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}

function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: cliUserData },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function expectedOutPath(inputPath, dir) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, '');
  return join(dir, `${stem}.jpg`);
}

try {
  const cliRejected = cliLink('cli-rejected.ARW');
  const cliPicked = cliLink('cli-picked.ARW');
  const cliUnflagged = cliLink('cli-unflagged.ARW'); // no sidecar at all
  writeFlagSidecar(cliRejected, 'reject');
  writeFlagSidecar(cliPicked, 'pick');

  // --- 9a. --render --skip-rejected ---
  const r9a = runCli(['--out', cliOutDir, '--skip-rejected', '--json', cliRejected, cliPicked, cliUnflagged]);
  check('a batch with one reject skip + two normal renders exits 0', r9a.status === 0, {
    status: r9a.status,
    stdout: r9a.stdout,
    stderr: r9a.stderr,
  });
  check('the rejected image is skipped — no output file', !existsSync(expectedOutPath(cliRejected, cliOutDir)), expectedOutPath(cliRejected, cliOutDir));
  check('the picked image renders normally', existsSync(expectedOutPath(cliPicked, cliOutDir)), expectedOutPath(cliPicked, cliOutDir));
  check('the unflagged image renders normally too', existsSync(expectedOutPath(cliUnflagged, cliOutDir)), expectedOutPath(cliUnflagged, cliOutDir));

  const jsonLines9a = r9a.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  check('every NDJSON line parses', jsonLines9a.every((l) => l !== null), r9a.stdout);
  const skipRejected9a = jsonLines9a.find((l) => l?.input === cliRejected);
  check('NDJSON reports the rejected input as {status:"skipped-rejected"}', skipRejected9a?.status === 'skipped-rejected', skipRejected9a);

  const r9aHuman = runCli(['--out', cliOutDir, '--skip-rejected', cliRejected, cliPicked]);
  check(
    'human mode prints a SKIPPED line (not an ERROR) for the rejected input, exit 0',
    r9aHuman.status === 0 && /SKIPPED \(rejected\)/.test(r9aHuman.stdout) && !/ERROR/.test(r9aHuman.stdout),
    { status: r9aHuman.status, stdout: r9aHuman.stdout }
  );

  // --- 9b. Absence changes nothing: without --skip-rejected, the rejected input renders like any other ---
  const r9b = runCli(['--out', cliOutDir, cliRejected]);
  check(
    "without --skip-rejected, a rejected input renders exactly like an unflagged one — flagging in the GUI never silently changes an existing script's output",
    r9b.status === 0 && existsSync(expectedOutPath(cliRejected, cliOutDir)),
    { status: r9b.status, stdout: r9b.stdout }
  );

  // --- 9c. --check --skip-rejected: applies to golden checks too (unlike --min-rating, which --check rejects outright) ---
  const cliCheckRejected = cliLink('cli-check-rejected.ARW');
  writeFlagSidecar(cliCheckRejected, 'reject');
  const r9c = runCli(['--check', '--skip-rejected', '--json', cliCheckRejected]);
  check('--check --skip-rejected is accepted (unlike --min-rating) and exits 0 for a rejected-only batch', r9c.status === 0, {
    status: r9c.status,
    stdout: r9c.stdout,
    stderr: r9c.stderr,
  });
  const jsonLine9c = r9c.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))[0];
  check('--check reports the rejected input as {status:"skipped-rejected"} too, never a failure', jsonLine9c?.status === 'skipped-rejected', jsonLine9c);

  // Without --skip-rejected, that SAME input has no golden yet — a genuine FAILURE, proving the skip precedes (and is independent of) the golden-check machinery.
  const r9cNoSkip = runCli(['--check', cliCheckRejected]);
  check(
    "without --skip-rejected, the same rejected-but-golden-less input is a genuine FAILURE (no-golden) — the skip is opt-in, not automatic",
    r9cNoSkip.status === 1,
    { status: r9cNoSkip.status, stdout: r9cNoSkip.stdout }
  );

  // --- 9d. rejected together with --diff ---
  const rBadDiff = runCli(['--diff', cliPicked, cliRejected, '--image', cliPicked, '--skip-rejected']);
  check('--skip-rejected is rejected together with --diff (exit 2)', rBadDiff.status === 2, rBadDiff);
} finally {
  rmSync(cliWorkDir, { recursive: true, force: true });
  if (ownCliUserData) rmSync(cliUserData, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
