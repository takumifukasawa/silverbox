/**
 * Global undo verify (docs/brief-bank/global-undo.md): ONE LIFO timeline
 * shared by every photo and every batch action, replacing the old per-open-
 * photo `history` (see appStore.ts's `undoStack`/`pushHistory`/`undo`/
 * `redo`). Decision 1 is DECIDED: ⌘Z on an entry belonging to a photo that
 * ISN'T currently open JUMPS — opens that photo first (the normal
 * openImageByPath machinery, flush-on-switch and all), THEN reverts. The
 * implementation sketch's older "without switching" phrasing predates that
 * decision; this script tests the JUMP behavior instead, per the decided
 * semantics.
 *
 * Checks:
 *  1. LIFO across two open photos: editing A, then B, undoes B's edit FIRST
 *     (same-photo, no jump — B is already open) and A's edit SECOND (a
 *     genuine JUMP: A is not open, so undo opens it before reverting).
 *  2. Redo is symmetric: redoing A's entry (jumping back to A) then B's
 *     entry (jumping forward to B) restores both edits in original order.
 *  3. Rating and flag round-trip through the SAME stack (global-undo
 *     decision 2 supersedes the old "metadata never undoes" contract) —
 *     undo/redo works for both, same as any graph edit.
 *  4. Truncation: a new edit after an undo drops whatever was on the redo
 *     branch (standard timeline semantics).
 *  5. Bounded depth: pushing more than UNDO_STACK_LIMIT (200) entries caps
 *     the stack at 200, oldest dropped first.
 *  6. Blocked undo: if the target photo's file is missing (e.g. mid-relink),
 *     the undo is BLOCKED with a notice — the entry stays on the stack,
 *     untouched, not silently skipped, not applied blind. Renaming the file
 *     back and retrying succeeds.
 *  7. Interleaved with autosave: undoing an edit rides the normal
 *     dirty-autosave debounce — the look file on disk reflects the revert
 *     once the debounce settles, exactly like any other edit.
 *
 * Pure-stack unit coverage (push/bound/truncate/LIFO-both-ways) lives in
 * src/renderer/store/undoStack.test.ts (vitest), not here — this script only
 * exercises the store-level dispatch (jumping photos, autosave) end to end.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();

// Autosave (check 7) needs settings.autosaveSidecar actually ON — isolate
// settings.json the same way verify-project.mjs does: this machine's own
// real settings.json may have it OFF, which would silently no-op that check.
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-undo-userdata-'));

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-undo-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
const PHOTO_A = fixture('undo-a.ARW');
const PHOTO_B = fixture('undo-b.ARW');
const PHOTO_C = fixture('undo-c.ARW');
const PHOTO_D = fixture('undo-d.ARW');
const PHOTO_E = fixture('undo-e.ARW');

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p, { keepFolderContext: false });
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const devEv = () => page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev);
  const setEv = (ev) => page.evaluate((v) => window.__debug.updateNodeParam('dev', 'basic.ev', v), ev);
  const currentLook = () => page.evaluate(() => window.__debug.projectState().currentLookPath);
  const imageStatus = () => page.evaluate(() => window.__debug.imageState().status);
  const undoState = () => page.evaluate(() => window.__debug.undoStackState());
  const doUndo = () => page.keyboard.press('Meta+z');
  const doRedoByButton = async () => {
    await page.locator('[data-testid="redo-button"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="redo-button"]').click();
  };

  // === 1. LIFO across two open photos: same-photo undo first, then a JUMP ===
  console.log('verify-undo (1. LIFO across two photos — same-photo undo, then a jump):');
  await openAndWait(PHOTO_A);
  await setEv(0.5);
  check('A is dirty right after its edit', await page.evaluate(() => window.__debug.graphDirty()), null);
  const lookA = await currentLook();

  await openAndWait(PHOTO_B);
  await setEv(0.7);
  const lookB = await currentLook();
  check('A and B resolved to different look paths', lookA !== lookB, { lookA, lookB });

  const stackAfterBothEdits = await undoState();
  check(
    'the top two undo entries target B then A (most recent push last)',
    stackAfterBothEdits.undo.at(-1)?.target === PHOTO_B && stackAfterBothEdits.undo.at(-2)?.target === PHOTO_A,
    stackAfterBothEdits.undo.slice(-2)
  );

  // First undo: B is already open — no jump, just reverts in place.
  await doUndo();
  await page.waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0, { timeout: 5_000 });
  check('undo #1 reverts B in place (still B open, no jump needed)', (await currentLook()) === lookB, await currentLook());
  check("B's ev is back to its pre-edit value (0)", (await devEv()) === 0, await devEv());

  // Second undo: the next entry targets A, which is NOT open — a genuine JUMP.
  await doUndo();
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 15_000 });
  await page.waitForFunction((p) => window.__debug.projectState().currentLookPath === p, lookA, { timeout: 15_000 });
  check('undo #2 JUMPS to A (screen state now shows A — projectState().currentLookPath)', (await currentLook()) === lookA, await currentLook());
  check("A's ev is back to its pre-edit value (0) after the jump", (await devEv()) === 0, await devEv());

  // === 2. Redo is symmetric — jumps back the other way ===
  console.log('verify-undo (2. redo is symmetric — jumps back the other way):');
  await doRedoByButton(); // redoes the MOST recently undone entry first (A's)
  await page.waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.5, { timeout: 5_000 });
  check('redo #1 re-applies A\'s edit, staying on A (already open)', (await currentLook()) === lookA && (await devEv()) === 0.5, {
    look: await currentLook(),
    ev: await devEv(),
  });

  await doRedoByButton(); // redoes B's entry — a jump forward to B
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 15_000 });
  await page.waitForFunction((p) => window.__debug.projectState().currentLookPath === p, lookB, { timeout: 15_000 });
  check('redo #2 JUMPS forward to B', (await currentLook()) === lookB, await currentLook());
  check("B's ev is re-applied (0.7) after the jump", (await devEv()) === 0.7, await devEv());

  // === 3. Rating and flag round-trip through the SAME global stack ===
  console.log('verify-undo (3. rating + flag round-trip through the global stack):');
  const ratingState = () => page.evaluate(() => window.__debug.sidecarState().rating);
  const flagState = () => page.evaluate(() => window.__debug.sidecarState().flag);

  await page.evaluate(() => window.__debug.setRating(4));
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 4, { timeout: 5_000 });
  const stackAfterRating = await undoState();
  check("setRating pushed a 'rating' entry onto the SAME stack", stackAfterRating.undo.at(-1)?.kind === 'rating', stackAfterRating.undo.at(-1));

  await doUndo();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 0, { timeout: 5_000 });
  check('undo reverts the rating', (await ratingState()) === 0, await ratingState());
  await doRedoByButton();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 4, { timeout: 5_000 });
  check('redo restores the rating', (await ratingState()) === 4, await ratingState());

  await page.keyboard.press('p'); // pick
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'pick', { timeout: 5_000 });
  const stackAfterFlag = await undoState();
  check("pressing p pushed a 'flag' entry onto the SAME stack", stackAfterFlag.undo.at(-1)?.kind === 'flag', stackAfterFlag.undo.at(-1));

  await doUndo();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  check('undo reverts the flag', (await flagState()) === null, await flagState());
  await doRedoByButton();
  await page.waitForFunction(() => window.__debug.sidecarState().flag === 'pick', { timeout: 5_000 });
  check('redo restores the flag', (await flagState()) === 'pick', await flagState());

  // === 4. Truncation: a new op drops whatever was on the redo branch ===
  console.log('verify-undo (4. a new edit truncates the redo branch):');
  await doUndo(); // undo the flag pick again -> one entry now sits on redo
  await page.waitForFunction(() => window.__debug.sidecarState().flag === null, { timeout: 5_000 });
  const stackWithRedo = await undoState();
  check('redo branch has at least one entry before the new op', stackWithRedo.redo.length > 0, stackWithRedo.redo.length);

  await setEv(1.23); // a brand-new, unrelated edit
  const stackAfterNewOp = await undoState();
  check('the new edit truncated the redo branch entirely', stackAfterNewOp.redo.length === 0, stackAfterNewOp.redo);

  // === 5. Bounded depth: caps at UNDO_STACK_LIMIT (200), oldest dropped first ===
  console.log('verify-undo (5. bounded stack depth — caps at 200, oldest dropped):');
  const UNDO_STACK_LIMIT = 200; // src/renderer/store/undoStack.ts's own constant
  await page.evaluate((n) => {
    // Alternating values are each a genuine change (setRating no-ops on a
    // repeat of the SAME value) — this pushes exactly one 'rating' entry per
    // call, fast, well past the bound.
    for (let i = 0; i < n; i++) window.__debug.setRating(i % 2 === 0 ? 1 : 2);
  }, UNDO_STACK_LIMIT + 25);
  const boundedStack = await undoState();
  check(`the undo stack never exceeds ${UNDO_STACK_LIMIT} entries`, boundedStack.undo.length === UNDO_STACK_LIMIT, boundedStack.undo.length);

  // === 6. Blocked undo: the target photo's file is missing ===
  console.log('verify-undo (6. blocked undo — the target photo file is missing):');
  await openAndWait(PHOTO_C);
  await setEv(1.3);
  const lookC = await currentLook();
  await openAndWait(PHOTO_D); // C is no longer open — its entry needs a jump to undo

  const stackBeforeMissingUndo = await undoState();
  check("the top undo entry targets C (not currently open)", stackBeforeMissingUndo.undo.at(-1)?.target === PHOTO_C, stackBeforeMissingUndo.undo.at(-1));

  const hiddenC = `${PHOTO_C}.hidden`;
  renameSync(PHOTO_C, hiddenC); // simulate "file missing, relink pending"
  try {
    await doUndo();
    await page.waitForSelector('[data-testid="project-notice"]', { timeout: 10_000 });
    check('a notice appears explaining the blocked undo', true, true);
    const stackAfterBlocked = await undoState();
    check(
      "the entry stays on the stack — not silently skipped, not applied blind",
      stackAfterBlocked.undo.at(-1)?.target === PHOTO_C && stackAfterBlocked.undo.length === stackBeforeMissingUndo.undo.length,
      { before: stackBeforeMissingUndo.undo.length, after: stackAfterBlocked.undo.length }
    );
  } finally {
    renameSync(hiddenC, PHOTO_C); // restore before retrying, whether or not the checks above passed
  }

  // Retrying now that the file is back: the SAME undo() call succeeds.
  await doUndo();
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 15_000 });
  await page.waitForFunction((p) => window.__debug.projectState().currentLookPath === p, lookC, { timeout: 15_000 });
  check('retrying the undo after the file is restored succeeds — jumps to C and reverts', (await currentLook()) === lookC && (await devEv()) === 0, {
    look: await currentLook(),
    ev: await devEv(),
  });
  const stackAfterRetry = await undoState();
  check("C's entry is consumed off the stack once the retry succeeds", stackAfterRetry.undo.at(-1)?.target !== PHOTO_C, stackAfterRetry.undo.at(-1));

  // === 7. Interleaved with autosave: the revert reaches disk once the debounce settles ===
  console.log('verify-undo (7. undo interleaves with autosave — the look file on disk reflects the revert):');
  await openAndWait(PHOTO_E);
  await setEv(2.2);
  const lookE = await currentLook();
  const evOf = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')).graph?.nodes?.find((n) => n.id === 'dev')?.develop?.basic?.ev;
    } catch {
      return undefined;
    }
  };
  // Wait for the pre-undo edit itself to autosave first, so the undo below
  // is reverting a genuinely-saved state, not racing the FIRST debounce.
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check("E's edit (2.2) reached disk before the undo", evOf(lookE) === 2.2, evOf(lookE));

  await doUndo();
  await page.waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0, { timeout: 5_000 });
  check('undo reverts E in memory immediately', (await devEv()) === 0, await devEv());
  // The debounce (1000ms) plus slack — poll rather than a fixed sleep.
  const start = Date.now();
  let onDisk;
  while (Date.now() - start < 10_000) {
    onDisk = evOf(lookE);
    if (onDisk === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("the reverted look eventually lands on disk too (autosave's normal debounce)", onDisk === 0, onDisk);

  check('no page errors across the run', true, true);
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
