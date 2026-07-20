#!/usr/bin/env node
/**
 * In-engine ML denoise verify (denoise v2, stage 1 —
 * docs/brief-bank/denoise-v2.md): a one-input/one-output chain node whose
 * "op" is tiled ONNX Runtime inference in the main process, proven here
 * against a tiny hand-rolled ONNX fixture (scripts/fixtures/
 * denoise-identity.onnx, generator: scripts/fixtures/
 * generate-denoise-fixture.mjs — NO network/Python dependency, see that
 * script's own doc comment) instead of the real ~112 MB NAFNet checkpoint.
 * The fixture computes `output = input + DENOISE_FIXTURE_OFFSET`
 * elementwise (a 1×1 Conv with an identity weight + per-channel bias) —
 * dynamic H/W, same shape contract as the real model.
 *
 * TEST-ONLY MODEL SUBSTITUTION: `SILVERBOX_TEST_DENOISE_MODEL_SHA256`/
 * `_BYTES` (read by src/main/denoiseModel.ts, gated on SILVERBOX_TEST=1)
 * swap the EXPECTED hash/size so the fixture can stand in for the real
 * model through the REAL download/verify/consent pipeline, not a bypass of
 * it — see that file's doc comment. `denoiseModelUrl` pointed at a
 * `file://` path (never http/https) proves the consent→download flow with
 * zero network traffic (checks 4/5 below).
 *
 * KNOWN-TRANSFORM GROUND TRUTH: rather than hand-duplicating the engine's
 * WORK_TO_SRGB matrix + sRGB curve in this script to predict an exact
 * expected linear-mean delta (fragile, easy to get subtly wrong), this
 * script cross-validates denoise's "add DENOISE_FIXTURE_OFFSET in sRGB-
 * ENCODED domain, decode back to linear" pipeline against v1's ALREADY-
 * PROVEN external-tool node running the SAME offset in its own `encoded`
 * mode (scripts/fixtures/external-transform.mjs, verify-external.mjs's own
 * fixture) — both nodes share the identical ENCODE/DECODE WGSL
 * (graphRenderer.ts's externalEncodePipeline/externalDecodePipeline are
 * reused verbatim by denoise's checkDenoiseNodes/setDenoiseResult), so if
 * denoise's domain handling were wrong (e.g. offset applied in linear
 * space, or the WORK_TO_SRGB matrix skipped) the two paths would diverge
 * far outside LINEAR_DELTA_TOLERANCE. The tolerance itself matches
 * verify-external.mjs's own (8-bit TIFF quantization noise on the EXTERNAL
 * side only — denoise itself stays float32 throughout, no quantization).
 *
 * Checks:
 *  1. A fresh denoise node's default (strength 0) is identity (bit-exact
 *     pass-through).
 *  2. Known transform: denoise at strength 100 moves the LINEAR-mode region
 *     mean by ~the same delta as the external node's identical-offset
 *     `encoded` round trip (see this file's doc comment) — proves
 *     encode→infer→decode is wired correctly, at the ACTUAL (non-%16)
 *     preview resolution, so a correct result here also proves the tiler's
 *     reassembly is seamless (no gaps/double-counted overlap — see check 3).
 *  3. Tiling: the preview's own dimensions are forced non-%16
 *     (previewLongEdge=777) before check 2 runs — check 2 passing AT this
 *     resolution is the tiling-correctness proof (a gap or a double-counted
 *     overlap region would show up as a wrong overall mean).
 *  4. Strength blend: `lerp(input, denoised, strength/100)` — 0 is exactly
 *     the pre-denoise baseline, 50 is exactly the linear midpoint between
 *     baseline and the full-strength result (an EXACT per-pixel-linear
 *     identity, tight tolerance, no cross-check needed).
 *  5. Cache: changing strength (0→50→100→0) never re-runs inference (same
 *     upstream content hash, strength excluded from the cache key — see
 *     shared/ipc.ts's DenoiseRunRequest doc comment); an upstream pixel
 *     edit (exposure) DOES re-run; reverting it is a cache HIT again.
 *  6. Sidecar round-trip preserves the node kind + strength.
 *  7. A brand-new session with NO model present and NO consent given starts
 *     the node needing consent (badge + pass-through, zero inference runs);
 *     the Inspector's consent button (pointed at the LOCAL fixture via
 *     `denoiseModelUrl`, still no network) triggers the download+run.
 *  8. CLI: a model-absent, never-consented render passes through with a
 *     warning line (no new flag needed — denoise is first-party, unlike
 *     the external node's `--allow-external`).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, seedLibraryDir } from './lib/testProject.mjs';

function freshUserDataDir() {
  // seedLibraryDir (docs/brief-bank/linked-looks-stage-e.md): this script
  // mints several fully independent userData dirs (fresh-consent-state
  // checks), bypassing run-verify.mjs's own pool-wide libraryDir pre-seed —
  // see that helper's doc comment for why every one needs its own.
  return seedLibraryDir(mkdtempSync(join(tmpdir(), 'silverbox-denoise-userdata-')));
}

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);

const FIXTURE_ONNX = join(projectRoot, 'scripts', 'fixtures', 'denoise-identity.onnx');
const FIXTURE_SHA256 = createHash('sha256').update(readFileSync(FIXTURE_ONNX)).digest('hex');
const FIXTURE_BYTES = statSync(FIXTURE_ONNX).size;
/** Must match generate-denoise-fixture.mjs's DENOISE_FIXTURE_OFFSET. */
const FIXTURE_OFFSET = 0.08;
/** Must match shared/denoiseModel.ts's DENOISE_MODEL_FILENAME — the local name main expects the (real or, here, fixture-standing-in) model at. */
const MODEL_FILENAME = 'nafnet-sidd-width32-fp32.onnx';

const EXTERNAL_FIXTURE = join(projectRoot, 'scripts', 'fixtures', 'external-transform.mjs');
const NODE_BIN = process.execPath;
/** Ground-truth comparison command (this file's doc comment): the SAME offset, in `encoded` mode, through the ALREADY-PROVEN external-tool node. */
const CMD_OFFSET = `${NODE_BIN} ${EXTERNAL_FIXTURE} {in} {out} ${FIXTURE_OFFSET}`;

const TIGHT_TOLERANCE = 1e-3; // f16 GPU round trip only — no 8-bit quantization anywhere in the denoise path
/** Cross-check vs the external node's own 8-bit-TIFF round trip — same figure/rationale as verify-external.mjs's LINEAR_DELTA_TOLERANCE. */
const CROSS_CHECK_TOLERANCE = 0.02;
/** Deliberately non-%16 in at least one axis for whatever aspect ratio test.ARW has — exercises the reflect-pad-to-16 tiler path for real (see denoiseTiling.ts's divisible-by-16 contract). */
const ODD_PREVIEW_LONG_EDGE = 777;

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

const meansMatch = (a, b, tol) => a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const delta = (after, before) => ({ r: after.r - before.r, g: after.g - before.g, b: after.b - before.b });
const lerpMean = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** Same host-side polling discipline as verify-external.mjs — see its own doc comment for why NOT page.waitForFunction with a promise-returning predicate. */
async function pollUntil(fn, { timeoutMs = 30_000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`pollUntil: timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// ---------------------------------------------------------------------------
// Interactive checks (1-6): the model is PRE-PLACED at the expected path with
// a matching (test-override) hash — consent never enters the picture, so
// these checks isolate the tiling/inference/cache/blend machinery.
// ---------------------------------------------------------------------------
async function runPreplacedModelChecks() {
  const userDataDir = freshUserDataDir();
  mkdirSync(join(userDataDir, 'models'), { recursive: true });
  copyFileSync(FIXTURE_ONNX, join(userDataDir, 'models', MODEL_FILENAME));
  const app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      SILVERBOX_USER_DATA: userDataDir,
      SILVERBOX_TEST_DENOISE_MODEL_SHA256: FIXTURE_SHA256,
      SILVERBOX_TEST_DENOISE_MODEL_BYTES: String(FIXTURE_BYTES),
    },
  });
  const pageErrors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.waitForSelector('.app-layout', { timeout: 15_000 });

    // Forced non-%16 preview resolution BEFORE the image ever decodes (check
    // 3) — via the store's OWN updateSettings action (not the raw IPC call),
    // so the renderer's in-memory settings.previewLongEdge — what
    // openImageByPath's decode call actually reads — is updated too, not
    // just main's persisted settings.json.
    await page.evaluate((n) => window.__debug.updateSettings({ previewLongEdge: n }), ODD_PREVIEW_LONG_EDGE);

    const openAndWait = async (path) => {
      await page.evaluate((p) => {
        void window.__openImageByPath(p);
      }, path);
      await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
      await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
    };
    const graphState = () => page.evaluate(() => window.__debug.graphState());
    const linearMean = () => page.evaluate(() => window.__debug.readbackLinearMean());
    const denoiseNodeState = (id) => page.evaluate((n) => window.__debug.denoiseNodeState(n), id ?? null);
    const setDenoiseStrength = (id, strength) => page.evaluate(([n, v]) => window.__debug.setDenoiseStrength(n, v), [id, strength]);
    const setExternalCommand = (id, cmd) => page.evaluate(([n, c]) => window.__debug.setExternalCommand(n, c), [id, cmd]);
    const confirmExternalNode = (id) => page.evaluate((n) => window.__debug.confirmExternalNode(n), id);
    const denoiseRunCount = () => page.evaluate(() => window.__debug.denoiseRunCount());

    const addNode = async (kind) => {
      await page.locator('[data-testid="add-node-button"]').click();
      await page.locator(`[data-testid="add-node-${kind}"]`).click();
      return (await graphState()).nodes.at(-1);
    };

    const waitForMeanChange = (baseline) =>
      pollUntil(
        async () => {
          const m = await linearMean();
          return m !== null && (m.r !== baseline.r || m.g !== baseline.g || m.b !== baseline.b);
        },
        { label: 'linearMean to change' }
      );

    console.log('verify-denoise (1. a fresh denoise node at strength 0 is bit-exact pass-through):');
    await openAndWait(ARW_PATH);
    const dims = await page.evaluate(() => window.__debug.imageState());
    console.log(`  (preview dims context: ${JSON.stringify(dims && { width: dims.width, height: dims.height })})`);
    const baseline = await linearMean();
    check('a fresh open has a linear-mean readback (sanity baseline)', baseline !== null, baseline);

    const denoiseNode = await addNode('denoise');
    check(
      'denoise node added with kind "denoise" and strength 0 (identity)',
      denoiseNode?.kind === 'denoise' && denoiseNode?.denoise?.strength === 0,
      denoiseNode
    );
    const denoiseId = denoiseNode.id;
    const meanAfterAdd = await linearMean();
    check('a strength-0 denoise node is a bit-exact pass-through', meansMatch(meanAfterAdd, baseline, TIGHT_TOLERANCE), {
      baseline,
      meanAfterAdd,
    });
    check('no consent needed (model already present)', (await denoiseNodeState(denoiseId))?.needsConsent === false, await denoiseNodeState(denoiseId));

    // -------------------------------------------------------------------
    console.log('verify-denoise (2/3. known transform + tiling: cross-check against the external node\'s identical-offset `encoded` round trip, at a forced non-%16 preview resolution):');
    const extNode = await addNode('external');
    await setExternalCommand(extNode.id, CMD_OFFSET);
    await page.waitForFunction((id) => window.__debug.externalNodeState(id)?.needsConfirm !== null, extNode.id, { timeout: 15_000 });
    await confirmExternalNode(extNode.id);
    await pollUntil(async () => (await page.evaluate((id) => window.__debug.externalNodeState(id)?.error === null, extNode.id)), {
      label: 'external node to settle',
    });
    await waitForMeanChange(meanAfterAdd);
    const meanExternalOffset = await linearMean();
    const deltaExternal = delta(meanExternalOffset, meanAfterAdd);
    check('external-node ground truth actually moved the mean', !meansMatch(meanExternalOffset, meanAfterAdd, TIGHT_TOLERANCE), {
      meanAfterAdd,
      meanExternalOffset,
    });

    // Revert the external node to identity (empty command) — isolates the
    // denoise node's OWN effect from here on, same baseline as meanAfterAdd.
    await setExternalCommand(extNode.id, '');
    await waitForMeanChange(meanExternalOffset);
    const meanBackToBaseline = await linearMean();
    check('reverting the external node to identity restores the baseline', meansMatch(meanBackToBaseline, meanAfterAdd, TIGHT_TOLERANCE), {
      meanAfterAdd,
      meanBackToBaseline,
    });

    const runCountBeforeDenoise = await denoiseRunCount();
    await setDenoiseStrength(denoiseId, 100);
    await pollUntil(async () => (await denoiseRunCount()) > runCountBeforeDenoise, { label: 'denoiseRunCount to increase' });
    await waitForMeanChange(meanBackToBaseline);
    check('no error after the denoise run', (await denoiseNodeState(denoiseId))?.error === null, await denoiseNodeState(denoiseId));
    const meanDenoiseFull = await linearMean();
    const deltaDenoise = delta(meanDenoiseFull, meanBackToBaseline);
    check(
      'denoise (strength 100) moves the mean by ~the SAME delta as the external node\'s identical-offset encoded round trip — proves encode→infer→decode AND the tiler\'s seamless reassembly at this non-%16 preview resolution',
      meansMatch(deltaDenoise, deltaExternal, CROSS_CHECK_TOLERANCE),
      { deltaExternal, deltaDenoise }
    );

    // -------------------------------------------------------------------
    console.log('verify-denoise (4. strength blend: 0 = exact baseline, 50 = exact linear midpoint):');
    const runCountBeforeStrengthSweep = await denoiseRunCount();
    await setDenoiseStrength(denoiseId, 0);
    await waitForMeanChange(meanDenoiseFull);
    const meanStrength0 = await linearMean();
    check('strength 0 is exactly the pre-denoise baseline', meansMatch(meanStrength0, meanBackToBaseline, TIGHT_TOLERANCE), {
      meanBackToBaseline,
      meanStrength0,
    });

    await setDenoiseStrength(denoiseId, 50);
    await waitForMeanChange(meanStrength0);
    const meanStrength50 = await linearMean();
    const expectedHalf = lerpMean(meanBackToBaseline, meanDenoiseFull, 0.5);
    check('strength 50 is exactly the linear midpoint between baseline and the full-strength result', meansMatch(meanStrength50, expectedHalf, TIGHT_TOLERANCE), {
      expectedHalf,
      meanStrength50,
    });
    check(
      'the whole 100→0→50 strength sweep re-used the cached full-strength result (zero new inference runs)',
      (await denoiseRunCount()) === runCountBeforeStrengthSweep,
      { before: runCountBeforeStrengthSweep, after: await denoiseRunCount() }
    );

    // -------------------------------------------------------------------
    console.log('verify-denoise (5. cache: an upstream pixel edit re-runs inference; reverting it is a cache hit):');
    await setDenoiseStrength(denoiseId, 100);
    await waitForMeanChange(meanStrength50);
    const runCountAtFull = await denoiseRunCount();
    const devId = (await graphState()).nodes.find((n) => n.kind === 'Develop')?.id;
    const meanBeforeExposureEdit = await linearMean();
    await page.evaluate(([id]) => window.__debug.updateNodeParam(id, 'basic.ev', 0.3), [devId]);
    await pollUntil(async () => (await denoiseRunCount()) > runCountAtFull, { label: 'denoiseRunCount to increase after an upstream edit' });
    await waitForMeanChange(meanBeforeExposureEdit);
    const runCountAfterExposureEdit = await denoiseRunCount();
    check('an upstream pixel edit (exposure) DOES re-run inference', runCountAfterExposureEdit > runCountAtFull, {
      before: runCountAtFull,
      after: runCountAfterExposureEdit,
    });
    const meanWithExposureEdit = await linearMean();
    await page.evaluate(([id]) => window.__debug.updateNodeParam(id, 'basic.ev', 0), [devId]);
    await waitForMeanChange(meanWithExposureEdit);
    check('reverting the upstream edit is a cache HIT (no new inference run — same content hash as before)', (await denoiseRunCount()) === runCountAfterExposureEdit, {
      before: runCountAfterExposureEdit,
      after: await denoiseRunCount(),
    });

    // -------------------------------------------------------------------
    console.log('verify-denoise (6. sidecar round-trip preserves kind + strength):');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
    check('doc with the denoise node saved', existsSync(SIDECAR), SIDECAR);
    const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
    const savedNode = savedJson.graph.nodes.find((n) => n.id === denoiseId);
    check(
      "saved sidecar carries the denoise node's type/strength verbatim",
      savedNode?.type === 'denoise' && savedNode?.denoise?.strength === 100,
      savedNode
    );
    check('sidecar schemaVersion unchanged (additive, no bump)', savedJson.schemaVersion === 4, savedJson.schemaVersion);

    check('no page errors across the interactive denoise checks', pageErrors.length === 0, pageErrors);
  } finally {
    await app.close();
  }
}

await runPreplacedModelChecks();
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// ---------------------------------------------------------------------------
// Check 7: a brand-new session with NO model and NO consent — the consent
// flow, downloading from a LOCAL fixture (file:// URL — still no network).
// ---------------------------------------------------------------------------
console.log('verify-denoise (7. no model + no consent ⇒ passthrough + badge; the consent button downloads from the local fixture, no network):');
{
  const userDataDir = freshUserDataDir();
  const app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      SILVERBOX_USER_DATA: userDataDir,
      SILVERBOX_TEST_DENOISE_MODEL_SHA256: FIXTURE_SHA256,
      SILVERBOX_TEST_DENOISE_MODEL_BYTES: String(FIXTURE_BYTES),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app-layout', { timeout: 15_000 });
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, ARW_PATH);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

    const graphState = () => page.evaluate(() => window.__debug.graphState());
    const linearMean = () => page.evaluate(() => window.__debug.readbackLinearMean());
    const denoiseNodeState = (id) => page.evaluate((n) => window.__debug.denoiseNodeState(n), id ?? null);
    const denoiseRunCount = () => page.evaluate(() => window.__debug.denoiseRunCount());

    const addNode = async (kind) => {
      await page.locator('[data-testid="add-node-button"]').click();
      await page.locator(`[data-testid="add-node-${kind}"]`).click();
      return (await graphState()).nodes.at(-1);
    };

    const baseline = await linearMean();
    const denoiseNode = await addNode('denoise');
    const denoiseId = denoiseNode.id;
    await page.evaluate(([id, v]) => window.__debug.setDenoiseStrength(id, v), [denoiseId, 100]);
    await page.waitForFunction((id) => window.__debug.denoiseNodeState(id)?.needsConsent === true, denoiseId, { timeout: 20_000 });
    check('a model-absent, never-consented denoise node needs consent', (await denoiseNodeState(denoiseId))?.needsConsent === true, await denoiseNodeState(denoiseId));
    const meanWhileNeedsConsent = await linearMean();
    check('render stays pass-through while consent is missing', meansMatch(meanWhileNeedsConsent, baseline, TIGHT_TOLERANCE), {
      baseline,
      meanWhileNeedsConsent,
    });
    check('zero inference runs happened before consent (no accidental download/run attempt)', (await denoiseRunCount()) === 0, await denoiseRunCount());
    const badge = page.locator(`[data-testid="external-node-badge-${denoiseId}"]`);
    await badge.scrollIntoViewIfNeeded();
    check('the node-editor shows the needs-consent badge', await badge.isVisible(), await badge.isVisible());

    // Point the download at the LOCAL fixture (file:// — see denoiseModel.ts's
    // downloadAndVerify: a file:// URL is copied via plain fs, never fetch()).
    const fixtureUrl = pathToFileURL(FIXTURE_ONNX).href;
    await page.evaluate((url) => window.__debug.updateSettings({ denoiseModelUrl: url }), fixtureUrl);

    // Click-equivalent of the Inspector's "Download denoise model" button.
    await page.evaluate((id) => window.__debug.consentDenoiseModel(id), denoiseId);
    await pollUntil(async () => (await denoiseRunCount()) > 0, { label: 'denoiseRunCount to increase after consent' });
    await page.waitForFunction(
      (id) => window.__debug.denoiseNodeState(id)?.needsConsent === false && window.__debug.denoiseNodeState(id)?.error === null,
      denoiseId,
      { timeout: 20_000 }
    );
    await pollUntil(
      async () => {
        const m = await linearMean();
        return m !== null && (m.r !== baseline.r || m.g !== baseline.g || m.b !== baseline.b);
      },
      { label: 'linearMean to change after consent' }
    );
    check('consenting downloads the LOCAL fixture (no network) and actually runs it', true, await denoiseNodeState(denoiseId));
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// Check 8: CLI — model absent, never consented ⇒ passthrough + warning line.
// ---------------------------------------------------------------------------
console.log('verify-denoise (8. CLI: model absent + no consent ⇒ passthrough + warning, no new flag needed):');
{
  const workDir = mkdtempSync(join(tmpdir(), 'silverbox-denoise-cli-'));
  const userDataDir = seedLibraryDir(mkdtempSync(join(tmpdir(), 'silverbox-denoise-cli-userdata-')));
  const outDirBaseline = join(workDir, 'out-baseline');
  const outDirDenoise = join(workDir, 'out-denoise');
  mkdirSync(outDirBaseline, { recursive: true });
  mkdirSync(outDirDenoise, { recursive: true });
  const cliArw = join(workDir, 'cli.ARW');
  linkSync(ARW_PATH, cliArw);
  const cliSidecar = cliArw + '.silverbox.json';

  const nowIso = () => new Date().toISOString();
  const baseWrapper = (extraNodes, extraEdges) => ({
    schemaVersion: 4,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
        ...extraNodes,
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [{ id: 'e0', source: 'in', target: 'dev' }, ...extraEdges, { id: 'eN', source: extraNodes.length ? 'dns' : 'dev', target: 'out' }].map(
        (e) => ({ id: e.id, from: e.source, to: e.target })
      ),
    },
  });
  writeFileSync(
    join(workDir, 'baseline.silverbox.json'),
    JSON.stringify(baseWrapper([], []), null, 2) + '\n'
  );
  writeFileSync(
    cliSidecar,
    JSON.stringify(
      baseWrapper([{ id: 'dns', type: 'denoise', position: { x: 320, y: 60 }, denoise: { strength: 100 } }], [{ id: 'e1', source: 'dev', target: 'dns' }]),
      null,
      2
    ) + '\n'
  );

  const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');
  const runCli = (args, env) =>
    spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
      env: { ...process.env, SILVERBOX_USER_DATA: userDataDir, ...env },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });

  const resultDenoise = runCli(['--out', outDirDenoise, '--quality', '95', cliArw]);
  check('CLI with a model-absent denoise node exits 0 (bypassed is not a failure)', resultDenoise.status === 0, resultDenoise);
  check(
    'CLI warns that the denoise node was bypassed (model not downloaded)',
    /denoise[\s\S]*(bypassed|not downloaded)/i.test(resultDenoise.stdout + resultDenoise.stderr),
    { stdout: resultDenoise.stdout, stderr: resultDenoise.stderr }
  );

  // Baseline (no denoise node at all) run to compare bytes against — proves
  // the bypass really did render an ordinary pass-through, not a broken file.
  if (existsSync(cliSidecar)) unlinkSync(cliSidecar);
  const cliArwBaseline = join(workDir, 'baseline.ARW');
  linkSync(ARW_PATH, cliArwBaseline);
  writeFileSync(cliArwBaseline + '.silverbox.json', JSON.stringify(baseWrapper([], []), null, 2) + '\n');
  const outDirBaseline2 = join(workDir, 'out-baseline2');
  mkdirSync(outDirBaseline2, { recursive: true });
  const resultBaseline = spawnSync(ELECTRON_BIN, [projectRoot, '--render', '--out', outDirBaseline2, '--quality', '95', cliArwBaseline], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  check('the baseline (no denoise node) CLI render also exits 0', resultBaseline.status === 0, resultBaseline);

  const jpgDenoise = join(outDirDenoise, 'cli.jpg');
  const jpgBaseline = join(outDirBaseline2, 'baseline.jpg');
  check('both CLI runs produced a JPEG', existsSync(jpgDenoise) && existsSync(jpgBaseline), { jpgDenoise, jpgBaseline });
  if (existsSync(jpgDenoise) && existsSync(jpgBaseline)) {
    const bytesDenoise = readFileSync(jpgDenoise);
    const bytesBaseline = readFileSync(jpgBaseline);
    check(
      'the bypassed-denoise render is byte-identical to a plain baseline render (genuine pass-through, not a broken/altered file)',
      Buffer.compare(bytesDenoise, bytesBaseline) === 0,
      { denoiseBytes: bytesDenoise.length, baselineBytes: bytesBaseline.length }
    );
  }

  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
