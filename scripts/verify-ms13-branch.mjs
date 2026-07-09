/**
 * Milestone 13 verify: branching graphs. Adds a blend node (self-blend =
 * identity), rewires its 'b' input onto a real branch by dragging in the
 * editor, holds the branched render to the CPU reference, rejects a cycle,
 * survives a sidecar round-trip, and bypasses cleanly on delete.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;

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

const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

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
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const edgeList = () =>
    page.evaluate(() =>
      window.__debug
        .graphState()
        .edges.map((e) => `${e.source}->${e.target}${e.targetHandle ? ':' + e.targetHandle : ''}`)
        .sort()
    );

  console.log('verify-ms13 (self-blend is identity):');
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-blend"]').click();
  check(
    'blend node lands with a/b fed by the previous source',
    (await edgeList()).join(',').includes('dev->blend-1:a') &&
      (await edgeList()).join(',').includes('dev->blend-1:b'),
    await edgeList()
  );
  await page.evaluate(() => window.__debug.updateNodeParam('blend-1', 'amount', 0.7));
  const selfBlend = await page.evaluate(() => window.__debug.readbackMean());
  check('self-blend renders identity at any amount', meansMatch(selfBlend, neutral), { neutral, selfBlend });

  console.log('verify-ms13 (rewire b onto a branch by dragging):');
  // drag from the input node's source handle onto blend-1's 'b' input handle
  const srcHandle = page.locator('.react-flow__node[data-id="in"] .react-flow__handle.source');
  const dstHandle = page.locator('.react-flow__node[data-id="blend-1"] .react-flow__handle[data-handleid="b"]');
  const src = await srcHandle.boundingBox();
  const dst = await dstHandle.boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 8 });
  await page.mouse.up();
  check(
    'edge b now comes from the input',
    (await edgeList()).join(',').includes('in->blend-1:b') &&
      !(await edgeList()).join(',').includes('dev->blend-1:b'),
    await edgeList()
  );

  console.log('verify-ms13 (branched render matches CPU reference):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.5));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.saturation', -100));
  await page.evaluate(() => window.__debug.updateNodeParam('blend-1', 'amount', 0.5));
  const branchedGpu = await page.evaluate(() => window.__debug.readbackMean());
  const branchedCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('branched GPU matches CPU reference (within 1/255)', meansMatch(branchedGpu, branchedCpu), {
    branchedGpu,
    branchedCpu,
  });
  check(
    'branch actually differs from the plain chain (color leaks through the b path)',
    Math.abs(branchedGpu.r - branchedGpu.g) > 0.01,
    branchedGpu
  );
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms13-branch.png') });

  console.log('verify-ms13 (cycles are rejected):');
  const edgesBefore = await edgeList();
  // try to feed blend-1's output back into the Develop node — a cycle
  const blendSrc = page.locator('.react-flow__node[data-id="blend-1"] .react-flow__handle.source');
  const expTarget = page.locator('.react-flow__node[data-id="dev"] .react-flow__handle.target');
  const bs = await blendSrc.boundingBox();
  const et = await expTarget.boundingBox();
  await page.mouse.move(bs.x + bs.width / 2, bs.y + bs.height / 2);
  await page.mouse.down();
  await page.mouse.move(et.x + et.width / 2, et.y + et.height / 2, { steps: 8 });
  await page.mouse.up();
  check('cycle attempt leaves the graph unchanged', JSON.stringify(await edgeList()) === JSON.stringify(edgesBefore), {
    before: edgesBefore,
    after: await edgeList(),
  });

  console.log('verify-ms13 (sidecar round-trip):');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  check(
    'reopen restores the branch (including targetHandle)',
    (await edgeList()).join(',').includes('in->blend-1:b'),
    await edgeList()
  );
  const restoredGpu = await page.evaluate(() => window.__debug.readbackMean());
  check('restored branch renders like before the save', meansMatch(restoredGpu, branchedGpu), {
    branchedGpu,
    restoredGpu,
  });

  console.log('verify-ms13 (deleting blend bypasses via a):');
  await page.locator('.react-flow__node[data-id="blend-1"]').click();
  await page.locator('.react-flow__node[data-id="blend-1"]').press('Backspace');
  check(
    'chain rewires saturation → output',
    (await edgeList()).join(',').includes('dev->out'),
    await edgeList()
  );
  const bypassGpu = await page.evaluate(() => window.__debug.readbackMean());
  const bypassCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('bypassed graph matches CPU reference', meansMatch(bypassGpu, bypassCpu), { bypassGpu, bypassCpu });

  console.log('screenshot: test-artifacts/ms13-branch.png');
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
