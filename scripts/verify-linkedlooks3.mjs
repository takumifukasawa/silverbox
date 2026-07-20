/**
 * Shared-look hot-reload & drift verify (docs/brief-bank/
 * linked-looks-stage-d.md — stage D of linked-looks.md): builds on stage B's
 * link core (verify-linkedlooks.mjs) and stage C's publish
 * (verify-linkedlooks2.mjs). An external change to a shared-look FILE —
 * hand-edit, AI edit, `git pull` — propagates to followers through ONE
 * re-materialization path (appStore.ts's reMaterializeSharedLook), the SAME
 * fan-out shape publish uses, triggered by three entry points: a debounced
 * fs.watch on `<projectDir>/shared-looks/` (semantic 3), drift-at-open
 * comparing marker hashes (semantic 5), and app-side publish itself
 * (unaffected, but must not double-fan-out from its own write's echo —
 * semantic 2). Drives the REAL UI (SharedLookMenu.tsx) wherever a visible
 * gesture exists, external rewrites via direct fs writes (atomic
 * rename-into-place, verify-hotreload.mjs's own pattern), and
 * `window.__debug` for state assertions — same split every recent verify
 * script in this family uses.
 *
 * Setup: shared look "Drift Look" (basic-tone + wb) created from photo1;
 * photo2 pre-edited in wb before linking (follows basic-tone only), photo3
 * never touched before linking (follows both) — the SAME setup shape
 * verify-linkedlooks2.mjs's own script establishes.
 *
 * Checks (the brief's own numbered list):
 *  1. External edit: rewrite shared-looks/<slug>.json on disk (changed
 *     basic-tone value, atomic rename) while the app is open+clean →
 *     followers re-materialize (files show the new value; photo2's own wb
 *     edit stays untouched), notice fired, materializedFrom = new hash
 *     everywhere; ONE ⌘Z restores the look file byte-identical + all
 *     followers; redo re-applies.
 *  2. Echo suppression: an app-side publish does NOT trigger a second
 *     fan-out from its own fs-watch echo (undo stack gains exactly one
 *     entry).
 *  3. Drift at open: close the project, rewrite the look file on disk,
 *     reopen the project → fan-out runs at open (same asserts as 1). Then:
 *     a no-drift reopen (markers already match) runs NO fan-out.
 *  4. Value-drift-implies-fork: externally rewrite photo3's own look file
 *     changing a followed group's values (keep materializedFrom), reopen
 *     photo3 → that group is unlisted from follows (forked), values
 *     preserved; a subsequent external look edit does NOT clobber it.
 *  5. Missing file: remove the shared-look file on disk, reopen → notice,
 *     link kept, publish gracefully no-ops (never crashes).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, hasSharedLook, lookPathFor, readLook, readSharedLook, sharedLookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const projectDir = ensureTestProjectEnv();

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks3-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order (folder open's own sort): a_photo1 opens first.
const PHOTO1 = fixture('a_photo1.ARW');
const PHOTO2 = fixture('b_photo2.ARW'); // pre-edited in wb before linking
const PHOTO3 = fixture('c_photo3.ARW'); // never touched before linking

const devOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.id === 'dev').develop;
const linkOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.id === 'dev').link;
const devOfGraph = (graph) => graph.nodes.find((n) => n.id === 'dev').develop;
const linkOfGraph = (graph) => graph.nodes.find((n) => n.id === 'dev').link;
const devOfShared = (sharedDoc) => sharedDoc.look.graph.nodes.find((n) => n.id === 'dev').develop;
// sha256 of a shared-look/photo-look file's own serialized bytes, matching
// appStore.ts's materializedFrom computation exactly.
const sha256Hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** Atomic (rename-into-place) external rewrite of a shared-look file — verify-hotreload.mjs's own `atomicWrite` pattern, required so a live fs.watch never observes a half-written file. */
function atomicWriteSharedLook(slug, obj) {
  const target = sharedLookPathFor(slug);
  const tmp = `${target}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}
/** Same atomic rewrite, for a PHOTO's own look file (semantic 6's value-drift-fork setup). */
function atomicWriteLook(imagePath, obj) {
  const target = lookPathFor(imagePath);
  const tmp = `${target}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}

// Defensive against transient disk-read races: an atomic external write, or
// an in-flight app-side re-materialization, can leave a poll's own
// `readLook`/`linkOf` chain reading a not-yet-linked/not-yet-parseable file
// for a moment — a thrown error there means "not yet", same as `false`, not
// a real failure (the check() assertion after the wait still catches a
// genuine bug once the timeout is hit).
async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks3-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReadyOrError = () =>
    page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );
  const openImageFireAndForget = (path, opts) =>
    page.evaluate(({ p, o }) => void window.__openImageByPath(p, o), { p: path, o: opts });
  const openFolderFireAndForget = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const sharedLooksState = () => page.evaluate(() => window.__debug.sharedLooksState());
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const undoState = () => page.evaluate(() => window.__debug.undoStackState());
  const sharedLookNotice = () => page.evaluate(() => window.__debug.sharedLookHotReloadState());
  const developLinkState = (nodeId) => page.evaluate((id) => window.__debug.developLinkState(id), nodeId ?? undefined);

  const openImageAndWait = async (path) => {
    await openImageFireAndForget(path, { keepFolderContext: true });
    await waitReadyOrError();
  };

  const openSharedLookMenu = async () => {
    if ((await page.locator('[data-testid="shared-look-menu"]').count()) === 0) {
      await page.locator('[data-testid="shared-look-button"]').click();
      await page.waitForSelector('[data-testid="shared-look-menu"]', { timeout: 5_000 });
    }
  };
  const closeSharedLookMenuIfOpen = async () => {
    if ((await page.locator('[data-testid="shared-look-menu"]').count()) > 0) {
      await page.locator('[data-testid="shared-look-button"]').click();
    }
  };
  const sharedLookRow = (name) => page.locator('[data-testid="shared-look-row"]').filter({ hasText: name });

  const DEVELOP_FAMILY_IDS = ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail'];
  const setFamilyCheckboxes = async (idsToCheck) => {
    const want = new Set(idsToCheck);
    for (const id of DEVELOP_FAMILY_IDS) {
      const checkbox = page.locator(`[data-testid="family-scope-checkbox-${id}"] input[type="checkbox"]`);
      if (want.has(id)) await checkbox.check();
      else await checkbox.uncheck();
    }
  };
  const openPublishDialog = async () => {
    await openSharedLookMenu();
    await page.locator('[data-testid="shared-look-publish"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
  };
  const confirmPublish = async () => {
    await page.locator('[data-testid="family-scope-confirm"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });
  };

  // === Setup: open the folder — a_photo1 (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PHOTO1,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 3, { timeout: 15_000 });

  console.log('verify-linkedlooks3 (setup: create "Drift Look" from photo1, link photo2 [pre-edited wb] + photo3):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.6));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 15));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 5000));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.tint', 8));

  await openSharedLookMenu();
  await page.locator('[data-testid="shared-look-create-name"]').fill('Drift Look');
  await page.locator('[data-testid="shared-look-create"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
  await setFamilyCheckboxes(['basic-tone', 'wb']);
  await page.locator('[data-testid="family-scope-confirm"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });

  check(
    'shared look file appears under shared-looks/',
    await waitFor(async () => (await sharedLooksState()).some((p) => p.name === 'Drift Look')),
    await sharedLooksState()
  );
  const slug = (await sharedLooksState()).find((p) => p.name === 'Drift Look')?.slug;
  check('shared look slug resolved', !!slug, slug);

  await openImageAndWait(PHOTO2);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 4200)); // wb edit BEFORE linking — differs from the look's own 5000
  await page.click('[data-testid="save-button"]');
  check('photo2 pre-edit look lands on disk', await waitFor(() => devOf(readLook(PHOTO2)).basic.temp === 4200), lookPathFor(PHOTO2));

  await openImageAndWait(PHOTO1);
  await setSelection([PHOTO2, PHOTO3]);
  await openSharedLookMenu();
  await sharedLookRow('Drift Look').click();
  await page.locator('[data-testid="shared-look-link"]').click();
  check(
    'photo2 follows basic-tone only (wb stays individual — already edited)',
    await waitFor(() => JSON.stringify([...linkOf(readLook(PHOTO2)).follows].sort()) === JSON.stringify(['basic-tone'])),
    linkOf(readLook(PHOTO2))
  );
  check(
    'photo3 follows both basic-tone and wb (untouched before linking)',
    await waitFor(() => JSON.stringify([...linkOf(readLook(PHOTO3)).follows].sort()) === JSON.stringify(['basic-tone', 'wb'])),
    linkOf(readLook(PHOTO3))
  );
  await closeSharedLookMenuIfOpen();
  await waitFor(async () => (await graphDirty()) === false);
  check('session is clean after setup (photo1 stays open)', (await graphDirty()) === false, await graphDirty());

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks3 (1. external edit of the shared-look file -> ONE fan-out, clean session, auto-applies):');
  const sharedLookBeforeCheck1 = readSharedLook(slug);
  const rewritten1 = structuredClone(sharedLookBeforeCheck1);
  devOfShared(rewritten1).basic.ev = 2.4;
  const undoDepthBeforeCheck1 = (await undoState()).undo.length;
  atomicWriteSharedLook(slug, rewritten1);

  check(
    "shared-look watch re-materializes photo3 (follows both) with the new exposure",
    await waitFor(() => devOf(readLook(PHOTO3)).basic.ev === 2.4),
    () => devOf(readLook(PHOTO3)).basic
  );
  // Compound wait, not a one-shot read: the notice is set AFTER the whole
  // fan-out (including refreshPlaylistStatus's own IPC round trip) settles,
  // which can lag noticeably behind the LAST follower file actually landing
  // on disk (photo3's own wait above just proves the file update, not that
  // the notice has been set yet).
  await waitFor(async () => (await sharedLookNotice())?.kind === 'applied');
  const notice1 = await sharedLookNotice();
  check("'applied' notice fired naming the look, N=3 followers", notice1?.kind === 'applied' && notice1.message.includes('3'), notice1);

  const newHash1 = sha256Hex(readFileSync(sharedLookPathFor(slug), 'utf8'));
  check("photo3's materializedFrom equals the new look hash", linkOf(readLook(PHOTO3)).materializedFrom === newHash1, linkOf(readLook(PHOTO3)));
  check(
    "photo2 (follows basic-tone only) re-materialized with the new exposure too",
    devOf(readLook(PHOTO2)).basic.ev === 2.4,
    devOf(readLook(PHOTO2)).basic
  );
  check("photo2 keeps its OWN wb edit (temp=4200), untouched by the external edit", devOf(readLook(PHOTO2)).basic.temp === 4200, devOf(readLook(PHOTO2)).basic.temp);
  check("photo2's materializedFrom bumped too (unconditional, same publish contract)", linkOf(readLook(PHOTO2)).materializedFrom === newHash1, linkOf(readLook(PHOTO2)));
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 2.4);
  check("photo1 (open, also a follower) re-materialized live", devOfGraph(await graphState()).basic.ev === 2.4, devOfGraph(await graphState()));
  check("photo1's materializedFrom equals the new look hash", linkOfGraph(await graphState()).materializedFrom === newHash1, linkOfGraph(await graphState()));

  const undoDepthAfterCheck1 = (await undoState()).undo.length;
  check('exactly ONE undo entry pushed for the external edit', undoDepthAfterCheck1 === undoDepthBeforeCheck1 + 1, { before: undoDepthBeforeCheck1, after: undoDepthAfterCheck1 });
  const topEntry1 = (await undoState()).undo.at(-1);
  check("the new entry reuses the 'publish' undo kind (PublishUndoEntry, per the brief)", topEntry1?.kind === 'publish', topEntry1);

  // Follower files get a FRESH `updatedAt` stamp on every serializeGraphDoc
  // write (verify-linkedlooks2.mjs's own documented caveat) — undo/redo of a
  // follower goes through applySyncEntryGraphs, which re-serializes, so byte-
  // identical comparison only works for the shared-look FILE itself (its
  // undo/redo writes lookTextBefore/After VERBATIM). Followers are compared
  // at the MATERIALIZED-FIELD granularity instead (develop values + link
  // state), same precedent.
  const photo3StateAfterCheck1 = { develop: devOf(readLook(PHOTO3)), link: linkOf(readLook(PHOTO3)) };
  const photo2StateAfterCheck1 = { develop: devOf(readLook(PHOTO2)), link: linkOf(readLook(PHOTO2)) };
  const sharedLookTextAfterCheck1 = readFileSync(sharedLookPathFor(slug), 'utf8');

  await page.keyboard.press('Meta+z');
  await waitFor(() => readFileSync(sharedLookPathFor(slug), 'utf8') === JSON.stringify(sharedLookBeforeCheck1, null, 2) + '\n');
  check('⌘Z restores the shared-look file byte-identical to its pre-edit state', readFileSync(sharedLookPathFor(slug), 'utf8') === JSON.stringify(sharedLookBeforeCheck1, null, 2) + '\n', null);
  await waitFor(() => devOf(readLook(PHOTO3)).basic.ev !== 2.4);
  check("photo3 reverts (no longer 2.4)", devOf(readLook(PHOTO3)).basic.ev !== 2.4, devOf(readLook(PHOTO3)).basic);
  await waitFor(async () => devOfGraph(await graphState()).basic.ev !== 2.4);
  check('photo1 (open, live) reverts too', devOfGraph(await graphState()).basic.ev !== 2.4, devOfGraph(await graphState()));

  await page.keyboard.press('Meta+Shift+z');
  await waitFor(() => readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck1);
  check('redo restores the shared-look file byte-identical to its check-1 post-edit state', readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck1, null);
  await waitFor(() => JSON.stringify(devOf(readLook(PHOTO3))) === JSON.stringify(photo3StateAfterCheck1.develop));
  check(
    'redo restores photo3 to its check-1 materialized state (develop + link)',
    JSON.stringify(devOf(readLook(PHOTO3))) === JSON.stringify(photo3StateAfterCheck1.develop) &&
      JSON.stringify(linkOf(readLook(PHOTO3))) === JSON.stringify(photo3StateAfterCheck1.link),
    { develop: devOf(readLook(PHOTO3)), link: linkOf(readLook(PHOTO3)) }
  );
  await waitFor(() => JSON.stringify(devOf(readLook(PHOTO2))) === JSON.stringify(photo2StateAfterCheck1.develop));
  check(
    'redo restores photo2 to its check-1 materialized state (develop + link)',
    JSON.stringify(devOf(readLook(PHOTO2))) === JSON.stringify(photo2StateAfterCheck1.develop) &&
      JSON.stringify(linkOf(readLook(PHOTO2))) === JSON.stringify(photo2StateAfterCheck1.link),
    { develop: devOf(readLook(PHOTO2)), link: linkOf(readLook(PHOTO2)) }
  );
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 2.4);
  check('redo restores photo1 (open, live) to its check-1 exposure', devOfGraph(await graphState()).basic.ev === 2.4, devOfGraph(await graphState()));

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks3 (2. echo suppression: an app-side publish does not double-fan-out from its own fs-watch echo):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 33)); // fresh edit to publish
  const undoDepthBeforeCheck2 = (await undoState()).undo.length;
  await openPublishDialog();
  await confirmPublish();
  await waitFor(() => hasSharedLook(slug) && devOfShared(readSharedLook(slug)).basic.contrast === 33);
  const undoDepthRightAfterPublish = (await undoState()).undo.length;
  check('publish pushed exactly one undo entry', undoDepthRightAfterPublish === undoDepthBeforeCheck2 + 1, { before: undoDepthBeforeCheck2, after: undoDepthRightAfterPublish });
  // Give the shared-looks watch's own debounce (~150ms) + a wide margin to
  // fire its echo of this exact write and settle — a regression here would
  // append a SECOND 'publish'-kind entry from handleSharedLooksChanged
  // misreading our own write as an external change.
  await new Promise((r) => setTimeout(r, 1500));
  const undoDepthAfterSettle = (await undoState()).undo.length;
  check(
    "undo stack did NOT grow further — the watch's echo of our own publish write was suppressed",
    undoDepthAfterSettle === undoDepthRightAfterPublish,
    { rightAfterPublish: undoDepthRightAfterPublish, afterSettle: undoDepthAfterSettle }
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks3 (3. drift at open: an external edit while the project is closed re-materializes at reopen; a no-drift reopen is a no-op):');
  const sharedLookBeforeCheck3 = readSharedLook(slug);
  const rewritten3 = structuredClone(sharedLookBeforeCheck3);
  devOfShared(rewritten3).basic.ev = -1.7;
  atomicWriteSharedLook(slug, rewritten3);
  const newHash3 = sha256Hex(JSON.stringify(rewritten3, null, 2) + '\n');

  await page.evaluate(() => window.__newProject());
  const undoDepthBeforeReopen = (await undoState()).undo.length; // undo is a GLOBAL timeline (never reset by newProject) — used below to prove the no-drift reopen adds nothing
  await page.evaluate((dir) => window.__openProjectByPath(dir), projectDir);
  await page.waitForFunction(
    (p) => window.__debug.imageState().status === 'ready' && window.__debug.projectState()?.currentLookPath?.includes(p),
    'a_photo1',
    { timeout: 120_000 }
  );

  check(
    'drift-at-open re-materializes photo3 with the externally-edited exposure',
    await waitFor(() => devOf(readLook(PHOTO3)).basic.ev === -1.7),
    () => devOf(readLook(PHOTO3)).basic
  );
  check("photo3's materializedFrom equals the drifted-in hash", linkOf(readLook(PHOTO3)).materializedFrom === newHash3, linkOf(readLook(PHOTO3)));
  check(
    'photo2 (follows basic-tone only) re-materialized too, own wb (temp=4200) still untouched',
    devOf(readLook(PHOTO2)).basic.ev === -1.7 && devOf(readLook(PHOTO2)).basic.temp === 4200,
    devOf(readLook(PHOTO2)).basic
  );
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === -1.7);
  check('photo1 (reopened as the primary) reflects the drifted-in exposure', devOfGraph(await graphState()).basic.ev === -1.7, devOfGraph(await graphState()));
  const undoDepthAfterDriftReopen = (await undoState()).undo.length;
  check('drift-at-open pushed exactly one undo entry', undoDepthAfterDriftReopen === undoDepthBeforeReopen + 1, { before: undoDepthBeforeReopen, after: undoDepthAfterDriftReopen });

  // No-drift reopen: markers already match current content — a second
  // close/reopen cycle with NO external edit in between must be a pure no-op.
  await page.evaluate(() => window.__newProject());
  const undoDepthBeforeNoDriftReopen = (await undoState()).undo.length;
  await page.evaluate((dir) => window.__openProjectByPath(dir), projectDir);
  await page.waitForFunction(
    (p) => window.__debug.imageState().status === 'ready' && window.__debug.projectState()?.currentLookPath?.includes(p),
    'a_photo1',
    { timeout: 120_000 }
  );
  // No positive event to wait ON here (a compound wait would have nothing
  // sound to poll for) — settle on a fixed margin instead, then assert
  // nothing moved. photo1 is a real RAW decode + a project-wide drift scan,
  // already well over 1s in practice; 2s is a comfortable margin beyond that.
  await new Promise((r) => setTimeout(r, 2_000));
  const undoDepthAfterNoDriftReopen = (await undoState()).undo.length;
  check(
    'a no-drift reopen (markers already match) runs NO fan-out — undo stack unchanged',
    undoDepthAfterNoDriftReopen === undoDepthBeforeNoDriftReopen,
    { before: undoDepthBeforeNoDriftReopen, after: undoDepthAfterNoDriftReopen }
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks3 (4. value-drift-implies-fork: a hand-edited follower forks instead of being clobbered):');
  await openImageAndWait(PHOTO3);
  const photo3Before4 = readLook(PHOTO3);
  const matchingHash = linkOf(photo3Before4).materializedFrom; // == the CURRENT shared-look hash (photo3 is caught up, per check 3)
  check("setup: photo3's materializedFrom matches the shared look's CURRENT hash (precondition for this check)", matchingHash === sha256Hex(readFileSync(sharedLookPathFor(slug), 'utf8')), matchingHash);
  const handEdited = structuredClone(photo3Before4);
  devOf(handEdited).basic.tint = 47; // wb param — photo3 currently follows wb
  // materializedFrom deliberately UNCHANGED — the exact "editing a followed
  // group means also unlisting it, the sanitizer forgives the omission"
  // scenario the brief describes.
  atomicWriteLook(PHOTO3, handEdited);

  await openImageAndWait(PHOTO1); // navigate away and back — forces a fresh load of photo3's own file
  await openImageAndWait(PHOTO3);
  check(
    'wb is unlisted from follows (forked) on reopen — value-drift-implies-fork',
    await waitFor(async () => !(await developLinkState('dev'))?.follows.includes('wb')),
    await developLinkState('dev')
  );
  await waitFor(async () => devOfGraph(await graphState()).basic.tint === 47);
  check('the hand-edited value (tint=47) is PRESERVED, not clobbered', devOfGraph(await graphState()).basic.tint === 47, devOfGraph(await graphState()).basic);
  check('basic-tone is untouched by the fork (still following)', (await developLinkState('dev'))?.follows.includes('basic-tone'), await developLinkState('dev'));

  // A subsequent external look edit must not clobber the now-forked wb.
  const sharedLookBeforeCheck4b = readSharedLook(slug);
  const rewritten4b = structuredClone(sharedLookBeforeCheck4b);
  devOfShared(rewritten4b).basic.temp = 6100; // a wb value — would clobber photo3's tint=47 fork if not respected
  devOfShared(rewritten4b).basic.ev = 3.3; // also bump basic-tone so there's something to observably re-materialize
  atomicWriteSharedLook(slug, rewritten4b);
  check(
    "photo3's basic-tone re-materializes with the new external edit",
    await waitFor(() => devOf(readLook(PHOTO3)).basic.ev === 3.3),
    () => devOf(readLook(PHOTO3)).basic
  );
  check("photo3's forked wb (tint=47) is NOT clobbered by the subsequent external edit", devOf(readLook(PHOTO3)).basic.tint === 47, devOf(readLook(PHOTO3)).basic);

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks3 (5. missing shared-look file: notice fired, link kept, no crash, publish gracefully refuses):');
  rmSync(sharedLookPathFor(slug), { force: true });
  await openImageAndWait(PHOTO1);
  await openImageAndWait(PHOTO2); // photo2 also links this slug — either photo surfaces the missing-look notice
  const missingNotice = await sharedLookNotice();
  check("'missing' notice fired naming the look", missingNotice?.kind === 'missing' && missingNotice.slug === slug, missingNotice);
  check('link metadata is KEPT (never auto-stripped)', (await developLinkState('dev'))?.look === slug, await developLinkState('dev'));
  const publishBeforeMissing = (await undoState()).undo.length;
  await page.evaluate(() => window.__debug.publishToSharedLook(['basic-tone']));
  await new Promise((r) => setTimeout(r, 500));
  check('publish against a missing look gracefully no-ops (no crash, no undo entry)', (await undoState()).undo.length === publishBeforeMissing, {
    before: publishBeforeMissing,
    after: (await undoState()).undo.length,
  });

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
