/**
 * LUT import node verify (docs/brief-bank/lut-import-node.md): a chain op
 * (one input, one output) that samples an owned .cube — the READ mirror of
 * the shipped LUT export (scripts/verify-lut.mjs, a DIFFERENT, pre-existing
 * script — this feature's own script is named verify-lut-import.mjs /
 * `verify:lutimport` specifically to avoid colliding with it).
 *  1. An IDENTITY .cube (lut-identity-2x2x2.cube fixture) at amount 1 is a
 *     no-op within 1/255 (the round-trip encode/sample/decode is clean) —
 *     AND the compiled plan keeps a real CPU reference (unlike the spatial-
 *     like image/external/denoise nodes), GPU matching CPU within 1/255.
 *  2. A known red/blue channel-swap .cube (lut-swap-2x2x2.cube fixture)
 *     produces the expected shift (R and B visibly trade places) — GPU
 *     matches CPU within 1/255 for this non-identity table too (the 3D
 *     strip-texture path).
 *  3. amount 0 is identity regardless of which table is loaded (the mix
 *     knob's own identity invariant); an intermediate amount lands strictly
 *     between the untouched and full-strength renders.
 *  4. A 1D per-channel tone .cube (lut-tone-1d.cube fixture) changes the
 *     render and GPU matches CPU within 1/255 (the generic-'passes'/
 *     storage-buffer path — no 3D texture involved at all).
 *  5. A missing/unreadable .cube path ⇒ pass-through (render reverts to the
 *     untouched chain) + a node-editor relink notice, never a crash.
 *  6. Sidecar round-trip preserves path/inputSpace/amount; schemaVersion
 *     stays 4 (additive node kind, no version bump — same pattern IMAGE_KIND/
 *     EXTERNAL_KIND/DENOISE_KIND already followed).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
const GPU_CPU_TOLERANCE = 1 / 255;
const TIGHT_TOLERANCE = 1e-6;

const IDENTITY_CUBE = join(projectRoot, 'scripts/fixtures/lut-identity-2x2x2.cube');
const SWAP_CUBE = join(projectRoot, 'scripts/fixtures/lut-swap-2x2x2.cube');
const TONE_1D_CUBE = join(projectRoot, 'scripts/fixtures/lut-tone-1d.cube');
const MISSING_CUBE = '/nonexistent/path/does-not-exist-lut-verify.cube';

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
// A NaN mean serializes as {r:null,g:null,b:null} over page.evaluate's JSON
// bridge (JSON has no NaN) — a plain `!== null` check on the OBJECT would
// false-positive on that (the object itself is non-null even when its
// fields are all NaN-turned-null), so "is this a real CPU reference"
// checks below verify the FIELDS are actual finite numbers instead.
const isRealMean = (m) => m && Number.isFinite(m.r) && Number.isFinite(m.g) && Number.isFinite(m.b);

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const lutNodeState = (nodeId) => page.evaluate((n) => window.__debug.lutNodeState(n), nodeId ?? null);
  const setLutPath = (nodeId, path) => page.evaluate(([n, p]) => window.__debug.setLutPath(n, p), [nodeId, path]);
  const setLutAmount = (nodeId, amount) =>
    page.evaluate(([n, a]) => window.__debug.setLutAmount(n, a), [nodeId, amount]);
  const setLutInputSpace = (nodeId, space) =>
    page.evaluate(([n, s]) => window.__debug.setLutInputSpace(n, s), [nodeId, space]);
  const decodeCount = () => page.evaluate(() => window.__debug.lutSourceDecodeCount());

  const addNode = async (kind) => {
    await page.locator('[data-testid="add-node-button"]').click();
    await page.locator(`[data-testid="add-node-${kind}"]`).click();
    return (await graphState()).nodes.at(-1);
  };

  const waitForDecode = async (before) => {
    await page.waitForFunction((n) => window.__debug.lutSourceDecodeCount() > n, before, { timeout: 30_000 });
    await page.waitForTimeout(300); // let the freshly-uploaded texture / rev-bumped re-render land
  };

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (setup: add a lut node — auto-spliced into input→Develop→output):');
  const baselineMean = await gpuMean();
  check('a fresh open has a CPU reference (sanity baseline)', (await cpuMean()) !== null, await cpuMean());

  const lutNode = await addNode('lut');
  check('lut node added with kind "lut" and an empty default path (amount defaults to 1)', lutNode?.kind === 'lut' && lutNode?.lut?.path === '' && lutNode?.lut?.amount === 1, lutNode);
  const lutNodeId = lutNode.id;
  const g0 = await graphState();
  check(
    'adding it spliced it directly into the active chain (dev -> lut -> out), not left disconnected like the image node',
    g0.edges.some((e) => e.target === lutNodeId) && g0.edges.some((e) => e.source === lutNodeId),
    g0.edges
  );
  check('an empty path is identity: render unchanged from baseline', meansMatch(await gpuMean(), baselineMean, TIGHT_TOLERANCE), {
    baselineMean,
    afterAdd: await gpuMean(),
  });
  check('a freshly added, pathless lut node reports no missing-file badge (empty path is not "missing")', (await lutNodeState(lutNodeId))?.missing === false, await lutNodeState(lutNodeId));

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (1. IDENTITY .cube at amount 1 is a no-op within 1/255, GPU matches CPU):');
  const countBeforeIdentity = await decodeCount();
  await setLutPath(lutNodeId, IDENTITY_CUBE);
  await waitForDecode(countBeforeIdentity);
  check('the identity .cube loaded without becoming "missing"', (await lutNodeState(lutNodeId))?.missing === false, await lutNodeState(lutNodeId));
  const meanIdentity = await gpuMean();
  check('IDENTITY LUT applied ⇒ render still matches baseline within 1/255', meansMatch(meanIdentity, baselineMean, GPU_CPU_TOLERANCE), {
    baselineMean,
    meanIdentity,
  });
  const cpuIdentity = await cpuMean();
  check(
    'the compiled plan KEEPS a real CPU reference (a LUT node is a per-pixel color transform WITH a CPU mirror, not spatial like image/external/denoise)',
    cpuIdentity !== null,
    cpuIdentity
  );
  check('GPU matches CPU reference for the IDENTITY LUT (within 1/255)', meansMatch(meanIdentity, cpuIdentity), { meanIdentity, cpuIdentity });

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (2. red/blue channel-swap .cube produces the expected shift, GPU matches CPU):');
  const countBeforeSwap = await decodeCount();
  await setLutPath(lutNodeId, SWAP_CUBE);
  await waitForDecode(countBeforeSwap);
  check('the swap .cube loaded without becoming "missing"', (await lutNodeState(lutNodeId))?.missing === false, await lutNodeState(lutNodeId));
  const meanSwap = await gpuMean();
  check('the red/blue swap changes the render vs the identity baseline', !meansMatch(meanSwap, meanIdentity, TIGHT_TOLERANCE), {
    meanIdentity,
    meanSwap,
  });
  check(
    "the swap's R output is closer to the baseline's B (and vice versa) than to its own baseline channel — the expected R<->B shift",
    Math.abs(meanSwap.r - baselineMean.b) < Math.abs(meanSwap.r - baselineMean.r) &&
      Math.abs(meanSwap.b - baselineMean.r) < Math.abs(meanSwap.b - baselineMean.b),
    { baselineMean, meanSwap }
  );
  const cpuSwap = await cpuMean();
  check('GPU matches CPU reference for the red/blue-swap LUT (within 1/255, the 3D strip-texture path)', meansMatch(meanSwap, cpuSwap), { meanSwap, cpuSwap });

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (3. amount 0 is identity regardless of table; an intermediate amount lands strictly between):');
  await setLutAmount(lutNodeId, 0);
  await page.waitForTimeout(200);
  const meanAmount0 = await gpuMean();
  check('amount 0 ⇒ render matches baseline within 1/255 (identity mix), even with the swap table still loaded', meansMatch(meanAmount0, baselineMean, GPU_CPU_TOLERANCE), {
    baselineMean,
    meanAmount0,
  });
  await setLutAmount(lutNodeId, 0.5);
  await page.waitForTimeout(200);
  const meanAmountHalf = await gpuMean();
  const between = (lo, hi, v) => (v - lo) * (v - hi) <= 0;
  check(
    'amount 0.5 lands strictly between the untouched (baseline) and full-strength (swap) renders on every channel',
    between(baselineMean.r, meanSwap.r, meanAmountHalf.r) &&
      between(baselineMean.g, meanSwap.g, meanAmountHalf.g) &&
      between(baselineMean.b, meanSwap.b, meanAmountHalf.b),
    { baselineMean, meanSwap, meanAmountHalf }
  );
  await setLutAmount(lutNodeId, 1);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (4. 1D per-channel tone .cube changes the render, GPU matches CPU — no 3D texture involved):');
  const countBefore1d = await decodeCount();
  await setLutPath(lutNodeId, TONE_1D_CUBE);
  await waitForDecode(countBefore1d);
  check('the 1D tone .cube loaded without becoming "missing"', (await lutNodeState(lutNodeId))?.missing === false, await lutNodeState(lutNodeId));
  const mean1d = await gpuMean();
  check('the 1D tone LUT changes the render vs the identity baseline', !meansMatch(mean1d, meanIdentity, TIGHT_TOLERANCE), {
    meanIdentity,
    mean1d,
  });
  const cpu1d = await cpuMean();
  check('the compiled plan still keeps a real CPU reference for the 1D case', isRealMean(cpu1d), cpu1d);
  check('GPU matches CPU reference for the 1D LUT (within 1/255, the generic storage-buffer path)', meansMatch(mean1d, cpu1d), { mean1d, cpu1d });

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (5. missing/unreadable .cube ⇒ pass-through + relink notice, no crash):');
  const decodeCountBeforeMissing = await decodeCount();
  await setLutPath(lutNodeId, MISSING_CUBE);
  await page.waitForFunction((n) => window.__debug.lutNodeState(n)?.missing === true, lutNodeId, { timeout: 15_000 });
  check('missing path reports missing:true', (await lutNodeState(lutNodeId)).missing, await lutNodeState(lutNodeId));
  const missingBadge = page.locator(`[data-testid="external-node-badge-${lutNodeId}"]`);
  await missingBadge.scrollIntoViewIfNeeded();
  check('the node-editor shows the missing-file badge', await missingBadge.isVisible(), await missingBadge.isVisible());
  // decodeCount only increments on a SUCCESSFUL readFile (mirrors
  // imageNodeSource.ts's own imageNodeDecodeCount convention) — an unreadable
  // path throws before that point, so it stays unchanged, not +1.
  check('a missing path never increments the decode counter (readFile throws before the counter is reached)', (await decodeCount()) === decodeCountBeforeMissing, {
    before: decodeCountBeforeMissing,
    after: await decodeCount(),
  });
  const meanMissing = await gpuMean();
  check('a missing .cube renders as pass-through (matches the untouched-chain baseline, NOT a placeholder color)', meansMatch(meanMissing, baselineMean, GPU_CPU_TOLERANCE), {
    baselineMean,
    meanMissing,
  });

  // Inspector notice, reusing the Image node's relink-UI pattern.
  await page.locator(`[data-testid="node-thumb-${lutNodeId}"]`).click();
  const missingNotice = page.locator('[data-testid="lut-node-missing-notice"]');
  await missingNotice.scrollIntoViewIfNeeded();
  check('the Inspector shows a relink notice for the missing file', await missingNotice.isVisible(), await missingNotice.isVisible());

  // ---------------------------------------------------------------------
  console.log('verify-lut-import (6. sidecar round-trip preserves path/inputSpace/amount; schemaVersion stays 4):');
  // SWAP_CUBE was already loaded once in section 2 — lutSource.ts caches by
  // path (same "never re-attempted once settled" contract as
  // imageNodeSource.ts), so re-selecting it here does NOT fire a new decode;
  // a short settle wait is enough (no waitForDecode — that would time out
  // waiting for a decode that correctly never happens).
  await setLutPath(lutNodeId, SWAP_CUBE);
  await page.waitForTimeout(300);
  await setLutAmount(lutNodeId, 0.7);
  await setLutInputSpace(lutNodeId, 'rec709');
  check('Inspector state reflects path/amount/inputSpace before save', (await lutNodeState(lutNodeId))?.amount === 0.7 && (await lutNodeState(lutNodeId))?.inputSpace === 'rec709', await lutNodeState(lutNodeId));

  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('doc with a lut node saved', existsSync(SIDECAR), SIDECAR);
  const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check('saved sidecar is STILL schemaVersion 4 (additive node kind, no version bump — same pattern as image/external/denoise)', savedJson.schemaVersion === 4, savedJson.schemaVersion);
  const savedLutNode = savedJson.graph.nodes.find((n) => n.id === lutNodeId);
  check(
    "saved sidecar carries the lut node's type + path/inputSpace/amount",
    savedLutNode?.type === 'lut' && savedLutNode?.lut?.path === SWAP_CUBE && savedLutNode?.lut?.inputSpace === 'rec709' && savedLutNode?.lut?.amount === 0.7,
    savedLutNode
  );

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const reloadedGraph = await graphState();
  const reloadedLutNode = reloadedGraph.nodes.find((n) => n.id === lutNodeId);
  check(
    'reloaded doc preserves the lut node path/inputSpace/amount exactly',
    reloadedLutNode?.lut?.path === SWAP_CUBE && reloadedLutNode?.lut?.inputSpace === 'rec709' && reloadedLutNode?.lut?.amount === 0.7,
    reloadedLutNode
  );

  check('no page errors across the lut-node verify checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
