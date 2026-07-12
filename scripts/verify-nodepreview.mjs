/**
 * Per-node preview (per-node-preview pack, docs/brief-bank/per-node-preview.md):
 * tier 1 — every op node in the graph editor shows a live ~64px thumbnail of
 * ITS OWN output (renderer-side batch downsample of the retained per-step
 * textures, refreshed on a 300ms post-render debounce, blob: URL lifecycle
 * with a revocation audit — see engine/thumbnail/nodeThumbCache.ts); tier 2 —
 * "inspect mode" (the eye button / ⌥-click) previews ONE node's own output on
 * the main canvas (buildPlan's inspectNodeId truncates the chain at that
 * node), badged, exits via ✕/Escape/image-switch, mutually exclusive with
 * compare mode.
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
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

// autosave (default on) persists sidecars across suite scripts — isolate
const { rmSync: rmSidecarSync } = await import('node:fs');
rmSidecarSync(ARW_PATH + '.silverbox.json', { force: true });
rmSidecarSync(JPG_PATH + '.silverbox.json', { force: true });
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

  const nodeThumbs = () => page.evaluate(() => window.__debug.nodeThumbsState());
  const thumbRevocations = () => page.evaluate(() => window.__debug.nodeThumbRevocations());
  const inspectState = () => page.evaluate(() => window.__debug.inspectState());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const mainMean = () => page.evaluate(() => window.__debug.readbackMean());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const setEv = (v) => page.evaluate((v) => window.__debug.updateNodeParam('dev', 'basic.ev', v), v);

  // -------------------------------------------------------------------
  console.log('verify-nodepreview (1. every reachable node gets a live thumbnail; deletion prunes + revokes it):');
  await page.waitForFunction(
    () => {
      const t = window.__debug.nodeThumbsState();
      return !!(t.in && t.dev && t.out);
    },
    { timeout: 5_000 }
  );
  const initialThumbs = await nodeThumbs();
  check("the input node ('in') has a thumbnail", !!initialThumbs.in, initialThumbs);
  check("the Develop node ('dev') has a thumbnail", !!initialThumbs.dev, initialThumbs);
  check("the output node ('out') has a thumbnail", !!initialThumbs.out, initialThumbs);

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-brightness"]').click();
  const gWithBrightness = await graphState();
  const brightNodeId = gWithBrightness.nodes.find((n) => n.kind === 'brightness').id;
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'amount', 0.4), brightNodeId);
  await page.waitForFunction(
    (id) => !!window.__debug.nodeThumbsState()[id],
    brightNodeId,
    { timeout: 5_000 }
  );
  check('the newly added op node also gets a thumbnail', !!(await nodeThumbs())[brightNodeId], await nodeThumbs());

  const revocationsBeforeDelete = (await thumbRevocations()).length;
  const urlBeforeDelete = (await nodeThumbs())[brightNodeId];
  await page.evaluate((id) => window.__debug.selectNode(id), brightNodeId);
  await page.locator('[data-testid="delete-node-button"]').click();
  const thumbsAfterDelete = await nodeThumbs();
  check(
    'deleting the node prunes its thumbnail entry IMMEDIATELY (no need to wait for the next debounce)',
    !(brightNodeId in thumbsAfterDelete),
    thumbsAfterDelete
  );
  const revocationsAfterDelete = await thumbRevocations();
  check(
    "the deleted node's blob: URL was revoked (revocation audit)",
    revocationsAfterDelete.length > revocationsBeforeDelete && revocationsAfterDelete.includes(urlBeforeDelete),
    { urlBeforeDelete, revocationsAfterDelete }
  );

  // -------------------------------------------------------------------
  console.log('verify-nodepreview (2. an edit refreshes ITS OWN node thumbnail but leaves an upstream one untouched):');
  await setEv(0);
  await page.waitForTimeout(500); // settle at neutral before the baseline snapshot
  const beforeEdit = await nodeThumbs();
  await setEv(1.8);
  await page.waitForTimeout(500); // > NODE_THUMBNAIL_DEBOUNCE_MS (300ms) + PNG encode
  const afterEdit = await nodeThumbs();
  check(
    "the Develop node's OWN thumbnail URL changes (its bytes changed)",
    afterEdit.dev !== beforeEdit.dev,
    { before: beforeEdit.dev, after: afterEdit.dev }
  );
  check(
    "the input node's thumbnail URL is UNCHANGED (upstream of the edit, same bytes → same blob: URL kept, no re-encode)",
    afterEdit.in === beforeEdit.in,
    { before: beforeEdit.in, after: afterEdit.in }
  );
  await setEv(0);
  await page.waitForTimeout(400);

  // -------------------------------------------------------------------
  console.log('verify-nodepreview (3. inspect mode renders ONE node\'s output, ignoring downstream ops; badge; Escape restores):');
  await setEv(1.0);
  await page.waitForTimeout(400);
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-brightness"]').click();
  const gWithBrightness2 = await graphState();
  const contrastId = gWithBrightness2.nodes.find((n) => n.kind === 'brightness').id;
  // A strong amount so the "downstream op actually changes the output" sanity
  // check below is robust — contrast's own effect on the MEAN can be small
  // (it mostly redistributes around mid-gray), so brightness is the more
  // reliable "obviously moves the mean" choice for this cross-check.
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'amount', 60), contrastId);
  await page.waitForTimeout(400);
  const fullMean = await mainMean();

  // Ground truth for "inspecting 'dev' == a doc truncated right after dev":
  // temporarily rewire 'out' to read directly from 'dev' (bypassing the
  // downstream brightness node entirely) via the SAME connectEdge debug hook
  // the compare pack's own verify script uses, take its readback, then
  // rewire forward again — an entirely independent code path from
  // inspectNodeId (normal output resolution over a physically different
  // graph), so agreement between the two is a real cross-check, not a
  // tautology.
  await page.evaluate(() => window.__debug.connectEdge('dev', 'out'));
  await page.waitForTimeout(400);
  const truncatedMean = await mainMean();
  check('setup sanity: the downstream op actually changes the output', meansDiffer(fullMean, truncatedMean), { fullMean, truncatedMean });
  await page.evaluate((id) => window.__debug.connectEdge(id, 'out'), contrastId);
  await page.waitForTimeout(400);
  check("rewiring back restores the full-chain mean", meansMatch(await mainMean(), fullMean), { fullMean, restored: await mainMean() });

  // Enter inspect mode on 'dev' via its eye button.
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  check("inspectState() reports 'dev'", (await inspectState()) === 'dev', await inspectState());
  const badgeText = await page.locator('[data-testid="inspect-badge"]').textContent();
  check('the inspect badge is visible and names the node', badgeText?.includes('Develop'), badgeText);
  await page.waitForTimeout(400);
  const inspectMean = await mainMean();
  check(
    "inspecting 'dev' matches the independently-rewired truncated-doc readback (downstream ops ignored)",
    meansMatch(inspectMean, truncatedMean),
    { inspectMean, truncatedMean }
  );

  // Escape exits and restores the active-output render.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__debug.inspectState() === null, { timeout: 5_000 });
  check('Escape clears inspectState()', (await inspectState()) === null, await inspectState());
  check('the inspect badge is gone', (await page.locator('[data-testid="inspect-badge"]').count()) === 0, null);
  await page.waitForTimeout(400);
  check('the main canvas is back to the full-chain (active output) render', meansMatch(await mainMean(), fullMean), {
    fullMean,
    restored: await mainMean(),
  });

  // The ✕ button exits too.
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  await page.locator('[data-testid="inspect-exit"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === null, { timeout: 5_000 });
  check('the badge\'s ✕ button exits inspect mode', (await inspectState()) === null, await inspectState());

  // Mutual exclusivity with compare mode (both directions).
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  await page.evaluate(() => window.__debug.setCompareMode(true));
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  check('entering compare mode exits inspect mode', (await inspectState()) === null, await inspectState());
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  check('entering inspect mode exits compare mode', (await page.evaluate(() => window.__debug.compareState())).mode === false, await page.evaluate(() => window.__debug.compareState()));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__debug.inspectState() === null && window.__debug.compareState().mode === false, {
    timeout: 5_000,
  });

  await setEv(0);
  await page.waitForTimeout(300);

  // -------------------------------------------------------------------
  console.log('verify-nodepreview (4. switching images clears inspection + thumbnails):');
  await page.locator('.react-flow__node[data-id="dev"] [data-testid="node-inspect-dev"]').click();
  await page.waitForFunction(() => window.__debug.inspectState() === 'dev', { timeout: 5_000 });
  const thumbsBeforeSwitch = await nodeThumbs();
  check('thumbnails exist right before the image switch (setup sanity)', Object.keys(thumbsBeforeSwitch).length > 0, thumbsBeforeSwitch);
  const revocationsBeforeSwitch = (await thumbRevocations()).length;

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, JPG_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  check('inspectState() is cleared by the image switch', (await inspectState()) === null, await inspectState());
  const thumbsAfterSwitch = await nodeThumbs();
  check('nodeThumbs is cleared by the image switch (no stale entries survive)', Object.keys(thumbsAfterSwitch).length === 0, thumbsAfterSwitch);
  const revocationsAfterSwitch = await thumbRevocations();
  check(
    "the previous image's thumbnail URLs were revoked, not just dropped (revocation audit)",
    revocationsAfterSwitch.length >= revocationsBeforeSwitch + Object.keys(thumbsBeforeSwitch).length,
    { revocationsBeforeSwitch, revocationsAfterSwitch, thumbsBeforeSwitch }
  );

  check('no page errors across the node-preview verify checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
