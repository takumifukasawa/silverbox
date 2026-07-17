/**
 * Project storage verify, stage 3 (docs/brief-bank/project-storage.md):
 * relink + fingerprint + import-sidecars + save-as-move. Sibling of
 * scripts/verify-project.mjs (stage 1) — that script covers the quick
 * project / playlist / legacy-sidecar-offer basics; this one covers
 * everything stage 3 added on top of them. Native dialogs aren't drivable
 * from Playwright, so every check here drives the underlying STORE ACTION
 * directly via `window.__debug` (relinkPhoto/scanFolderForRelink/
 * importSidecarsFromFolder/saveQuickProjectAs) — the dialog wrappers
 * (Filmstrip's "Relink…"/"Scan folder…" buttons, the toolbar's "Import
 * sidecars from folder…"/"Save as project…" menu items) are thin enough
 * that exercising the store action IS exercising the feature; see this
 * task's report for what still needs the conductor's own hand-test.
 *
 * Checks:
 *  1. Fingerprint on save: saving a look writes a `fingerprint` field whose
 *     value matches a HAND-COMPUTED reference implementation of the same
 *     recipe (independent of src/main/index.ts's own computeFingerprint —
 *     this is a genuine cross-check, not a call into the same code).
 *  2. Relink: a playlist row's look already has a fingerprint — relinking to
 *     a byte-identical candidate succeeds directly; relinking to a
 *     DIFFERENT-content candidate is refused ('mismatch', a toolbar notice
 *     appears, the row is left untouched) unless `force`, which overrides it
 *     and refreshes the look's own fingerprint to the new file's. An
 *     unreadable candidate and an out-of-range index both report 'error'.
 *  3. Scan folder for candidates: one round trip finds a fingerprint-
 *     verified match in a folder (basename-matching files tried first, then
 *     the rest — a same-basename WRONG-content decoy must NOT win over a
 *     different-basename correct-content file), relinks on a hit, and
 *     reports "no match" (a project notice, not a crash) when nothing
 *     matches. A pre-stage-3 look with no stored fingerprint at all falls
 *     back to an unverified exact-basename match.
 *  4. Import sidecars from folder: copies every adjacent legacy sidecar not
 *     already on the playlist into the project's looks/ (adding `photo` +
 *     `fingerprint`), leaves originals untouched, and reports accurate
 *     imported/already-in-project/unreadable counts — without touching a
 *     look that's already on the playlist under its own separate edit.
 *  5. Save as project… (MOVE): every look (+ its golden/ PNG) physically
 *     moves from the quick project into a brand-new destination project;
 *     the quick project's own manifest is rewritten to zero rows; the new
 *     project becomes active (title bar included); and reopening the new
 *     project from disk (simulating a relaunch) restores a photo's edited
 *     look.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, manifestPath } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// Resolved to ABSOLUTE unconditionally (unlike some sibling scripts' bare
// fallback string) — this script's save-as-project check re-relativizes a
// playlist row's path against a SECOND project dir (resolveProjectPath's own
// "relative resolves against projectDir" contract), which only round-trips
// correctly when the row's stored path started out absolute. A relative
// SILVERBOX_TEST_ARW fallback reused verbatim (fine for the OTHER scripts'
// "same open, same path, every time" pattern — see findPlaylistPhoto's own
// doc comment) would otherwise resolve against the WRONG project dir once
// the row has moved.
const ARW_PATH = resolve(process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW');
const JPG_PATH = resolve(process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG');
const quickProjectDir = ensureTestProjectEnv();

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

/**
 * Hand-computed reference implementation of the fingerprint recipe —
 * DELIBERATELY independent of src/main/index.ts's own computeFingerprint
 * (that function's doc comment IS the stability contract this cross-checks
 * against): sha256(8-byte-LE size + first min(64KB,size) bytes + last
 * min(64KB,size) bytes), lowercase hex.
 */
function computeFingerprintRef(path) {
  const size = statSync(path).size;
  const headLen = Math.min(65536, size);
  const tailLen = Math.min(65536, size);
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(headLen);
    if (headLen > 0) readSync(fd, head, 0, headLen, 0);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) readSync(fd, tail, 0, tailLen, size - tailLen);
    const sizePrefix = Buffer.alloc(8);
    sizePrefix.writeBigUInt64LE(BigInt(size));
    const hash = createHash('sha256');
    hash.update(sizePrefix);
    hash.update(head);
    hash.update(tail);
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

async function waitFor(conditionFn, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await conditionFn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath(), 'utf8'));
}

const app = await electron.launch({ args: [projectRoot] });
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
  const setEv = (v) => page.evaluate((val) => window.__debug.updateNodeParam('dev', 'basic.ev', val), v);
  const relinkPhoto = (idx, path, force) =>
    page.evaluate(({ i, p, f }) => window.__debug.relinkPhoto(i, p, f), { i: idx, p: path, f: force });
  const relinkMismatchState = () => page.evaluate(() => window.__debug.relinkMismatchState());
  const scanFolderForRelink = (idx, dir) =>
    page.evaluate(({ i, d }) => window.__debug.scanFolderForRelink(i, d), { i: idx, d: dir });
  const importSidecarsFromFolder = (dir) => page.evaluate((d) => window.__debug.importSidecarsFromFolder(d), dir);
  const saveQuickProjectAs = (dir) => page.evaluate((d) => window.__debug.saveQuickProjectAs(d), dir);

  // === 1. Fingerprint on save matches a hand-computed reference ===
  console.log('verify-project2 (1. fingerprint on save matches a hand-computed reference implementation):');
  await openAndWait(ARW_PATH);
  await setEv(0.5);
  await save();
  const lookPathArw = lookPathFor(ARW_PATH);
  const savedArwLook = JSON.parse(readFileSync(lookPathArw, 'utf8'));
  const refFingerprintArw = computeFingerprintRef(ARW_PATH);
  check(
    'saved look carries a 64-char lowercase-hex fingerprint',
    typeof savedArwLook.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(savedArwLook.fingerprint),
    savedArwLook.fingerprint
  );
  check('fingerprint matches the hand-computed reference', savedArwLook.fingerprint === refFingerprintArw, {
    got: savedArwLook.fingerprint,
    want: refFingerprintArw,
  });

  // === 2. Relink: match / mismatch / force / error ===
  console.log('verify-project2 (2. relink — match, mismatch, force override, error paths):');
  const relinkWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-relink-'));
  cleanupPaths.push(relinkWorkDir);
  const missingPath = join(relinkWorkDir, 'missing.ARW');
  writeFileSync(missingPath, readFileSync(ARW_PATH));
  const idxMissing = (await projectState()).photoCount;
  await openAndWait(missingPath);
  await setEv(0.61);
  await save();
  const lookPathMissing = lookPathFor(missingPath);
  const savedMissingLook = JSON.parse(readFileSync(lookPathMissing, 'utf8'));
  check('the row-to-be-relinked look also got a fingerprint', typeof savedMissingLook.fingerprint === 'string', savedMissingLook.fingerprint);
  // The manifest write is a separate 300ms debounce from the look's own
  // autosave (appStore.ts's project-save subscriber) — wait for the row to
  // actually land on disk before treating it as the "before" baseline below.
  await waitFor(() => readManifest().photos[idxMissing]?.path?.endsWith('missing.ARW'));

  // A byte-identical copy (same fingerprint) and a byte-DIFFERENT one (JPG bytes).
  const matchPath = join(relinkWorkDir, 'match.ARW');
  writeFileSync(matchPath, readFileSync(ARW_PATH));
  const mismatchPath = join(relinkWorkDir, 'mismatch.ARW');
  writeFileSync(mismatchPath, readFileSync(JPG_PATH));

  const mismatchResult = await relinkPhoto(idxMissing, mismatchPath);
  check('relinking to different-content candidate reports mismatch', mismatchResult === 'mismatch', mismatchResult);
  const mismatchNotice = await relinkMismatchState();
  check(
    'relinkMismatchState names the right row + candidate',
    mismatchNotice?.playlistIndex === idxMissing && mismatchNotice?.newPath === mismatchPath,
    mismatchNotice
  );
  await waitFor(() => existsSync(manifestPath()));
  const manifestAfterMismatch = readManifest();
  check(
    'a mismatch leaves the playlist row untouched (still the old path)',
    manifestAfterMismatch.photos[idxMissing]?.path?.endsWith('missing.ARW'),
    manifestAfterMismatch.photos[idxMissing]
  );

  const matchResult = await relinkPhoto(idxMissing, matchPath);
  check('relinking to a byte-identical candidate succeeds without force', matchResult === 'relinked', matchResult);
  check('relinkMismatchState clears after a successful relink', (await relinkMismatchState()) === null, await relinkMismatchState());
  await waitFor(() => readManifest().photos[idxMissing]?.path?.endsWith('match.ARW'));
  const lookAfterMatch = JSON.parse(readFileSync(lookPathMissing, 'utf8'));
  check("the look's `photo` field now points at the new file", lookAfterMatch.photo?.endsWith('match.ARW'), lookAfterMatch.photo);
  check(
    "the look's fingerprint is unchanged (same bytes)",
    lookAfterMatch.fingerprint === savedMissingLook.fingerprint,
    lookAfterMatch.fingerprint
  );

  const forcedResult = await relinkPhoto(idxMissing, mismatchPath, true);
  check('force overrides a fingerprint mismatch', forcedResult === 'relinked', forcedResult);
  await waitFor(() => readManifest().photos[idxMissing]?.path?.endsWith('mismatch.ARW'));
  const lookAfterForce = JSON.parse(readFileSync(lookPathMissing, 'utf8'));
  const refFingerprintMismatch = computeFingerprintRef(mismatchPath);
  check(
    "a forced relink updates the look's fingerprint to the NEW file's",
    lookAfterForce.fingerprint === refFingerprintMismatch,
    { got: lookAfterForce.fingerprint, want: refFingerprintMismatch }
  );

  const errorResultMissingFile = await relinkPhoto(idxMissing, join(relinkWorkDir, 'does-not-exist.ARW'));
  check('relinking to an unreadable candidate reports error', errorResultMissingFile === 'error', errorResultMissingFile);
  const errorResultBadIndex = await relinkPhoto(99999, matchPath);
  check('relinking an out-of-range playlist index reports error', errorResultBadIndex === 'error', errorResultBadIndex);

  // === 3. Scan folder for candidates ===
  console.log('verify-project2 (3. scan folder for candidates — basename-first, fingerprint-verified, no-match, no-fingerprint fallback):');
  const scanOrigDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-scanorig-'));
  cleanupPaths.push(scanOrigDir);
  const scanOrigPath = join(scanOrigDir, 'scanme.ARW');
  writeFileSync(scanOrigPath, readFileSync(ARW_PATH));
  const idxScan = (await projectState()).photoCount;
  await openAndWait(scanOrigPath);
  await setEv(0.72);
  await save();

  const scanFolder = mkdtempSync(join(tmpdir(), 'silverbox-project2-scanfolder-'));
  cleanupPaths.push(scanFolder);
  // Same basename as the row's own photo, but WRONG content (must not win).
  writeFileSync(join(scanFolder, 'scanme.ARW'), readFileSync(JPG_PATH));
  // A decoy with an unrelated basename and content.
  writeFileSync(join(scanFolder, 'decoy.ARW'), Buffer.from('decoy'));
  // The REAL match: right content, different basename.
  writeFileSync(join(scanFolder, 'other.ARW'), readFileSync(ARW_PATH));

  const scanResult = await scanFolderForRelink(idxScan, scanFolder);
  check('scan folder finds the fingerprint-verified match', scanResult === 'relinked', scanResult);
  await waitFor(() => readManifest().photos[idxScan]?.path?.endsWith('other.ARW'));
  const manifestAfterScan = readManifest();
  check(
    'the CONTENT match wins, not the same-basename wrong-content decoy',
    manifestAfterScan.photos[idxScan]?.path?.endsWith('other.ARW') && !manifestAfterScan.photos[idxScan]?.path?.endsWith('scanme.ARW'),
    manifestAfterScan.photos[idxScan]
  );

  const emptyScanFolder = mkdtempSync(join(tmpdir(), 'silverbox-project2-scanempty-'));
  cleanupPaths.push(emptyScanFolder);
  const noMatchResult = await scanFolderForRelink(idxScan, emptyScanFolder);
  check('scan folder with nothing to find reports no-match', noMatchResult === 'no-match', noMatchResult);
  const notice = await page.locator('[data-testid="project-notice"]').textContent();
  check('a "no matching photo found" project notice is shown', (notice ?? '').includes('no matching photo found'), notice);

  // 3b. A pre-stage-3 look with NO stored fingerprint falls back to an
  // unverified exact-basename match.
  const legacyScanDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-legacyscan-'));
  cleanupPaths.push(legacyScanDir);
  const legacyScanPath = join(legacyScanDir, 'legacyscan.ARW');
  writeFileSync(legacyScanPath, readFileSync(ARW_PATH));
  const idxLegacyScan = (await projectState()).photoCount;
  await openAndWait(legacyScanPath);
  await setEv(0.15);
  await save();
  const legacyLookPath = lookPathFor(legacyScanPath);
  const legacyLook = JSON.parse(readFileSync(legacyLookPath, 'utf8'));
  delete legacyLook.fingerprint;
  writeFileSync(legacyLookPath, JSON.stringify(legacyLook, null, 2) + '\n', 'utf8');

  const legacyScanFolder = mkdtempSync(join(tmpdir(), 'silverbox-project2-legacyscanfolder-'));
  cleanupPaths.push(legacyScanFolder);
  // Same basename, but ARBITRARY (wrong) content — unverifiable without a
  // stored fingerprint, so the basename match should still be accepted.
  writeFileSync(join(legacyScanFolder, 'legacyscan.ARW'), readFileSync(JPG_PATH));
  writeFileSync(join(legacyScanFolder, 'unrelated.ARW'), Buffer.from('unrelated'));

  const legacyScanResult = await scanFolderForRelink(idxLegacyScan, legacyScanFolder);
  check('a look with no stored fingerprint falls back to an unverified basename match', legacyScanResult === 'relinked', legacyScanResult);
  await waitFor(() => readManifest().photos[idxLegacyScan]?.path?.endsWith('legacyscan.ARW'));

  // === 4. Import sidecars from folder ===
  console.log('verify-project2 (4. import sidecars from folder — counts, originals untouched, collision handling):');
  const importDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-import-'));
  cleanupPaths.push(importDir);

  // photoA: ALREADY on the playlist (opened directly, with its own edit) —
  // must be reported as "skipped: already in project" and its OWN look must
  // survive untouched, not get overwritten by the adjacent sidecar's content.
  const photoAPath = join(importDir, 'photoA.ARW');
  writeFileSync(photoAPath, readFileSync(ARW_PATH));
  const photoASidecarPath = `${photoAPath}.silverbox.json`;
  const nowIso = new Date().toISOString();
  const makeLegacyDoc = (ev) => ({
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop: { basic: { ev } } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  });
  writeFileSync(photoASidecarPath, JSON.stringify(makeLegacyDoc(0.99), null, 2) + '\n', 'utf8');
  await openAndWait(photoAPath); // adds photoA to the playlist WITHOUT importing its adjacent sidecar
  await setEv(0.42);
  await save();
  const photoALookPath = lookPathFor(photoAPath);
  const photoALookBefore = JSON.parse(readFileSync(photoALookPath, 'utf8'));

  // photoB: a fresh, valid legacy sidecar — should import cleanly.
  const photoBPath = join(importDir, 'photoB.ARW');
  writeFileSync(photoBPath, readFileSync(ARW_PATH));
  const photoBSidecarPath = `${photoBPath}.silverbox.json`;
  writeFileSync(photoBSidecarPath, JSON.stringify(makeLegacyDoc(0.33), null, 2) + '\n', 'utf8');

  // photoD: a malformed adjacent sidecar — should count as unreadable.
  const photoDPath = join(importDir, 'photoD.ARW');
  writeFileSync(photoDPath, readFileSync(ARW_PATH));
  const photoDSidecarPath = `${photoDPath}.silverbox.json`;
  writeFileSync(photoDSidecarPath, '{ not json', 'utf8');

  const importResult = await importSidecarsFromFolder(importDir);
  check(
    'import reports 1 imported, 1 skipped-existing, 1 unreadable',
    importResult.imported === 1 && importResult.skippedExisting === 1 && importResult.skippedUnreadable === 1,
    importResult
  );

  const photoBLookPath = lookPathFor(photoBPath);
  await waitFor(() => existsSync(photoBLookPath));
  const photoBLook = JSON.parse(readFileSync(photoBLookPath, 'utf8'));
  check("photoB's imported look carries the sidecar's develop ev", photoBLook.graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.33, photoBLook);
  check('photoB\'s imported look carries a `photo` field', typeof photoBLook.photo === 'string' && photoBLook.photo.endsWith('photoB.ARW'), photoBLook.photo);
  const refFingerprintPhotoB = computeFingerprintRef(photoBPath);
  check("photoB's imported look carries a matching fingerprint", photoBLook.fingerprint === refFingerprintPhotoB, {
    got: photoBLook.fingerprint,
    want: refFingerprintPhotoB,
  });

  const photoALookAfter = JSON.parse(readFileSync(photoALookPath, 'utf8'));
  check(
    "photoA's own (already-on-playlist) look is untouched by the import",
    photoALookAfter.graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.42,
    photoALookAfter
  );

  check('photoA\'s original adjacent sidecar is left untouched', existsSync(photoASidecarPath), photoASidecarPath);
  check('photoB\'s original adjacent sidecar is left untouched (copy, not move)', existsSync(photoBSidecarPath), photoBSidecarPath);
  check('photoD\'s malformed adjacent sidecar is left untouched', existsSync(photoDSidecarPath), photoDSidecarPath);

  // === 5. Save as project… (MOVE, with per-file tolerance) ===
  console.log('verify-project2 (5. save as project… — move, per-file tolerance for a missing/corrupted look, quick project left consistent, reopen restores the look, title updates):');
  // Fake golden PNG for the ARW_PATH row, to prove golden/ files move too.
  const goldenDir = join(quickProjectDir, 'golden');
  mkdirSync(goldenDir, { recursive: true });
  const arwGoldenName = `${basename(ARW_PATH)}.png`;
  writeFileSync(join(goldenDir, arwGoldenName), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const destDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-dest-'));
  cleanupPaths.push(destDir);
  const destName = basename(destDir);

  // NG fix pack (CRITICAL — "Save as project… fails and fails SILENTLY"):
  // main's moveProjectFiles used to abort the WHOLE batch on the first
  // ENOENT — which a real user hit because a playlist row can belong to a
  // photo that was only ever OPENED, never edited (autosave writes a look
  // only on a dirty session). Add exactly that row here: open a fresh photo
  // and never touch it — it lands on the playlist with a derived look name,
  // but no file exists yet at quickDir/looks/<name>.json.
  const neverEditedDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-neveredited-'));
  cleanupPaths.push(neverEditedDir);
  const neverEditedPath = join(neverEditedDir, 'never-edited.ARW');
  writeFileSync(neverEditedPath, readFileSync(ARW_PATH));
  const neverEditedLook = `${basename(neverEditedPath)}.json`;
  await openAndWait(neverEditedPath); // adds the playlist row WITHOUT ever writing a look file

  // A second new row whose look file DOES exist but cannot be moved (a
  // corrupted/unreadable look, per the brief's "chmod 000 or a directory in
  // its place" — a directory pre-seeded at the DESTINATION path is the
  // reliable cross-platform way to force rename() to fail with EISDIR,
  // since permissions on the source file alone don't block a same-
  // filesystem rename()).
  const corruptedDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-corrupted-'));
  cleanupPaths.push(corruptedDir);
  const corruptedPath = join(corruptedDir, 'corrupted.ARW');
  writeFileSync(corruptedPath, readFileSync(ARW_PATH));
  const corruptedLook = `${basename(corruptedPath)}.json`;
  await openAndWait(corruptedPath);
  await setEv(0.81);
  await save(); // a real look file now exists at quickDir/looks/corrupted.ARW.json
  mkdirSync(join(destDir, 'looks', corruptedLook), { recursive: true }); // pre-seed the trap

  // The import in check 4 (and the two rows just added) mutate
  // `project.photos` too — same 300ms debounce as every other playlist edit
  // — wait for the on-disk manifest to catch up with the in-memory playlist
  // before using it as the "before" baseline.
  const expectedCountBeforeMove = (await projectState()).photoCount;
  await waitFor(() => readManifest().photos.length === expectedCountBeforeMove);
  const beforeMove = readManifest();
  const photoCountBefore = beforeMove.photos.length;
  // Excluded from the BULK "every look moved/landed" assertions below —
  // these two rows are deliberately special-cased (no look to move; a look
  // that fails to move) and get their own dedicated checks instead.
  const specialLooks = new Set([neverEditedLook, corruptedLook]);
  const ordinaryPhotos = beforeMove.photos.filter((p) => !specialLooks.has(p.look));

  const saveAsResult = await saveQuickProjectAs(destDir);
  check('saveQuickProjectAs succeeds even with a missing-look row and a failed-move row', saveAsResult.ok === true, saveAsResult);

  check('every ORDINARY look moved out of the quick project (no longer in quickDir/looks/)', ordinaryPhotos.every((p) => !existsSync(join(quickProjectDir, 'looks', p.look))), null);
  check('every ORDINARY look landed in the destination project', ordinaryPhotos.every((p) => existsSync(join(destDir, 'looks', p.look))), null);
  check('the golden PNG moved alongside its look', existsSync(join(destDir, 'golden', arwGoldenName)) && !existsSync(join(goldenDir, arwGoldenName)), null);

  check('the never-edited row has no look file in EITHER project (there never was one)', !existsSync(join(quickProjectDir, 'looks', neverEditedLook)) && !existsSync(join(destDir, 'looks', neverEditedLook)), null);
  // Note: destDir/looks/<corruptedLook> ALREADY EXISTS at this point — it's
  // the pre-seeded trap DIRECTORY this check planted on purpose (a real
  // file can't rename() over an existing directory, EISDIR — see this
  // check's setup above). So "the move never happened" is proven by the
  // quick-project copy still being a plain FILE (untouched) and the
  // destination path STILL being that same directory (never overwritten by
  // the look's actual content) — not by the destination path being absent.
  const quickCorruptedStat = statSync(join(quickProjectDir, 'looks', corruptedLook));
  const destCorruptedStat = statSync(join(destDir, 'looks', corruptedLook));
  check(
    'the corrupted-look row stays behind in the quick project as a real file, and its dest-side trap directory is untouched',
    quickCorruptedStat.isFile() && destCorruptedStat.isDirectory(),
    { quickIsFile: quickCorruptedStat.isFile(), destIsDirectory: destCorruptedStat.isDirectory() }
  );

  const quickManifestAfter = readManifest();
  check(
    "the quick project's manifest is emptied down to exactly the FAILED row (not zero, not aborted-partial)",
    Array.isArray(quickManifestAfter.photos) && quickManifestAfter.photos.length === 1 && quickManifestAfter.photos[0]?.look === corruptedLook,
    quickManifestAfter
  );

  await waitFor(() => existsSync(join(destDir, 'project.silverbox')));
  const destManifest = JSON.parse(readFileSync(join(destDir, 'project.silverbox'), 'utf8'));
  check(
    "the new project's manifest carries every MIGRATED row (every row except the one that failed to move)",
    Array.isArray(destManifest.photos) && destManifest.photos.length === photoCountBefore - 1,
    destManifest
  );
  check('the never-edited row DID migrate to the new project (missingLook is not a failure)', destManifest.photos.some((p) => p.look === neverEditedLook), destManifest.photos);
  check('the corrupted-look row did NOT migrate to the new project', !destManifest.photos.some((p) => p.look === corruptedLook), destManifest.photos);
  check("the new project's name is the destination folder's own basename", destManifest.name === destName, destManifest.name);

  const noticeAfterSaveAs = await page.locator('[data-testid="project-notice"]').textContent();
  check(
    'the completion notice reports missing-look and failed counts (NG1: this used to fail silently)',
    (noticeAfterSaveAs ?? '').includes('1 no look yet') && (noticeAfterSaveAs ?? '').includes('1 failed'),
    noticeAfterSaveAs
  );
  const noticeKindAfterSaveAs = await page.locator('.toolbar-hotreload-notice[data-project-notice-kind]').getAttribute('data-project-notice-kind');
  check('a completion notice with a failure is kind "error" (persistent, not auto-dismissed)', noticeKindAfterSaveAs === 'error', noticeKindAfterSaveAs);

  const projAfterMove = await projectState();
  check('the active project switched to the destination dir', projAfterMove.dir === destDir, projAfterMove);
  check('the active project name matches the destination basename', projAfterMove.name === destName, projAfterMove);
  const titleAfterMove = await page.title();
  check('the title bar reflects the new project name', titleAfterMove.includes(destName), titleAfterMove);
  // corruptedPath (its look failed to move) is still the CANVAS's open photo
  // at this point (opened+saved right before the move, nothing opened
  // since) — currentLookPath must stay pointed at the OLD quick-project
  // location, since that's genuinely where the file still is; repointing it
  // at the (never-created) destDir path would leave the open session
  // watching/saving to a path with nothing there.
  check(
    "the currently-open (failed-to-move) photo's currentLookPath stays in the QUICK project, not repointed at destDir",
    projAfterMove.currentLookPath === join(quickProjectDir, 'looks', corruptedLook),
    projAfterMove.currentLookPath
  );

  // Reopen the NEW project from disk (simulates a relaunch) and confirm a
  // known edit survives the move: ARW_PATH was row 0, edited to ev 0.5 in
  // check 1 and never touched again since (whatever photo check 4 left open
  // — photoB, ev 0.33 — is the "before" state this must genuinely move on
  // from). Deliberately NOT waiting on imageStatus==='ready' here:
  // openProjectByPath does several IPC round trips (read+parse the
  // manifest, buildPlaylistEntries) BEFORE it ever calls openImageByPath
  // (the thing that actually flips status to 'loading') — a naive
  // status==='ready' wait can trivially observe the STALE 'ready' left over
  // from photoB and resolve immediately, never having watched the real
  // reopen happen at all. Polling the graph's own ev value instead can't
  // spuriously already be true (photoB's ev is 0.33, not 0.5), so it's only
  // ever satisfied by the genuine restore.
  await page.evaluate((dir) => {
    void window.__openProjectByPath(dir);
  }, destDir);
  await page.waitForFunction(
    () => window.__debug?.graphState().nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.5,
    { timeout: 120_000 }
  );
  check("reopening the new project restores ARW_PATH's edited look (ev 0.5)", (await devEv()) === 0.5, await devEv());
  const titleAfterReopen = await page.title();
  check('the title bar still reflects the new project name after reopening', titleAfterReopen.includes(destName), titleAfterReopen);

  // === 6. NG2 fix pack — notice dismiss (✕) lifecycle ===
  console.log('verify-project2 (6. NG2 — a persistent (error-kind) project-notice is dismissable via ✕):');
  // A corrupt-manifest openProjectByPath (same shape verify-project.mjs's
  // own check already exercises) raises an 'error'-kind projectNotice
  // WITHOUT touching whichever project is currently active on a parse
  // failure (`return false` right after raiseNotice) — decoupled from any
  // playlist-row bookkeeping left over from the checks above, unlike
  // reusing an existing row would be.
  const corruptProjectDir = mkdtempSync(join(tmpdir(), 'silverbox-project2-corruptmanifest-'));
  cleanupPaths.push(corruptProjectDir);
  writeFileSync(join(corruptProjectDir, 'project.silverbox'), '{ not json', 'utf8');
  await page.evaluate((dir) => {
    void window.__openProjectByPath(dir);
  }, corruptProjectDir);
  await page.waitForSelector('[data-testid="project-notice"]', { timeout: 5_000 });
  const dismissNoticeKind = await page.locator('.toolbar-hotreload-notice[data-project-notice-kind]').getAttribute('data-project-notice-kind');
  check('a corrupt-manifest project-notice is kind "error"', dismissNoticeKind === 'error', dismissNoticeKind);
  await page.locator('[data-testid="project-notice-dismiss"]').click();
  check('clicking ✕ clears the notice immediately (NG2: notices used to only clear via a NEWER notice replacing them)', (await page.locator('[data-testid="project-notice"]').count()) === 0, null);

  // === 7. NG3 fix pack — refreshPlaylistStatus surfaces a renamed CURRENT photo ===
  console.log('verify-project2 (7. NG3 — an externally renamed CURRENT photo is surfaced, not silent; clears once it resolves again):');
  const ng3Dir = mkdtempSync(join(tmpdir(), 'silverbox-project2-ng3-'));
  cleanupPaths.push(ng3Dir);
  const ng3OrigPath = join(ng3Dir, 'ng3.ARW');
  writeFileSync(ng3OrigPath, readFileSync(ARW_PATH));
  await openAndWait(ng3OrigPath);
  const missingState = () => page.evaluate(() => window.__debug.currentPhotoMissingState());
  check('no missing notice while the file is still where it was opened from', (await missingState()) === null, await missingState());

  // Simulate an external rename WHILE the photo is open (main/index.ts's own
  // fs.watch only covers the SIDECAR, never the photo file itself — this is
  // exactly the "missing status only computes on project/folder open" gap).
  const ng3RenamedPath = join(ng3Dir, 'ng3-renamed.ARW');
  renameSync(ng3OrigPath, ng3RenamedPath);
  // window focus regain is App.tsx's real trigger; drive the same store
  // action directly (native window-manager focus events aren't drivable
  // from Playwright) — see refreshPlaylistStatus's own doc comment.
  await page.evaluate(() => window.__debug.refreshPlaylistStatus());
  await waitFor(async () => (await missingState()) !== null);
  check('refreshPlaylistStatus surfaces the current photo as missing after an external rename', typeof (await missingState()) === 'string' && (await missingState()).includes('missing'), await missingState());
  const missingNoticeText = await page.locator('[data-testid="current-photo-missing-notice"]').textContent();
  check('the toolbar shows the current-photo-missing notice', (missingNoticeText ?? '').includes('missing'), missingNoticeText);

  // Move it back (simulating the fix) and confirm the SAME refresh clears it.
  renameSync(ng3RenamedPath, ng3OrigPath);
  await page.evaluate(() => window.__debug.refreshPlaylistStatus());
  await waitFor(async () => (await missingState()) === null);
  check('the missing notice clears once the file resolves again', (await missingState()) === null, null);
} finally {
  await app.close();
}

for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
