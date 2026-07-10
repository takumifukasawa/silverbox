/**
 * Spec-alignment verify (REBUILD-SPEC MS6 remainder): editor robustness.
 * Deleting an edge breaks the path → yellow banner + pass-through preview
 * (never a crash); undo restores. Rejected connections show a transient red
 * notice. Toolbar Undo/Redo buttons and ⌘Y work.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());

  console.log('verify-editing (broken path = banner + pass-through):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2));
  const brightened = await page.evaluate(() => window.__debug.readbackMean());
  check('exposure edit brightens first', brightened.g > neutral.g + 0.1, { neutral, brightened });

  // delete the Develop→output edge by selecting it and pressing Backspace
  // (click exactly on the bezier path — its bbox center is off the curve)
  const edgePoint = await page.evaluate(() => {
    const path = document.querySelector('.react-flow__edge[data-id="e1"] path');
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const ctm = path.getScreenCTM();
    return { x: ctm.a * p.x + ctm.c * p.y + ctm.e, y: ctm.b * p.x + ctm.d * p.y + ctm.f };
  });
  await page.mouse.click(edgePoint.x, edgePoint.y);
  await page.keyboard.press('Backspace');
  await page.waitForSelector('[data-testid="broken-banner"]', { timeout: 5_000 });
  check('broken-path banner appears', true, true);
  const passThrough = await page.evaluate(() => window.__debug.readbackMean());
  check('preview falls back to the unedited image (pass-through)', meansMatch(passThrough, neutral), {
    neutral,
    passThrough,
  });

  await page.keyboard.press('Meta+z');
  await page.waitForSelector('[data-testid="broken-banner"]', { state: 'detached', timeout: 5_000 });
  check('undo restores the edge and clears the banner', true, true);
  const restored = await page.evaluate(() => window.__debug.readbackMean());
  check('preview shows the edit again', meansMatch(restored, brightened), { brightened, restored });

  console.log('verify-editing (rejected connection notice):');
  // output → Develop would be a cycle
  const outSrc = page.locator('.react-flow__node[data-id="dev"] .react-flow__handle.source');
  const devTarget = page.locator('.react-flow__node[data-id="dev"] .react-flow__handle.target');
  const a = await outSrc.boundingBox();
  const b = await devTarget.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  const noticeShown = await page
    .waitForSelector('[data-testid="reject-banner"]', { timeout: 5_000 })
    .then(() => true, () => false);
  check('rejected connection shows the red notice', noticeShown, noticeShown);

  console.log('verify-editing (toolbar undo/redo + ⌘Y):');
  check(
    'undo button reflects history',
    await page.locator('[data-testid="undo-button"]').isEnabled(),
    await page.locator('[data-testid="undo-button"]').isEnabled()
  );
  await page.locator('[data-testid="undo-button"]').click();
  const evAfterUndo = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('toolbar undo reverts the exposure edit', evAfterUndo === 0, evAfterUndo);
  await page.locator('[data-testid="redo-button"]').click();
  const evAfterRedo = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('toolbar redo restores it', evAfterRedo === 2, evAfterRedo);
  await page.keyboard.press('Meta+y');
  const evAfterY = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev
  );
  check('⌘Y undoes like ⌘Z', evAfterY === 0, evAfterY);

  console.log('verify-editing (node drag: follows the pointer, ONE commit, ≤2 worker re-renders — #pointer-drag-lag):');
  // Root cause: position is layout-only (buildPlan never reads it), but the
  // OLD code re-derived React Flow's `nodes` prop fresh from the store every
  // render with no onNodesChange handler, so the node's visual position was
  // never updated per mouse-move at all — it only caught up on whatever
  // incidental re-render happened to fire, which read as "lags far behind
  // the cursor." The fix: drag positions live in NodeEditorPanel's own local
  // React state (via onNodesChange/applyNodeChanges); the GraphDoc — and the
  // render worker post it drives — only sees ONE commit, at drag end.
  const devPosBefore = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev').position
  );
  const pastBeforeDrag = (await page.evaluate(() => window.__debug.historyState())).past;
  const postsBeforeDrag = await page.evaluate(() => window.__debug.renderPostCount());
  const devNode = page.locator('.react-flow__node[data-id="dev"]');
  const devBoxBefore = await devNode.boundingBox();
  const dx = 150;
  const dy = 40;
  const startX = devBoxBefore.x + devBoxBefore.width / 2;
  const startY = devBoxBefore.y + devBoxBefore.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 60 discrete mousemove events, matching a real scripted 60-move drag
  await page.mouse.move(startX + dx, startY + dy, { steps: 60 });
  const devBoxDuringDrag = await devNode.boundingBox();
  check(
    'the node visually follows the pointer DURING the drag (not frozen/lagging behind)',
    Math.abs(devBoxDuringDrag.x - (devBoxBefore.x + dx)) < 20 && Math.abs(devBoxDuringDrag.y - (devBoxBefore.y + dy)) < 20,
    { devBoxBefore, devBoxDuringDrag, expectedDx: dx, expectedDy: dy }
  );
  await page.mouse.up();

  const postsAfterDrag = await page.evaluate(() => window.__debug.renderPostCount());
  check(
    'a 60-move drag posts to the render worker at most twice (position-only edits never re-post the plan)',
    postsAfterDrag - postsBeforeDrag <= 2,
    { postsBeforeDrag, postsAfterDrag, delta: postsAfterDrag - postsBeforeDrag }
  );

  const pastAfterDrag = (await page.evaluate(() => window.__debug.historyState())).past;
  check('the whole drag is exactly ONE undo entry (not one per mouse-move)', pastAfterDrag === pastBeforeDrag + 1, {
    pastBeforeDrag,
    pastAfterDrag,
  });

  const devPosAfter = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev').position
  );
  check(
    'the GraphDoc position commits once, at drag end',
    devPosAfter.x !== devPosBefore.x || devPosAfter.y !== devPosBefore.y,
    { devPosBefore, devPosAfter }
  );
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
