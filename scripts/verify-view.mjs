/**
 * Viewer toggles: Before/After shows the unedited decode (\ key + A/B
 * button, badge, readbacks follow so the histogram matches the screen), and
 * the grayscale check view desaturates the CANVAS ONLY — readbacks and
 * therefore exports keep their color.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

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

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());

  // channel means of the on-screen canvas, via a screenshot decoded by sharp
  const canvasChannelMeans = async () => {
    const buf = await page.locator('.canvas-view-canvas').screenshot();
    const stats = await sharp(buf).stats();
    return { r: stats.channels[0].mean / 255, g: stats.channels[1].mean / 255, b: stats.channels[2].mean / 255 };
  };

  console.log('verify-view (before/after):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2));
  const edited = await gpuMean();
  check('exposure edit brightens first', edited.g > neutral.g + 0.1, { neutral, edited });

  await page.keyboard.press('\\');
  await page.waitForSelector('[data-testid="before-badge"]', { timeout: 5_000 });
  check('\\ shows the Before badge', true, true);
  const before = await gpuMean();
  check('before view shows the unedited decode', meansMatch(before, neutral), { neutral, before });

  await page.keyboard.press('\\');
  await page.waitForSelector('[data-testid="before-badge"]', { state: 'detached', timeout: 5_000 });
  const after = await gpuMean();
  check('toggling back restores the edit', meansMatch(after, edited), { edited, after });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));

  console.log('verify-view (grayscale check view):');
  const colorCanvas = await canvasChannelMeans();
  check(
    'color view shows a colorful canvas (r ≠ b)',
    Math.abs(colorCanvas.r - colorCanvas.b) > 0.02,
    colorCanvas
  );
  await page.locator('[data-testid="view-grayscale"]').click();
  // the render effect is synchronous with the state change; give one frame
  await page.waitForTimeout(300);
  const grayCanvas = await canvasChannelMeans();
  check(
    'grayscale view renders r ≈ g ≈ b on screen',
    Math.abs(grayCanvas.r - grayCanvas.g) < 0.01 && Math.abs(grayCanvas.b - grayCanvas.g) < 0.01,
    grayCanvas
  );
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'view-grayscale.png') });
  const readbackInGray = await gpuMean();
  check('readbacks (and exports) keep their color in grayscale view', meansMatch(readbackInGray, neutral), {
    neutral,
    readbackInGray,
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  const backToColor = await canvasChannelMeans();
  check('G toggles back to the color view', Math.abs(backToColor.r - backToColor.b) > 0.02, backToColor);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
