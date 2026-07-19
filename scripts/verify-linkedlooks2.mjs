/**
 * Publish verify (docs/brief-bank/linked-looks-stage-c.md — publish to the
 * shared look, stage C of linked-looks.md): builds on stage B's link core
 * (verify-linkedlooks.mjs) — a shared look (共通ルック) lives at
 * `<projectDir>/shared-looks/<slug>.json`, and a photo's Develop node
 * carries an additive `link` field naming which look it follows, per
 * develop family. This script drives the REAL UI (SharedLookMenu.tsx's new
 * "この写真の調整を共通ルックに反映" button + the shared FamilyScopeDialog)
 * wherever a visible gesture exists, and `window.__debug` for state
 * assertions, exactly like verify-linkedlooks.mjs's own split.
 *
 * Setup: shared look "Warm Look" (basic-tone + wb) created from photo1;
 * photo2 pre-edited in wb before linking (follows basic-tone only), photo3
 * never touched before linking (follows both) — the SAME setup shape
 * verify-linkedlooks.mjs's own checks 1-2 establish.
 *
 * Checks (the brief's own numbered list):
 *  1. Fork basic-tone on photo1 (edit exposure), publish basic-tone (+ wb,
 *     the dialog's own default-checked = the look's CURRENT includes):
 *     shared-look file carries the new value; photo3's file re-materialized
 *     with it; photo2's basic-tone updated too (it follows basic-tone),
 *     photo2's own wb untouched; ALL THREE files' materializedFrom equal
 *     the new look hash; photo1's basic-tone is back in `follows`.
 *  2. Add a second (unlinked) Develop node to photo1's chain (hand-spliced
 *     on disk — there is no UI action to add a second Develop node) with a
 *     different exposure; edit the LINKED node's own exposure too; publish
 *     basic-tone again → the published value is the LINKED node's, not the
 *     tweak layer's.
 *  3. One ⌘Z: shared-look file byte-identical to its check-1 state, all
 *     three photo files byte-identical to their check-1 state; redo
 *     re-applies check 2's values.
 *  4. Publish with a family newly checked (not in the look's includes):
 *     look's includes grows; existing followers (photo2/photo3) do NOT
 *     start following it (their `follows` unchanged); the publisher DOES
 *     (semantic 5).
 *  5. CLI render of a follower (photo3) reflects the published values
 *     (materialization, no CLI code changes) — proven by rendering two
 *     on-disk snapshots of its look file (early vs. final) and confirming
 *     the pixels differ.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';
import { ensureTestProjectEnv, hasSharedLook, lookPathFor, readLook, readSharedLook, sharedLookPathFor } from './lib/testProject.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks2-'));
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
const hasLookOnDisk = (path) => existsSync(lookPathFor(path));
// A shared-look file's own shape (presetDoc.ts's serializePreset) nests the
// captured graph under `.look.graph`, unlike a photo look file's top-level
// `.graph` — readSharedLook() returns the WHOLE wrapper (name/includes/look).
const devOfShared = (sharedDoc) => sharedDoc.look.graph.nodes.find((n) => n.id === 'dev').develop;
// sha256 of the shared-look file's own serialized bytes, matching appStore.ts's
// materializedFrom computation exactly (sha256Hex(new TextEncoder().encode(text).buffer)) — Node's
// createHash over the UTF-8 bytes produces the identical digest.
const sha256Hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
/** Atomic (rename-into-place) external rewrite of an ALREADY-OPEN photo's look file — verify-hotreload.mjs's own `atomicWrite` pattern, required so a live fs.watch never observes a half-written file. */
function atomicWriteLook(imagePath, obj) {
  const target = lookPathFor(imagePath);
  const tmp = `${target}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}

async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks2-userdata-'));

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
  const familyCheckboxState = async () => {
    const state = {};
    for (const id of DEVELOP_FAMILY_IDS) {
      state[id] = await page.locator(`[data-testid="family-scope-checkbox-${id}"] input[type="checkbox"]`).isChecked();
    }
    return state;
  };

  /** Open photo1's Publish dialog via the REAL button, wait for it to appear. */
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

  console.log('verify-linkedlooks2 (setup: create "Warm Look" from photo1, link photo2 [pre-edited wb] + photo3):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.6));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 15));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 5000));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.tint', 8));

  await openSharedLookMenu();
  await page.locator('[data-testid="shared-look-create-name"]').fill('Warm Look');
  await page.locator('[data-testid="shared-look-create"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
  await setFamilyCheckboxes(['basic-tone', 'wb']);
  await page.locator('[data-testid="family-scope-confirm"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });

  check(
    'shared look file appears under shared-looks/',
    await waitFor(async () => (await sharedLooksState()).some((p) => p.name === 'Warm Look')),
    await sharedLooksState()
  );
  const slug = (await sharedLooksState()).find((p) => p.name === 'Warm Look')?.slug;
  check('shared look slug resolved', !!slug, slug);

  await openImageAndWait(PHOTO2);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 4200)); // wb edit BEFORE linking — differs from the look's own 5000
  await page.click('[data-testid="save-button"]');
  check('photo2 pre-edit look lands on disk', await waitFor(() => hasLookOnDisk(PHOTO2)), lookPathFor(PHOTO2));

  await openImageAndWait(PHOTO1);
  await setSelection([PHOTO2, PHOTO3]);
  await openSharedLookMenu();
  await sharedLookRow('Warm Look').click();
  await page.locator('[data-testid="shared-look-link"]').click();
  check('photo2 gains a look file', await waitFor(() => hasLookOnDisk(PHOTO2)), lookPathFor(PHOTO2));
  check('photo3 gains a look file', await waitFor(() => hasLookOnDisk(PHOTO3)), lookPathFor(PHOTO3));
  check(
    'photo2 follows basic-tone only (wb stays individual — already edited)',
    JSON.stringify([...linkOf(readLook(PHOTO2)).follows].sort()) === JSON.stringify(['basic-tone']),
    linkOf(readLook(PHOTO2))
  );
  check(
    'photo3 follows both basic-tone and wb (untouched before linking)',
    JSON.stringify([...linkOf(readLook(PHOTO3)).follows].sort()) === JSON.stringify(['basic-tone', 'wb']),
    linkOf(readLook(PHOTO3))
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks2 (1. fork basic-tone on photo1, publish -> shared look + all followers re-materialized):');
  await openImageAndWait(PHOTO1);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.3));
  await waitFor(async () => !linkOfGraph(await graphState()).follows.includes('basic-tone'));
  check('editing exposure forks basic-tone off follows', !linkOfGraph(await graphState()).follows.includes('basic-tone'), linkOfGraph(await graphState()));

  await openPublishDialog();
  const publishDefaults1 = await familyCheckboxState();
  check(
    "publish dialog defaults to the look's CURRENT includes (basic-tone + wb checked, nothing else — semantic 1's own default, not a remembered habit)",
    publishDefaults1['basic-tone'] === true &&
      publishDefaults1['wb'] === true &&
      DEVELOP_FAMILY_IDS.filter((id) => id !== 'basic-tone' && id !== 'wb').every((id) => publishDefaults1[id] === false),
    publishDefaults1
  );
  await confirmPublish();

  // confirmPublish() only waits for the DIALOG to close — publishToSharedLook
  // itself keeps running in the background (fire-and-forget, same "void
  // theAction(...)" shape every other gesture in this suite uses) — so every
  // read of its RESULT must poll (waitFor), not assume it already landed.
  await waitFor(() => hasSharedLook(slug) && devOfShared(readSharedLook(slug)).basic.ev === 1.3);
  const sharedLookAfterPublish1 = readSharedLook(slug);
  check(
    "shared look file's develop carries the new exposure (1.3)",
    devOfShared(sharedLookAfterPublish1).basic.ev === 1.3,
    devOfShared(sharedLookAfterPublish1)?.basic
  );
  const newHash1 = sha256Hex(readFileSync(sharedLookPathFor(slug), 'utf8'));

  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 1.3 && linkOfGraph(await graphState()).follows.includes('basic-tone'));
  check("photo1 (publisher) re-follows basic-tone (semantic 5)", linkOfGraph(await graphState()).follows.includes('basic-tone'), linkOfGraph(await graphState()));
  check('photo1 (publisher) materializedFrom equals the new look hash', linkOfGraph(await graphState()).materializedFrom === newHash1, linkOfGraph(await graphState()));

  await waitFor(() => devOf(readLook(PHOTO3)).basic.ev === 1.3);
  check('photo3 (follows both) re-materialized with the new exposure', devOf(readLook(PHOTO3)).basic.ev === 1.3, devOf(readLook(PHOTO3)).basic);
  check("photo3 materializedFrom equals the new look hash", linkOf(readLook(PHOTO3)).materializedFrom === newHash1, linkOf(readLook(PHOTO3)));

  await waitFor(() => devOf(readLook(PHOTO2)).basic.ev === 1.3);
  check('photo2 (follows basic-tone only) also re-materialized with the new exposure', devOf(readLook(PHOTO2)).basic.ev === 1.3, devOf(readLook(PHOTO2)).basic);
  check("photo2 keeps its OWN wb edit (temp=4200), untouched by publish", devOf(readLook(PHOTO2)).basic.temp === 4200, devOf(readLook(PHOTO2)).basic.temp);
  check(
    "photo2 materializedFrom equals the new look hash too (CRITICAL DETAIL: bumped even though wb — photo2's individual family — didn't move)",
    linkOf(readLook(PHOTO2)).materializedFrom === newHash1,
    linkOf(readLook(PHOTO2))
  );

  // Snapshot right here — check 3's undo target (the shared-look file's own
  // bytes, restored VERBATIM on undo/redo — see PublishUndoEntry's doc
  // comment) — kept for check 5's CLI render too (a real on-disk snapshot).
  const sharedLookTextAfterCheck1 = readFileSync(sharedLookPathFor(slug), 'utf8');
  const photo3TextAfterCheck1 = readFileSync(lookPathFor(PHOTO3), 'utf8');

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks2 (2. a tweak-layer Develop node must never leak into publish):');
  const beforeSplice = readLook(PHOTO1);
  const devNodeRaw = beforeSplice.graph.nodes.find((n) => n.id === 'dev');
  const outNodeRaw = beforeSplice.graph.nodes.find((n) => n.type === 'output');
  const dev2 = {
    id: 'dev2',
    type: 'Develop',
    position: { x: devNodeRaw.position.x + 160, y: devNodeRaw.position.y },
    // A full clone of the linked node's own (already-valid) develop payload,
    // with only its OWN exposure bent far away — a tweak layer, no `link`.
    develop: { ...structuredClone(devNodeRaw.develop), basic: { ...devNodeRaw.develop.basic, ev: 8.8 } },
  };
  const splicedEdges = beforeSplice.graph.edges
    .filter((e) => !(e.from === 'dev' && e.to === outNodeRaw.id))
    .concat([
      { id: 'e-dev2-in', from: 'dev', to: 'dev2' },
      { id: 'e-dev2-out', from: 'dev2', to: outNodeRaw.id },
    ]);
  const spliced = { ...beforeSplice, graph: { ...beforeSplice.graph, nodes: [...beforeSplice.graph.nodes, dev2], edges: splicedEdges } };

  // External rewrite of the currently-open photo's own look file (verify-
  // hotreload.mjs's exact mechanism — atomic rename-into-place, since a live
  // fs.watch is armed on this exact path): the session is clean here (check
  // 1's publish already flushed via saveGraph), so this auto-reloads with
  // no dialog, per the shipped hot-reload discipline.
  check('session is clean before the external rewrite', (await graphDirty()) === false, await graphDirty());
  atomicWriteLook(PHOTO1, spliced);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'reloaded', { timeout: 10_000 });
  check('photo1 now has 2 Develop nodes (the linked one + the hand-spliced tweak layer)', (await graphState()).nodes.filter((n) => n.kind === 'Develop').length === 2, await graphState());

  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2.1)); // the LINKED node's own new exposure
  await waitFor(async () => devOfGraph(await graphState()).basic.ev === 2.1);

  await openPublishDialog();
  await confirmPublish(); // default-checked still [basic-tone, wb] — the look's current includes

  await waitFor(() => hasSharedLook(slug) && devOfShared(readSharedLook(slug)).basic.ev === 2.1);
  const sharedLookAfterPublish2 = readSharedLook(slug);
  check(
    "published value is the LINKED node's own exposure (2.1), never the tweak layer's (8.8)",
    devOfShared(sharedLookAfterPublish2).basic.ev === 2.1,
    devOfShared(sharedLookAfterPublish2)?.basic
  );
  await waitFor(() => devOf(readLook(PHOTO3)).basic.ev === 2.1);
  check("photo3 re-materialized with the LINKED node's exposure (2.1)", devOf(readLook(PHOTO3)).basic.ev === 2.1, devOf(readLook(PHOTO3)).basic);
  check(
    "photo1's own tweak-layer node (dev2) is untouched by publish (still 8.8)",
    (await graphState()).nodes.find((n) => n.id === 'dev2').develop.basic.ev === 8.8,
    (await graphState()).nodes.find((n) => n.id === 'dev2').develop.basic
  );

  const sharedLookTextAfterCheck2 = readFileSync(sharedLookPathFor(slug), 'utf8');
  const newHash2 = sha256Hex(sharedLookTextAfterCheck2);

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks2 (3. one undo reverts the WHOLE check-2 publish; redo re-applies it):');
  // The shared-look FILE's own undo/redo writes `lookTextBefore`/
  // `lookTextAfter` VERBATIM (PublishUndoEntry's own doc comment) — a real
  // byte === byte comparison. A FOLLOWER's restore instead goes through
  // applySyncEntryGraphs (Record<string, GraphDoc> in, fresh JSON.stringify
  // out — the SAME mechanism DeleteSharedLookUndoEntry's own follower
  // restore already uses), which stamps a fresh `updatedAt` on every write
  // (serializeGraphDoc — not part of the parsed GraphDoc at all, so no
  // undo/redo mechanism built this way can ever reproduce it verbatim); the
  // checks below therefore compare the MATERIALIZED FIELDS instead (develop
  // values + link state), the same granularity verify-linkedlooks.mjs's own
  // undo/redo checks already use for follower files.
  await page.keyboard.press('Meta+z');
  await waitFor(() => readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck1);
  check('shared-look file reverts byte-identical to its pre-check-2-publish state', readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck1, null);

  // Undo of check 2's publish reverts photo1 to "right before check 2's OWN
  // publish click" — which still carries the dev2 splice and the ev=2.1 edit
  // (both separate, earlier undo entries, untouched by undoing just the
  // publish) — NOT all the way back to check 1's state. basic-tone is still
  // forked (the edit's own fork, not yet re-published) and materializedFrom
  // is back to check 1's hash (check 2's publish hadn't bumped it yet).
  await waitFor(async () => linkOfGraph(await graphState()).materializedFrom === newHash1);
  const photo1AfterUndo = await graphState();
  check(
    "photo1 (publisher, in-memory) reverts to its pre-check-2-publish state (ev=2.1 unchanged, basic-tone still forked, materializedFrom back to check 1's hash)",
    devOfGraph(photo1AfterUndo).basic.ev === 2.1 &&
      !linkOfGraph(photo1AfterUndo).follows.includes('basic-tone') &&
      linkOfGraph(photo1AfterUndo).materializedFrom === newHash1,
    linkOfGraph(photo1AfterUndo)
  );
  await waitFor(() => linkOf(readLook(PHOTO2)).materializedFrom === newHash1);
  check(
    "photo2 file reverts to its check-1 materialized state (ev=1.3, materializedFrom back to check 1's hash — unaffected by check 2's edits, which never touched photo2)",
    devOf(readLook(PHOTO2)).basic.ev === 1.3 && linkOf(readLook(PHOTO2)).materializedFrom === newHash1,
    readLook(PHOTO2)
  );
  await waitFor(() => linkOf(readLook(PHOTO3)).materializedFrom === newHash1);
  check(
    "photo3 file reverts to its check-1 materialized state (ev=1.3, materializedFrom back to check 1's hash)",
    devOf(readLook(PHOTO3)).basic.ev === 1.3 && linkOf(readLook(PHOTO3)).materializedFrom === newHash1,
    readLook(PHOTO3)
  );

  await page.keyboard.press('Meta+Shift+z');
  await waitFor(() => readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck2);
  check('redo restores the shared-look file byte-identical to its check-2 state', readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextAfterCheck2, null);
  await waitFor(async () => linkOfGraph(await graphState()).materializedFrom === newHash2);
  const photo1AfterRedo = await graphState();
  check(
    "redo restores photo1 to its check-2 published state (ev=2.1, basic-tone re-followed, materializedFrom == check 2's hash)",
    devOfGraph(photo1AfterRedo).basic.ev === 2.1 &&
      linkOfGraph(photo1AfterRedo).follows.includes('basic-tone') &&
      linkOfGraph(photo1AfterRedo).materializedFrom === newHash2,
    linkOfGraph(photo1AfterRedo)
  );
  await waitFor(() => linkOf(readLook(PHOTO2)).materializedFrom === newHash2);
  check(
    "redo restores photo2 to its check-2 published state (ev=2.1, materializedFrom == check 2's hash)",
    devOf(readLook(PHOTO2)).basic.ev === 2.1 && linkOf(readLook(PHOTO2)).materializedFrom === newHash2,
    readLook(PHOTO2)
  );
  await waitFor(() => linkOf(readLook(PHOTO3)).materializedFrom === newHash2);
  check(
    "redo restores photo3 to its check-2 published state (ev=2.1, materializedFrom == check 2's hash)",
    devOf(readLook(PHOTO3)).basic.ev === 2.1 && linkOf(readLook(PHOTO3)).materializedFrom === newHash2,
    readLook(PHOTO3)
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks2 (4. publish with a newly-checked family -> look grows, existing followers unaffected, publisher follows it):');
  const includesBeforeCheck4 = readSharedLook(slug).includes;
  check("look's includes does NOT yet offer curves", !includesBeforeCheck4.includes('curves'), includesBeforeCheck4);
  const photo2FollowsBeforeCheck4 = linkOf(readLook(PHOTO2)).follows;
  const photo3FollowsBeforeCheck4 = linkOf(readLook(PHOTO3)).follows;

  // photo1 is still the open photo (nothing navigated away since check 2/3) —
  // no reopen needed, and a same-path reopen here would itself push a
  // spurious "Reload from disk" undo entry for no reason.
  await openPublishDialog();
  await setFamilyCheckboxes(['basic-tone', 'wb', 'curves']); // curves newly checked, beyond the look's current includes
  await confirmPublish();

  await waitFor(() => readSharedLook(slug).includes.includes('curves'));
  check("shared look's includes GREW to include curves", readSharedLook(slug).includes.includes('curves'), readSharedLook(slug).includes);
  check("photo1 (publisher) NOW follows curves too (semantic 5)", (await graphState()).nodes.find((n) => n.id === 'dev').link.follows.includes('curves'), (await graphState()).nodes.find((n) => n.id === 'dev').link);
  check(
    "photo2's own follows is UNCHANGED (does not start following curves)",
    JSON.stringify([...linkOf(readLook(PHOTO2)).follows].sort()) === JSON.stringify([...photo2FollowsBeforeCheck4].sort()),
    linkOf(readLook(PHOTO2)).follows
  );
  check(
    "photo3's own follows is UNCHANGED (does not start following curves)",
    JSON.stringify([...linkOf(readLook(PHOTO3)).follows].sort()) === JSON.stringify([...photo3FollowsBeforeCheck4].sort()),
    linkOf(readLook(PHOTO3)).follows
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks2 (5. CLI render of a follower reflects published values, no CLI code changes):');
  const photo3TextEarly = photo3TextAfterCheck1; // captured right after check 1's publish
  const photo3TextFinal = readFileSync(lookPathFor(PHOTO3), 'utf8'); // current, after checks 1-4
  const earlyPath = join(workDir, 'photo3-early.json');
  const finalPath = join(workDir, 'photo3-final.json');
  writeFileSync(earlyPath, photo3TextEarly, 'utf8');
  writeFileSync(finalPath, photo3TextFinal, 'utf8');

  const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');
  const cliOutDir = join(workDir, 'cli-out');
  const runCli = (args) =>
    spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
      cwd: projectRoot,
      env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  const outFor = (subdir) => {
    const dir = join(cliOutDir, subdir);
    mkdirSync(dir, { recursive: true });
    return { dir, path: join(dir, `${basename(PHOTO3).replace(/\.[^.]+$/, '')}.jpg`) };
  };
  const earlyOut = outFor('early');
  const finalOut = outFor('final');
  const rEarly = runCli(['--out', earlyOut.dir, earlyPath]);
  check('CLI render of photo3 (post-check-1 snapshot) exits 0', rEarly.status === 0, { status: rEarly.status, stderr: rEarly.stderr });
  const rFinal = runCli(['--out', finalOut.dir, finalPath]);
  check('CLI render of photo3 (current, post checks 1-4) exits 0', rFinal.status === 0, { status: rFinal.status, stderr: rFinal.stderr });
  const bytesEarly = await sharp(earlyOut.path).raw().toBuffer();
  const bytesFinal = await sharp(finalOut.path).raw().toBuffer();
  check(
    'the two CLI renders differ — the follower materialization actually changed pixels, with zero CLI-side code (plain reads of whatever is on disk)',
    !bytesEarly.equals(bytesFinal),
    { same: bytesEarly.equals(bytesFinal) }
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
