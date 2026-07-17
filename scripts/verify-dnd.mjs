/**
 * Spec-alignment verify (UI spec §14): drag & drop open. A CDP-synthesized
 * OS file drag shows the overlay on drag-over, hides it on drag-leave, and a
 * drop opens the file through webUtils.getPathForFile; a multi-file drop
 * (UX pack, hand-test 2026-07-17 item 1) adds every dropped file to the
 * active project's playlist, shows the filmstrip, and opens the first
 * (drop-order — appStore.ts's openMultiDrop, replacing the OLD "silently
 * pick one file, preferring a RAW-named one, discard the rest" behavior this
 * script used to assert).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
// openMultiDrop touches the project system (ensureActiveProject) — isolate
// it the same way every other project-touching script does (must be set
// BEFORE electron.launch — see testProject.mjs's own doc comment) so a
// standalone run of this script never touches a real quickProjectDir.
ensureTestProjectEnv();

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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  const session = await page.context().newCDPSession(page);
  const box = await page.locator('.canvas-view').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  console.log('verify-dnd (overlay on drag-over, hidden on leave):');
  const dragData = { items: [], files: [JPG_PATH], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dragData });
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dragData });
  const overlayShown = await page
    .waitForSelector('[data-testid="drop-overlay"]', { timeout: 3_000 })
    .then(() => true, () => false);
  check('drag-over shows the drop overlay', overlayShown, overlayShown);
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'dnd-dragover.png') });

  console.log('verify-dnd (drop opens the file and clears the overlay):');
  await session.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: dragData });
  const overlayGone = await page
    .waitForSelector('[data-testid="drop-overlay"]', { state: 'detached', timeout: 3_000 })
    .then(() => true, () => false);
  check('the drop clears the overlay', overlayGone, overlayGone);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const jpgState = await page.evaluate(() => window.__debug.imageState());
  check('dropping the JPG opens it', jpgState.fullWidth === 4608 && jpgState.fullHeight === 3072, jpgState);

  console.log('verify-dnd (multi-file drop adds every file to the playlist, shows the strip, opens the first):');
  // Two FRESH hardlinks, distinct from JPG_PATH above (already on the
  // playlist from the single-file drop just above — dropping it again would
  // be a no-op re-add, not a genuine new playlist entry) — this way the
  // "+2" delta below is unambiguous.
  const multiDropDir = mkdtempSync(join(tmpdir(), 'silverbox-dnd-multidrop-'));
  const multiA = join(multiDropDir, 'multi-a.JPG');
  const multiB = join(multiDropDir, 'multi-b.ARW');
  linkSync(JPG_PATH, multiA);
  linkSync(ARW_PATH, multiB);
  try {
    const playlistBeforeMultiDrop = await page.evaluate(() => window.__debug.projectState().photoCount);
    const multiData = { items: [], files: [multiA, multiB], dragOperationsMask: 1 };
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: multiData });
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: multiData });
    await session.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: multiData });
    await page.waitForFunction(
      (p) => window.__debug?.imageState().status === 'ready' && window.__debug.folderState().currentPath === p,
      multiA,
      { timeout: 120_000 }
    );
    const afterMultiDrop = await page.evaluate(() => ({
      image: window.__debug.imageState(),
      folder: window.__debug.folderState(),
      project: window.__debug.projectState(),
      stripPresent: !!document.querySelector('[data-testid="filmstrip"]'),
    }));
    check(
      'the FIRST dropped file (drop order, not RAW-preference) is the one that opened',
      afterMultiDrop.folder.currentPath === multiA && afterMultiDrop.image.fullWidth === 4608 && afterMultiDrop.image.fullHeight === 3072,
      afterMultiDrop
    );
    check(
      "both dropped files landed on the active project's playlist",
      afterMultiDrop.project.photoCount === playlistBeforeMultiDrop + 2,
      { playlistBeforeMultiDrop, afterProjectState: afterMultiDrop.project }
    );
    check('the filmstrip is visible after the drop (folderDir set)', afterMultiDrop.folder.dir !== null, afterMultiDrop.folder);
    check('the filmstrip element is actually in the DOM', afterMultiDrop.stripPresent === true, afterMultiDrop);
  } finally {
    rmSync(multiDropDir, { recursive: true, force: true });
  }
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
