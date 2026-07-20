/**
 * Fork-survives-publish regression verify (docs/brief-bank/
 * linked-looks-forkbug.md — USER-REPORTED hand-test bug). Builds the EXACT
 * scenario the user reproduced by hand, through the REAL edit/switch/publish
 * gestures (updateNodeParam + flush-on-switch + the publish dialog), NOT a
 * direct store poke that would bypass the persistence step under suspicion:
 *
 *   1. A shared look ("Fork Look", basic-tone) exists; link photo1 AND photo2
 *      to it (both untouched at link time → both follow basic-tone).
 *   2. Open photo1, adjust CONTRAST → this must FORK basic-tone on photo1
 *      (basic-tone leaves photo1.follows; photo1 keeps its own contrast).
 *   3. Switch to photo2 (the switch must persist photo1's fork to disk).
 *   4. Adjust photo2's contrast → forks basic-tone on photo2.
 *   5. Publish basic-tone from photo2.
 *
 * EXPECTED (spec §4.2/§4.4): photo1's contrast is UNCHANGED — a forked family
 * is not in follows, so publish's fan-out (follows ∩ published) skips it.
 * The bug was: photo1's contrast became the LOOK's value — the fork was lost.
 *
 * The scenario is run under BOTH autosave settings:
 *  - autosave OFF — the config THIS machine's real settings.json ships (see
 *    verify-project.mjs's note) and the one the user hand-tested under. An
 *    ordinary value edit is intentionally discarded on switch here, but a
 *    FORK (link metadata) is deliberate structural intent that publish reads
 *    off disk — it MUST survive the switch regardless of the autosave
 *    setting. This is the fails-before / passes-after leg of the fix.
 *  - autosave ON — the ordinary flush-on-switch path.
 *
 * Setup + harness scaffolding mirror verify-linkedlooks3.mjs (folder open,
 * real SharedLookMenu gestures, window.__debug for state assertions).
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, readLook, readSharedLook, hasSharedLook, seedLibraryDir } from './lib/testProject.mjs';

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
    console.log(`  FAIL  ${name}  (actual: ${typeof actual === 'function' ? safeCall(actual) : JSON.stringify(actual)})`);
  }
};
const safeCall = (fn) => {
  try {
    return JSON.stringify(fn());
  } catch (err) {
    return `<threw: ${String(err)}>`;
  }
};

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-forkbug-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order (folder open's own sort): a_ opens first.
const PHOTOS = {
  off: [fixture('a_off1.ARW'), fixture('b_off2.ARW')],
  on: [fixture('c_on1.ARW'), fixture('d_on2.ARW')],
};

const devOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.id === 'dev').develop;
const linkOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.id === 'dev').link;
const devOfShared = (sharedDoc) => sharedDoc.look.graph.nodes.find((n) => n.id === 'dev').develop;

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
const userDataDir = process.env.SILVERBOX_USER_DATA ?? seedLibraryDir(mkdtempSync(join(tmpdir(), 'silverbox-forkbug-userdata-')));

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
  const openImageFireAndForget = (path, opts) => page.evaluate(({ p, o }) => void window.__openImageByPath(p, o), { p: path, o: opts });
  const openFolderFireAndForget = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const sharedLooksState = () => page.evaluate(() => window.__debug.sharedLooksState());
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const developLinkState = (nodeId) => page.evaluate((id) => window.__debug.developLinkState(id), nodeId ?? undefined);
  const setAutosave = (on) => page.evaluate((v) => window.__debug.updateSettings({ autosaveSidecar: v }), on);

  const devOfGraph = (graph) => graph.nodes.find((n) => n.id === 'dev').develop;

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

  // === Setup: open the folder — a_off1 (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PHOTOS.off[0],
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, { timeout: 15_000 });

  /**
   * Run the full fork+switch+publish scenario for one autosave setting.
   * `photoA` is the creator/forked follower; `photoB` is the publisher.
   */
  async function runScenario({ autosave, tag, lookName, photoA, photoB }) {
    console.log(`\n=== ${tag} (autosave ${autosave ? 'ON' : 'OFF'}) ===`);
    await setAutosave(true); // ON for setup so the look-create + link land cleanly on disk

    await openImageAndWait(photoA);
    console.log(`${tag} (setup: create "${lookName}" [basic-tone] from photoA, link photoB):`);
    // Distinctive look value so photoA's forked value (55) is provably
    // different from both the look's ORIGINAL (20) and photoB's published (77).
    await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 20));

    await openSharedLookMenu();
    await page.locator('[data-testid="shared-look-create-name"]').fill(lookName);
    await page.locator('[data-testid="shared-look-create"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
    await setFamilyCheckboxes(['basic-tone']);
    await page.locator('[data-testid="family-scope-confirm"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });

    check(`${tag}: shared look file appears`, await waitFor(async () => (await sharedLooksState()).some((p) => p.name === lookName)), await sharedLooksState());
    const slug = (await sharedLooksState()).find((p) => p.name === lookName)?.slug;
    check(`${tag}: slug resolved`, !!slug, slug);
    check(`${tag}: photoA (creator) follows basic-tone`, await waitFor(async () => (await developLinkState('dev'))?.follows.includes('basic-tone')), await developLinkState('dev'));

    await setSelection([photoB]);
    await openSharedLookMenu();
    await sharedLookRow(lookName).click();
    await page.locator('[data-testid="shared-look-link"]').click();
    check(
      `${tag}: photoB follows basic-tone (untouched before linking)`,
      await waitFor(() => JSON.stringify([...linkOf(readLook(photoB)).follows].sort()) === JSON.stringify(['basic-tone'])),
      () => linkOf(readLook(photoB))
    );
    check(`${tag}: photoB materialized the look contrast (=20)`, await waitFor(() => devOf(readLook(photoB)).basic.contrast === 20), () => devOf(readLook(photoB)).basic);
    await closeSharedLookMenuIfOpen();
    await waitFor(async () => (await graphDirty()) === false);

    // --- fork basic-tone on photoA via the REAL contrast edit, then switch away ---
    console.log(`${tag} (fork basic-tone on photoA via the real contrast edit [autosave ${autosave ? 'ON' : 'OFF'}], then switch away):`);
    await setAutosave(autosave); // the setting the user was actually in when they forked
    // The same call the Inspector's contrast slider makes (InspectorPanel.tsx
    // updateNodeParam('dev','basic.contrast', …)).
    await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 55));
    check(`${tag}: photoA forked basic-tone IN MEMORY (leaves follows)`, !(await developLinkState('dev'))?.follows.includes('basic-tone'), await developLinkState('dev'));

    // Switch to photoB — the persistence step under suspicion. A FORK must
    // survive this switch even with autosave off; a mere value tweak need not.
    await openImageAndWait(photoB);

    check(
      `${tag}: photoA's fork PERSISTED to disk (basic-tone left follows)`,
      await waitFor(() => !linkOf(readLook(photoA)).follows.includes('basic-tone')),
      () => linkOf(readLook(photoA))
    );
    check(
      `${tag}: photoA's forked contrast (=55) persisted to disk`,
      await waitFor(() => devOf(readLook(photoA)).basic.contrast === 55),
      () => devOf(readLook(photoA)).basic
    );

    // --- fork + publish basic-tone from photoB → photoA must be UNTOUCHED ---
    console.log(`${tag} (fork + publish basic-tone from photoB → photoA must be UNCHANGED):`);
    await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 77));
    check(`${tag}: photoB forked basic-tone IN MEMORY too`, !(await developLinkState('dev'))?.follows.includes('basic-tone'), await developLinkState('dev'));

    await openPublishDialog();
    await setFamilyCheckboxes(['basic-tone']);
    await confirmPublish();

    check(`${tag}: shared look basic-tone published from photoB (=77)`, await waitFor(() => hasSharedLook(slug) && devOfShared(readSharedLook(slug)).basic.contrast === 77), () => devOfShared(readSharedLook(slug)).basic);

    // THE BUG CHECK — photoA's forked contrast must survive the publish.
    // Give the fan-out ample time to (wrongly) rewrite photoA before asserting.
    await new Promise((r) => setTimeout(r, 1_500));
    check(
      `${tag}: photoA's forked contrast is UNCHANGED by the publish (=55, NOT the look's 77)`,
      devOf(readLook(photoA)).basic.contrast === 55,
      () => devOf(readLook(photoA)).basic
    );
    check(`${tag}: photoA still does NOT follow basic-tone after the publish`, !linkOf(readLook(photoA)).follows.includes('basic-tone'), () => linkOf(readLook(photoA)));

    // Sanity: photoB (the publisher) re-follows basic-tone with its own value.
    await waitFor(async () => devOfGraph(await graphState()).basic.contrast === 77);
    check(`${tag}: photoB (publisher) carries its published contrast (=77)`, devOfGraph(await graphState()).basic.contrast === 77, devOfGraph(await graphState()).basic);
  }

  // The user's real config first — autosave OFF (the fails-before leg).
  await runScenario({ autosave: false, tag: 'OFF', lookName: 'Fork Look Off', photoA: PHOTOS.off[0], photoB: PHOTOS.off[1] });
  // …and the ordinary flush-on-switch path — autosave ON.
  await runScenario({ autosave: true, tag: 'ON', lookName: 'Fork Look On', photoA: PHOTOS.on[0], photoB: PHOTOS.on[1] });

  console.log('');
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
