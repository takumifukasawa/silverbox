/**
 * Sidecar hot-reload verify — the AI-editing loop (ROADMAP "in flight" #4).
 *
 * While an image is open, main watches its sidecar's directory (fs.watch on
 * a single file loses the inode across the atomic rename every writer —
 * ours included — uses) and pushes a debounced (~150ms) `sidecar:changed`
 * event to the renderer whenever the sidecar's own basename is touched. The
 * renderer re-reads the file and:
 *   - ignores it silently if the content matches `lastSidecarText` (our own
 *     save's echo, or no real change);
 *   - auto-reloads it as ONE undo entry when the session is clean
 *     (graphDirty false), with a transient "reloaded" toolbar notice;
 *   - shows a persistent "pending" notice with an inline Reload button when
 *     the session has unsaved edits (never auto-clobbers them);
 *   - shows a persistent "malformed" warning (keeping the in-app graph
 *     untouched) when the new content doesn't parse.
 *
 * This script drives ALL of that through one continuous session on the same
 * develop node's `basic.ev` slider — see appStore.ts's handleExternalSidecar-
 * Change/reloadSidecarNow/applyExternalGraph and main/index.ts's
 * armSidecarWatch.
 *
 * Checks:
 *  1. Clean session: external rewrite → graph updates, render mean changes,
 *     "reloaded" notice, exactly ONE history entry; ⌘Z restores the
 *     pre-reload graph AND render.
 *  2. Self-write (⌘S alone): no reload notice, no extra history entry
 *     (settle window past the debounce).
 *  3. Dirty session: external rewrite does NOT change the graph, shows the
 *     Reload-button notice; clicking it applies the external content as one
 *     more history entry.
 *  4. Dirty session, alternate resolution: the notice also clears on ⌘S,
 *     and disk ends up with the IN-APP doc (the user's edits win).
 *  5. Malformed external content: graph/dirty untouched, warning notice,
 *     sidecarUnreadable never set, and a subsequent save still works and
 *     repairs the file.
 *  6. A rapid burst of 3 external writes collapses (debounce) into ONE
 *     reload of the LAST content, not three history entries.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

// No watcher exists yet (the app hasn't launched) — safe to delete outright,
// unlike every OTHER reset in this script, which overwrites in place instead
// of deleting (see the comment on externalWriteEv below).
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

/**
 * Atomic external rewrite: same shape as main's own writeSidecar (temp file,
 * then rename into place within the SAME directory fs.watch is watching) —
 * simulates an AI agent / editor / `git checkout` touching the file out from
 * under the running app. Deliberately an in-place REWRITE, never a delete:
 * this script keeps one continuous app session across every check below, so
 * deleting the file while a real watcher is armed on it would race the next
 * section's own "reset the baseline" edit (main's fs.watch would report a
 * genuine external deletion, which is correct product behavior but not what
 * a same-session test reset wants). Each section instead re-establishes its
 * baseline via the UI (setDev + save), which overwrites — never removes —
 * the file.
 */
function atomicWrite(content) {
  const tmp = `${SIDECAR}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, SIDECAR);
}

/** Mutate the on-disk doc's Develop node basic.ev and rewrite atomically — the "AI edited the sidecar" move. */
function externalWriteEv(ev) {
  const doc = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const dev = doc.graph.nodes.find((n) => n.type === 'Develop');
  dev.develop.basic.ev = ev;
  atomicWrite(JSON.stringify(doc, null, 2) + '\n');
}

function externalWriteGarbage() {
  atomicWrite('{ this is not valid json, an AI mid-edit or a merge conflict marker\n');
}

function readDiskEv() {
  const doc = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  return doc.graph.nodes.find((n) => n.type === 'Develop').develop.basic.ev;
}

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // Fire-and-forget open (ms2's lesson): the evaluate call itself must not
  // hold onto the in-page promise across the decode.
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  const setDev = (value) => page.evaluate((v) => window.__debug.updateNodeParam('dev', 'basic.ev', v), value);
  const devEv = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev ?? null);
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const historyState = () => page.evaluate(() => window.__debug.historyState());
  const hotReload = () => page.evaluate(() => window.__debug.hotReloadState());
  const dirty = () => page.evaluate(() => window.__debug.graphDirty());
  const sidecarUnreadable = () => page.evaluate(() => window.__debug.sidecarState().unreadable);
  const save = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  // === 1. Clean session: external rewrite auto-reloads; ⌘Z restores ===
  console.log('verify-hotreload (clean session auto-reload + undo restores):');
  await setDev(0.3);
  await save();
  check('baseline saved (graphDirty false)', (await dirty()) === false, await dirty());
  const meanBefore = await gpuMean();
  const histBefore = await historyState();
  externalWriteEv(0.6);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'reloaded', { timeout: 5_000 });
  const notice1 = await hotReload();
  check('"reloaded" notice appears', notice1?.kind === 'reloaded' && /reloaded/i.test(notice1.message), notice1);
  check('graph updates to the external value', (await devEv()) === 0.6, await devEv());
  const meanAfter = await gpuMean();
  check('render mean changes', Math.abs(meanAfter.g - meanBefore.g) > 0.01, { meanBefore, meanAfter });
  const histAfter = await historyState();
  check('exactly ONE history entry added', histAfter.past === histBefore.past + 1, { histBefore, histAfter });
  check('graphDirty stays false after a clean auto-reload', (await dirty()) === false, await dirty());
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.3, {
    timeout: 5_000,
  });
  const meanUndo = await gpuMean();
  check('⌘Z restores the pre-reload render (GPU tolerance)', Math.abs(meanUndo.g - meanBefore.g) < 1 / 255, {
    meanBefore,
    meanUndo,
  });

  // === 2. Self-write: ⌘S alone raises no notice, no extra history entry ===
  console.log('verify-hotreload (self-write produces no notice):');
  await setDev(0.4);
  const histBeforeSelfSave = await historyState();
  await save();
  await page.waitForTimeout(800); // settle window well past the 150ms debounce
  check('no hot-reload notice after our own save', (await hotReload()) === null, await hotReload());
  const histAfterSelfSave = await historyState();
  check(
    'no extra history entry from our own save',
    histAfterSelfSave.past === histBeforeSelfSave.past && histAfterSelfSave.future === histBeforeSelfSave.future,
    { histBeforeSelfSave, histAfterSelfSave }
  );

  // === 3. Dirty session: pending notice, never auto-clobbers; Reload applies ===
  console.log('verify-hotreload (dirty session — pending notice + Reload button):');
  // baseline on disk is 0.4 (section 2's save); make an unsaved edit
  await setDev(0.45);
  check('dirty after an unsaved edit', (await dirty()) === true, await dirty());
  const histBeforeDirtyExternal = await historyState();
  externalWriteEv(0.7);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'pending', { timeout: 5_000 });
  const pendingNotice = await hotReload();
  check('"pending" notice offers Reload', /reload/i.test(pendingNotice?.message ?? ''), pendingNotice);
  check('graph is NOT clobbered while dirty', (await devEv()) === 0.45, await devEv());
  check('still dirty (edits preserved)', (await dirty()) === true, await dirty());
  await page.click('[data-testid="hotreload-reload-button"]');
  await page.waitForFunction(
    () => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.7,
    { timeout: 5_000 }
  );
  check('Reload applies the external content', (await devEv()) === 0.7, await devEv());
  check('graphDirty false after the Reload click', (await dirty()) === false, await dirty());
  check('notice cleared after Reload', (await hotReload()) === null, await hotReload());
  const histAfterDirtyReload = await historyState();
  check('exactly ONE history entry for the Reload click', histAfterDirtyReload.past === histBeforeDirtyExternal.past + 1, {
    histBeforeDirtyExternal,
    histAfterDirtyReload,
  });

  // === 4. Dirty session, alternate resolution: notice clears on save ===
  console.log('verify-hotreload (dirty session — notice clears on save; the in-app doc wins):');
  // baseline on disk is 0.7 (the Reload above); make an unsaved edit
  await setDev(0.55);
  externalWriteEv(0.9);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'pending', { timeout: 5_000 });
  await save();
  check('notice clears on save', (await hotReload()) === null, await hotReload());
  check('disk now holds the in-app doc, not the external one', readDiskEv() === 0.55, readDiskEv());

  // === 5. Malformed external content ===
  console.log('verify-hotreload (malformed external content):');
  // baseline: dirty false, graph ev 0.55, disk ev 0.55 (section 4's save)
  externalWriteGarbage();
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'malformed', { timeout: 5_000 });
  const malformedNotice = await hotReload();
  check(
    '"malformed" warning keeps the in-app state',
    malformedNotice?.kind === 'malformed' && /keeping the in-app state/i.test(malformedNotice.message),
    malformedNotice
  );
  check('graph is untouched by malformed content', (await devEv()) === 0.55, await devEv());
  check('sidecarUnreadable is NOT set (saving over it is legitimate recovery)', (await sidecarUnreadable()) === false, await sidecarUnreadable());
  // saving still works and repairs the file
  await setDev(0.56);
  await save();
  let repaired = null;
  try {
    repaired = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  } catch {
    // leave `repaired` null — the check below reports the failure
  }
  check('a subsequent save repairs the file (valid JSON, schemaVersion 4)', repaired?.schemaVersion === 4, repaired);

  // === 6. Rapid burst of external writes collapses to ONE reload ===
  console.log('verify-hotreload (rapid burst collapses to one reload):');
  // baseline: dirty false, graph/disk ev 0.56 (section 5's repair save)
  const histBeforeBurst = await historyState();
  externalWriteEv(0.61);
  await new Promise((resolve) => setTimeout(resolve, 20));
  externalWriteEv(0.62);
  await new Promise((resolve) => setTimeout(resolve, 20));
  externalWriteEv(0.63);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'reloaded', { timeout: 5_000 });
  await page.waitForTimeout(400); // make sure no SECOND reload sneaks in behind the first
  check('burst lands the LAST content', (await devEv()) === 0.63, await devEv());
  const histAfterBurst = await historyState();
  check('burst collapses to exactly ONE history entry (not three)', histAfterBurst.past === histBeforeBurst.past + 1, {
    histBeforeBurst,
    histAfterBurst,
  });

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
