/**
 * Spec-alignment verify (UI spec §14): drag & drop open. A CDP-synthesized
 * OS file drag shows the overlay on drag-over, hides it on drag-leave, and a
 * drop opens the file through webUtils.getPathForFile; multi-file drops
 * prefer the RAW-named file.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = 'test-assets/test.ARW';
const JPG_PATH = 'test-assets/test.JPG';

console.log('building…');
execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });

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

  console.log('verify-dnd (multi-file drop prefers the RAW):');
  const multiData = { items: [], files: [JPG_PATH, ARW_PATH], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: multiData });
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: multiData });
  await session.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: multiData });
  await page.waitForFunction(
    () => window.__debug?.imageState().status === 'ready' && window.__debug.imageState().fullWidth === 4624,
    undefined,
    { timeout: 120_000 }
  );
  const rawState = await page.evaluate(() => window.__debug.imageState());
  check('the RAW wins over the JPG', rawState.fullWidth === 4624 && rawState.fullHeight === 3080, rawState);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
