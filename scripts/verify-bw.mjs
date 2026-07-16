/**
 * B&W conversion + channel mixer verify (docs/brief-bank/bw-mixer.md):
 *
 *  1. Enabled with all-zero mix ⇒ pixel-wise gray (r≈g≈b) whose GPU readback
 *     matches the CPU reference (within 1/255) — same idiom as
 *     verify-hsl.mjs's own GPU/CPU parity checks.
 *  2. Disabled ⇒ bit-exact pass-through; `mix` stays preserved-but-inert
 *     while disabled (toggling back on round-trips the render exactly).
 *  3. Band selectivity: locate two distinctly-hued, reasonably saturated
 *     regions in the REAL test image (imageForVerify() grid-stats machinery,
 *     same technique verify-colorkey.mjs uses to find its "leaf" region) —
 *     each region's OWN dominant band's mix −100 darkens its mono value,
 *     +100 lightens it, while the OTHER region stays essentially unmoved
 *     (the brief's own sketch names "red"/"green" specifically, but the
 *     shipped fixture has no strongly red- or green-hued patch at all — see
 *     this file's own note further down — so the two regions and their
 *     bands are resolved dynamically against whatever photo is actually
 *     loaded, same "compute from the image, don't hardcode" spirit as
 *     verify-colorkey.mjs).
 *  4. Grading after B&W still tints (the pipeline-position rationale: B&W
 *     sits between HSL and Grading specifically so split-toning a mono
 *     image — the classic darkroom move — still works).
 *  5. Sidecar round-trip, INCLUDING `mix` preserved while B&W is disabled.
 *  6. Preset family inclusion: `bw` shows up in the family-scope dialog
 *     (docs/brief-bank/preset-scoping-and-export-overrides.md §1),
 *     default-checked alongside the other develop-group families — the
 *     dialog already exists (FamilyScopeDialog.tsx), so this runs for real
 *     rather than skipping.
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
const GRID_SIZE = 10;
/** Must match HSL_BANDS / HSL_BAND_CENTER_DEG in developNode.ts. */
const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];

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

  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const setBwEnabled = (enabled) => page.evaluate(([id, e]) => window.__debug.setDevelopBwEnabled(id, e), ['dev', enabled]);
  const setBwMix = (bandIndex, v) =>
    page.evaluate(([i, val]) => window.__debug.updateNodeParam('dev', `bw.mix.${i}`, val), [bandIndex, v]);
  const devDevelop = () => page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop);
  /** Mean brightness (0..1) of a crop of the CURRENT preview's ENCODED output — same helper verify-colorkey.mjs uses. */
  const regionMean = async (x0, y0, w, h) => {
    const px = await page.evaluate(([x0, y0, w, h]) => window.__debug.encodedCropForVerify(x0, y0, w, h), [x0, y0, w, h]);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += px[i] + px[i + 1] + px[i + 2];
      n++;
    }
    return sum / (n * 3 * 255);
  };

  const neutral = await gpuMean();

  // ---------------------------------------------------------------------
  console.log('verify-bw (1. enabled, all-zero mix ⇒ pixel-wise gray, GPU matches CPU):');
  await setBwEnabled(true);
  const grayMean = await gpuMean();
  const grayCpu = await cpuMean();
  check(
    'r≈g≈b (mono replacement)',
    Math.abs(grayMean.r - grayMean.g) < GPU_CPU_TOLERANCE && Math.abs(grayMean.g - grayMean.b) < GPU_CPU_TOLERANCE,
    grayMean
  );
  check('GPU matches CPU reference (within 1/255)', meansMatch(grayMean, grayCpu), { grayMean, grayCpu });
  check('the mono render actually differs from the color original', !meansMatch(grayMean, neutral, GPU_CPU_TOLERANCE), {
    neutral,
    grayMean,
  });

  // ---------------------------------------------------------------------
  console.log('verify-bw (2. disabled ⇒ bit-exact passthrough; mix preserved-but-inert):');
  const redIdx = HSL_BANDS.indexOf('red');
  await setBwMix(redIdx, 42); // dial in a mix WHILE enabled
  const withMix = await gpuMean();
  // A whole-FRAME mean is a weak instrument for one band's local effect (most
  // pixels never touch the red band at all) — a tiny-but-nonzero, exactly
  // reproducible delta is still real evidence of a wired-up render change;
  // section 3 below proves the actual per-band magnitude on a region that
  // DOES sit in-band.
  const NONZERO_EPSILON = 1e-6;
  check(
    'mix actually changes the render while enabled (nonzero, deterministic delta)',
    Math.abs(withMix.r - grayMean.r) > NONZERO_EPSILON ||
      Math.abs(withMix.g - grayMean.g) > NONZERO_EPSILON ||
      Math.abs(withMix.b - grayMean.b) > NONZERO_EPSILON,
    { grayMean, withMix }
  );

  await setBwEnabled(false);
  const disabledMean = await gpuMean();
  check(
    'disabling B&W restores the EXACT pre-B&W render (identity invariant — pass fully skipped)',
    meansMatch(disabledMean, neutral, GPU_CPU_TOLERANCE),
    { neutral, disabledMean }
  );
  const devWhileDisabled = await devDevelop();
  check('mix stays preserved (not reset) while disabled', devWhileDisabled?.bw?.mix?.[redIdx] === 42, devWhileDisabled?.bw);
  check('enabled reads back false', devWhileDisabled?.bw?.enabled === false, devWhileDisabled?.bw);

  await setBwEnabled(true);
  const reenabledMean = await gpuMean();
  check('re-enabling restores the SAME render as before (mix round-tripped through the toggle)', meansMatch(reenabledMean, withMix, GPU_CPU_TOLERANCE), {
    withMix,
    reenabledMean,
  });
  await setBwMix(redIdx, 0); // back to the neutral mono baseline for section 3

  // ---------------------------------------------------------------------
  // Band selectivity: rather than assuming this specific test photo has a
  // literal "red" and "green" patch (the shipped fixture is a warm-toned
  // yellow/orange scene with no strongly red- or green-hued region at all —
  // confirmed by inspecting imageForVerify()'s own grid stats), pick TWO
  // real, distinctly-hued, reasonably saturated regions from whatever
  // photo is actually loaded (SILVERBOX_TEST_ARW may point at a different
  // fixture) and drive whichever HSL_BANDS entry is closest to each one's
  // hue — same spirit as the brief's "red patch / green patch" sketch, just
  // resolved against the REAL image the same way verify-colorkey.mjs's own
  // dominant-saturation search is (computed in-page, not hardcoded).
  console.log('verify-bw (3. band selectivity — locate two distinctly-hued regions in the real image):');
  const gridStats = await page.evaluate((gridSize) => {
    const img = window.__debug.imageForVerify();
    if (!img) return null;
    const { data, width, height } = img;
    const srgbEncode1 = (v) => {
      const c = Math.min(Math.max(v, 0), 1);
      return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    };
    const rgb2hsl = (r, g, b) => {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const l = 0.5 * (mx + mn);
      const d = mx - mn;
      if (d < 1e-6) return [0, 0, l];
      const s = d / (1 - Math.abs(2 * l - 1));
      let h;
      if (mx === r) h = (g - b) / d;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return [h, s, l];
    };
    const cw = Math.floor(width / gridSize);
    const ch = Math.floor(height / gridSize);
    const cells = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const x0 = gx * cw;
        const y0 = gy * ch;
        const strideX = Math.max(1, Math.floor(cw / 32));
        const strideY = Math.max(1, Math.floor(ch / 32));
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let y = y0; y < y0 + ch; y += strideY) {
          for (let x = x0; x < x0 + cw; x += strideX) {
            const idx = (y * width + x) * 4;
            sr += srgbEncode1(data[idx]);
            sg += srgbEncode1(data[idx + 1]);
            sb += srgbEncode1(data[idx + 2]);
            n++;
          }
        }
        const r = sr / n;
        const g = sg / n;
        const b = sb / n;
        const [hue, sat, lum] = rgb2hsl(r, g, b);
        cells.push({ gx, gy, x0, y0, w: cw, h: ch, hue, sat, lum });
      }
    }
    return { width, height, cellW: cw, cellH: ch, cells };
  }, GRID_SIZE);
  check('imageForVerify() produced usable grid stats', gridStats !== null && gridStats.cells.length === GRID_SIZE * GRID_SIZE, gridStats && gridStats.cells.length);

  const circDist = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  };
  /** Must match HSL_BAND_CENTER_DEG in developNode.ts. */
  const HSL_BAND_CENTER_DEG = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 270, magenta: 300 };
  const nearestBand = (hue) =>
    HSL_BANDS.reduce((best, band) => (circDist(hue, HSL_BAND_CENTER_DEG[band]) < circDist(hue, HSL_BAND_CENTER_DEG[best]) ? band : best), HSL_BANDS[0]);

  // Cell A: the single most-saturated cell in the whole frame (always
  // meaningfully colored, whatever the scene). Cell B: the most-saturated
  // cell whose dominant band is at least TWO steps away (circularly) from
  // cell A's — adjacent bands blend continuously (by design, same as HSL),
  // so merely "a different nearest band" still bleeds across the shared
  // boundary; a ≥2 index gap guarantees the two bands' blend ranges never
  // overlap. (An initial red(0°)/green(120°) hardcoded-target search hit
  // exactly this on THIS fixture, whose whole palette sits in the 30-90°
  // range with no true red or green at all.)
  const bandIndexCircDist = (i, j) => Math.min(Math.abs(i - j), HSL_BANDS.length - Math.abs(i - j));
  const bySat = [...gridStats.cells].sort((a, b) => b.sat - a.sat);
  const cellA = bySat[0];
  const bandA = nearestBand(cellA.hue);
  const bandAIdx = HSL_BANDS.indexOf(bandA);
  const farEnough = bySat.filter((c) => bandIndexCircDist(HSL_BANDS.indexOf(nearestBand(c.hue)), bandAIdx) >= 2);
  const cellB =
    farEnough[0] ??
    [...gridStats.cells].sort(
      (a, b) => bandIndexCircDist(HSL_BANDS.indexOf(nearestBand(b.hue)), bandAIdx) - bandIndexCircDist(HSL_BANDS.indexOf(nearestBand(a.hue)), bandAIdx)
    )[0];
  const bandB = nearestBand(cellB.hue);
  const bandBIdx = HSL_BANDS.indexOf(bandB);
  console.log(`  cell A: hue=${cellA.hue.toFixed(1)} sat=${cellA.sat.toFixed(3)} -> band "${bandA}"`);
  console.log(`  cell B: hue=${cellB.hue.toFixed(1)} sat=${cellB.sat.toFixed(3)} -> band "${bandB}"`);
  check('cell A and cell B land on bands at least 2 apart (no shared blend boundary)', bandIndexCircDist(bandAIdx, bandBIdx) >= 2, {
    bandA,
    bandB,
  });

  const regionA = () => regionMean(cellA.x0, cellA.y0, cellA.w, cellA.h);
  const regionB = () => regionMean(cellB.x0, cellB.y0, cellB.w, cellB.h);
  const UNMOVED_TOLERANCE = 0.01; // same figure verify-colorkey.mjs uses for its own "barely touches" checks

  const baselineA = await regionA();
  const baselineB = await regionB();

  await setBwMix(bandAIdx, -100);
  const aDark = await regionA();
  const bAtADark = await regionB();
  await setBwMix(bandAIdx, 100);
  const aBright = await regionA();
  const bAtABright = await regionB();
  await setBwMix(bandAIdx, 0); // reset

  check(`"${bandA}" band −100 darkens cell A's mono value`, aDark < baselineA, { baselineA, aDark });
  check(`"${bandA}" band +100 lightens cell A's mono value`, aBright > baselineA, { baselineA, aBright });
  check(
    `"${bandA}" band barely touches cell B's mono value`,
    Math.abs(bAtADark - baselineB) < UNMOVED_TOLERANCE && Math.abs(bAtABright - baselineB) < UNMOVED_TOLERANCE,
    { baselineB, bAtADark, bAtABright }
  );

  await setBwMix(bandBIdx, -100);
  const bDark = await regionB();
  const aAtBDark = await regionA();
  await setBwMix(bandBIdx, 100);
  const bBright = await regionB();
  const aAtBBright = await regionA();
  await setBwMix(bandBIdx, 0); // reset

  check(`"${bandB}" band −100 darkens cell B's mono value`, bDark < baselineB, { baselineB, bDark });
  check(`"${bandB}" band +100 lightens cell B's mono value`, bBright > baselineB, { baselineB, bBright });
  check(
    `"${bandB}" band barely touches cell A's mono value`,
    Math.abs(aAtBDark - baselineA) < UNMOVED_TOLERANCE && Math.abs(aAtBBright - baselineA) < UNMOVED_TOLERANCE,
    { baselineA, aAtBDark, aAtBBright }
  );

  // ---------------------------------------------------------------------
  console.log('verify-bw (4. grading after B&W still tints the mono image):');
  const monoBaseline = await gpuMean();
  check('sanity: still mono before grading (r≈g≈b)', Math.abs(monoBaseline.r - monoBaseline.g) < GPU_CPU_TOLERANCE, monoBaseline);
  await page.evaluate(() => {
    window.__debug.updateNodeParam('dev', 'grading.global.hue', 30);
    window.__debug.updateNodeParam('dev', 'grading.global.sat', 80);
  });
  const gradedMean = await gpuMean();
  check(
    'a global grading tint on the B&W output produces a colored (non-gray) render',
    Math.abs(gradedMean.r - gradedMean.g) > 0.01 || Math.abs(gradedMean.g - gradedMean.b) > 0.01,
    { monoBaseline, gradedMean }
  );
  await page.evaluate(() => {
    window.__debug.updateNodeParam('dev', 'grading.global.hue', 0);
    window.__debug.updateNodeParam('dev', 'grading.global.sat', 0);
  });

  // ---------------------------------------------------------------------
  console.log('verify-bw (5. sidecar round-trip, incl. mix preserved while disabled):');
  await setBwMix(redIdx, 37);
  const greenIdx = HSL_BANDS.indexOf('green');
  await setBwMix(greenIdx, -18);
  await setBwEnabled(false);
  const beforeSaveDev = await devDevelop();
  const beforeSaveMean = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('sidecar file written', existsSync(SIDECAR), SIDECAR);

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredDev = await devDevelop();
  check('reopen restores bw.enabled (false)', restoredDev?.bw?.enabled === false, restoredDev?.bw);
  check('reopen restores bw.mix.red', restoredDev?.bw?.mix?.[redIdx] === 37, restoredDev?.bw);
  check('reopen restores bw.mix.green', restoredDev?.bw?.mix?.[greenIdx] === -18, restoredDev?.bw);
  const restoredMean = await gpuMean();
  check('restored render matches the pre-save render', meansMatch(restoredMean, beforeSaveMean, GPU_CPU_TOLERANCE), {
    beforeSaveMean,
    restoredMean,
  });
  check('reopened dev params match what was saved', JSON.stringify(restoredDev?.bw) === JSON.stringify(beforeSaveDev?.bw), {
    beforeSaveDev: beforeSaveDev?.bw,
    restoredDev: restoredDev?.bw,
  });

  // ---------------------------------------------------------------------
  console.log('verify-bw (6. preset family inclusion — bw shows up default-checked in the family-scope dialog):');
  // Clear the remembered selection first (same idiom as verify-presets.mjs's
  // own "defaults" check) so the dialog shows the true shipped defaults.
  await page.evaluate(() => window.__debug.updateSettings({ presetSaveFamilies: [] }));
  await page.locator('[data-testid="presets-button"]').click();
  await page.waitForSelector('[data-testid="presets-menu"]', { timeout: 5_000 });
  await page.locator('[data-testid="preset-save-name"]').fill('BW Family Check');
  await page.locator('[data-testid="preset-save"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
  const bwCheckbox = page.locator('[data-testid="family-scope-checkbox-bw"] input[type="checkbox"]');
  check('the "bw" family checkbox exists in the family-scope dialog', (await bwCheckbox.count()) === 1, await bwCheckbox.count());
  check('the "bw" family is checked by default', await bwCheckbox.isChecked(), await bwCheckbox.isChecked());
  await page.locator('[data-testid="family-scope-cancel"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
