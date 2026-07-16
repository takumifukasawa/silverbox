/**
 * Milestone 11 verify: undo/redo. Slider-drag runs coalesce into one history
 * entry, ⌘Z / ⇧⌘Z walk params and structure edits both ways, a fresh edit
 * clears the redo stack, and the undone graph still renders to the CPU
 * reference.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
ensureTestProjectEnv();
rmLook(ARW_PATH);
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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const history = () => page.evaluate(() => window.__debug.historyState());
  const evParam = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev);
  const satParam = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.saturation);
  const nodeCount = () => page.evaluate(() => window.__debug.graphState().nodes.length);

  console.log('verify-ms11 (coalescing):');
  check('history starts empty', JSON.stringify(await history()) === '{"past":0,"future":0}', await history());
  for (const v of [0.1, 0.2, 0.3]) {
    await page.evaluate((x) => window.__debug.updateNodeParam('dev', 'basic.ev', x), v);
  }
  check('a slider run coalesces into one entry', (await history()).past === 1, await history());
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.saturation', 50));
  check('a different param starts a new entry', (await history()).past === 2, await history());

  console.log('verify-ms11 (undo/redo params):');
  await page.keyboard.press('Meta+z');
  check('⌘Z reverts the saturation edit', (await satParam()) === 0 && (await evParam()) === 0.3, {
    sat: await satParam(),
    ev: await evParam(),
  });
  await page.keyboard.press('Meta+z');
  check('second ⌘Z reverts the whole slider run', (await evParam()) === 0, await evParam());
  check('history is fully unwound', JSON.stringify(await history()) === '{"past":0,"future":2}', await history());
  await page.keyboard.press('Meta+Shift+z');
  check('⇧⌘Z restores the slider run', (await evParam()) === 0.3, await evParam());
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1));
  check('a fresh edit clears the redo stack', (await history()).future === 0, await history());

  console.log('verify-ms11 (undo structure edits):');
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-whitebalance"]').click();
  check('added node appears', (await nodeCount()) === 4, await nodeCount());
  await page.keyboard.press('Meta+z');
  check('⌘Z removes the added node', (await nodeCount()) === 3, await nodeCount());
  await page.keyboard.press('Meta+Shift+z');
  check('⇧⌘Z re-adds it', (await nodeCount()) === 4, await nodeCount());
  await page.keyboard.press('Meta+z');

  console.log('verify-ms11 (undone graph still renders correctly):');
  const gpu = await page.evaluate(() => window.__debug.readbackMean());
  const cpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check(
    'GPU matches CPU reference after undo/redo churn (within 1/255)',
    gpu && cpu && Math.abs(gpu.r - cpu.r) < GPU_CPU_TOLERANCE && Math.abs(gpu.g - cpu.g) < GPU_CPU_TOLERANCE,
    { gpu, cpu }
  );
  check('undo marks the graph dirty', await page.evaluate(() => window.__debug.graphDirty()), false);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
