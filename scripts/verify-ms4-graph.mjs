/**
 * Milestone 4 verify: the GraphDoc op chain runs on the GPU and matches the
 * CPU reference implementations from the op registry. Opens the real ARW,
 * then: neutral graph = identity, exposure +1 EV and saturation 0 each match
 * cpuReferenceMean() (which executes the same chain on the CPU), and the
 * node editor + inspector UI drive the same parameters.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = 'test-assets/test.ARW';

// rgba16float chain passes + 8-bit readback quantization; means stay well
// inside 1/255 per channel (see verify-ms3).
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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  console.log('verify-ms4 (graph model):');
  const graph = await page.evaluate(() => window.__debug.graphState());
  check(
    'default graph is input → Develop → output',
    graph.nodes.map((n) => n.kind).join(',') === 'input,Develop,output' && graph.edges.length === 2,
    graph.nodes.map((n) => n.kind)
  );
  check(
    'React Flow renders 3 nodes and 2 edges',
    (await page.locator('.react-flow__node').count()) === 3 &&
      (await page.locator('.react-flow__edge').count()) === 2,
    { nodes: await page.locator('.react-flow__node').count(), edges: await page.locator('.react-flow__edge').count() }
  );

  console.log('verify-ms4 (neutral chain = identity):');
  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const neutralGpu = await page.evaluate(() => window.__debug.readbackMean());
  const neutralCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('neutral GPU matches CPU reference (within 1/255)', meansMatch(neutralGpu, neutralCpu), {
    neutralGpu,
    neutralCpu,
  });
  check(
    'neutral display is neither black nor blown out',
    neutralGpu && neutralGpu.r > 0.02 && neutralGpu.r < 0.98,
    neutralGpu
  );

  console.log('verify-ms4 (exposure +1 EV):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1));
  const evGpu = await page.evaluate(() => window.__debug.readbackMean());
  const evCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('+1 EV GPU matches CPU reference (within 1/255)', meansMatch(evGpu, evCpu), { evGpu, evCpu });
  check('+1 EV brightens the display', evGpu && neutralGpu && evGpu.g > neutralGpu.g + 0.05, {
    neutral: neutralGpu?.g,
    ev: evGpu?.g,
  });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms4-exposure.png') });

  console.log('verify-ms4 (saturation −100):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.saturation', -100));
  const satGpu = await page.evaluate(() => window.__debug.readbackMean());
  const satCpu = await page.evaluate(() => window.__debug.cpuReferenceMean());
  check('saturation −100 GPU matches CPU reference (within 1/255)', meansMatch(satGpu, satCpu), { satGpu, satCpu });
  check(
    'saturation −100 renders grayscale (channel means converge)',
    satGpu && Math.abs(satGpu.r - satGpu.g) < 0.01 && Math.abs(satGpu.b - satGpu.g) < 0.01,
    satGpu
  );
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms4-grayscale.png') });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.saturation', 0));

  console.log('verify-ms4 (inspector UI):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const slider = page.locator('.inspector input[type="range"]').first();
  check(
    'clicking the Develop node shows the Basic sliders',
    (await page.locator('.inspector input[type="range"]').count()) === 8,
    await page.locator('.inspector input[type="range"]').count()
  );

  await slider.focus();
  await page.keyboard.press('ArrowRight');
  const evAfterKey = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('arrow key on the slider updates the graph param', evAfterKey === 0.01, evAfterKey);
  check(
    'inspector number input shows the updated value',
    (await page.locator('.param-row').first().locator('input[type="number"]').inputValue()) === '0.01',
    await page.locator('.param-row').first().locator('input[type="number"]').inputValue()
  );

  console.log('screenshots: test-artifacts/ms4-exposure.png, ms4-grayscale.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
