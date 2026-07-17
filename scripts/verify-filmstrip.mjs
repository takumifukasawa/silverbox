/**
 * Folder filmstrip verify (ROADMAP "nice to have" — browse a folder, NOT a
 * catalog): open a folder → a thumbnail strip appears below the canvas →
 * click a cell (or ←/→) to switch images. Post-project-storage-migration
 * (stage 1), the strip renders the active PROJECT's whole PLAYLIST, which
 * ACCUMULATES across folder opens within one session (a playlist doesn't
 * own photos — filmstrip-curation.md) — every count/order assertion below
 * accounts for that running total instead of assuming "just this folder".
 *
 * Fixture: a temp folder with 3 hardlinked ARW copies under distinct names
 * (a_DSC1/b_DSC2/c_DSC3 — sorted order matters) + 1 hardlinked JPG
 * (d_DSC4), plus a second temp folder (e_DSC5/f_DSC6) for the folder-switch
 * check. Hardlinks are the suite's own isolation trick (see run-verify.mjs).
 * One file (b_DSC2.ARW) gets a real look, written by opening it and
 * clicking Save (not hand-authored JSON — same as an ordinary session).
 *
 * Checks:
 *  1. openFolder(dir) via the __openFolderByPath debug hook (dialogs are
 *     untestable — real drop/toolbar paths funnel through the same store
 *     action): the strip shows exactly 4 cells, sorted by filename, and the
 *     FIRST (sorted) image is the one that's open.
 *  2. Thumbnails materialize (lazily, via IntersectionObserver) for the
 *     visible cells — with only 4 cells, all of them should load.
 *  3. b_DSC2's cell (and only that one) shows the "edited" dot; a_DSC1's
 *     cell (the current image) is highlighted.
 *  4. Clicking cell 3 (c_DSC3) opens it and moves the highlight; ←/→ then
 *     step next/prev; arrow keys do nothing while a text input is focused.
 *  5. Switching to a SECOND folder EXTENDS the playlist (project-storage
 *     migration): the strip now shows all 6 accumulated cells (folder A's 4
 *     + folder B's 2), and folder B's own first (sorted) image opens.
 *  6. A single-file open (the same debug hook every other script uses)
 *     shows no strip at all — folder context is cleared.
 *  7. Multi-file DROP (UX pack, hand-test 2026-07-17 item 1), driven via a
 *     CDP-synthesized OS drag (verify-dnd.mjs's own dispatch mechanism, not
 *     a debug hook — this exercises the real drop path end to end): dropping
 *     2 fresh files adds BOTH to the active project's playlist (exact +2,
 *     against the authoritative projectState().photoCount, since the strip
 *     was hidden — 0 DOM cells — right before this from check 6), shows the
 *     filmstrip, and opens the FIRST dropped file.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
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

// --- fixtures: two temp folders of hardlinks (same trick run-verify.mjs's own isolation uses) ---
const folderA = mkdtempSync(join(tmpdir(), 'silverbox-filmstrip-a-'));
const folderB = mkdtempSync(join(tmpdir(), 'silverbox-filmstrip-b-'));
const aDsc1 = join(folderA, 'a_DSC1.ARW');
const bDsc2 = join(folderA, 'b_DSC2.ARW');
const cDsc3 = join(folderA, 'c_DSC3.ARW');
const dDsc4 = join(folderA, 'd_DSC4.JPG');
const eDsc5 = join(folderB, 'e_DSC5.ARW');
const fDsc6 = join(folderB, 'f_DSC6.ARW');
linkSync(ARW_PATH, aDsc1);
linkSync(ARW_PATH, bDsc2);
linkSync(ARW_PATH, cDsc3);
linkSync(JPG_PATH, dDsc4);
linkSync(ARW_PATH, eDsc5);
linkSync(ARW_PATH, fDsc6);

function cleanup() {
  rmSync(folderA, { recursive: true, force: true });
  rmSync(folderB, { recursive: true, force: true });
}

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
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
    page.evaluate(
      ({ p, o }) => {
        void window.__openImageByPath(p, o);
      },
      { p: path, o: opts }
    );
  const openFolderFireAndForget = (dir) =>
    page.evaluate((d) => {
      void window.__openFolderByPath(d);
    }, dir);

  // === 1. Open the folder — 4 cells, sorted, first image open ===
  console.log('verify-filmstrip (open a folder shows the strip, sorted, first image open):');
  await openFolderFireAndForget(folderA);
  // waitReadyOrError() alone is satisfiable by the PREVIOUS image's stale
  // 'ready' (openFolder hasn't even flipped to 'loading' while its
  // listImages IPC is in flight) — under parallel-suite contention that
  // window is wide enough to read section-1 state mid-decode. Wait for the
  // compound condition instead: the folder's FIRST image is current AND ready.
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    aDsc1,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, {
    timeout: 15_000,
  });
  const cellsAfterOpen = await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path));
  check('4 cells appear', cellsAfterOpen.length === 4, cellsAfterOpen);
  check(
    'cells are sorted by filename (nothing accumulated yet — this is the FIRST open of the session)',
    JSON.stringify(cellsAfterOpen) === JSON.stringify([aDsc1, bDsc2, cDsc3, dDsc4]),
    cellsAfterOpen
  );
  const stateAfterOpen = await page.evaluate(() => ({
    image: window.__debug.imageState(),
    folder: window.__debug.folderState(),
  }));
  check('first (sorted) image is open', stateAfterOpen.folder.currentPath === aDsc1, stateAfterOpen.folder);
  check('image reaches ready', stateAfterOpen.image.status === 'ready', stateAfterOpen.image);

  // === Fixture setup: a real look for b_DSC2.ARW only (open it, Save) ===
  //
  // Project-storage migration: this now happens INSIDE folder A's context
  // (keepFolderContext:true) so the playlist's own ORDER is established
  // purely by the folder scan above (nothing individually opened before
  // it) — then aDsc1 is reopened so "current" is back where checks 2-3
  // expect it.
  console.log("verify-filmstrip (fixture setup — one look'd file):");
  await openImageFireAndForget(bDsc2, { keepFolderContext: true });
  await waitReadyOrError();
  await page.click('[data-testid="save-button"]');
  // A fresh open is ALREADY graphDirty === false, so waiting on that (as this
  // fixture originally did) resolves instantly and races the async look
  // write — under parallel-suite contention the existsSync below lost that
  // race. Wait for the FILE, the thing the fixture actually needs.
  const bDsc2Look = lookPathFor(bDsc2);
  for (let i = 0; i < 100 && !existsSync(bDsc2Look); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('look written for b_DSC2.ARW (in the active project, not next to the photo)', existsSync(bDsc2Look), bDsc2Look);
  check('etiquette rule: nothing new appears next to b_DSC2.ARW', !existsSync(bDsc2 + '.silverbox.json'), bDsc2 + '.silverbox.json');

  // folderEntries (hasLook/rating included) is a point-in-time snapshot,
  // rebuilt on openFolder — NOT live-reactive to a save that just happened
  // elsewhere in the same session. Re-opening the SAME folder is cheap and
  // forces a fresh buildPlaylistEntries pass (nothing new to ADD to the
  // playlist — every path here is already on it), which also re-opens
  // aDsc1 (the first sorted entry), putting "current" back where checks 2-3
  // expect it.
  await openFolderFireAndForget(folderA);
  await waitReadyOrError();
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    aDsc1,
    { timeout: 120_000 }
  );

  // === 2. Thumbnails materialize for visible cells ===
  console.log('verify-filmstrip (thumbnails materialize lazily for visible cells):');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-thumb"]').length === 4, {
    timeout: 15_000,
  });
  const thumbSrcs = await page.$$eval('[data-testid="filmstrip-thumb"]', (els) => els.map((e) => e.src));
  check('all 4 cells loaded a blob: thumbnail', thumbSrcs.every((s) => s.startsWith('blob:')), thumbSrcs);

  // === 3. Edited dot + current highlight ===
  console.log("verify-filmstrip (edited dot on the look'd file, highlight on the current file):");
  const dotState = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="filmstrip-cell"]')].map((c) => ({
      path: c.dataset.path,
      dot: !!c.querySelector('[data-testid="filmstrip-edited-dot"]'),
      current: c.classList.contains('filmstrip-cell--current'),
    }))
  );
  const bCell = dotState.find((c) => c.path === bDsc2);
  const aCell = dotState.find((c) => c.path === aDsc1);
  check("b_DSC2's cell shows the edited dot", bCell?.dot === true, dotState);
  check('no OTHER cell shows the edited dot', dotState.filter((c) => c.dot).length === 1, dotState);
  check('a_DSC1 (the current image) is highlighted', aCell?.current === true, dotState);
  check('exactly one cell is highlighted', dotState.filter((c) => c.current).length === 1, dotState);

  // === 4. Click cell 3 (c_DSC3) opens it; ←/→ step prev/next; text-entry guard ===
  console.log('verify-filmstrip (click a cell opens it; arrow keys step prev/next):');
  await page.click(`[data-testid="filmstrip-cell"][data-path="${cDsc3}"]`);
  await waitReadyOrError();
  await page.waitForFunction((p) => window.__debug.folderState().currentPath === p, cDsc3, { timeout: 15_000 });
  const afterClick = await page.evaluate(() => ({
    current: window.__debug.folderState().currentPath,
    highlighted: [...document.querySelectorAll('[data-testid="filmstrip-cell"]')]
      .filter((c) => c.classList.contains('filmstrip-cell--current'))
      .map((c) => c.dataset.path),
  }));
  check('clicking cell 3 opens c_DSC3', afterClick.current === cDsc3, afterClick);
  check('highlight moved to c_DSC3', JSON.stringify(afterClick.highlighted) === JSON.stringify([cDsc3]), afterClick);

  await page.keyboard.press('ArrowRight');
  await waitReadyOrError();
  await page.waitForFunction((p) => window.__debug.folderState().currentPath === p, dDsc4, { timeout: 15_000 });
  check('ArrowRight steps to d_DSC4 (next)', true, null);

  await page.keyboard.press('ArrowLeft');
  await waitReadyOrError();
  await page.waitForFunction((p) => window.__debug.folderState().currentPath === p, cDsc3, { timeout: 15_000 });
  check('ArrowLeft steps back to c_DSC3 (prev)', true, null);

  console.log('verify-filmstrip (rapid switching: newest open wins — the epoch guard):');
  // Fire three opens back-to-back WITHOUT waiting between them: c -> a -> b.
  // Before the openImageEpoch guard, whichever RAW decode resolved LAST won
  // the UI (multi-second decodes make out-of-order resolution routine), so
  // the displayed image could disagree with the strip highlight. The guard
  // makes "last requested" == "displayed" by construction; assert it settles
  // on b_DSC2 and NEVER regresses afterwards.
  await page.evaluate(
    ([p1, p2, p3]) => {
      void window.__openImageByPath(p1, { keepFolderContext: true });
      void window.__openImageByPath(p2, { keepFolderContext: true });
      void window.__openImageByPath(p3, { keepFolderContext: true });
    },
    [cDsc3, aDsc1, bDsc2]
  );
  await page.waitForFunction(
    (p) => window.__debug.imageState().status === 'ready' && window.__debug.folderState().currentPath === p,
    bDsc2,
    { timeout: 120_000 }
  );
  // give any stale (slower) open a window to wrongly clobber the state
  await page.waitForTimeout(2_000);
  const afterBurst = await page.evaluate(() => ({
    current: window.__debug.folderState().currentPath,
    status: window.__debug.imageState().status,
  }));
  check('after a 3-open burst, the LAST-requested image is the one displayed (and stays)', afterBurst.current === bDsc2 && afterBurst.status === 'ready', afterBurst);

  // step back to c_DSC3 for the text-entry check below
  await page.click(`[data-testid="filmstrip-cell"][data-path="${cDsc3}"]`);
  await waitReadyOrError();
  await page.waitForFunction((p) => window.__debug.folderState().currentPath === p, cDsc3, { timeout: 15_000 });

  // Arrow keys must not fire while a text input is focused (isTextEntry's
  // guard, App.tsx) — focus a real <input type="text"> and confirm no
  // navigation happens across a bounded settle window (no navigation event
  // to poll FOR here, so a timeout is the only option).
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-testid', 'filmstrip-verify-text-probe');
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const afterTextFocusRight = await page.evaluate(() => window.__debug.folderState().currentPath);
  check('ArrowRight is ignored while a text input is focused', afterTextFocusRight === cDsc3, afterTextFocusRight);
  await page.evaluate(() => document.querySelector('[data-testid="filmstrip-verify-text-probe"]')?.remove());

  // === 5. Switch to a SECOND folder: the playlist EXTENDS (project-storage
  // migration — a playlist doesn't own photos, folder-open just adds
  // whatever's new), the strip re-renders, and folder A's thumbnail blob:
  // URLs still get revoked (the `key={dir}` remount happens regardless of
  // the playlist's own accumulation — see Filmstrip.tsx's doc comment). ===
  console.log("verify-filmstrip (switching folders extends the playlist, re-renders the strip, revokes folder A's thumbnail URLs):");
  const priorThumbUrls = await page.$$eval('[data-testid="filmstrip-thumb"]', (els) => els.map((e) => e.src));
  const revocationsBefore = await page.evaluate(() => window.__debug.thumbnailRevocations().length);
  await openFolderFireAndForget(folderB);
  await waitReadyOrError();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 6, {
    timeout: 15_000,
  });
  const cellsB = await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path));
  check(
    'the strip now shows all 6 accumulated cells (folder A\'s 4 + folder B\'s 2, in playlist order)',
    JSON.stringify(cellsB) === JSON.stringify([aDsc1, bDsc2, cDsc3, dDsc4, eDsc5, fDsc6]),
    cellsB
  );
  const stateB = await page.evaluate(() => window.__debug.folderState());
  check("folder B's own first (sorted) image opens", stateB.currentPath === eDsc5, stateB);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-thumb"]').length === 6, {
    timeout: 15_000,
  });
  const revocationsAfter = await page.evaluate(() => window.__debug.thumbnailRevocations());
  const allPriorRevoked = priorThumbUrls.every((u) => revocationsAfter.includes(u));
  check("every one of folder A's thumbnail URLs got revoked (the strip remounted)", allPriorRevoked, { priorThumbUrls, revocationsAfter });
  check('at least one revocation happened across the switch', revocationsAfter.length > revocationsBefore, {
    revocationsBefore,
    revocationsAfterLength: revocationsAfter.length,
  });

  // === 6. A single-file open (existing flow) shows NO strip ===
  console.log('verify-filmstrip (a single-file open shows no strip):');
  await openImageFireAndForget(JPG_PATH);
  await waitReadyOrError();
  const afterSingle = await page.evaluate(() => ({
    folder: window.__debug.folderState(),
    stripPresent: !!document.querySelector('[data-testid="filmstrip"]'),
  }));
  check('folder context cleared on a standalone single-file open', afterSingle.folder.dir === null, afterSingle.folder);
  check('no strip element in the DOM', afterSingle.stripPresent === false, afterSingle);

  // === 7. Multi-file DROP adds all to the playlist, opens the first, shows
  // the strip (UX pack, hand-test 2026-07-17 item 1) — driven via the SAME
  // CDP-synthesized OS drag verify-dnd.mjs uses (Input.dispatchDragEvent),
  // not a debug hook, so this exercises the real App.tsx onDrop → appStore's
  // openMultiDrop path end to end. Two FRESH hardlinks (never opened before
  // in this session) so the "+2" delta is unambiguous; the baseline is
  // projectState().photoCount (the AUTHORITATIVE playlist size), not the
  // DOM's folderState().entries — check 6 just cleared the strip to 0 DOM
  // cells, but the active project's playlist still holds the 6 entries
  // accumulated by checks 1-5 underneath. ===
  console.log('verify-filmstrip (7. multi-file drop adds all to the playlist, opens the first, shows the strip):');
  const multiDropDir = mkdtempSync(join(tmpdir(), 'silverbox-filmstrip-multidrop-'));
  const hDsc8 = join(multiDropDir, 'h_DSC8.ARW');
  const iDsc9 = join(multiDropDir, 'i_DSC9.JPG');
  linkSync(ARW_PATH, hDsc8);
  linkSync(JPG_PATH, iDsc9);
  try {
    const photoCountBeforeDrop = await page.evaluate(() => window.__debug.projectState().photoCount);
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('.canvas-view').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const dragData = { items: [], files: [hDsc8, iDsc9], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: dragData });
    await page.waitForFunction(
      (p) => window.__debug?.imageState().status === 'ready' && window.__debug.folderState().currentPath === p,
      hDsc8,
      { timeout: 120_000 }
    );
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length > 0, {
      timeout: 15_000,
    });
    const afterMultiDrop = await page.evaluate(() => ({
      folder: window.__debug.folderState(),
      cellCount: document.querySelectorAll('[data-testid="filmstrip-cell"]').length,
      stripPresent: !!document.querySelector('[data-testid="filmstrip"]'),
    }));
    check('the strip is visible after the drop', afterMultiDrop.stripPresent === true, afterMultiDrop);
    check(
      'the playlist grew by exactly 2 (both dropped files added, none skipped/deduped)',
      afterMultiDrop.folder.entries.length === photoCountBeforeDrop + 2,
      { photoCountBeforeDrop, afterEntries: afterMultiDrop.folder.entries.length }
    );
    check('the DOM cell count matches the playlist size', afterMultiDrop.cellCount === afterMultiDrop.folder.entries.length, afterMultiDrop);
    check('the FIRST dropped file is the one that opened', afterMultiDrop.folder.currentPath === hDsc8, afterMultiDrop.folder);
  } finally {
    rmSync(multiDropDir, { recursive: true, force: true });
  }

  // === 8. Portrait ARW thumbnail renders portrait, not landscape (round-10
  // fix pack item 1) — same fixture convention verify-preview.mjs uses for
  // its portrait overlay checks: an env-overridable path, loud SKIP if the
  // fixture file isn't present on this machine. thumbnailCache.ts's Sony RAW
  // path now bakes extractSonyEmbeddedPreview's `flip` into the cached blob's
  // own pixels (via an OffscreenCanvas rotate), so the <img>'s natural size
  // should already be upright — no CSS rotation involved here, unlike the
  // opening-preview overlay. The playlist has accumulated 6 entries by now
  // (checks 1-5 above), so this looks up the NEW cell by its own path rather
  // than assuming it's the only cell/thumbnail on the strip. ===
  const PORTRAIT_ARW =
    process.env.SILVERBOX_TEST_PORTRAIT_ARW ?? 'test-assets/italy/DSC06787.ARW';
  if (!existsSync(PORTRAIT_ARW)) {
    console.log(`  SKIP  portrait thumbnail orientation check (fixture missing: ${PORTRAIT_ARW})`);
  } else {
    console.log('verify-filmstrip (portrait ARW filmstrip thumbnail renders portrait):');
    const folderC = mkdtempSync(join(tmpdir(), 'silverbox-filmstrip-portrait-'));
    const gDsc7 = join(folderC, 'g_DSC7.ARW');
    linkSync(PORTRAIT_ARW, gDsc7);
    try {
      await openFolderFireAndForget(folderC);
      await waitReadyOrError();
      await page.waitForFunction(
        (p) => document.querySelector(`[data-testid="filmstrip-cell"][data-path="${p}"] [data-testid="filmstrip-thumb"]`) !== null,
        gDsc7,
        { timeout: 15_000 }
      );
      // Wait for the <img> itself to finish decoding (blob: URLs resolve
      // async relative to the src assignment) so naturalWidth/Height are real.
      await page.waitForFunction(
        (p) => {
          const img = document.querySelector(`[data-testid="filmstrip-cell"][data-path="${p}"] [data-testid="filmstrip-thumb"]`);
          return !!img && img.complete && img.naturalWidth > 0;
        },
        gDsc7,
        { timeout: 15_000 }
      );
      const thumbSize = await page.$eval(
        `[data-testid="filmstrip-cell"][data-path="${gDsc7}"] [data-testid="filmstrip-thumb"]`,
        (img) => ({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })
      );
      check(
        'portrait ARW thumbnail is taller than wide (not the landscape raw bytes)',
        thumbSize.naturalHeight > thumbSize.naturalWidth,
        thumbSize
      );
    } finally {
      rmSync(folderC, { recursive: true, force: true });
    }
  }
} finally {
  await app.close();
}

cleanup();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
