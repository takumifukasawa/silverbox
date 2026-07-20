/**
 * Sidecar visual diff verify — "code review for looks" (git-native
 * completion brief §1). Two halves, exactly like the feature itself:
 *
 *  1. In-app (one continuous Electron session, same develop-node `basic.ev`
 *     trick verify-hotreload.mjs already uses): a dirty-session hot-reload
 *     'pending' notice gains a "Show diff" button; clicking it opens a
 *     dialog with diffLook's param lines (window.__debug.sidecarDiffState()),
 *     a "Compare visually" toggle that rides the existing compare-view
 *     machinery with the external doc as pane B's transient override, and
 *     "Reload"/"Keep mine" — the same decisive pair the bare toolbar Reload
 *     button and ⌘S already offer, just reachable from inside the dialog.
 *  2. CLI `--diff <sidecarA> <sidecarB> --image <arw>` (spawned exactly like
 *     verify-cli.mjs's own `--render`/`--check` checks — a real windowless
 *     `electron <projectRoot> --render --diff …` invocation, not driven
 *     through the UI): human-mode lines + ΔE stats, `--json` NDJSON, a
 *     dims-changed (crop difference) outcome, and bad-usage exit codes.
 *
 * diffLook itself (the pure param-diff function) is exhaustively unit-tested
 * separately (src/renderer/engine/look/diffLook.test.ts, `npm run
 * test:unit`) — this script only proves the two dialog/CLI entry points wire
 * it up correctly, not its line-by-line grammar.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, seedLibraryDir } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
// Part 1 (in-app dialog) is an interactive open — its look lives in the
// active test project's looks/, project-storage migration. Part 2 (the
// CLI's own --diff sidecarA/sidecarB fixtures, below) are unrelated: they're
// arbitrary files passed directly as CLI args, never resolved against any
// project, so they stay untouched.
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const meansDiffer = (a, b, minDelta = 0.01) =>
  a && b && (Math.abs(a.r - b.r) > minDelta || Math.abs(a.g - b.g) > minDelta || Math.abs(a.b - b.b) > minDelta);

// =============================================================================
// Part 1: in-app dialog (one continuous session, hotreload.mjs's own pattern)
// =============================================================================

/** Same atomic-rewrite trick verify-hotreload.mjs uses — a genuine external touch, never a delete. */
function atomicWrite(content) {
  const tmp = `${SIDECAR}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, SIDECAR);
}

function externalWriteEv(ev) {
  const doc = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const dev = doc.graph.nodes.find((n) => n.type === 'Develop');
  dev.develop.basic.ev = ev;
  atomicWrite(JSON.stringify(doc, null, 2) + '\n');
}

function readDiskEv() {
  const doc = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  return doc.graph.nodes.find((n) => n.type === 'Develop').develop.basic.ev;
}

/** LR-style signed-number formatting diffLook itself uses (fmtNum) — duplicated here ONLY for building the exact expected line text, not to re-test the formatter (that's diffLook.test.ts's job). */
function fmtNum(v) {
  const rounded = Math.round(v * 1000) / 1000;
  if (rounded === 0) return '0';
  const abs = Math.abs(rounded).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return rounded > 0 ? `+${abs}` : `-${abs}`;
}

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  const setDev = (value) => page.evaluate((v) => window.__debug.updateNodeParam('dev', 'basic.ev', v), value);
  const devEv = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev ?? null);
  const dirty = () => page.evaluate(() => window.__debug.graphDirty());
  const hotReload = () => page.evaluate(() => window.__debug.hotReloadState());
  const diffState = () => page.evaluate(() => window.__debug.sidecarDiffState());
  const historyState = () => page.evaluate(() => window.__debug.historyState());
  const compareState = () => page.evaluate(() => window.__debug.compareState());
  const mainMean = () => page.evaluate(() => window.__debug.readbackMean());
  const compareMean = () => page.evaluate(() => window.__debug.compareReadbackMean());
  const save = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  // === 1. Dirty-session "Show diff" opens the dialog with the right lines ===
  console.log('verify-diff (1. "Show diff" button opens the dialog with diffLook lines):');
  await setDev(0.2);
  await save();
  await setDev(0.35); // unsaved edit — in-app ev now 0.35, disk still 0.2
  check('dirty after the unsaved edit', (await dirty()) === true, await dirty());
  externalWriteEv(0.6); // disk ev now 0.6 — a real conflict with the unsaved 0.35
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'pending', { timeout: 5_000 });
  check('"Show diff" button is present next to the pending notice', await page.locator('[data-testid="hotreload-diff-button"]').isVisible(), null);

  await page.locator('[data-testid="hotreload-diff-button"]').click();
  await page.waitForFunction(() => window.__debug.sidecarDiffState() !== null, { timeout: 5_000 });
  check('dialog becomes visible', await page.locator('[data-testid="sidecar-diff-dialog"]').isVisible(), null);
  const lines1 = (await diffState()).lines;
  const expectedLine1 = `dev: basic.ev ${fmtNum(0.35)} → ${fmtNum(0.6)}`;
  check('lines include the current(0.35) vs disk(0.6) basic.ev change', lines1.includes(expectedLine1), lines1);
  check('the diff is against the CURRENT (unsaved) graph, not the last-saved one', !lines1.some((l) => l.includes('0.2')), lines1);

  // === 2. "Compare visually" rides compare mode with a transient override ===
  console.log('verify-diff (2. "Compare visually" — pane B renders the external doc, not the CURRENT graph):');
  check('compare mode starts off', (await compareState()).mode === false, await compareState());
  await page.locator('[data-testid="sidecar-diff-compare-visually"]').click();
  await page.waitForFunction(() => window.__debug.compareState().mode === true, { timeout: 5_000 });
  const isActive = await page.locator('[data-testid="sidecar-diff-compare-visually"]').evaluate((el) => el.classList.contains('active'));
  check('the toggle shows active once compare mode is on', isActive, isActive);
  await page.waitForTimeout(300); // let the compare pane's render settle
  const m1 = await mainMean();
  const c1 = await compareMean();
  check("pane B's render (disk, ev 0.6) differs from the main pane (in-app, ev 0.35)", meansDiffer(m1, c1), { m1, c1 });

  await page.locator('[data-testid="sidecar-diff-compare-visually"]').click();
  await page.waitForFunction(() => window.__debug.compareState().mode === false, { timeout: 5_000 });
  check('toggling again turns compare mode back off', (await compareState()).mode === false, await compareState());

  // === 3. "Reload" (inside the dialog) applies the external content ===
  console.log('verify-diff (3. dialog\'s Reload button applies the external content):');
  const histBeforeReload = await historyState();
  await page.locator('[data-testid="sidecar-diff-reload-button"]').click();
  await page.waitForFunction(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.6,
    { timeout: 5_000 }
  );
  check('graph now holds the external value', (await devEv()) === 0.6, await devEv());
  check('graphDirty is false after Reload', (await dirty()) === false, await dirty());
  check('the dialog closes on Reload', (await diffState()) === null, await diffState());
  check('the hot-reload notice clears on Reload', (await hotReload()) === null, await hotReload());
  const histAfterReload = await historyState();
  check('exactly ONE history entry for the dialog\'s Reload', histAfterReload.past === histBeforeReload.past + 1, {
    histBeforeReload,
    histAfterReload,
  });

  // === 4. "Keep mine" (inside the dialog) saves the in-app doc over disk ===
  console.log('verify-diff (4. dialog\'s Keep mine button saves the IN-APP doc):');
  await setDev(0.15); // unsaved edit over the just-reloaded 0.6 baseline
  externalWriteEv(0.9); // disk now 0.9 — a fresh conflict
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'pending', { timeout: 5_000 });
  await page.locator('[data-testid="hotreload-diff-button"]').click();
  await page.waitForFunction(() => window.__debug.sidecarDiffState() !== null, { timeout: 5_000 });
  const expectedLine2 = `dev: basic.ev ${fmtNum(0.15)} → ${fmtNum(0.9)}`;
  check('lines reflect the new conflict (0.15 vs 0.9)', (await diffState()).lines.includes(expectedLine2), (await diffState()).lines);

  await page.locator('[data-testid="sidecar-diff-keep-mine-button"]').click();
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('the dialog closes on Keep mine', (await diffState()) === null, await diffState());
  check('the hot-reload notice clears on Keep mine', (await hotReload()) === null, await hotReload());
  check('disk now holds the IN-APP value (0.15), not the external one (0.9)', readDiskEv() === 0.15, readDiskEv());
  check('the in-app graph is untouched (still 0.15)', (await devEv()) === 0.15, await devEv());

  // === 5. Escape closes the dialog WITHOUT deciding anything ===
  console.log('verify-diff (5. Escape closes the dialog, leaving the pending conflict untouched):');
  await setDev(0.25); // unsaved edit over the 0.15 baseline
  externalWriteEv(1.1);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'pending', { timeout: 5_000 });
  await page.locator('[data-testid="hotreload-diff-button"]').click();
  await page.waitForFunction(() => window.__debug.sidecarDiffState() !== null, { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__debug.sidecarDiffState() === null, { timeout: 5_000 });
  check('Escape closes the dialog', (await diffState()) === null, await diffState());
  check("the underlying 'pending' conflict is untouched by merely closing the dialog", (await hotReload())?.kind === 'pending', await hotReload());
  check('the in-app graph is untouched (still 0.25, not reloaded/saved)', (await devEv()) === 0.25, await devEv());

  check('no page errors across the whole session', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// =============================================================================
// Part 2: CLI `--diff <sidecarA> <sidecarB> --image <arw>`
// =============================================================================

console.log('verify-diff (6. CLI --diff: human output, --json NDJSON, dims-changed, bad usage):');

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-diff-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-diff-userdata-'));
// The visible library (docs/brief-bank/linked-looks-stage-e.md) — see
// verify-cli.mjs's own identical comment: an isolated libraryDir keeps a
// standalone run off the real ~/Silverbox/Library.
if (ownUserData) seedLibraryDir(userDataDir);

function link(name, src = ARW_PATH) {
  const dst = join(workDir, name);
  linkSync(src, dst);
  return dst;
}

const nowIso = () => new Date().toISOString();

/** schemaVersion-4 wire wrapper (verify-cli.mjs's own shape) — nodes carry `type`, edges carry `from`/`to`. */
function graphWrapper(nodes, edges) {
  return { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph: { nodes, edges } };
}

function simpleLook(develop, inputExtra) {
  return {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 }, ...inputExtra },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, ...(develop ? { develop } : {}) },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
}

/** Writes a sidecar doc to an ARBITRARY path (not `<image>.silverbox.json` — --diff's whole point is two FILES, neither has to live next to the image). */
function writeDocAt(path, develop, inputExtra) {
  const { nodes, edges } = simpleLook(develop, inputExtra);
  writeFileSync(path, JSON.stringify(graphWrapper(nodes, edges), null, 2) + '\n');
}

const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNdjson(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
}

try {
  const arw = link('diff.ARW');
  const pathA = join(workDir, 'a.silverbox.json');
  const pathB = join(workDir, 'b.silverbox.json');
  writeDocAt(pathA, { basic: { ev: 0 } });
  writeDocAt(pathB, { basic: { ev: 0.5 } });

  // -------------------------------------------------------------------
  const rHuman = runCli(['--diff', pathA, pathB, '--image', arw]);
  check('--diff exits 0 (differences found, but a diff always "succeeds")', rHuman.status === 0, {
    status: rHuman.status,
    stdout: rHuman.stdout,
    stderr: rHuman.stderr,
  });
  check('human output includes the basic.ev line', rHuman.stdout.includes('dev: basic.ev 0 → +0.5'), rHuman.stdout);
  check('human output includes a ΔE stats line', /ΔE mean=[\d.]+ p95=[\d.]+ max=[\d.]+/.test(rHuman.stdout), rHuman.stdout);

  const rJson = runCli(['--diff', pathA, pathB, '--image', arw, '--json']);
  check('--json exits 0', rJson.status === 0, { status: rJson.status, stdout: rJson.stdout });
  const jsonLines = parseNdjson(rJson.stdout);
  check('every stdout line under --json parses as JSON (NDJSON)', jsonLines.every((l) => l !== null), rJson.stdout);
  const diffLine = jsonLines.find((l) => l?.input === arw);
  check('NDJSON carries {input,lines,deltaE}', !!diffLine && Array.isArray(diffLine.lines) && typeof diffLine.deltaE?.mean === 'number', diffLine);
  check('NDJSON lines include the basic.ev change', diffLine?.lines.includes('dev: basic.ev 0 → +0.5'), diffLine?.lines);
  check('a real ev change produces a nonzero mean ΔE', diffLine?.deltaE.mean > 0, diffLine?.deltaE);

  // -------------------------------------------------------------------
  console.log('verify-diff (7. identical docs -> no lines, ΔE ~ 0):');
  const pathIdentical = join(workDir, 'identical.silverbox.json');
  writeDocAt(pathIdentical, { basic: { ev: 0.2 } });
  const rIdentical = runCli(['--diff', pathIdentical, pathIdentical, '--image', arw, '--json']);
  check('identical docs still exit 0', rIdentical.status === 0, rIdentical);
  const identicalLine = parseNdjson(rIdentical.stdout).find((l) => l?.input === arw);
  check('identical docs produce NO lines', Array.isArray(identicalLine?.lines) && identicalLine.lines.length === 0, identicalLine);
  // A generous-but-still-tiny bound (not a bare === 0) — two INDEPENDENT
  // decode+render passes of the identical doc should reproduce the same
  // pixels almost exactly, but this isn't asserting bit-exactness (that's
  // the engine invariants' job elsewhere), just "no real difference".
  check('identical docs produce ~0 ΔE (same render twice)', identicalLine?.deltaE.mean < 0.01, identicalLine?.deltaE);

  // -------------------------------------------------------------------
  console.log('verify-diff (8. a crop difference reports dims-changed, param lines still present):');
  const pathCropA = join(workDir, 'cropA.silverbox.json');
  const pathCropB = join(workDir, 'cropB.silverbox.json');
  writeDocAt(pathCropA, undefined, {
    geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, orientation: { quarterTurns: 0, flipH: false } },
  });
  writeDocAt(pathCropB, undefined, {
    geometry: { crop: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, angle: 0, orientation: { quarterTurns: 0, flipH: false } },
  });
  const rDims = runCli(['--diff', pathCropA, pathCropB, '--image', arw]);
  check('a dims-changing crop diff still exits 0 (informational, not a failure)', rDims.status === 0, rDims);
  check('human output reports DIMS CHANGED', rDims.stdout.includes('DIMS CHANGED'), rDims.stdout);
  const rDimsJson = runCli(['--diff', pathCropA, pathCropB, '--image', arw, '--json']);
  const dimsLine = parseNdjson(rDimsJson.stdout).find((l) => l?.input === arw);
  check("NDJSON carries status:'dims-changed' with lines, no deltaE", dimsLine?.status === 'dims-changed' && Array.isArray(dimsLine.lines) && dimsLine.deltaE === undefined, dimsLine);
  check('the crop change itself shows up as a geometry line', dimsLine?.lines.some((l) => l.startsWith('in: geometry.crop')), dimsLine?.lines);

  // -------------------------------------------------------------------
  console.log('verify-diff (9. bad usage and read failures):');
  const rMissingB = runCli(['--diff', pathA]);
  check('--diff with only one path is bad usage (exit 2)', rMissingB.status === 2, rMissingB);

  // CLI tooling parity (project-storage.md stage 2): --image is no longer
  // ALWAYS required at parse time — it CAN be derived from both sidecars'
  // `photo` field (scripts/verify-cli-project.mjs exercises the successful
  // derivation). pathA/pathB here are plain hand-written docs with no
  // `photo` at all, so this is now a RUNTIME "could not derive" failure
  // (exit 1, {input,error}), not bad usage (exit 2) — see appStore.ts's
  // runCliDiff.
  const rNoImage = runCli(['--diff', pathA, pathB, '--json']);
  check('--diff without --image and with no derivable `photo` exits 1 (not bad usage)', rNoImage.status === 1, rNoImage);
  const noImageLine = parseNdjson(rNoImage.stdout)[0];
  check('reports a clear "could not derive" error, not a silent guess', !!noImageLine?.error && /could not derive/.test(noImageLine.error), noImageLine);

  const rExtraPositional = runCli(['--diff', pathA, pathB, '--image', arw, arw]);
  check('--diff with a positional image argument is bad usage (exit 2)', rExtraPositional.status === 2, rExtraPositional);

  const rImageAlone = runCli(['--image', arw, arw]);
  check('--image without --diff is bad usage (exit 2)', rImageAlone.status === 2, rImageAlone);

  const missingSidecar = join(workDir, 'does-not-exist.silverbox.json');
  const rMissingFile = runCli(['--diff', missingSidecar, pathB, '--image', arw, '--json']);
  check('a missing sidecar file exits 1', rMissingFile.status === 1, rMissingFile);
  const errorLine = parseNdjson(rMissingFile.stdout).find((l) => l?.input === arw);
  check('NDJSON carries {input,error} for the unreadable sidecar', !!errorLine?.error, errorLine);

  const rHelp = runCli(['--help']);
  check('--help documents --diff\'s usage line', /--diff <sidecarA> <sidecarB>/.test(rHelp.stdout), rHelp.stdout);
  check('--help documents the git-show recipe (never shells to git itself)', /git show/.test(rHelp.stdout), rHelp.stdout);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
