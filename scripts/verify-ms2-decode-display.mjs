/**
 * Milestone 2 verify: open a real ARW and a real JPEG through the app's own
 * pipeline (IPC file read → worker decode → linearize → preview downsample →
 * canvas display) and confirm dimensions, toolbar info, and displayed pixels.
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
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
rmSidecarSync(JPG_PATH + '.silverbox.json', { force: true });

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
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  const openAndWait = async (path) => {
    // fire-and-forget: a page.evaluate that stays in flight across the decode
    // can be killed by a transient execution-context teardown during decode GC
    // (waitForFunction below is resilient to that; a held evaluate is not)
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );
    return page.evaluate(() => window.__debug.imageState());
  };

  // ---- RAW ----
  console.log('verify-ms2 (RAW):');
  const rawState = await openAndWait(ARW_PATH);
  check('RAW decode succeeds', rawState.status === 'ready', rawState);
  check('RAW full size is 4624×3080', rawState.fullWidth === 4624 && rawState.fullHeight === 3080, rawState);
  check(
    'RAW preview long edge is 2560',
    Math.max(rawState.width, rawState.height) === 2560,
    { w: rawState.width, h: rawState.height }
  );
  check(
    'RAW preview keeps aspect ratio',
    Math.abs(rawState.width / rawState.height - 4624 / 3080) < 0.01,
    rawState.width / rawState.height
  );

  const rawMean = await page.evaluate(() => window.__debug.readbackMean());
  check(
    'RAW display is neither black nor blown out',
    rawMean && rawMean.r > 0.02 && rawMean.r < 0.98 && rawMean.g > 0.02 && rawMean.g < 0.98,
    rawMean
  );

  const toolbarText = await page.locator('.toolbar-info').textContent();
  check('toolbar shows file name', toolbarText?.includes('DSC02993.ARW'), toolbarText);
  check('toolbar shows camera model', toolbarText?.includes('ILCE-7CM2'), toolbarText);
  check('toolbar shows ISO', toolbarText?.includes('ISO 5000'), toolbarText);

  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms2-raw.png') });

  // ---- JPEG (same scene straight out of camera) ----
  console.log('verify-ms2 (JPEG):');
  const jpgState = await openAndWait(JPG_PATH);
  check('JPEG decode succeeds', jpgState.status === 'ready', jpgState);
  check(
    'JPEG preview long edge is 2560',
    Math.max(jpgState.width, jpgState.height) === 2560,
    { w: jpgState.width, h: jpgState.height }
  );
  const jpgMean = await page.evaluate(() => window.__debug.readbackMean());
  check(
    'JPEG display is neither black nor blown out',
    jpgMean && jpgMean.r > 0.02 && jpgMean.r < 0.98,
    jpgMean
  );

  // same scene: per-channel means of RAW and camera JPEG should be in the same
  // ballpark (camera applies its own tone curve, so allow a generous margin)
  check(
    'RAW and JPEG show the same scene (channel means within 0.25)',
    Math.abs(rawMean.r - jpgMean.r) < 0.25 &&
      Math.abs(rawMean.g - jpgMean.g) < 0.25 &&
      Math.abs(rawMean.b - jpgMean.b) < 0.25,
    { rawMean, jpgMean }
  );

  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms2-jpg.png') });
  console.log('screenshots: test-artifacts/ms2-raw.png, ms2-jpg.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
