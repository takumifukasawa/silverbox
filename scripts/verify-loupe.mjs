/**
 * Eyedropper loupe verify (PixelLoupe.tsx):
 *  1. Armed WB eyedropper + hover → the loupe appears, its center cell is the
 *     canvas pixel under the cursor, and its RGB readout equals that
 *     displayed pixel.
 *  2. Leaving the canvas hides it; a click picks WB and hides it; Escape
 *     disarms and hides it.
 *  3. No loupe while the eyedropper is not armed.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();

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
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.locator('.react-flow__node[data-id="dev"]').click();
  const canvas = page.locator('[data-testid="canvas-view-canvas"]');
  const loupe = page.locator('[data-testid="pixel-loupe"]');
  const box = await canvas.boundingBox();
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.55 };

  console.log('verify-loupe (3. not armed):');
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(200);
  check('no loupe while the eyedropper is off', (await loupe.count()) === 0, null);

  console.log('verify-loupe (1. armed + hover):');
  await page.locator('[data-testid="wb-eyedropper"]').click();
  await page.mouse.move(at.x - 3, at.y - 3);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(300);
  check('the loupe appears', (await loupe.count()) === 1, null);
  const got = {
    ix: Number(await loupe.getAttribute('data-ix')),
    iy: Number(await loupe.getAttribute('data-iy')),
    rgb: await loupe.getAttribute('data-rgb'),
  };
  // Where the cursor lands per the canvas's own bounding box. At fit zoom
  // one image pixel is a fraction of a screen pixel, so this estimate may
  // round to the neighbour; the exact pick mapping is shared code
  // (localToImagePixel) and unit-tested.
  const expected = await page.evaluate(
    ([cx, cy, ix, iy]) => {
      const c = document.querySelector('[data-testid="canvas-view-canvas"]');
      const r = c.getBoundingClientRect();
      const s = r.width / c.width;
      const t = document.createElement('canvas');
      t.width = 1;
      t.height = 1;
      const g = t.getContext('2d');
      g.drawImage(c, ix, iy, 1, 1, 0, 0, 1, 1);
      return {
        ix: Math.floor((cx - r.left) / s),
        iy: Math.floor((cy - r.top) / s),
        rgbAtLoupePixel: Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(','),
      };
    },
    [at.x, at.y, got.ix, got.iy]
  );
  check(
    'center cell is the pixel under the cursor (within sub-pixel rounding)',
    Math.abs(got.ix - expected.ix) <= 1 && Math.abs(got.iy - expected.iy) <= 1,
    { got, expected }
  );
  check('RGB readout equals the displayed pixel at the outlined cell', got.rgb === expected.rgbAtLoupePixel, { got, expected });
  // Widest readout ("R 255" x3 + a 4-digit coordinate) must stay inside its
  // own box, below the magnified grid (it once wrapped onto the grid).
  const readout = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="pixel-loupe"]');
    const grid = root.querySelector('.pixel-loupe-grid').getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const spans = [...root.querySelectorAll('.pixel-loupe-readout span')];
    const worst = ['R 255', 'G 255', 'B 255', '8191, 5463'];
    spans.forEach((s, i) => (s.textContent = worst[i] ?? s.textContent));
    const rects = spans.map((s) => s.getBoundingClientRect());
    return {
      gridBottom: grid.bottom,
      boxBottom: box.bottom,
      boxRight: box.right,
      spanTop: Math.min(...rects.map((r) => r.top)),
      spanBottom: Math.max(...rects.map((r) => r.bottom)),
      spanRight: Math.max(...rects.map((r) => r.right)),
    };
  });
  check(
    'widest RGB readout stays below the magnified grid and inside the loupe',
    readout.spanTop >= readout.gridBottom && readout.spanBottom <= readout.boxBottom && readout.spanRight <= readout.boxRight,
    readout
  );
  const lb = await loupe.boundingBox();
  check('the loupe does not cover the cursor', !(at.x >= lb.x && at.x <= lb.x + lb.width && at.y >= lb.y && at.y <= lb.y + lb.height), lb);
  await page.mouse.move(at.x + 5, at.y);
  await page.waitForTimeout(200);
  const moved = Number(await loupe.getAttribute('data-ix'));
  check('the loupe follows the pointer', moved !== got.ix, { before: got.ix, moved });

  console.log('verify-loupe (2. hide):');
  await page.mouse.move(box.x - 40, box.y - 40);
  await page.waitForTimeout(200);
  check('leaving the canvas hides it', (await loupe.count()) === 0, null);
  const tempBefore = await page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.temp);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(200);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  const tempAfter = await page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.temp);
  check('a click still picks WB through the loupe', tempAfter !== tempBefore, { tempBefore, tempAfter });
  check('picking hides the loupe', (await loupe.count()) === 0, null);
  await page.locator('[data-testid="wb-eyedropper"]').click();
  await page.mouse.move(at.x + 2, at.y + 2);
  await page.waitForTimeout(200);
  check('re-armed loupe is back', (await loupe.count()) === 1, null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape disarms and hides it', (await loupe.count()) === 0, null);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
