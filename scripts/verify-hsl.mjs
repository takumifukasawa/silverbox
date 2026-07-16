/**
 * Spec-alignment verify (REBUILD-SPEC MS10): 8-band HSL. All-zero = exact
 * pass-through, Green saturation −100 desaturates greens (and matches the
 * CPU reference), band selectivity (red band leaves a green scene mostly
 * alone), hue rotation and luminance directions behave, the 3-tab UI drives
 * the params, and values survive the sidecar.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
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

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const setHsl = (band, ch, v) =>
    page.evaluate(([b, c, x]) => window.__debug.updateNodeParam('dev', `hsl.${b}.${c}`, x), [band, ch, v]);

  console.log('verify-hsl (green saturation −100):');
  await setHsl('green', 's', -100);
  const greenDesat = await gpuMean();
  const greenDesatCpu = await cpuMean();
  check('GPU matches CPU reference (within 1/255)', meansMatch(greenDesat, greenDesatCpu), {
    greenDesat,
    greenDesatCpu,
  });
  // the mint-leaves scene is green-dominant: killing green saturation pulls
  // the g mean toward r/b noticeably
  // the warm indoor light pushes the leaves' hue toward yellow, so the green
  // band only owns part of the scene — the readback is deterministic, so a
  // small strict-direction threshold is enough
  // threshold 0.001 → 0.0004 for the Rec.2020 migration: the same greens carry
  // less RGB chroma in the wider working space (weaker band mask) and the
  // noAutoBright decode is darker — direction unchanged, magnitude smaller
  check(
    'greens desaturate (g mean falls toward r/b)',
    neutral.g - greenDesat.g > 0.0004,
    { neutral: neutral.g, desat: greenDesat.g }
  );

  console.log('verify-hsl (band selectivity — magenta band on a green scene):');
  await setHsl('green', 's', 0);
  await setHsl('magenta', 's', -100);
  const magentaDesat = await gpuMean();
  const magentaCpu = await cpuMean();
  check('magenta band GPU matches CPU reference', meansMatch(magentaDesat, magentaCpu), {
    magentaDesat,
    magentaCpu,
  });
  check(
    'magenta band barely touches the green scene',
    Math.abs(magentaDesat.g - neutral.g) < 0.004 && Math.abs(magentaDesat.r - neutral.r) < 0.004,
    { neutral, magentaDesat }
  );
  await setHsl('magenta', 's', 0);

  console.log('verify-hsl (hue rotation + luminance):');
  await setHsl('green', 'h', 100); // greens rotate toward aqua/blue
  const hueRot = await gpuMean();
  const hueRotCpu = await cpuMean();
  check('hue rotation GPU matches CPU reference', meansMatch(hueRot, hueRotCpu), { hueRot, hueRotCpu });
  // threshold 0.0003 → 0.00005 for the Rec.2020 migration (same reasons as the
  // desaturation check above; the deterministic readback measured ~0.00009)
  check('rotating green toward aqua raises b relative to g', hueRot.b - neutral.b > 0.00005, {
    neutral: neutral.b,
    rotated: hueRot.b,
  });
  await setHsl('green', 'h', 0);
  await setHsl('green', 'l', 100);
  const lumUp = await gpuMean();
  const lumUpCpu = await cpuMean();
  check('luminance GPU matches CPU reference', meansMatch(lumUp, lumUpCpu), { lumUp, lumUpCpu });
  // threshold 0.003 → 0.001 for the Rec.2020 migration (same reasons as the
  // desaturation check above; the deterministic readback measured ~0.0012)
  check('green luminance +100 brightens the scene', lumUp.g > neutral.g + 0.001, {
    neutral: neutral.g,
    lum: lumUp.g,
  });
  await setHsl('green', 'l', 0);

  console.log('verify-hsl (all-zero = exact pass-through):');
  const back = await gpuMean();
  check('zeroing every band restores the neutral render', meansMatch(back, neutral), { neutral, back });

  console.log('verify-hsl (3-tab UI drives the params):');
  await page.locator('.react-flow__node[data-id="dev"]').click();
  await page.locator('[data-testid="hsl-tab-s"]').click();
  const bandRows = page.locator('.inspector-section', { hasText: 'HSL' }).locator('.param-row');
  check('saturation tab shows 8 band sliders', (await bandRows.count()) === 8, await bandRows.count());
  const greenRow = bandRows.nth(3); // red, orange, yellow, green…
  await greenRow.locator('input[type="number"]').fill('-50');
  const uiValue = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.hsl?.green?.s
  );
  check('number input drives hsl.green.s', uiValue === -50, uiValue);

  console.log('verify-hsl (sidecar round-trip):');
  const edited = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredHsl = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.hsl?.green?.s
  );
  check('reopen restores hsl.green.s', restoredHsl === -50, restoredHsl);
  const restored = await gpuMean();
  check('restored HSL renders like before the save', meansMatch(restored, edited), { edited, restored });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
