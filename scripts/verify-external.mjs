/**
 * External-tool hook node verify (denoise v1, task #41): a one-input/one-
 * output chain node whose "op" is an arbitrary out-of-process command,
 * proven here against a KNOWN deterministic fixture
 * (scripts/fixtures/external-transform.mjs — adds a constant offset to every
 * sample and writes the result back, same depth/dims) instead of a real
 * dependency like gmic (see docs/research/denoise.md §recommendation: G'MIC
 * is the user-facing default example, not a verify-time dependency).
 *
 * Checks:
 *  1. A fresh node's default (empty) command is identity (bit-exact
 *     pass-through). Setting a real command surfaces a needs-confirm state
 *     and stays pass-through until confirmed; confirming it spawns the
 *     fixture and the render changes — the LINEAR-mode region mean moves by
 *     exactly the fixture's offset (readbackLinearMean is an exact,
 *     debug-only tool for this: no sRGB curve/gamut matrix stands between
 *     the external node's linear output and this readback).
 *  2. Cache: re-rendering with unchanged upstream pixels does NOT re-spawn
 *     the subprocess (spawn counter unchanged); an upstream pixel edit DOES.
 *  3. A failing command (--fail) ⇒ pass-through + error badge, no crash, no
 *     cached result poisoning later checks.
 *  4. Sidecar round-trip preserves command/encoded.
 *  5. encoded vs linear modes produce DIFFERENT results for the identical
 *     fixture/offset (encoded runs the offset through the sRGB curve+matrix
 *     round trip; linear does not).
 *  6. A brand-new app session (fresh confirm state — SECURITY: a doc never
 *     auto-runs its external node) opening a doc with an already-configured
 *     external node starts DISABLED (needs-confirm, pass-through render)
 *     until the confirm button runs it.
 *  7. CLI: without --allow-external the node is bypassed (warning line, exit
 *     0); with the flag it actually runs (output pixels change).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

/**
 * Fresh `<userData>/external-cache` per Electron launch (main/index.ts's
 * SILVERBOX_USER_DATA test hook — same isolation verify-cli.mjs relies on):
 * the on-disk cache tier is content-hash keyed, so re-using the OS-default
 * userData dir across repeated runs of THIS script (or across the two
 * separate sessions checks 1-5 vs 6 launch) would cross-contaminate — a
 * later run's identical (pixel hash, command, encoded, nodeId) tuple would
 * hit a PRIOR run's cached result and never actually spawn, which would
 * both mis-report "no re-spawn" as a false negative AND defeat check 6's
 * whole point (a brand-new session must genuinely re-run once confirmed).
 */
function freshUserDataDir() {
  return mkdtempSync(join(tmpdir(), 'silverbox-external-userdata-'));
}

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const FIXTURE = join(projectRoot, 'scripts', 'fixtures', 'external-transform.mjs');
const NODE_BIN = process.execPath;
const OFFSET = 0.1;
const CMD_OK = `${NODE_BIN} ${FIXTURE} {in} {out} ${OFFSET}`;
const CMD_FAIL = `${NODE_BIN} ${FIXTURE} {in} {out} --fail`;
const TIGHT_TOLERANCE = 1e-6;
/** Linear-mean-delta tolerance: f16 GPU round trip + 8-bit TIFF quantization (see externalTool.ts's doc comment for the bit-depth deviation) both add noise on top of the fixture's exact +0.1. */
const LINEAR_DELTA_TOLERANCE = 0.02;

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

/**
 * Host-side polling for anything that depends on an async debug hook
 * (externalToolSpawnCount/readbackMean/readbackLinearMean all round-trip
 * through IPC or the render worker's request bridge). Deliberately NOT
 * page.waitForFunction with a promise-returning predicate: that pattern
 * raced ahead of the actual settlement during development here — a stale/
 * in-flight response transiently satisfied the predicate before the real
 * state (spawn count, cached texture) had landed. A plain host-side loop
 * that fully awaits each check has no such ambiguity.
 */
async function pollUntil(fn, { timeoutMs = 20_000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`pollUntil: timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// ---------------------------------------------------------------------------
// Interactive checks (1-6): drive the real app via Playwright.
// ---------------------------------------------------------------------------
async function runInteractiveChecks() {
  const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: freshUserDataDir() } });
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
    const graphState = () => page.evaluate(() => window.__debug.graphState());
    const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
    const linearMean = () => page.evaluate(() => window.__debug.readbackLinearMean());
    const externalNodeState = (id) => page.evaluate((n) => window.__debug.externalNodeState(n), id ?? null);
    const setExternalCommand = (id, cmd) =>
      page.evaluate(([n, c]) => window.__debug.setExternalCommand(n, c), [id, cmd]);
    const setExternalEncoded = (id, enc) =>
      page.evaluate(([n, e]) => window.__debug.setExternalEncoded(n, e), [id, enc]);
    const confirmExternalNode = (id) => page.evaluate((n) => window.__debug.confirmExternalNode(n), id);
    const spawnCount = () => page.evaluate(() => window.__debug.externalToolSpawnCount());
    const devNodeId = async () => (await graphState()).nodes.find((n) => n.kind === 'Develop')?.id;

    const addNode = async (kind) => {
      await page.locator('[data-testid="add-node-button"]').click();
      await page.locator(`[data-testid="add-node-${kind}"]`).click();
      return (await graphState()).nodes.at(-1);
    };

    const waitForSpawnCountAbove = (n) => pollUntil(async () => (await spawnCount()) > n, { label: `spawnCount > ${n}` });
    const waitForMeanChange = (baseline) =>
      pollUntil(
        async () => {
          const m = await gpuMean();
          return m !== null && (m.r !== baseline.r || m.g !== baseline.g || m.b !== baseline.b);
        },
        { label: 'gpuMean to change' }
      );

    // -------------------------------------------------------------------
    console.log('verify-external (1. identity by default; confirm gate; confirming runs the fixture, linear mean moves by exactly the offset):');
    await openAndWait(ARW_PATH);
    const baselineMean = await gpuMean();
    const baselineLinear = await linearMean();
    check('a fresh open has a linear-mean readback (sanity baseline)', baselineLinear !== null, baselineLinear);

    const extNode = await addNode('external');
    check(
      'external node added with kind "external" and an empty default command (identity)',
      extNode?.kind === 'external' && extNode?.external?.command === '' && extNode?.external?.encoded === true,
      extNode
    );
    const extId = extNode.id;

    const meanAfterAdd = await gpuMean();
    check('an empty-command external node is a bit-exact pass-through', meansMatch(meanAfterAdd, baselineMean, TIGHT_TOLERANCE), {
      baselineMean,
      meanAfterAdd,
    });

    // LINEAR mode (encoded:false) first — its effect is EXACTLY predictable
    // (the fixture's +offset lands directly on linear samples, no sRGB
    // curve/gamut matrix in between), which is what makes an exact numeric
    // assertion possible; ENCODED mode's turn comes in check 5, where only
    // "differs from linear" is asserted (its own round trip through the
    // curve+matrix makes an exact prediction impractical to duplicate here).
    await setExternalEncoded(extId, false);
    await setExternalCommand(extId, CMD_OK);
    await page.waitForFunction((id) => window.__debug.externalNodeState(id)?.needsConfirm !== null, extId, { timeout: 15_000 });
    check('setting a real command surfaces a needs-confirm state (SECURITY: never auto-runs)', true, await externalNodeState(extId));
    const meanWhilePending = await gpuMean();
    check('render stays pass-through while the command is unconfirmed', meansMatch(meanWhilePending, meanAfterAdd, TIGHT_TOLERANCE), {
      meanWhilePending,
      meanAfterAdd,
    });

    const spawnBeforeConfirm = await spawnCount();
    await confirmExternalNode(extId);
    await waitForSpawnCountAbove(spawnBeforeConfirm);
    await page.waitForFunction(
      (id) => window.__debug.externalNodeState(id)?.needsConfirm === null,
      extId,
      { timeout: 5_000 }
    );
    // Let the async GPU round trip (readback → IPC → decode/upload → re-render) settle.
    await waitForMeanChange(meanAfterAdd);
    const linearAfterConfirm = await linearMean();
    const linearDelta = {
      r: linearAfterConfirm.r - baselineLinear.r,
      g: linearAfterConfirm.g - baselineLinear.g,
      b: linearAfterConfirm.b - baselineLinear.b,
    };
    check(
      'confirming runs the fixture: the LINEAR-mode region mean moved by ~+offset (per channel)',
      Math.abs(linearDelta.r - OFFSET) < LINEAR_DELTA_TOLERANCE &&
        Math.abs(linearDelta.g - OFFSET) < LINEAR_DELTA_TOLERANCE &&
        Math.abs(linearDelta.b - OFFSET) < LINEAR_DELTA_TOLERANCE,
      { linearDelta, expectedOffset: OFFSET }
    );
    check('no error recorded after a successful run', (await externalNodeState(extId))?.error === null, await externalNodeState(extId));

    // -------------------------------------------------------------------
    console.log('verify-external (2. cache: unchanged upstream does not re-spawn; an upstream pixel edit does):');
    const spawnAfterFirstRun = await spawnCount();
    const meanAfterFirstRun = await gpuMean();
    // Two no-op passes (re-render with literally nothing changed) — a real
    // re-spawn would show up as the counter climbing past its current value.
    await page.waitForTimeout(1_200); // comfortably past EXTERNAL_DEBOUNCE_MS with no upstream change
    check('re-rendering the SAME doc does not re-spawn the subprocess (cache hit — same content hash)', (await spawnCount()) === spawnAfterFirstRun, {
      before: spawnAfterFirstRun,
      after: await spawnCount(),
    });

    const devId = await devNodeId();
    await page.evaluate(([id]) => window.__debug.updateNodeParam(id, 'basic.ev', 0.3), [devId]);
    await waitForSpawnCountAbove(spawnAfterFirstRun);
    await waitForMeanChange(meanAfterFirstRun);
    const spawnAfterExposureEdit = await spawnCount();
    check('an upstream pixel edit (exposure) DOES re-spawn the subprocess', spawnAfterExposureEdit > spawnAfterFirstRun, {
      before: spawnAfterFirstRun,
      after: spawnAfterExposureEdit,
    });
    // Revert the upstream edit so later checks compare against the SAME
    // baseline look — this reproduces the ORIGINAL (pre-edit) pixel content
    // exactly, so it's a cache HIT (same content hash as check 1's run, see
    // checkExternalNodes' `notifyReady` path) rather than a fresh spawn: no
    // NEW subprocess call, just a re-render once the cached texture is
    // recognized again.
    const meanWithExposureEdit = await gpuMean();
    const spawnBeforeRevert = await spawnCount();
    await page.evaluate(([id]) => window.__debug.updateNodeParam(id, 'basic.ev', 0), [devId]);
    await waitForMeanChange(meanWithExposureEdit);
    check('reverting the upstream edit is a cache HIT (no new spawn)', (await spawnCount()) === spawnBeforeRevert, {
      before: spawnBeforeRevert,
      after: await spawnCount(),
    });

    // -------------------------------------------------------------------
    console.log('verify-external (3. a failing command passes through + shows an error badge, no crash):');
    const meanBeforeFail = await gpuMean();
    await setExternalCommand(extId, CMD_FAIL);
    // A DIFFERENT command string is a DIFFERENT confirm key (docKey, command)
    // — the SECURITY gate is keyed on the exact command text, so swapping in
    // CMD_FAIL needs its own confirm before it ever runs (and fails), same as
    // CMD_OK did the first time in check 1.
    await page.waitForFunction((id) => window.__debug.externalNodeState(id)?.needsConfirm !== null, extId, { timeout: 15_000 });
    await confirmExternalNode(extId);
    await page.waitForFunction((id) => window.__debug.externalNodeState(id)?.error !== null, extId, { timeout: 20_000 });
    check('a failing command records an error (badge state)', true, await externalNodeState(extId));
    // Pass-through means identity — the node's own INPUT unchanged (the true
    // baseline mean), not whatever the PREVIOUS successful command happened
    // to leave on screen (meanBeforeFail, a real transformed result, not the
    // node's input) — a failed run has no cached texture, so resolveSteps
    // falls all the way back to the plain identity blit.
    const meanAfterFail = await gpuMean();
    check('render falls back to pass-through (identity — no cached result for a failed run)', meansMatch(meanAfterFail, baselineMean, TIGHT_TOLERANCE), {
      baselineMean,
      meanBeforeFail,
      meanAfterFail,
    });
    const badge = page.locator(`[data-testid="external-node-badge-${extId}"]`);
    await badge.scrollIntoViewIfNeeded();
    check('the node-editor shows the error badge', await badge.isVisible(), await badge.isVisible());

    // restore the working command for the rest of the checks
    await setExternalCommand(extId, CMD_OK);
    await waitForMeanChange(meanAfterFail);
    check('render recovers once the command is fixed again', (await externalNodeState(extId))?.error === null, await externalNodeState(extId));

    // -------------------------------------------------------------------
    console.log('verify-external (4. sidecar round-trip preserves command/encoded):');
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
    check('doc with the external node saved', existsSync(SIDECAR), SIDECAR);
    const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
    const savedExtNode = savedJson.graph.nodes.find((n) => n.id === extId);
    check(
      "saved sidecar carries the external node's type/command/encoded verbatim",
      savedExtNode?.type === 'external' && savedExtNode?.external?.command === CMD_OK && savedExtNode?.external?.encoded === false,
      savedExtNode
    );

    // -------------------------------------------------------------------
    console.log('verify-external (5. encoded vs linear modes produce DIFFERENT results for the identical fixture):');
    const meanLinear = await gpuMean();
    // Toggling `encoded` alone changes the content-hash cache key (it's part
    // of the hash — see checkExternalNodes) but NOT the confirm key (that's
    // (docKey, command) only — encoded is a rendering detail, not a trust
    // boundary), so switching to encoded:true for the FIRST time this
    // session should run WITHOUT surfacing needs-confirm again.
    await setExternalEncoded(extId, true);
    await waitForMeanChange(meanLinear);
    check('switching to encoded mode never re-surfaced a needs-confirm state', (await externalNodeState(extId))?.needsConfirm === null, await externalNodeState(extId));
    const meanEncoded = await gpuMean();
    check('encoded vs linear mode render DIFFERENT results for the same fixture/offset', !meansMatch(meanLinear, meanEncoded, TIGHT_TOLERANCE), {
      meanEncoded,
      meanLinear,
    });
    await setExternalEncoded(extId, false); // leave the doc back in its saved (linear) shape

    check('no page errors across the interactive external-node checks', pageErrors.length === 0, pageErrors);
  } finally {
    await app.close();
  }

  // -------------------------------------------------------------------
  console.log('verify-external (6. a brand-new session starts DISABLED; the confirm button runs it):');
  const app2 = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: freshUserDataDir() } });
  try {
    const page2 = await app2.firstWindow();
    await page2.waitForSelector('.app-layout', { timeout: 15_000 });
    await page2.evaluate((p) => {
      void window.__openImageByPath(p);
    }, ARW_PATH);
    await page2.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page2.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

    const graph2 = await page2.evaluate(() => window.__debug.graphState());
    const extNode2 = graph2.nodes.find((n) => n.kind === 'external');
    check('reloaded doc still has the external node with its saved command', extNode2?.external?.command === CMD_OK, extNode2);
    const extId2 = extNode2.id;

    // A fresh Electron instance (fresh in-memory confirm Set) opening a doc
    // whose external node already has a real, previously-confirmed-in-a-
    // DIFFERENT-session command must start DISABLED again — confirm state is
    // SESSION-scoped, never persisted (see externalNodeRunner.ts).
    await page2.waitForFunction(
      (id) => window.__debug.externalNodeState(id)?.needsConfirm !== null,
      extId2,
      { timeout: 20_000 }
    );
    const stateBeforeConfirm2 = await page2.evaluate((n) => window.__debug.externalNodeState(n), extId2);
    check('a fresh session starts the external node DISABLED (needs confirm) even with a saved command', stateBeforeConfirm2.needsConfirm === CMD_OK, stateBeforeConfirm2);

    const spawnBefore2 = await page2.evaluate(() => window.__debug.externalToolSpawnCount());
    check('nothing spawned yet in this fresh session before confirming', spawnBefore2 === 0, spawnBefore2);

    await page2.evaluate((n) => window.__debug.confirmExternalNode(n), extId2);
    await pollUntil(async () => (await page2.evaluate(() => window.__debug.externalToolSpawnCount())) > spawnBefore2, {
      label: 'session 2 spawnCount to increase',
    });
    await page2.waitForFunction(
      (id) => window.__debug.externalNodeState(id)?.needsConfirm === null && window.__debug.externalNodeState(id)?.error === null,
      extId2,
      { timeout: 20_000 }
    );
    check('confirming in the new session actually runs the command', true, await page2.evaluate((n) => window.__debug.externalNodeState(n), extId2));
  } finally {
    await app2.close();
  }
}

await runInteractiveChecks();
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// ---------------------------------------------------------------------------
// CLI checks (7): the real headless `--render` path, no Playwright.
// ---------------------------------------------------------------------------
console.log('verify-external (7. CLI: --allow-external gates whether the node actually runs):');
{
  const workDir = mkdtempSync(join(tmpdir(), 'silverbox-external-cli-'));
  const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-external-cli-userdata-'));
  const outDir = join(workDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const cliArw = join(workDir, 'cli.ARW');
  linkSync(ARW_PATH, cliArw);
  const cliSidecar = cliArw + '.silverbox.json';

  const nowIso = () => new Date().toISOString();
  const wrapper = {
    schemaVersion: 4,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
        { id: 'ext', type: 'external', position: { x: 320, y: 60 }, external: { command: CMD_OK, encoded: true } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'ext' },
        { id: 'e2', from: 'ext', to: 'out' },
      ],
    },
  };
  writeFileSync(cliSidecar, JSON.stringify(wrapper, null, 2) + '\n');

  const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');
  const runCli = (args) =>
    spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
      env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });

  const outNoFlag = join(outDir, 'no-flag.jpg');
  const resultNoFlag = runCli(['--out', outDir, '--quality', '95', cliArw]);
  // default basePath == input basename with a new extension — see cliOutputPath;
  // we don't know the exact stem the CLI derives, so just look at stdout/stderr
  // for the warning and confirm SOME jpg landed in outDir instead of asserting
  // an exact filename.
  check('CLI without --allow-external exits 0 (a bypassed external node is not a failure)', resultNoFlag.status === 0, resultNoFlag);
  check(
    'CLI without --allow-external warns that the external node was bypassed',
    /external node\(s\) bypassed/.test(resultNoFlag.stdout + resultNoFlag.stderr),
    { stdout: resultNoFlag.stdout, stderr: resultNoFlag.stderr }
  );

  const outDirAllowed = join(workDir, 'out-allowed');
  mkdirSync(outDirAllowed, { recursive: true });
  const resultAllowed = runCli(['--out', outDirAllowed, '--quality', '95', '--allow-external', cliArw]);
  check('CLI with --allow-external exits 0', resultAllowed.status === 0, resultAllowed);
  check(
    'CLI with --allow-external does not print the bypass warning',
    !/external node\(s\) bypassed/.test(resultAllowed.stdout + resultAllowed.stderr),
    { stdout: resultAllowed.stdout, stderr: resultAllowed.stderr }
  );

  // Compare the two renders' bytes: --allow-external actually ran the
  // fixture (pixels changed), the no-flag run stayed at plain Develop output.
  // cliOutputPath (appStore.ts) derives <outDir>/<input-stem>.jpg — both
  // runs share the same input basename ("cli.ARW"), just different outDirs.
  const jpgNoFlag = join(outDir, 'cli.jpg');
  const jpgAllowed = join(outDirAllowed, 'cli.jpg');
  check('both CLI runs produced a JPEG', existsSync(jpgNoFlag) && existsSync(jpgAllowed), { jpgNoFlag, jpgAllowed });
  if (existsSync(jpgNoFlag) && existsSync(jpgAllowed)) {
    const bytesNoFlag = readFileSync(jpgNoFlag);
    const bytesAllowed = readFileSync(jpgAllowed);
    check('the --allow-external render differs from the bypassed one (the fixture actually ran)', Buffer.compare(bytesNoFlag, bytesAllowed) !== 0, {
      noFlagBytes: bytesNoFlag.length,
      allowedBytes: bytesAllowed.length,
    });
  }

  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
