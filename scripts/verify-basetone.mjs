/**
 * Base tone verify (docs/decisions/0001 + 0002, docs/plans/active/base-tone-stage.md):
 *
 *  1. Fresh RAW open is NEUTRAL (SILVERBOX_TEST_BASE_CURVE_DEFAULT=1 opts this
 *     run into the real fresh-open defaults): profile.amount 0, baseTone
 *     'none', identity tone curve; the RAW corrections (sharpen 40, color NR
 *     25) are still seeded; the Inspector's selector shows None and writes
 *     the doc when changed.
 *  2. With the defaults suppressed (plain SILVERBOX_TEST, no spatial passes,
 *     so the CPU mirror exists): every non-none base tone's GPU readback
 *     matches the CPU reference within 1/255, changes the render, and
 *     brightens it vs 'none'; switching back to 'none' restores the exact
 *     neutral render.
 *  3. Sidecar round-trip: baseTone survives save + reopen with the same render.
 *  4. Undo restores the previous base tone.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
const GPU_CPU_TOLERANCE = 1 / 255;
const TONES = ['reinhard', 'sigmoid', 'agx', 'aces'];

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
const lum = (m) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;

async function openFresh(env) {
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  const app = await electron.launch({ args: [projectRoot], env: { ...process.env, ...env } });
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  return { app, page };
}

const devOf = (page) => page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.develop);
const isIdentityCurve = (pts) => Array.isArray(pts) && pts.every(([x, y]) => x === y);

// ---------------------------------------------------------------------------
console.log('verify-basetone (1. fresh RAW open is neutral):');
{
  const { app, page } = await openFresh({ SILVERBOX_TEST_BASE_CURVE_DEFAULT: '1' });
  try {
    const dev = await devOf(page);
    check('profile.amount is 0 (no camera-profile emulation)', dev?.profile?.amount === 0, dev?.profile);
    check("profile.baseTone is 'none'", dev?.profile?.baseTone === 'none', dev?.profile);
    check('tone curve rgb is identity', isIdentityCurve(dev?.toneCurve?.rgb), dev?.toneCurve?.rgb);
    check('default sharpen 40 still seeded', dev?.detail?.sharpen?.amount === 40, dev?.detail?.sharpen);
    check('default color NR 25 still seeded', dev?.detail?.noiseColor?.amount === 25, dev?.detail?.noiseColor);
    await page.locator('.react-flow__node[data-id="dev"]').click();
    const select = page.locator('[data-testid="base-tone-select"]');
    check('the Inspector shows the base-tone selector set to None', (await select.inputValue()) === 'none', await select.inputValue());
    await select.selectOption('sigmoid');
    const picked = await devOf(page);
    check("choosing Sigmoid in the Inspector writes profile.baseTone 'sigmoid'", picked?.profile?.baseTone === 'sigmoid', picked?.profile);
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------
const { app, page } = await openFresh({});
try {
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const setTone = (id) => page.evaluate((v) => window.__debug.setDevelopBaseTone('dev', v), id);

  console.log('verify-basetone (2. every base tone: GPU matches CPU, changes + brightens the render):');
  const neutral = await gpuMean();
  const neutralCpu = await cpuMean();
  check("'none' GPU matches CPU", meansMatch(neutral, neutralCpu), { neutral, neutralCpu });
  for (const id of TONES) {
    await setTone(id);
    const g = await gpuMean();
    const c = await cpuMean();
    check(`${id}: GPU matches CPU reference (within 1/255)`, meansMatch(g, c), { g, c });
    check(`${id}: brightens the neutral decode`, lum(g) > lum(neutral) + 0.01, { neutral: lum(neutral), g: lum(g) });
  }
  await setTone('none');
  check("back to 'none' restores the exact neutral render", meansMatch(await gpuMean(), neutral, 1e-6), null);

  console.log('verify-basetone (3. sidecar round-trip):');
  await setTone('agx');
  const beforeSave = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('sidecar file written', existsSync(SIDECAR), SIDECAR);
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restored = await devOf(page);
  check("reopen restores baseTone 'agx'", restored?.profile?.baseTone === 'agx', restored?.profile);
  check('restored render matches the pre-save render', meansMatch(await gpuMean(), beforeSave), null);

  console.log('verify-basetone (4. undo):');
  await setTone('aces');
  await page.evaluate(() => window.__debug.undo());
  const afterUndo = await devOf(page);
  check("undo restores the previous base tone ('agx')", afterUndo?.profile?.baseTone === 'agx', afterUndo?.profile);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
