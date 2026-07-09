/**
 * Spec-alignment verify (REBUILD-SPEC MS4): the Develop node. Checks the
 * default graph shape, the identity invariant (untouched Develop = zero plan
 * steps = render identical to the bare decode), every Basic slider against
 * the CPU reference and its expected direction, atomic/Develop equivalence
 * for exposure, and the inspector section UI (number inputs, double-click
 * reset).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
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

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const setDev = (path, value) =>
    page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());

  console.log('verify-develop (default graph + identity):');
  const kinds = await page.evaluate(() => window.__debug.graphState().nodes.map((n) => n.kind).join(','));
  check('default graph is input → Develop → output', kinds === 'input,Develop,output', kinds);
  const neutral = await gpuMean();
  const neutralCpu = await cpuMean();
  check(
    'untouched Develop is an exact pass-through of the decode (CPU = raw pixels)',
    meansMatch(neutral, neutralCpu, 1 / 255),
    { neutral, neutralCpu }
  );

  console.log('verify-develop (each Basic slider vs CPU reference):');
  const sliders = [
    ['basic.ev', 1, (m) => m.g > neutral.g + 0.05, 'exposure +1EV brightens'],
    ['basic.contrast', 60, (m) => Math.abs(m.g - neutral.g) > 0.005, 'contrast changes tones'],
    ['basic.highlights', -80, (m) => m.g < neutral.g + 0.001, 'highlights −80 does not brighten overall'],
    ['basic.shadows', 80, (m) => m.g > neutral.g + 0.01, 'shadows +80 lifts the image'],
    ['basic.whites', 80, (m) => m.g > neutral.g, 'whites +80 raises the top end'],
    ['basic.blacks', 80, (m) => m.g > neutral.g, 'blacks +80 lifts the black point'],
    ['basic.saturation', -100, (m) => Math.abs(m.r - m.b) < Math.abs(neutral.r - neutral.b) * 0.2, 'saturation −100 desaturates'],
    ['basic.vibrance', 80, (m) => Math.abs(m.g - neutral.g) < 0.2, 'vibrance +80 stays sane'],
  ];
  for (const [path, value, direction, label] of sliders) {
    await setDev(path, value);
    const gpu = await gpuMean();
    const cpu = await cpuMean();
    check(`${label} — GPU matches CPU reference (within 1/255)`, meansMatch(gpu, cpu), { path, gpu, cpu });
    check(`${label} — effect direction`, direction(gpu), { path, gpu, neutral });
    await setDev(path, 0);
  }
  const restored = await gpuMean();
  check('resetting all sliders restores the neutral render', meansMatch(restored, neutral), {
    neutral,
    restored,
  });

  console.log('verify-develop (atomic exposure ≡ Develop exposure):');
  await setDev('basic.ev', 1);
  const devEv = await gpuMean();
  await setDev('basic.ev', 0);
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-exposure"]').click();
  const atomicId = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.kind === 'exposure')?.id
  );
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'ev', 1), atomicId);
  const atomicEv = await gpuMean();
  check('atomic exposure EV=1 renders identically to Develop ev=1', meansMatch(atomicEv, devEv, 1e-6), {
    devEv,
    atomicEv,
  });
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'ev', 0), atomicId);

  console.log('verify-develop (inspector UI):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const basicSection = page.locator('.inspector-section').filter({ hasText: 'Basic' }).first();
  check(
    'Develop inspector shows the Basic section with 10 rows (incl. Temp/Tint)',
    (await page.locator('.inspector-title').textContent()) === 'Develop' &&
      (await basicSection.locator('.param-row').count()) === 10,
    { title: await page.locator('.inspector-title').textContent(), rows: await basicSection.locator('.param-row').count() }
  );
  const evRow = basicSection.locator('.param-row').nth(2); // Temp, Tint, then Exposure
  await evRow.locator('input[type="number"]').fill('2');
  const evAfterNumber = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('number input drives the param', evAfterNumber === 2, evAfterNumber);
  await evRow.dblclick();
  const evAfterReset = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('double-clicking the row resets to default', evAfterReset === 0, evAfterReset);

  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.shadows', 60));
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'develop.png') });
  console.log('screenshot: test-artifacts/develop.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
