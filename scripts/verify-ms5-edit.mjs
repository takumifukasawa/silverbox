/**
 * Milestone 5 verify: graph editing. Adds white-balance and contrast nodes
 * through the real UI (toolbar select + Add), confirms defaults are identity,
 * drives their params and holds the GPU to the CPU reference, then deletes a
 * node with the keyboard and checks the chain rewires.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const chainKinds = () =>
    page.evaluate(() => {
      const g = window.__debug.graphState();
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const out = new Map(g.edges.map((e) => [e.source, e.target]));
      const kinds = [];
      let cur = g.nodes.find((n) => n.kind === 'input');
      while (cur) {
        kinds.push(cur.kind);
        cur = byId.get(out.get(cur.id));
      }
      return kinds;
    });
  const neutralGpu = await page.evaluate(() => window.__debug.readbackMean());

  console.log('verify-ms5 (add via UI):');
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-whitebalance"]').click();
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-contrast"]').click();
  check(
    'chain is input→Develop→whitebalance→contrast→output',
    (await chainKinds()).join(',') === 'input,Develop,whitebalance,contrast,output',
    await chainKinds()
  );
  // edges render a frame after nodes measure, so poll rather than snapshot
  const flowRendered = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.react-flow__node').length === 5 &&
        document.querySelectorAll('.react-flow__edge').length === 4,
      { timeout: 5_000 }
    )
    .then(() => true, () => false);
  check('React Flow renders 5 nodes / 4 edges', flowRendered, {
    nodes: await page.locator('.react-flow__node').count(),
    edges: await page.locator('.react-flow__edge').count(),
  });
  check(
    'adding a node selects it and shows its sliders',
    (await page.locator('.inspector input[type="range"]').count()) === 1 &&
      (await page.locator('.inspector-title').textContent()) === 'Contrast',
    await page.locator('.inspector-title').textContent()
  );

  console.log('verify-ms5 (default params are identity):');
  const defaultsGpu = await page.evaluate(() => window.__debug.readbackMean());
  check('4-op neutral chain still matches the neutral render', meansMatch(defaultsGpu, neutralGpu), {
    neutralGpu,
    defaultsGpu,
  });

  console.log('verify-ms5 (white balance + contrast vs CPU reference):');
  await page.evaluate(() => window.__debug.updateNodeParam('whitebalance-1', 'temp', 6500));
  await page.evaluate(() => window.__debug.updateNodeParam('contrast-1', 'amount', 40));
  const editedGpu = await page.evaluate(() => window.__debug.readbackMean());
  const editedCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('edited 4-op chain GPU matches CPU reference (within 1/255)', meansMatch(editedGpu, editedCpu), {
    editedGpu,
    editedCpu,
  });
  check('warmer WB shifts red above blue vs neutral', editedGpu && neutralGpu &&
    editedGpu.r - editedGpu.b > neutralGpu.r - neutralGpu.b + 0.05, { neutralGpu, editedGpu });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms5-edited.png') });

  console.log('verify-ms5 (delete rewires the chain):');
  await page.locator('.react-flow__node', { hasText: 'white balance' }).click();
  await page.locator('.react-flow__node', { hasText: 'white balance' }).press('Backspace');
  check(
    'chain is input→Develop→contrast→output after delete',
    (await chainKinds()).join(',') === 'input,Develop,contrast,output',
    await chainKinds()
  );
  const afterDeleteGpu = await page.evaluate(() => window.__debug.readbackMean());
  const afterDeleteCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('rewired chain GPU matches CPU reference (within 1/255)', meansMatch(afterDeleteGpu, afterDeleteCpu), {
    afterDeleteGpu,
    afterDeleteCpu,
  });
  await page.evaluate(() => window.__debug.updateNodeParam('contrast-1', 'amount', 0));
  const restoredGpu = await page.evaluate(() => window.__debug.readbackMean());
  check('delete + neutral params restore the neutral render', meansMatch(restoredGpu, neutralGpu), {
    neutralGpu,
    restoredGpu,
  });

  console.log('screenshot: test-artifacts/ms5-edited.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
