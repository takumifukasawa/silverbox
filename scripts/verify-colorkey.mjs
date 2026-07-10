/**
 * ColorKey (secondary) mask verify: the new `colorKey` mask shape (hue/sat/
 * lum keying with per-axis smoothstep falloff — see maskNode.ts's doc
 * comment) plus the mask-deletion edge-drop fix (removeOpNode).
 *
 *  1. Real image: switch a Local Adjustment's mask to colorKey, seed it from
 *     the image's OWN dominant-saturation region (a stand-in for "the known
 *     mint-green leaf hue" — computed in-page from imageForVerify() rather
 *     than hardcoded, so this keeps working if the fixture image changes);
 *     +1.5EV through it ⇒ GPU==CPU parity, the keyed (leaf) region brightens,
 *     a neutral (low-saturation) region stays close to its own baseline.
 *  2. Range behavior: widening hueRange/satRange/lumRange broadens coverage
 *     (the neutral region starts brightening too); inverting flips which
 *     region brightens.
 *  3. Eyedropper: click-to-seed changes shapes[0]'s hue/sat/lum in ONE undo
 *     entry and exits picking mode (mirrors the WB-eyedropper flow verified
 *     in verify-polish.mjs).
 *  4. Mask deletion semantics: deleting the mask node feeding a blend's
 *     'mask' port DROPS that edge (not the generic bypass rewire) — the
 *     blend falls back to its uniform factor; one undo entry restores it.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;
const GRID_SIZE = 10;

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
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const edgeList = (g) =>
    g.edges.map((e) => `${e.source}->${e.target}${e.targetHandle ? ':' + e.targetHandle : ''}`).sort();
  const updateNodeParam = (nodeId, key, value) =>
    page.evaluate(([n, k, v]) => window.__debug.updateNodeParam(n, k, v), [nodeId, key, value]);
  const setMaskShape = (nodeId, shape) =>
    page.evaluate(([n, s]) => window.__debug.setMaskShape(n, s), [nodeId, shape]);
  const maskState = (nodeId) => page.evaluate((n) => window.__debug.maskState(n), nodeId ?? null);

  /** Mean brightness (0..1) of a crop of the CURRENT preview's ENCODED output — a real GPU readback, not a lossy screenshot. */
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

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (setup: default graph + Local Adjustment):');
  await openAndWait(ARW_PATH);
  await page.locator('[data-testid="add-local-adjustment"]').click();
  const gAfterLA = await graphState();
  check(
    'D/M/B wired as usual (mask-1 feeds blend-1:mask)',
    edgeList(gAfterLA).includes('mask-1->blend-1:mask'),
    edgeList(gAfterLA)
  );

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (type selector: radial -> colorKey, one undo entry):');
  const pastBeforeType = await historyPast();
  await page.locator('[data-testid="mask-type-colorkey"]').click();
  check('switching to colorKey is exactly one undo entry', (await historyPast()) === pastBeforeType + 1, {
    before: pastBeforeType,
    after: await historyPast(),
  });
  const afterTypeSwitch = await maskState('mask-1');
  check("mask-1's shape type is now 'colorKey'", afterTypeSwitch?.shapes?.[0]?.type === 'colorKey', afterTypeSwitch);

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (locate a leaf-like (high-sat) region and a neutral (low-sat) region in-page):');
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
  const sorted = [...gridStats.cells].sort((a, b) => a.sat - b.sat);
  const neutralCell = sorted[0];
  const leafCell = sorted[sorted.length - 1];
  console.log(`  leaf-like cell: hue=${leafCell.hue.toFixed(1)} sat=${leafCell.sat.toFixed(3)} lum=${leafCell.lum.toFixed(3)}`);
  console.log(`  neutral cell:   hue=${neutralCell.hue.toFixed(1)} sat=${neutralCell.sat.toFixed(3)} lum=${neutralCell.lum.toFixed(3)}`);
  check('leaf-like cell is meaningfully more saturated than the neutral cell', leafCell.sat > neutralCell.sat + 0.05, {
    leafSat: leafCell.sat,
    neutralSat: neutralCell.sat,
  });

  const narrowShape = {
    type: 'colorKey',
    mode: 'add',
    hue: leafCell.hue,
    hueRange: 40,
    sat: leafCell.sat,
    satRange: 0.4,
    lum: leafCell.lum,
    lumRange: 0.6,
    softness: 0.5,
    invert: false,
  };

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (1. real image: GPU==CPU, leaf region brightens, neutral region stable):');
  await setMaskShape('mask-1', narrowShape);
  await updateNodeParam('dev-1', 'basic.ev', 0);
  const preLeaf = await regionMean(leafCell.x0, leafCell.y0, leafCell.w, leafCell.h);
  const preNeutral = await regionMean(neutralCell.x0, neutralCell.y0, neutralCell.w, neutralCell.h);
  await updateNodeParam('dev-1', 'basic.ev', 1.5);
  const colorKeyGpu = await gpuMean();
  const colorKeyCpu = await cpuMean();
  check('colorKey masked edit: GPU matches CPU within 1/255', meansMatch(colorKeyGpu, colorKeyCpu), {
    colorKeyGpu,
    colorKeyCpu,
  });
  const postLeaf = await regionMean(leafCell.x0, leafCell.y0, leafCell.w, leafCell.h);
  const postNeutral = await regionMean(neutralCell.x0, neutralCell.y0, neutralCell.w, neutralCell.h);
  check('the keyed (leaf-like) region brightens under the masked +1.5EV edit', postLeaf > preLeaf + 0.01, {
    preLeaf,
    postLeaf,
  });
  check('the neutral region stays close to its pre-edit baseline', Math.abs(postNeutral - preNeutral) < 0.02, {
    preNeutral,
    postNeutral,
  });

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (2. range behavior: widening ranges broadens coverage; invert flips it):');
  const widenedShape = { ...narrowShape, hueRange: 170, satRange: 1, lumRange: 1 };
  await setMaskShape('mask-1', widenedShape);
  const widenedNeutral = await regionMean(neutralCell.x0, neutralCell.y0, neutralCell.w, neutralCell.h);
  check('widening hue/sat/lum ranges brings the neutral region into the key too (it now brightens)', widenedNeutral > postNeutral + 0.02, {
    postNeutral,
    widenedNeutral,
  });

  await setMaskShape('mask-1', { ...narrowShape, invert: true });
  const invertedLeaf = await regionMean(leafCell.x0, leafCell.y0, leafCell.w, leafCell.h);
  const invertedNeutral = await regionMean(neutralCell.x0, neutralCell.y0, neutralCell.w, neutralCell.h);
  check('inverting: the neutral region now brightens (it is now inside the key)', invertedNeutral > preNeutral + 0.01, {
    preNeutral,
    invertedNeutral,
  });
  check('inverting: the leaf region no longer brightens (near its own pre-edit baseline)', Math.abs(invertedLeaf - preLeaf) < 0.02, {
    preLeaf,
    invertedLeaf,
  });
  // restore the narrow, non-inverted shape for the following checks
  await setMaskShape('mask-1', narrowShape);

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (3. eyedropper: click-to-seed changes hue/sat/lum in one undo entry, exits picking):');
  const farOffShape = { ...narrowShape, hue: 10, sat: 0.05, lum: 0.05 };
  await setMaskShape('mask-1', farOffShape);
  const pastBeforePick = await historyPast();
  await page.locator('[data-testid="colorkey-eyedropper"]').click();
  const eyedropperButton = page.locator('[data-testid="colorkey-eyedropper"]');
  check('eyedropper button shows picking state', (await eyedropperButton.textContent())?.includes('Click the image'), await eyedropperButton.textContent());
  const canvas = page.locator('.canvas-view-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const canvasBox = await canvas.boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + canvasBox.height * 0.4);
  await page.waitForFunction(
    (before) => window.__debug.historyState().past === before + 1,
    pastBeforePick,
    { timeout: 10_000 }
  );
  const afterPick = await maskState('mask-1');
  const pickedShape = afterPick.shapes[0];
  check(
    'picking a canvas pixel changed hue/sat/lum away from the far-off seed',
    pickedShape.hue !== farOffShape.hue || pickedShape.sat !== farOffShape.sat || pickedShape.lum !== farOffShape.lum,
    { farOffShape, pickedShape }
  );
  check(
    'picking left ranges/softness/invert untouched',
    pickedShape.hueRange === farOffShape.hueRange &&
      pickedShape.satRange === farOffShape.satRange &&
      pickedShape.lumRange === farOffShape.lumRange &&
      pickedShape.softness === farOffShape.softness &&
      pickedShape.invert === farOffShape.invert,
    pickedShape
  );
  check('picking is exactly one undo entry', (await historyPast()) === pastBeforePick + 1, {
    before: pastBeforePick,
    after: await historyPast(),
  });
  check('picking mode exits after the click', (await eyedropperButton.textContent())?.trim() === 'Eyedropper', await eyedropperButton.textContent());
  // restore the narrow shape before the deletion test
  await setMaskShape('mask-1', narrowShape);

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (sidecar round-trip: colorKey shape survives save/reload):');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await openAndWait(ARW_PATH);
  const reloadedMask = (await graphState()).nodes.find((n) => n.id === 'mask-1');
  const reloadedShape = reloadedMask?.mask?.shapes?.[0];
  check("reload restores mask-1's shape type ('colorKey')", reloadedShape?.type === 'colorKey', reloadedShape);
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;
  check(
    'reload restores colorKey hue/hueRange/sat/satRange/lum/lumRange/softness (within float round-trip noise)',
    near(reloadedShape?.hue, narrowShape.hue) &&
      near(reloadedShape?.hueRange, narrowShape.hueRange) &&
      near(reloadedShape?.sat, narrowShape.sat) &&
      near(reloadedShape?.satRange, narrowShape.satRange) &&
      near(reloadedShape?.lum, narrowShape.lum) &&
      near(reloadedShape?.lumRange, narrowShape.lumRange) &&
      near(reloadedShape?.softness, narrowShape.softness),
    { narrowShape, reloadedShape }
  );

  // ---------------------------------------------------------------------
  console.log('verify-colorkey (4. deletion semantics: deleting the mask node DROPS the blend mask edge):');
  const gBeforeDelete = await graphState();
  check("blend-1's mask edge exists before deletion", edgeList(gBeforeDelete).includes('mask-1->blend-1:mask'), edgeList(gBeforeDelete));
  await page.locator('.react-flow__node[data-id="mask-1"]').click();
  const pastBeforeDelete = await historyPast();
  await page.locator('[data-testid="delete-node-button"]').click();
  check('deleting the mask node is exactly one undo entry', (await historyPast()) === pastBeforeDelete + 1, {
    before: pastBeforeDelete,
    after: await historyPast(),
  });
  const gAfterDelete = await graphState();
  check(
    "blend-1's mask edge is GONE (not rewired to any other source)",
    !gAfterDelete.edges.some((e) => e.target === 'blend-1' && e.targetHandle === 'mask'),
    edgeList(gAfterDelete)
  );
  check('mask-1 node itself is gone', !gAfterDelete.nodes.some((n) => n.id === 'mask-1'), gAfterDelete.nodes.map((n) => n.id));
  // without a mask, blend-1's amount=1 uniform factor applies dev-1's +1.5EV
  // uniformly — the leaf/neutral distinction from check 1 should collapse
  const uniformLeaf = await regionMean(leafCell.x0, leafCell.y0, leafCell.w, leafCell.h);
  const uniformNeutral = await regionMean(neutralCell.x0, neutralCell.y0, neutralCell.w, neutralCell.h);
  check(
    'render falls back to a uniform-factor blend: the neutral region now brightens like the leaf region did',
    uniformNeutral > preNeutral + 0.01,
    { preNeutral, uniformNeutral, uniformLeaf }
  );

  console.log('verify-colorkey (4. undo restores the deleted mask node + its blend mask edge):');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(() => window.__debug.graphState().nodes.some((n) => n.id === 'mask-1'), { timeout: 5_000 });
  const gAfterUndo = await graphState();
  check('undo restores mask-1', gAfterUndo.nodes.some((n) => n.id === 'mask-1'), gAfterUndo.nodes.map((n) => n.id));
  check("undo restores blend-1's mask edge", edgeList(gAfterUndo).includes('mask-1->blend-1:mask'), edgeList(gAfterUndo));

  check('no page errors across the colorKey checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
