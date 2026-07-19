/**
 * Linked-look core verify (docs/brief-bank/linked-looks-stage-b.md — link
 * core, stage B of linked-looks.md): a shared look (共通ルック) lives at
 * `<projectDir>/shared-looks/<slug>.json` (presetDoc.ts's own format), and a
 * photo's Develop node carries an additive `link` field (parent spec §4)
 * naming which look it follows, per develop family. Drives the REAL UI
 * (SharedLookMenu.tsx's toolbar dropdown, InspectorPanel.tsx's per-family
 * fork badge/revert button and linked-look row) wherever a visible gesture
 * exists, and `window.__debug` for state assertions and batch-selection
 * setup (same split every recent verify script uses).
 *
 * Checks (the brief's own numbered list):
 *  1. Create shared look from photo1 (basic-tone + wb checked) → file exists
 *     under shared-looks/, photo1's Develop carries
 *     link {look, follows:[basic-tone,wb], materializedFrom}.
 *  2. Link photos 2+3 (photo2 pre-edited in wb): photo2 follows basic-tone
 *     only (wb individual, badge state via __debug.developLinkState), photo3
 *     follows both; both files carry the look's basic-tone values
 *     materialized; the already-linked primary (photo1) is skipped, not
 *     double-linked (constraint 3); batch undo reverts photo2+photo3.
 *  3. Edit exposure (basic-tone) on photo1 → follows loses basic-tone;
 *     revert-to-look (the real "合わせる" button) restores the look's value
 *     and re-adds it.
 *  4. Unlink photo3 (the real "共通ルックから外す" button) → link field gone,
 *     values byte-identical.
 *  5. Delete the shared look (the real Delete button) → photos 1+2 lose link
 *     fields, values unchanged; undo restores BOTH the link fields AND the
 *     shared-look FILE itself, byte-identical (conductor review finding: a
 *     follower's `link` REFERENCES the shared look, unlike a preset which
 *     nothing references, so undo-of-delete must resurrect the file too, or
 *     the restored `link` points at nothing); redo removes both again.
 *  6. Old-reader/CLI guard: a look file with `link` renders byte-identical
 *     to the same file with `link` stripped (CLI ignores it entirely); a
 *     look file round-tripped through load→save (the real Save button)
 *     keeps the link field (passthrough).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks-'));
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

async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-linkedlooks-userdata-'));

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
  const undoStackState = () => page.evaluate(() => window.__debug.undoStackState());
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const sharedLooksState = () => page.evaluate(() => window.__debug.sharedLooksState());
  const developLinkState = () => page.evaluate(() => window.__debug.developLinkState('dev'));
  const selectDevNode = () => page.evaluate(() => window.__debug.selectNode('dev'));

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

  // === Setup: open the folder — a_photo1 (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PHOTO1,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 3, { timeout: 15_000 });

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (1. Create shared look from photo1, basic-tone + wb checked):');
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
  check('shared look file readable on disk', hasSharedLook(slug), slug);
  const sharedLookDoc = hasSharedLook(slug) ? readSharedLook(slug) : null;
  check(
    "shared look file's own includes is exactly [basic-tone, wb] (refused/ignored every structural family, semantic 1)",
    JSON.stringify([...(sharedLookDoc?.includes ?? [])].sort()) === JSON.stringify(['basic-tone', 'wb']),
    sharedLookDoc?.includes
  );

  await waitFor(async () => !!linkOfGraph(await graphState()));
  const photo1LinkAfterCreate = linkOfGraph(await graphState());
  check(
    'photo1 (live graph) carries link {look, follows:[basic-tone,wb], materializedFrom}',
    photo1LinkAfterCreate?.look === slug &&
      [...photo1LinkAfterCreate.follows].sort().join(',') === 'basic-tone,wb' &&
      typeof photo1LinkAfterCreate.materializedFrom === 'string' &&
      photo1LinkAfterCreate.materializedFrom.length > 0,
    photo1LinkAfterCreate
  );
  await waitFor(() => hasLookOnDisk(PHOTO1) && !!linkOf(readLook(PHOTO1)));
  check(
    'photo1 look FILE on disk carries the same link',
    JSON.stringify(linkOf(readLook(PHOTO1))) === JSON.stringify(photo1LinkAfterCreate),
    linkOf(readLook(PHOTO1))
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (2. Link photos 2+3 — photo2 pre-edited in wb; constraint 3 skips the already-linked primary):');
  await openImageAndWait(PHOTO2);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.temp', 4200)); // wb edit BEFORE linking — differs from the look's own 5000
  await page.click('[data-testid="save-button"]');
  check('photo2 pre-edit look lands on disk', await waitFor(() => hasLookOnDisk(PHOTO2)), lookPathFor(PHOTO2));
  check('photo3 has no look at all yet (never opened)', !hasLookOnDisk(PHOTO3), null);

  await openImageAndWait(PHOTO1); // primary for the link gesture, per semantic 2's own "primary included"
  await setSelection([PHOTO2, PHOTO3]);
  const stackBeforeLink = await undoStackState();
  await openSharedLookMenu();
  await sharedLookRow('Warm Look').click();
  await page.locator('[data-testid="shared-look-link"]').click();

  check('photo2 gains a look file', await waitFor(() => hasLookOnDisk(PHOTO2)), lookPathFor(PHOTO2));
  check('photo3 (seeded fresh) gains a look file', await waitFor(() => hasLookOnDisk(PHOTO3)), lookPathFor(PHOTO3));
  await waitFor(async () => (await undoStackState()).undo.length === stackBeforeLink.undo.length + 1);

  const photo2Look = readLook(PHOTO2);
  const photo3Look = readLook(PHOTO3);
  check(
    'photo2 follows basic-tone only (wb stays individual — already edited)',
    JSON.stringify([...linkOf(photo2Look).follows].sort()) === JSON.stringify(['basic-tone']),
    linkOf(photo2Look)
  );
  check(
    'photo3 follows both basic-tone and wb (untouched before linking)',
    JSON.stringify([...linkOf(photo3Look).follows].sort()) === JSON.stringify(['basic-tone', 'wb']),
    linkOf(photo3Look)
  );
  check('photo2 basic-tone values materialized from the look (ev=0.6)', devOf(photo2Look).basic.ev === 0.6, devOf(photo2Look).basic);
  check("photo2 keeps its OWN wb edit (temp=4200), NOT the look's (5000)", devOf(photo2Look).basic.temp === 4200, devOf(photo2Look).basic.temp);
  check('photo3 basic-tone values materialized from the look (ev=0.6)', devOf(photo3Look).basic.ev === 0.6, devOf(photo3Look).basic);
  check('photo3 wb values materialized from the look too (temp=5000)', devOf(photo3Look).basic.temp === 5000, devOf(photo3Look).basic.temp);

  const stackAfterLink = await undoStackState();
  const linkEntry = stackAfterLink.undo.at(-1);
  check(
    'ONE sync batch entry, targeting photo2+photo3 only (photo1 skipped — already linked, constraint 3)',
    linkEntry?.kind === 'sync' && JSON.stringify(linkEntry.targets.slice().sort()) === JSON.stringify([PHOTO2, PHOTO3].sort()),
    linkEntry
  );

  // badge state via __debug (brief's own "badge state queryable via __debug")
  await openImageAndWait(PHOTO2);
  const photo2Badge = await developLinkState();
  check(
    'photo2 badge state: wb forked, basic-tone followed',
    photo2Badge?.follows.includes('basic-tone') &&
      !photo2Badge.follows.includes('wb') &&
      photo2Badge.forked.includes('wb') &&
      !photo2Badge.forked.includes('basic-tone'),
    photo2Badge
  );

  console.log('verify-linkedlooks (2b. batch undo reverts photo2+photo3):');
  await page.keyboard.press('Meta+z');
  await waitFor(() => !linkOf(readLook(PHOTO2)));
  check('photo2 loses its link on undo', !linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));
  check('photo2 keeps its own wb edit after undo (temp=4200)', devOf(readLook(PHOTO2)).basic.temp === 4200, devOf(readLook(PHOTO2)).basic.temp);
  check('photo3 reverts to the seeded-default look (no link) on undo', !linkOf(readLook(PHOTO3)), linkOf(readLook(PHOTO3)));

  await page.keyboard.press('Meta+Shift+z');
  await waitFor(() => !!linkOf(readLook(PHOTO2)) && !!linkOf(readLook(PHOTO3)));
  check('redo re-links photo2', !!linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));
  check('redo re-links photo3', !!linkOf(readLook(PHOTO3)), linkOf(readLook(PHOTO3)));

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (3. Edit exposure on photo1 -> forks basic-tone; revert-to-look restores it):');
  await openImageAndWait(PHOTO1);
  await selectDevNode();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.3));
  await waitFor(async () => {
    const g = await graphState();
    return !linkOfGraph(g).follows.includes('basic-tone');
  });
  const afterEdit = linkOfGraph(await graphState());
  check(
    'editing exposure forks basic-tone off follows (wb stays followed)',
    !afterEdit.follows.includes('basic-tone') && afterEdit.follows.includes('wb'),
    afterEdit
  );
  const stackBeforeRevert = await undoStackState();
  check(
    'fork was metadata-only — no NEW undo entry beyond the edit itself',
    stackBeforeRevert.undo.at(-1)?.kind === 'photo-edit',
    stackBeforeRevert.undo.at(-1)
  );

  await page.waitForSelector('[data-testid="family-revert-basic-tone"]', { timeout: 10_000 });
  const revertButton = page.locator('[data-testid="family-revert-basic-tone"]');
  await revertButton.scrollIntoViewIfNeeded();
  await revertButton.click();
  await waitFor(async () => linkOfGraph(await graphState()).follows.includes('basic-tone'));
  const afterRevert = linkOfGraph(await graphState());
  check('revert-to-look re-adds basic-tone to follows', afterRevert.follows.includes('basic-tone'), afterRevert);
  check("revert-to-look restores the look's own ev value (0.6)", devOfGraph(await graphState()).basic.ev === 0.6, devOfGraph(await graphState()).basic.ev);
  await waitFor(() => hasLookOnDisk(PHOTO1) && devOf(readLook(PHOTO1)).basic.ev === 0.6);
  check(
    'the revert is on disk too',
    devOf(readLook(PHOTO1)).basic.ev === 0.6 && !!linkOf(readLook(PHOTO1)).follows.includes('basic-tone'),
    linkOf(readLook(PHOTO1))
  );

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (4. Unlink photo3 -> link gone, values byte-identical):');
  await openImageAndWait(PHOTO3);
  await selectDevNode();
  await waitFor(async () => !!linkOfGraph(await graphState()));
  const photo3DevelopBeforeUnlink = JSON.stringify(devOfGraph(await graphState()));
  await page.waitForSelector('[data-testid="linked-look-unlink"]', { timeout: 10_000 });
  await page.locator('[data-testid="linked-look-unlink"]').click();
  await waitFor(async () => !linkOfGraph(await graphState()));
  check('photo3 (live graph) loses its link field', !linkOfGraph(await graphState()), await graphState());
  check(
    'photo3 develop VALUES are byte-identical after unlink (見た目は変わらない)',
    JSON.stringify(devOfGraph(await graphState())) === photo3DevelopBeforeUnlink,
    { before: photo3DevelopBeforeUnlink, after: JSON.stringify(devOfGraph(await graphState())) }
  );
  await waitFor(() => !linkOf(readLook(PHOTO3)));
  check('photo3 look FILE on disk loses the link field too', !linkOf(readLook(PHOTO3)), linkOf(readLook(PHOTO3)));

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (5. Delete the shared look -> photos 1+2 lose link fields, values unchanged; undo restores file + links):');
  await openImageAndWait(PHOTO1); // keep the primary open across the delete — exercises the "currently open follower" path
  await waitFor(async () => !!linkOfGraph(await graphState()));
  const photo1DevelopBeforeDelete = JSON.stringify(devOfGraph(await graphState()));
  const photo2DevelopBeforeDelete = JSON.stringify(devOf(readLook(PHOTO2)));
  check('photo1 is linked going into the delete', !!linkOfGraph(await graphState()), await graphState());
  check('photo2 is linked going into the delete', !!linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));
  const sharedLookTextBeforeDelete = readFileSync(sharedLookPathFor(slug), 'utf8');

  await openSharedLookMenu();
  await sharedLookRow('Warm Look').click();
  await page.locator('[data-testid="shared-look-delete"]').click();

  check('the shared look FILE is deleted', await waitFor(() => !hasSharedLook(slug)), null);
  await waitFor(async () => !linkOfGraph(await graphState()));
  check('photo1 (live graph, currently open) loses its link', !linkOfGraph(await graphState()), await graphState());
  check('photo1 develop values unchanged', JSON.stringify(devOfGraph(await graphState())) === photo1DevelopBeforeDelete, {
    before: photo1DevelopBeforeDelete,
    after: JSON.stringify(devOfGraph(await graphState())),
  });
  await waitFor(() => !linkOf(readLook(PHOTO2)));
  check('photo2 look file loses its link', !linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));
  check('photo2 develop values unchanged', JSON.stringify(devOf(readLook(PHOTO2))) === photo2DevelopBeforeDelete, {
    before: photo2DevelopBeforeDelete,
    after: JSON.stringify(devOf(readLook(PHOTO2))),
  });
  // Inspector degrades quietly while the look file is gone (conductor
  // review's defensive-degradation requirement): the linked-look row is
  // moot here (photo1 just lost its link), but re-select 'dev' on photo2
  // (still shows a stale `link` on its OWN develop node until we get
  // there) is covered implicitly — no page error is the actual proof (see
  // the end-of-run pageErrors check).

  await page.keyboard.press('Meta+z');
  await waitFor(async () => !!linkOfGraph(await graphState()));
  check("undo restores photo1's link field", !!linkOfGraph(await graphState()), await graphState());
  await waitFor(() => !!linkOf(readLook(PHOTO2)));
  check("undo restores photo2's link field", !!linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));
  check(
    'undo ALSO restores the shared look FILE, byte-identical (conductor fix — link fields REFERENCE the shared look, unlike a preset)',
    await waitFor(() => hasSharedLook(slug)) && readFileSync(sharedLookPathFor(slug), 'utf8') === sharedLookTextBeforeDelete,
    { exists: hasSharedLook(slug) }
  );

  await page.keyboard.press('Meta+Shift+z');
  await waitFor(() => !hasSharedLook(slug));
  check('redo removes the shared look FILE again', !hasSharedLook(slug), null);
  await waitFor(async () => !linkOfGraph(await graphState()));
  check("redo strips photo1's link field again", !linkOfGraph(await graphState()), await graphState());
  await waitFor(() => !linkOf(readLook(PHOTO2)));
  check("redo strips photo2's link field again", !linkOf(readLook(PHOTO2)), linkOf(readLook(PHOTO2)));

  // Undo once more so photo1/photo2 are linked again for check 6's own use.
  await page.keyboard.press('Meta+z');
  await waitFor(async () => !!linkOfGraph(await graphState()));
  await waitFor(() => !!linkOf(readLook(PHOTO2)));
  await waitFor(() => hasSharedLook(slug));

  // ---------------------------------------------------------------------
  console.log('verify-linkedlooks (6. Old-reader/CLI guard + load->save passthrough):');

  // 6a. CLI render ignores `link` entirely — byte-identical with/without it.
  const photo1LookWithLink = readLook(PHOTO1);
  check("photo1 look on disk still carries `link` (post-undo) for the CLI comparison", !!linkOf(photo1LookWithLink), linkOf(photo1LookWithLink));
  const withLinkPath = join(workDir, 'with-link.json');
  const withoutLinkPath = join(workDir, 'without-link.json');
  writeFileSync(withLinkPath, JSON.stringify(photo1LookWithLink, null, 2) + '\n', 'utf8');
  const strippedDoc = JSON.parse(JSON.stringify(photo1LookWithLink));
  delete strippedDoc.graph.nodes.find((n) => n.id === 'dev').link;
  writeFileSync(withoutLinkPath, JSON.stringify(strippedDoc, null, 2) + '\n', 'utf8');

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
    return { dir, path: join(dir, `${basename(PHOTO1).replace(/\.[^.]+$/, '')}.jpg`) };
  };
  const withLinkOut = outFor('withlink');
  const withoutLinkOut = outFor('withoutlink');
  const rWithLink = runCli(['--out', withLinkOut.dir, withLinkPath]);
  check('CLI render of the look WITH `link` exits 0', rWithLink.status === 0, { status: rWithLink.status, stderr: rWithLink.stderr });
  const rWithoutLink = runCli(['--out', withoutLinkOut.dir, withoutLinkPath]);
  check('CLI render of the same look WITHOUT `link` exits 0', rWithoutLink.status === 0, { status: rWithoutLink.status, stderr: rWithoutLink.stderr });
  const bytesWithLink = await sharp(withLinkOut.path).raw().toBuffer();
  const bytesWithoutLink = await sharp(withoutLinkOut.path).raw().toBuffer();
  check(
    'the CLI render is byte-identical whether `link` is present or absent (old readers ignore it)',
    bytesWithLink.equals(bytesWithoutLink),
    { sameBytes: bytesWithLink.equals(bytesWithoutLink) }
  );

  // 6b. load->save (the real Save button) keeps the link field.
  await openImageAndWait(PHOTO1);
  await waitFor(async () => !!linkOfGraph(await graphState()));
  const linkBeforeSave = linkOfGraph(await graphState());
  await page.click('[data-testid="save-button"]');
  await waitFor(() => JSON.stringify(linkOf(readLook(PHOTO1))) === JSON.stringify(linkBeforeSave));
  check(
    'a load->save round trip (the real Save button) keeps the link field verbatim',
    JSON.stringify(linkOf(readLook(PHOTO1))) === JSON.stringify(linkBeforeSave),
    linkOf(readLook(PHOTO1))
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
