/**
 * Folder filmstrip verify (ROADMAP "nice to have" — browse a folder, NOT a
 * catalog): open a folder → a thumbnail strip appears below the canvas →
 * click a cell (or ←/→) to switch images. No database, nothing persisted
 * anywhere except the sidecars that already exist.
 *
 * Fixture: a temp folder with 3 hardlinked ARW copies under distinct names
 * (a_DSC1/b_DSC2/c_DSC3 — sorted order matters) + 1 hardlinked JPG
 * (d_DSC4), plus a second temp folder (e_DSC5/f_DSC6) for the folder-switch
 * check. Hardlinks are the suite's own isolation trick (see run-verify.mjs).
 * One file (b_DSC2.ARW) gets a real sidecar, written by opening it and
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
 *  5. Switching to a SECOND folder re-renders the strip and revokes every
 *     blob: URL the first folder's thumbnails had allocated.
 *  6. A single-file open (the same debug hook every other script uses)
 *     shows no strip at all — folder context is cleared.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

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
  const sidecar = bDsc2 + '.silverbox.json';
  if (existsSync(sidecar)) unlinkSync(sidecar);
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

  const openImageFireAndForget = (path) =>
    page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
  const openFolderFireAndForget = (dir) =>
    page.evaluate((d) => {
      void window.__openFolderByPath(d);
    }, dir);

  // === Fixture setup: a real sidecar for b_DSC2.ARW only (open it, Save) ===
  console.log('verify-filmstrip (fixture setup — one sidecar\'d file):');
  await openImageFireAndForget(bDsc2);
  await waitReadyOrError();
  await page.click('[data-testid="save-button"]');
  // A fresh open is ALREADY graphDirty === false, so waiting on that (as this
  // fixture originally did) resolves instantly and races the async sidecar
  // write — under parallel-suite contention the existsSync below lost that
  // race. Wait for the FILE, the thing the fixture actually needs.
  for (let i = 0; i < 100 && !existsSync(bDsc2 + '.silverbox.json'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('sidecar written for b_DSC2.ARW', existsSync(bDsc2 + '.silverbox.json'), null);

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
    'cells are sorted by filename',
    JSON.stringify(cellsAfterOpen) === JSON.stringify([aDsc1, bDsc2, cDsc3, dDsc4]),
    cellsAfterOpen
  );
  const stateAfterOpen = await page.evaluate(() => ({
    image: window.__debug.imageState(),
    folder: window.__debug.folderState(),
  }));
  check('first (sorted) image is open', stateAfterOpen.folder.currentPath === aDsc1, stateAfterOpen.folder);
  check('image reaches ready', stateAfterOpen.image.status === 'ready', stateAfterOpen.image);

  // === 2. Thumbnails materialize for visible cells ===
  console.log('verify-filmstrip (thumbnails materialize lazily for visible cells):');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-thumb"]').length === 4, {
    timeout: 15_000,
  });
  const thumbSrcs = await page.$$eval('[data-testid="filmstrip-thumb"]', (els) => els.map((e) => e.src));
  check('all 4 cells loaded a blob: thumbnail', thumbSrcs.every((s) => s.startsWith('blob:')), thumbSrcs);

  // === 3. Edited dot + current highlight ===
  console.log('verify-filmstrip (edited dot on the sidecar\'d file, highlight on the current file):');
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

  // === 5. Switch to a SECOND folder: strip re-renders, old thumbnails revoked ===
  console.log("verify-filmstrip (switching folders re-renders the strip, revokes folder A's thumbnail URLs):");
  const priorThumbUrls = await page.$$eval('[data-testid="filmstrip-thumb"]', (els) => els.map((e) => e.src));
  const revocationsBefore = await page.evaluate(() => window.__debug.thumbnailRevocations().length);
  await openFolderFireAndForget(folderB);
  await waitReadyOrError();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 2, {
    timeout: 15_000,
  });
  const cellsB = await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path));
  check('folder B strip shows its own 2 cells', JSON.stringify(cellsB) === JSON.stringify([eDsc5, fDsc6]), cellsB);
  const stateB = await page.evaluate(() => window.__debug.folderState());
  check('folder B opens its own first image', stateB.currentPath === eDsc5, stateB);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-thumb"]').length === 2, {
    timeout: 15_000,
  });
  const revocationsAfter = await page.evaluate(() => window.__debug.thumbnailRevocations());
  const allPriorRevoked = priorThumbUrls.every((u) => revocationsAfter.includes(u));
  check("every one of folder A's thumbnail URLs got revoked", allPriorRevoked, { priorThumbUrls, revocationsAfter });
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
} finally {
  await app.close();
}

cleanup();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
