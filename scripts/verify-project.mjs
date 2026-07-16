/**
 * Project storage verify (project-storage migration, stage 1 —
 * docs/brief-bank/project-storage.md): the ONE-place-documents-live model
 * end to end. Unlike every other script, this one deliberately reaches
 * around `scripts/lib/testProject.mjs`'s convenience helpers in a few
 * places (the collision check, the corrupt-manifest check) — it's testing
 * the project machinery ITSELF, not using it as a fixture backdrop.
 *
 * Checks:
 *  1. Opening a photo with no active project auto-creates the quick
 *     project at SILVERBOX_TEST_PROJECT: manifest appears on disk, the
 *     playlist gets a row, currentLookPath is under looks/.
 *  2. An edit autosaves into looks/ (never next to the photo — the
 *     etiquette rule), carrying the `photo` wrapper field.
 *  3. Reopening the same photo restores the look; currentLookPath is
 *     stable across the reopen.
 *  4. A photo with an adjacent LEGACY sidecar but no project look yet:
 *     opens with defaults (never silently reads the legacy file as live
 *     state), offers a one-click import; importing copies it into looks/
 *     (adding `photo`), reloads, and leaves the original untouched.
 *  5. A corrupt project.silverbox fails soft: a notice, no crash, and a
 *     normal photo open still works right afterward (quick recovery).
 *  6. __openProjectByPath on a second, already-prepared project directory
 *     switches the active project — playlist AND title bar.
 *  7. Look-name collision: two different photos sharing a basename (from
 *     different directories) get suffixed look names (`-2`), and each
 *     restores its OWN edit correctly.
 *  8. Autosave flush-before-switch (conductor review "data loss" finding):
 *     an edit made <1000ms before switching photos — well inside the
 *     debounce, before it would ever have fired on its own — must still
 *     reach disk, both via __openImageByPath (8a) and __openProjectByPath
 *     (8b), without leaking the flushed photo's bookkeeping onto whichever
 *     photo the switch landed on (8a); a rapid A→B→A round trip preserves
 *     both edits (8c).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, manifestPath } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const quickProjectDir = ensureTestProjectEnv();

// Check 8 needs autosave actually ON — isolate settings.json the same way
// verify-cst.mjs/verify-exportsettings.mjs do (reuse the runner's assignment
// when present; otherwise mint our own fresh temp dir for a standalone run).
// This machine's own real settings.json has autosaveSidecar OFF, which would
// silently no-op every check below without this.
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-project-userdata-'));
process.env.SILVERBOX_USER_DATA = userDataDir;

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

const cleanupPaths = [];

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path, opts) => {
    await page.evaluate(
      ({ p, o }) => {
        void window.__openImageByPath(p, o);
      },
      { p: path, o: opts }
    );
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const devEv = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev);
  const projectState = () => page.evaluate(() => window.__debug.projectState());
  const save = async () => {
    await page.keyboard.press('Meta+s');
    await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  };

  // === 1. Opening a photo with no active project auto-creates the quick project ===
  console.log('verify-project (1. opening a photo with no active project auto-creates the quick project):');
  check('no project.silverbox on disk yet', !existsSync(manifestPath()), manifestPath());
  await openAndWait(ARW_PATH);
  const proj1 = await projectState();
  check('projectState().dir is the quick-project dir (SILVERBOX_TEST_PROJECT)', proj1.dir === quickProjectDir, { proj1, quickProjectDir });
  check('project has a (non-empty) name', typeof proj1.name === 'string' && proj1.name.length > 0, proj1);
  check('playlist has exactly 1 photo', proj1.photoCount === 1, proj1);
  check('currentLookPath is under the project\'s looks/', proj1.currentLookPath === lookPathFor(ARW_PATH), {
    got: proj1.currentLookPath,
    want: lookPathFor(ARW_PATH),
  });

  // Manifest writes are debounced (~300ms — see appStore.ts's project-save subscriber).
  for (let i = 0; i < 50 && !existsSync(manifestPath()); i++) await new Promise((r) => setTimeout(r, 100));
  check('project.silverbox now exists on disk', existsSync(manifestPath()), manifestPath());
  const manifest1 = JSON.parse(readFileSync(manifestPath(), 'utf8'));
  check('manifest is schemaVersion 1', manifest1.schemaVersion === 1, manifest1);
  check(
    'manifest playlist has a row for the photo',
    manifest1.photos?.some((p) => p.look === `${basename(ARW_PATH)}.json`),
    manifest1
  );

  // === 2. Edit → autosave lands in looks/, carries `photo`, nothing next to the photo ===
  console.log('verify-project (2. autosave lands in looks/, carries `photo`, nothing appears next to the photo):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.5));
  const lookPath = lookPathFor(ARW_PATH);
  for (let i = 0; i < 100 && !existsSync(lookPath); i++) await new Promise((r) => setTimeout(r, 100));
  check('autosave wrote the look file', existsSync(lookPath), lookPath);
  const saved = JSON.parse(readFileSync(lookPath, 'utf8'));
  check('look carries a non-empty `photo` field', typeof saved.photo === 'string' && saved.photo.length > 0, saved.photo);
  check(
    'etiquette rule: nothing new appears next to the photo',
    !existsSync(ARW_PATH + '.silverbox.json'),
    ARW_PATH + '.silverbox.json'
  );

  // === 3. Reopen restores the look; currentLookPath stable ===
  console.log('verify-project (3. reopening the photo restores the look; currentLookPath is stable):');
  await openAndWait(JPG_PATH); // switch away first — a REAL reopen, not a no-op
  await openAndWait(ARW_PATH);
  check('reopen restores the edited ev from the look', (await devEv()) === 0.5, await devEv());
  const proj3 = await projectState();
  check('currentLookPath is stable across the reopen', proj3.currentLookPath === lookPath, { got: proj3.currentLookPath, want: lookPath });

  // === 4. Legacy adjacent sidecar + no project look → import offer ===
  console.log('verify-project (4. a legacy adjacent sidecar offers a one-click import instead of being read silently):');
  const legacyWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-project-legacy-'));
  cleanupPaths.push(legacyWorkDir);
  const legacyArw = join(legacyWorkDir, 'legacy.ARW');
  linkSync(ARW_PATH, legacyArw);
  const legacySidecarPath = legacyArw + '.silverbox.json';
  const nowIso = new Date().toISOString();
  const legacyDoc = {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop: { basic: { ev: 1.25 } } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  };
  writeFileSync(legacySidecarPath, JSON.stringify(legacyDoc, null, 2) + '\n', 'utf8');

  await openAndWait(legacyArw);
  check('no look exists yet for the legacy-sidecar photo', !existsSync(lookPathFor(legacyArw)), lookPathFor(legacyArw));
  await page.waitForSelector('[data-testid="legacy-sidecar-notice"]', { timeout: 5_000 });
  check('the import-offer notice is shown', (await page.locator('[data-testid="legacy-sidecar-notice"]').count()) === 1, null);
  check('opens with DEFAULTS meanwhile (never silently reads the legacy sidecar as live state)', (await devEv()) === 0, await devEv());

  await page.click('[data-testid="import-legacy-sidecar-button"]');
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 1.25, {
    timeout: 10_000,
  });
  check('after import, the graph reflects the imported look', true, null);
  const importedLookPath = lookPathFor(legacyArw);
  check('a look now exists for the photo, inside the project', existsSync(importedLookPath), importedLookPath);
  const importedLook = JSON.parse(readFileSync(importedLookPath, 'utf8'));
  check('the imported look carries the `photo` field', typeof importedLook.photo === 'string' && importedLook.photo.length > 0, importedLook.photo);
  check('the original adjacent sidecar is left untouched ("Import" copies, never moves")', existsSync(legacySidecarPath), legacySidecarPath);
  check('the import notice is gone after importing', (await page.locator('[data-testid="legacy-sidecar-notice"]').count()) === 0, null);

  // reopening the same photo again must NOT re-offer the import (it has a look now)
  await openAndWait(ARW_PATH);
  await openAndWait(legacyArw);
  check('the import offer does not reappear once a look exists', (await page.locator('[data-testid="legacy-sidecar-notice"]').count()) === 0, null);

  // === 5. A corrupt project.silverbox fails soft: notice, no crash, quick recovery ===
  console.log('verify-project (5. a corrupt project.silverbox fails soft — notice, no crash, quick recovery):');
  const corruptProjectDir = mkdtempSync(join(tmpdir(), 'silverbox-project-corrupt-'));
  cleanupPaths.push(corruptProjectDir);
  writeFileSync(join(corruptProjectDir, 'project.silverbox'), '{ not json', 'utf8');
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.evaluate((dir) => {
    void window.__openProjectByPath(dir);
  }, corruptProjectDir);
  await page.waitForSelector('[data-testid="project-notice"]', { timeout: 5_000 });
  check('a project-notice appears for the corrupt manifest', (await page.locator('[data-testid="project-notice"]').count()) === 1, null);
  check('no page errors were thrown (fails soft, no crash)', pageErrors.length === 0, pageErrors);
  await openAndWait(ARW_PATH);
  check(
    'a normal photo open still works right after the failed project open (quick recovery)',
    (await page.evaluate(() => window.__debug.imageState().status)) === 'ready',
    null
  );

  // === 6. __openProjectByPath on a second, prepared project switches playlist + title ===
  console.log('verify-project (6. __openProjectByPath switches the active project — playlist + title):');
  const secondProjectDir = mkdtempSync(join(tmpdir(), 'silverbox-project-second-'));
  cleanupPaths.push(secondProjectDir);
  mkdirSync(join(secondProjectDir, 'looks'), { recursive: true });
  const secondPhotosDir = mkdtempSync(join(tmpdir(), 'silverbox-project-second-photos-'));
  cleanupPaths.push(secondPhotosDir);
  const secondArw = join(secondPhotosDir, 'second.ARW');
  linkSync(ARW_PATH, secondArw);
  const secondManifest = {
    schemaVersion: 1,
    name: 'SecondProject',
    photos: [{ path: secondArw, look: 'second.ARW.json' }],
  };
  writeFileSync(join(secondProjectDir, 'project.silverbox'), JSON.stringify(secondManifest, null, 2) + '\n', 'utf8');

  await page.evaluate((dir) => {
    void window.__openProjectByPath(dir);
  }, secondProjectDir);
  await page.waitForFunction((p) => window.__debug?.projectState().dir === p, secondProjectDir, { timeout: 15_000 });
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const proj6 = await projectState();
  check('active project switched to the second project dir', proj6.dir === secondProjectDir, proj6);
  check('project name switched to the second project\'s', proj6.name === 'SecondProject', proj6);
  check('playlist switched to the second project\'s 1 photo', proj6.photoCount === 1, proj6);
  const title = await page.title();
  check('title bar reflects the new project name', title.includes('SecondProject'), title);
  check('the second project\'s photo is open', (await page.evaluate(() => window.__debug.imageState().status)) === 'ready', null);

  // === 7. Look-name collision: same basename from different dirs → suffixed look names ===
  console.log('verify-project (7. look-name collision — same basename, different dirs → suffixed look names):');
  const dupDirX = mkdtempSync(join(tmpdir(), 'silverbox-project-dupx-'));
  const dupDirY = mkdtempSync(join(tmpdir(), 'silverbox-project-dupy-'));
  cleanupPaths.push(dupDirX, dupDirY);
  const dupX = join(dupDirX, 'dup.ARW');
  const dupY = join(dupDirY, 'dup.ARW');
  linkSync(ARW_PATH, dupX);
  linkSync(ARW_PATH, dupY);

  await openAndWait(dupX);
  const dupXProj = await projectState();
  check(
    'the FIRST dup.ARW gets the plain look name',
    dupXProj.currentLookPath === join(dupXProj.dir, 'looks', 'dup.ARW.json'),
    dupXProj
  );
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.11));
  await save();

  await openAndWait(dupY);
  const dupYProj = await projectState();
  check(
    'the SECOND dup.ARW (different dir, same basename) gets the SUFFIXED look name',
    dupYProj.currentLookPath === join(dupYProj.dir, 'looks', 'dup.ARW-2.json'),
    dupYProj
  );
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.22));
  await save();

  await openAndWait(dupX);
  check("dirX's dup.ARW restores its OWN ev (0.11), not the other file's", (await devEv()) === 0.11, await devEv());
  await openAndWait(dupY);
  check("dirY's dup.ARW restores its OWN ev (0.22), not the other file's", (await devEv()) === 0.22, await devEv());

  // Fire-and-forget switch (never await the open call itself — see this
  // repo's verify-script conventions: a held evaluate can die mid-decode).
  const switchImage = (path) => page.evaluate((p) => void window.__openImageByPath(p), path);
  const switchProject = (dir) => page.evaluate((d) => void window.__openProjectByPath(d), dir);
  const waitReady = () => page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const evOf = (doc) => doc?.graph?.nodes?.find((n) => n.id === 'dev')?.develop?.basic?.ev;
  /**
   * Poll a look file until `evOf(doc) === expectedEv` or the timeout lapses,
   * returning whatever the LAST read was. The flush write is fire-and-forget
   * (never awaited by the app itself), and — unlike check 2's "does the file
   * exist yet" poll — these look files already exist from earlier checks, so
   * merely polling for existence would return stale pre-flush content
   * immediately instead of waiting for the write this check is about.
   */
  const pollLookForEv = async (path, expectedEv) => {
    let doc = null;
    for (let i = 0; i < 50; i++) {
      if (existsSync(path)) {
        doc = JSON.parse(readFileSync(path, 'utf8'));
        if (evOf(doc) === expectedEv) return doc;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return doc;
  };

  // === 8a. __openImageByPath flushes the OLD photo's dirty edit before the switch ===
  console.log('verify-project (8a. __openImageByPath flushes a dirty edit made <1000ms before the switch):');
  // Checks 6/7 left the active project pointed elsewhere (secondProjectDir) —
  // reset to the quick project first so `lookPathFor(ARW_PATH)` below (which
  // assumes SILVERBOX_TEST_PROJECT) actually names where this open's look
  // will land, same reset 8d does before its own round trip.
  await switchProject(quickProjectDir);
  await page.waitForFunction((p) => window.__debug?.projectState().dir === p, quickProjectDir, { timeout: 15_000 });
  await waitReady();
  await openAndWait(ARW_PATH);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.63));
  check('A (ARW) is dirty right after the edit', await page.evaluate(() => window.__debug.graphDirty()), null);
  // Switch immediately — no waiting for the 1000ms debounce.
  await switchImage(JPG_PATH);
  await waitReady();
  check('B (JPG) is now the open photo', (await page.evaluate(() => window.__debug.folderState().currentPath)) === JPG_PATH, null);
  const flushedA = await pollLookForEv(lookPathFor(ARW_PATH), 0.63);
  check("A's look file on disk carries the pre-switch edit (nothing lost)", evOf(flushedA) === 0.63, flushedA);

  // === 8b. B's own state is untouched by A's flush bookkeeping ===
  console.log('verify-project (8b. the flushed photo\'s bookkeeping does not leak onto the newly-open photo):');
  check("B is NOT dirty (A's flush post-write set() did not stomp B)", (await page.evaluate(() => window.__debug.graphDirty())) === false, null);
  check("B's graph is intact (fresh default ev, not A's 0.63)", (await devEv()) === 0, await devEv());

  // === 8c. Same flush guarantee across __openProjectByPath ===
  console.log('verify-project (8c. __openProjectByPath flushes the OLD project\'s dirty photo before switching projects):');
  const flushProjADir = mkdtempSync(join(tmpdir(), 'silverbox-project-flushA-'));
  const flushProjAPhotosDir = mkdtempSync(join(tmpdir(), 'silverbox-project-flushA-photos-'));
  cleanupPaths.push(flushProjADir, flushProjAPhotosDir);
  mkdirSync(join(flushProjADir, 'looks'), { recursive: true });
  const flushAArw = join(flushProjAPhotosDir, 'flushA.ARW');
  linkSync(ARW_PATH, flushAArw);
  writeFileSync(
    join(flushProjADir, 'project.silverbox'),
    JSON.stringify({ schemaVersion: 1, name: 'FlushA', photos: [{ path: flushAArw, look: 'flushA.ARW.json' }] }, null, 2) + '\n',
    'utf8'
  );
  const flushProjBDir = mkdtempSync(join(tmpdir(), 'silverbox-project-flushB-'));
  const flushProjBPhotosDir = mkdtempSync(join(tmpdir(), 'silverbox-project-flushB-photos-'));
  cleanupPaths.push(flushProjBDir, flushProjBPhotosDir);
  mkdirSync(join(flushProjBDir, 'looks'), { recursive: true });
  const flushBArw = join(flushProjBPhotosDir, 'flushB.ARW');
  linkSync(ARW_PATH, flushBArw);
  writeFileSync(
    join(flushProjBDir, 'project.silverbox'),
    JSON.stringify({ schemaVersion: 1, name: 'FlushB', photos: [{ path: flushBArw, look: 'flushB.ARW.json' }] }, null, 2) + '\n',
    'utf8'
  );

  await switchProject(flushProjADir);
  await page.waitForFunction((p) => window.__debug?.projectState().dir === p, flushProjADir, { timeout: 15_000 });
  await waitReady();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.77));
  check('FlushA\'s photo is dirty right after the edit', await page.evaluate(() => window.__debug.graphDirty()), null);

  // Switch projects immediately — no waiting for the debounce.
  await switchProject(flushProjBDir);
  await page.waitForFunction((p) => window.__debug?.projectState().dir === p, flushProjBDir, { timeout: 15_000 });
  await waitReady();
  const flushedProjA = await pollLookForEv(join(flushProjADir, 'looks', 'flushA.ARW.json'), 0.77);
  check("the OLD project's photo look carries the pre-switch edit", evOf(flushedProjA) === 0.77, flushedProjA);
  check('the NEW project (FlushB) photo is NOT dirty (no bookkeeping leak)', (await page.evaluate(() => window.__debug.graphDirty())) === false, null);

  // === 8d. Rapid A→B→A round trip preserves BOTH edits ===
  console.log('verify-project (8d. rapid A-edit -> open-B -> B-edit -> open-A round trip preserves both edits):');
  await switchProject(quickProjectDir);
  await page.waitForFunction((p) => window.__debug?.projectState().dir === p, quickProjectDir, { timeout: 15_000 });
  await waitReady();
  await openAndWait(ARW_PATH);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.11));
  await switchImage(JPG_PATH);
  await waitReady();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.22));
  await switchImage(ARW_PATH);
  await waitReady();

  const roundTripA = await pollLookForEv(lookPathFor(ARW_PATH), 1.11);
  const roundTripB = await pollLookForEv(lookPathFor(JPG_PATH), 1.22);
  check("A's round-trip edit (1.11) landed on disk", evOf(roundTripA) === 1.11, roundTripA);
  check("B's round-trip edit (1.22) landed on disk", evOf(roundTripB) === 1.22, roundTripB);
  // The reopened A itself must reflect its OWN edit, not B's — either read
  // straight off the freshly-flushed look (the common case, given a small
  // JSON write finishes long before a RAW decode does) or via the clean-
  // session hot-reload picking up the flush's write after the fact.
  await page
    .waitForFunction(() => window.__debug.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 1.11, { timeout: 10_000 })
    .catch(() => {});
  check("reopening A after the round trip shows A's OWN edit (1.11), not B's or stale", (await devEv()) === 1.11, await devEv());
} finally {
  await app.close();
}

if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
