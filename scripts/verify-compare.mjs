/**
 * Compare view (compare pack, docs/brief-bank/compare-view-and-ratings.md):
 * a toolbar toggle (+ `C` shortcut) splits the canvas into two synced panes
 * sharing ONE viewport (pan/zoom moves both). Mode A (default): CURRENT vs
 * BEFORE, reusing the exact "before" render showBefore drives. Mode B (2+
 * outputs): the active output vs a second output picked from the compare
 * strip's dropdown. A modal canvas tool like crop/spot/maskDraw/the
 * eyedroppers — deactivateOtherTools (appStore.ts) gains 'compare'; Escape
 * exits (App.tsx).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
const GPU_TOLERANCE = 1 / 255;

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

const meansMatch = (a, b, tol = GPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const meansDiffer = (a, b, minDelta = 0.05) =>
  a && b && (Math.abs(a.r - b.r) > minDelta || Math.abs(a.g - b.g) > minDelta || Math.abs(a.b - b.b) > minDelta);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const compareState = () => page.evaluate(() => window.__debug.compareState());
  const mainMean = () => page.evaluate(() => window.__debug.readbackMean());
  const compareMean = () => page.evaluate(() => window.__debug.compareReadbackMean());
  const isActive = (testid) => page.locator(`[data-testid="${testid}"]`).evaluate((el) => el.classList.contains('active'));

  // -------------------------------------------------------------------
  console.log('verify-compare (1. toolbar toggle shows the compare pane, synced view transforms):');
  const paneDisplayBefore = await page.locator('[data-testid="compare-pane"]').evaluate((el) => getComputedStyle(el).display);
  check('compare pane is hidden (display:none) before toggling on', paneDisplayBefore === 'none', paneDisplayBefore);

  await page.locator('[data-testid="compare-toggle"]').click();
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  check('toggle button sets compareMode', (await compareState()).mode, await compareState());
  check('the toolbar button shows active', await isActive('compare-toggle'), await isActive('compare-toggle'));
  const paneDisplayAfter = await page.locator('[data-testid="compare-pane"]').evaluate((el) => getComputedStyle(el).display);
  check('compare pane becomes visible', paneDisplayAfter !== 'none', paneDisplayAfter);

  // pan one (drag on the MAIN container) — both canvases' transforms must move identically
  const box = await page.locator('.canvas-viewport').boundingBox();
  const beforeMainT = await page.locator('[data-testid="canvas-view-canvas"]').evaluate((el) => el.style.transform);
  const beforeCompareT = await page.locator('[data-testid="compare-canvas"]').evaluate((el) => el.style.transform);
  check('both canvases start with the SAME transform (fit is shared)', beforeMainT === beforeCompareT, {
    beforeMainT,
    beforeCompareT,
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 25, { steps: 4 });
  await page.mouse.up();
  const afterMainT = await page.locator('[data-testid="canvas-view-canvas"]').evaluate((el) => el.style.transform);
  const afterCompareT = await page.locator('[data-testid="compare-canvas"]').evaluate((el) => el.style.transform);
  check('panning the MAIN pane moved it', afterMainT !== beforeMainT, { beforeMainT, afterMainT });
  check(
    'the compare pane moved IDENTICALLY (shared viewport, one event binding)',
    afterCompareT === afterMainT,
    { afterMainT, afterCompareT }
  );
  // restore the fit view so later mean comparisons aren't affected by a pan-clipped viewport
  await page.locator('[data-testid="view-fit"]').click();

  // -------------------------------------------------------------------
  console.log('verify-compare (2. Mode A: current vs before, panes differ after an edit):');
  const neutralMain = await mainMean();
  const neutralCompare = await compareMean();
  check('before any edit, Mode A panes match (both show the unedited decode)', meansMatch(neutralMain, neutralCompare), {
    neutralMain,
    neutralCompare,
  });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2));
  await page.waitForTimeout(400);
  const editedMain = await mainMean();
  const editedCompare = await compareMean();
  check('the main (current) pane brightens with the edit', editedMain.g > neutralMain.g + 0.1, { neutralMain, editedMain });
  check('the compare (before) pane is UNCHANGED by the edit', meansMatch(editedCompare, neutralCompare), {
    neutralCompare,
    editedCompare,
  });
  check('Mode A panes now differ (current vs before)', meansDiffer(editedMain, editedCompare), { editedMain, editedCompare });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------
  console.log('verify-compare (3. compare strip dropdown only appears with 2+ outputs):');
  check(
    'no compare-output-selector with a single output',
    (await page.locator('[data-testid="compare-output-selector"]').count()) === 0,
    await page.locator('[data-testid="compare-output-selector"]').count()
  );

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-output"]').click();
  const gWithSecondOutput = await page.evaluate(() => window.__debug.graphState());
  const secondOutputId = gWithSecondOutput.nodes.find((n) => n.kind === 'output' && n.id !== 'out').id;
  // wire the second output straight off the input node (bypassing Develop) so
  // its render visibly differs from 'out' once an edit is applied — same
  // debug-hook wiring verify-exportsettings.mjs uses (a mouse drag-to-wire
  // here is ms13's own coverage, not this script's concern).
  await page.evaluate((target) => window.__debug.connectEdge('in', target), secondOutputId);

  const selectorOptions = await page
    .locator('[data-testid="compare-output-selector"]')
    .locator('option')
    .allTextContents();
  check('the dropdown appears once a second output exists, offering "Before" + the other output', (
    selectorOptions.includes('Before') && selectorOptions.length === 2
  ), selectorOptions);

  // -------------------------------------------------------------------
  console.log('verify-compare (4. Mode B: two outputs\' means match their solo renders):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.5));
  await page.waitForTimeout(300);
  const outSoloMean = await mainMean();

  // solo-render the second output by switching activeOutputId via the REAL
  // output-selector (appears now that there are 2+ outputs) — briefly, to
  // capture its ground-truth mean, then switch back to 'out'.
  await page.locator('[data-testid="output-selector"]').selectOption(secondOutputId);
  await page.waitForTimeout(300);
  const secondSoloMean = await mainMean();
  await page.locator('[data-testid="output-selector"]').selectOption('out');
  await page.waitForTimeout(300);
  check(
    "switching back to 'out' restores its solo mean",
    meansMatch(await mainMean(), outSoloMean),
    { outSoloMean, restored: await mainMean() }
  );
  check('the two outputs actually differ (setup sanity)', meansDiffer(outSoloMean, secondSoloMean), {
    outSoloMean,
    secondSoloMean,
  });

  await page.locator('[data-testid="compare-output-selector"]').selectOption(secondOutputId);
  await page.waitForTimeout(300);
  const modeBMain = await mainMean();
  const modeBCompare = await compareMean();
  check("Mode B's main pane still shows the active output ('out'), matching its solo mean", meansMatch(modeBMain, outSoloMean), {
    outSoloMean,
    modeBMain,
  });
  check("Mode B's compare pane shows the PICKED second output, matching its solo mean", meansMatch(modeBCompare, secondSoloMean), {
    secondSoloMean,
    modeBCompare,
  });

  // back to "Before" (Mode A) via the dropdown
  await page.locator('[data-testid="compare-output-selector"]').selectOption('');
  await page.waitForTimeout(300);
  check(
    'picking "Before" again returns to Mode A (compare pane shows the unedited decode)',
    meansMatch(await compareMean(), neutralCompare),
    { neutralCompare, backToBefore: await compareMean() }
  );
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------
  console.log("verify-compare (5. 'C' shortcut toggles, isTextEntry-guarded, Escape exits):");
  await page.locator('[data-testid="compare-toggle"]').click(); // off (from Mode B testing above)
  await page.waitForFunction(() => window.__debug.compareState().mode === false, { timeout: 5_000 });
  await page.keyboard.press('c');
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  check("'c' toggles compare mode ON", (await compareState()).mode, await compareState());
  await page.keyboard.press('c');
  await page.waitForFunction(() => window.__debug.compareState().mode === false, { timeout: 5_000 });
  check("'c' toggles compare mode OFF again", !(await compareState()).mode, await compareState());

  // isTextEntry guard: typing 'c' into a genuine text field must not toggle
  await page.evaluate(() => window.__debug.selectNode('out'));
  const outputNameInput = page.locator('[data-testid="output-name"]');
  await outputNameInput.click();
  await outputNameInput.press('c');
  check("'c' typed into a text field does not toggle compare (isTextEntry guard)", !(await compareState()).mode, await compareState());
  await page.keyboard.press('Escape'); // drop focus/blur before continuing
  await page.evaluate(() => window.__debug.selectNode(null));

  await page.locator('[data-testid="compare-toggle"]').click();
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__debug.compareState().mode === false, { timeout: 5_000 });
  check('Escape exits compare mode', !(await compareState()).mode, await compareState());
  const paneDisplayAfterEscape = await page.locator('[data-testid="compare-pane"]').evaluate((el) => getComputedStyle(el).display);
  check('the compare pane hides again after Escape', paneDisplayAfterEscape === 'none', paneDisplayAfterEscape);

  // -------------------------------------------------------------------
  console.log('verify-compare (6. modal tools are mutually exclusive — one canvas tool at a time):');
  await page.locator('[data-testid="compare-toggle"]').click();
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  await page.locator('[data-testid="crop-toggle"]').click();
  check('activating crop deactivates compare', !(await compareState()).mode && (await isActive('crop-toggle')), {
    compareMode: (await compareState()).mode,
    crop: await isActive('crop-toggle'),
  });
  await page.locator('[data-testid="compare-toggle"]').click();
  check('activating compare deactivates crop', (await compareState()).mode && !(await isActive('crop-toggle')), {
    compareMode: (await compareState()).mode,
    crop: await isActive('crop-toggle'),
  });
  await page.locator('[data-testid="spots-toggle"]').click();
  check('activating spots deactivates compare', (await page.locator('[data-testid="spots-toggle"]').evaluate((el) => el.classList.contains('active'))) && !(await compareState()).mode, {
    spots: await isActive('spots-toggle'),
    compareMode: (await compareState()).mode,
  });
  await page.locator('[data-testid="compare-toggle"]').click();
  check('activating compare deactivates spots', (await compareState()).mode && !(await isActive('spots-toggle')), {
    compareMode: (await compareState()).mode,
    spots: await isActive('spots-toggle'),
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__debug.compareState().mode === false, { timeout: 5_000 });

  check('no page errors across the compare verify checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
