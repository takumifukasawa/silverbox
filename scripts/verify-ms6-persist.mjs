/**
 * Milestone 6 verify: GraphDoc sidecar persistence. Edits the graph, saves
 * with ⌘S, checks the JSON on disk, confirms the graph is per-image (a
 * sidecar-less image resets to the default doc), restores the saved graph on
 * reopen with a render matching the CPU reference, and falls back to the
 * default doc when the sidecar is corrupt.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
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

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  const openAndWait = async (path) => {
    // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const evParam = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev);

  console.log('verify-ms6 (edit → dirty → ⌘S):');
  await openAndWait(ARW_PATH);
  check('freshly opened image is not dirty', !(await page.evaluate(() => window.__debug.graphDirty())), true);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.5));
  check('editing a param marks the graph dirty', await page.evaluate(() => window.__debug.graphDirty()), false);
  check(
    'toolbar shows the dirty indicator',
    (await page.locator('[data-testid="dirty-indicator"]').count()) === 1,
    await page.locator('[data-testid="dirty-indicator"]').count()
  );
  const editedGpu = await page.evaluate(() => window.__debug.readbackMean());

  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('⌘S clears the dirty flag', true, true);
  check(
    'dirty indicator disappears after save',
    (await page.locator('[data-testid="dirty-indicator"]').count()) === 0,
    await page.locator('[data-testid="dirty-indicator"]').count()
  );
  check('sidecar file exists next to the image', existsSync(SIDECAR), SIDECAR);
  const saved = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check(
    // schemaVersion 4 (anchor-space masks/spots, UX pack C §1): the version
    // this build always writes now; a v2/v3 sidecar still LOADS (see
    // scripts/verify-masks.mjs's inline v2/v3 fixture checks) — only the
    // number a *save* stamps on disk changed.
    'sidecar is schemaVersion 4 with source block and the edited ev',
    saved.schemaVersion === 4 &&
      saved.source?.fileName === basename(ARW_PATH) &&
      saved.source?.kind === 'raw' &&
      typeof saved.createdAt === 'string' &&
      saved.graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.5,
    saved
  );
  check('sidecar is pretty-printed and newline-terminated',
    readFileSync(SIDECAR, 'utf8').includes('\n    "nodes"') && readFileSync(SIDECAR, 'utf8').endsWith('\n'), null);

  console.log('verify-ms6 (graph is per-image):');
  await openAndWait(JPG_PATH);
  check('sidecar-less image resets to the default graph', (await evParam()) === 0, await evParam());

  console.log('verify-ms6 (reopen restores the saved graph):');
  await openAndWait(ARW_PATH);
  check('reopened image restores ev from the sidecar', (await evParam()) === 0.5, await evParam());
  check('restored graph is not dirty', !(await page.evaluate(() => window.__debug.graphDirty())), true);
  const restoredGpu = await page.evaluate(() => window.__debug.readbackMean());
  const restoredCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('restored render matches CPU reference (within 1/255)', meansMatch(restoredGpu, restoredCpu), {
    restoredGpu,
    restoredCpu,
  });
  check('restored render matches the pre-save render', meansMatch(restoredGpu, editedGpu), {
    editedGpu,
    restoredGpu,
  });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms6-restored.png') });

  console.log('verify-ms6 (corrupt sidecar falls back):');
  writeFileSync(SIDECAR, '{ not json', 'utf8');
  await openAndWait(JPG_PATH);
  await openAndWait(ARW_PATH);
  check('corrupt sidecar falls back to the default graph', (await evParam()) === 0, await evParam());
  check(
    'image still decodes and renders',
    (await page.evaluate(() => window.__debug.imageState())).status === 'ready',
    await page.evaluate(() => window.__debug.imageState())
  );

  console.log('screenshot: test-artifacts/ms6-restored.png');
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
