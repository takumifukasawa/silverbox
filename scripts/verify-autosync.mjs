/**
 * Auto Sync verify (docs/brief-bank/multi-select-sync.md item E, UX pack
 * round 2 — LR-style toggle beside the existing Sync… button). A separate
 * script from verify-sync.mjs (which owns the explicit Sync… button/dialog
 * mechanics this reuses) since this one exercises the NEW debounced
 * gesture-end subscriber and its own settings field.
 *
 * Checks:
 *  1. OFF (default): editing the primary with 2+ selected never writes the
 *     secondaries' looks — today's explicit-only behavior, unchanged.
 *  2. ON + 2+ selected: several RAPID edits (simulating a slider drag's many
 *     onChange ticks) within the debounce window fan out as exactly ONE
 *     sync (one new 'sync' undo entry), carrying the FINAL value — never
 *     per-tick.
 *  3. ON but only the primary open (nothing selected): no sync fires (no
 *     target to fan out to).
 *  4. Toggling OFF again stops the fan-out — a further edit writes nothing
 *     new to the targets.
 *  5. Flush-on-switch: an edit made <1000ms before switching photos (well
 *     inside the debounce, before it would ever fire on its own) still
 *     reaches the targets — the switch must not silently drop it.
 *  6. The toolbar checkbox itself drives `settings.autoSyncEnabled` (real
 *     click, not just the debug hook) and persists across updateSettings'
 *     round trip.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

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
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-autosync-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
const PRIMARY = fixture('a_primary.ARW');
const TARGET_A = fixture('b_targeta.ARW');
const TARGET_B = fixture('c_targetb.ARW');

const readLook = (path) => JSON.parse(readFileSync(lookPathFor(path), 'utf8'));
const devOf = (doc) => doc.graph.nodes.find((n) => n.id === 'dev');

// Same settings.json isolation precaution verify-sync.mjs/verify-undo.mjs
// take — this machine's own real settings.json may have autosaveSidecar OFF,
// and autoSyncEnabled defaults false either way (must be flipped explicitly).
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-autosync-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReady = () => page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const openFireAndForget = (path, opts) => page.evaluate(({ p, o }) => void window.__openImageByPath(p, o), { p: path, o: opts });
  const openFolderFireAndForget = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const setSelection = (paths) => page.evaluate((ps) => window.__debug.setFilmstripSelection(ps), paths);
  const setAutoSync = (on) => page.evaluate((v) => window.__debug.updateSettings({ autoSyncEnabled: v }), on);
  const undoCount = () => page.evaluate(() => window.__debug.undoStackState().undo.length);

  // syncSelection (and therefore the auto-sync fan-out) only ever targets
  // photos already on the ACTIVE PROJECT's playlist (findPlaylistPhoto) —
  // opening the whole fixture folder once puts PRIMARY/TARGET_A/TARGET_B all
  // on it (same setup shape verify-sync.mjs uses), before narrowing back down
  // to PRIMARY as the open/current photo.
  await openFolderFireAndForget(workDir);
  await waitReady(page);
  await openFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReady(page);

  // === 1. OFF (default): edits with 2+ selected never touch the secondaries ===
  console.log('verify-autosync (1. OFF by default — no fan-out):');
  check('autoSyncEnabled starts false', (await page.evaluate(() => window.__debug.autoSyncState())) === false, null);
  await setSelection([TARGET_A, TARGET_B]);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.2));
  await page.waitForTimeout(1_500); // well past the 1000ms debounce
  check('OFF: TARGET_A has no look file on disk', !existsSync(lookPathFor(TARGET_A)), lookPathFor(TARGET_A));
  check('OFF: TARGET_B has no look file on disk', !existsSync(lookPathFor(TARGET_B)), lookPathFor(TARGET_B));

  // === 2. ON + 2+ selected: rapid ticks settle into ONE sync, final value only ===
  console.log('verify-autosync (2. ON — rapid ticks fan out as exactly one sync, gesture-end only):');
  await setAutoSync(true);
  check('autoSyncEnabled is now true', (await page.evaluate(() => window.__debug.autoSyncState())) === true, null);
  const stackBeforeRapid = await undoCount();
  for (const v of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    await page.evaluate((val) => window.__debug.updateNodeParam('dev', 'basic.ev', val), v);
    await page.waitForTimeout(50); // well inside the 1000ms debounce — simulates a drag's own tick cadence
  }
  // Wait for the debounce to fire — exactly one NEW undo entry, kind 'sync'.
  await page.waitForFunction(
    (n) => window.__debug.undoStackState().undo.length > n,
    stackBeforeRapid,
    { timeout: 15_000 }
  );
  await page.waitForTimeout(300); // let the write settle before reading disk
  const stackAfterRapid = await page.evaluate(() => window.__debug.undoStackState());
  const newEntries = stackAfterRapid.undo.slice(stackBeforeRapid);
  check('exactly ONE new undo entry from the whole rapid run (never per-tick)', newEntries.length === 1, newEntries);
  check('that one entry is a sync batch targeting both selected photos', newEntries[0]?.kind === 'sync', newEntries[0]);
  const waitForDiskEv = async (path, expected, timeoutMs = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(lookPathFor(path))) {
        const dev = devOf(readLook(path));
        if (dev?.develop?.basic?.ev === expected) return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  check('TARGET_A carries the FINAL ev (0.7), not an intermediate tick', await waitForDiskEv(TARGET_A, 0.7), devOf(readLook(TARGET_A)));
  check('TARGET_B carries the FINAL ev (0.7) too', await waitForDiskEv(TARGET_B, 0.7), devOf(readLook(TARGET_B)));

  // === 3. ON but nothing selected: no sync fires ===
  console.log('verify-autosync (3. ON but no selection — no target, nothing fires):');
  await setSelection([]);
  const stackBeforeLone = await undoCount();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.9));
  await page.waitForTimeout(1_500);
  const stackAfterLone = await page.evaluate(() => window.__debug.undoStackState());
  const loneNewEntries = stackAfterLone.undo.slice(stackBeforeLone);
  check('no sync entry when nothing is selected', !loneNewEntries.some((e) => e.kind === 'sync'), loneNewEntries);

  // === 4. Toggling OFF stops the fan-out ===
  console.log('verify-autosync (4. toggling OFF stops the fan-out):');
  await setSelection([TARGET_A, TARGET_B]);
  await setAutoSync(false);
  const evBeforeOff = devOf(readLook(TARGET_A)).develop.basic.ev;
  const stackBeforeOff = await undoCount();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.1));
  await page.waitForTimeout(1_500);
  const stackAfterOff = await page.evaluate(() => window.__debug.undoStackState());
  check('no new sync entry once OFF again', !stackAfterOff.undo.slice(stackBeforeOff).some((e) => e.kind === 'sync'), stackAfterOff.undo.slice(stackBeforeOff));
  check('TARGET_A\'s ev is unchanged from before toggling off', devOf(readLook(TARGET_A)).develop.basic.ev === evBeforeOff, devOf(readLook(TARGET_A)));

  // === 5. Flush-on-switch: an edit made <1000ms before switching still reaches the targets ===
  console.log('verify-autosync (5. flush-on-switch — a fast switch does not drop the pending fan-out):');
  await setAutoSync(true);
  const stackBeforeSwitch = await undoCount();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.2));
  // Switch immediately — well inside the 1000ms debounce, before it would ever fire on its own.
  await openFireAndForget(TARGET_A, { keepFolderContext: true });
  await waitReady(page);
  // Re-select before the switch so the primary/target set is well-defined
  // for the assertion (imagePath is now TARGET_A itself; check TARGET_B's disk look instead).
  await page.waitForFunction(
    (n) => window.__debug.undoStackState().undo.length > n,
    stackBeforeSwitch,
    { timeout: 15_000 }
  );
  await page.waitForTimeout(300);
  check('the flushed sync landed on TARGET_B before/at the switch (ev=1.2)', await waitForDiskEv(TARGET_B, 1.2), devOf(readLook(TARGET_B)));

  // === 6. The toolbar checkbox itself drives the setting (real click) ===
  console.log('verify-autosync (6. the toolbar checkbox toggles the real setting):');
  await openFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReady(page);
  await setSelection([TARGET_A]);
  await setAutoSync(false);
  const checkbox = page.locator('[data-testid="filmstrip-autosync-toggle"]');
  check('checkbox starts unchecked', !(await checkbox.isChecked()), null);
  await checkbox.click();
  await page.waitForFunction(() => window.__debug.settingsState().autoSyncEnabled === true, { timeout: 5_000 });
  check('clicking the checkbox flips the real setting to true', await page.evaluate(() => window.__debug.settingsState().autoSyncEnabled), null);
  check('the checkbox itself now reports checked', await checkbox.isChecked(), null);

  // === 7. ←/→ dissolves the ⌘selection (hand-test round 3: no cross-primary clobber) ===
  // An arrow switch changes the primary exactly like a plain cell click (which
  // clears the selection) — leaving the selection alive let an edit on the NEW
  // primary auto-sync-clobber the still-selected previous photo, which read as
  // "my edits disappeared" in the user's hand test. The pending fan-out is
  // flushed BEFORE the clear (stepFilmstrip), so §5's guarantee still holds.
  console.log('verify-autosync (7. arrow switch clears the selection — no cross-primary clobber):');
  await openFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReady(page);
  await setAutoSync(true);
  await setSelection([TARGET_B]);
  const evTargetBBeforeArrow = devOf(readLook(TARGET_B)).develop.basic.ev;
  // §6 left focus on the Auto Sync checkbox (an INPUT) — the arrow handler
  // correctly yields to focused controls (ms4's arrow-on-slider guard), so
  // drop focus first, exactly as a user clicking back into the canvas would.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press('ArrowRight'); // sorted a_primary → b_targeta: primary moves off PRIMARY
  await waitReady(page);
  const selAfterArrow = await page.evaluate(() => window.__debug.filmstripSelectionState());
  check('arrow switch cleared the secondary selection', selAfterArrow.secondary.length === 0, selAfterArrow);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', -0.8));
  await page.waitForTimeout(1_500);
  check(
    'editing the NEW primary no longer fans onto the previously selected photo',
    devOf(readLook(TARGET_B)).develop.basic.ev === evTargetBBeforeArrow,
    devOf(readLook(TARGET_B))
  );

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

rmSync(workDir, { recursive: true, force: true });
if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
