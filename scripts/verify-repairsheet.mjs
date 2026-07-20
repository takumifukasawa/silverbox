/**
 * Repair sheet (ゴミ取りセット) verify (docs/brief-bank/linked-looks-stage-f.md):
 * a sensor-anchored, one-shot dust-stamp set. Spots are stored in PHYSICAL
 * SENSOR PIXELS and applied through each target's readout-window ∘ orientation
 * transform (repairSheetTransform.ts); the applied spots become ordinary
 * photo-local spots. RAW-only v1.
 *
 * Checks (the brief's own 5 E2E items):
 *  1. Photo 1: place 2 spots, save sheet -> repair-sheets/<slug>.json exists
 *     with SENSOR-px coords (not normalized 0..1).
 *  2. Apply to selection (photos 2+3, same ARW): both gain 2 ordinary spots at
 *     the correct anchor coords (same file => same mapping, round-trips to the
 *     original anchor coords); ONE batch undo removes from both; redo restores.
 *  3. Cap refusal: a target pre-seeded with 31 spots + 2 mapped = 33 > 32 ->
 *     that target is SKIPPED with a loud notice, its file untouched (31 intact);
 *     a co-target still gets applied.
 *  4. JPEG target: skipped with a loud notice, never written.
 *  5. Applied spots are ORDINARY: one is deletable afterward via the spot tool.
 *
 * The pure sensor<->anchor math is unit-tested separately
 * (src/renderer/engine/graph/repairSheetTransform.test.ts) — this script proves
 * the end-to-end create/apply/undo/skip machinery against a real decode.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, readLook } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const testProjectDir = ensureTestProjectEnv();

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-repairsheet-'));
function fixture(name, srcPath = ARW_PATH) {
  const dst = join(workDir, name);
  linkSync(srcPath, dst);
  return dst;
}
// All ARW fixtures are hardlinks of the SAME test ARW — same readout window &
// orientation, so create-on-one/apply-to-another round-trips exactly.
const P1 = fixture('a_source.ARW'); // create source — 2 spots
const P2 = fixture('b_apply1.ARW'); // check 2 primary
const P3 = fixture('c_apply2.ARW'); // check 2 secondary + check 5 delete
const P4 = fixture('d_cap.ARW'); // check 3: pre-seeded 31 spots (refused)
const P5 = fixture('e_cofit.ARW'); // check 3: co-target (applied)
const P6 = fixture('f_primary.ARW'); // check 3/4 neutral primary
const JPG = fixture('g_jpeg.JPG', JPG_PATH); // check 4: JPEG target (skipped)

const repairSheetPathFor = (slug) => join(testProjectDir, 'repair-sheets', `${slug}.json`);
const spotsOf = (diskDoc) => diskDoc.graph.nodes.find((n) => n.type === 'spots')?.spots?.spots ?? [];

async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-repairsheet-userdata-'));
// Playbook hazard: a self-minted userData with no libraryDir makes boot
// migration (stage E) write the REAL ~/Silverbox/Library. Seed an isolated one
// (same shape run-verify.mjs's setupIsolation writes for pooled scripts). When
// SILVERBOX_USER_DATA is inherited (pooled), run-verify already seeded it.
const libraryDir = ownUserData ? mkdtempSync(join(tmpdir(), 'silverbox-repairsheet-lib-')) : null;
if (ownUserData) {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ settingsVersion: 1, libraryDir }, null, 2) + '\n', 'utf8');
}

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
  const openImage = async (path) => {
    await page.evaluate((p) => void window.__openImageByPath(p, { keepFolderContext: true }), path);
    await waitReadyOrError();
  };
  const openFolder = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const liveSpots = async () => (await graphState()).nodes.find((n) => n.kind === 'spots')?.spots?.spots ?? [];
  const activeSpotsNodeId = () => page.evaluate(() => window.__debug.activeSpotsNodeId());
  const commitSpot = (dst, src, radius) => page.evaluate((a) => window.__debug.commitSpot(a.dst, a.src, a.radius), { dst, src, radius });
  const setSpots = (nodeId, spots) => page.evaluate((a) => window.__debug.setSpots(a.nodeId, a.spots), { nodeId, spots });
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const repairSheetsState = () => page.evaluate(() => window.__debug.repairSheetsState());
  const projectNotice = () => page.evaluate(() => window.__debug.projectNoticeState());
  const readoutState = () => page.evaluate(() => window.__debug.imageReadoutState());
  const undoStackState = () => page.evaluate(() => window.__debug.undoStackState());

  // A spot with the exact anchor coords we place — geometry is identity on a
  // fresh open, so anchor==output and commitSpot's args ARE the stored coords.
  const SPOT_A = { dst: { x: 0.3, y: 0.4 }, src: { x: 0.5, y: 0.42 }, radius: 0.05 };
  const SPOT_B = { dst: { x: 0.62, y: 0.55 }, src: { x: 0.7, y: 0.57 }, radius: 0.04 };

  // Bootstrap a spots node with an exact list of spots (commit one to
  // create/wire the node, then overwrite the list with the precise values).
  const seedSpots = async (spots) => {
    await commitSpot({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, 0.05);
    const nodeId = await activeSpotsNodeId();
    await setSpots(nodeId, spots);
    return nodeId;
  };
  const spotList = (specs) => specs.map((s) => ({ dx: s.dst.x, dy: s.dst.y, sx: s.src.x, sy: s.src.y, radius: s.radius, feather: 0.3 }));

  // === Setup: open the folder (populates the playlist for filmstrip selection) ===
  await openFolder(workDir);
  await page.waitForFunction(() => window.__debug.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 7, { timeout: 15_000 });
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: false }));

  // ---------------------------------------------------------------------
  console.log('verify-repairsheet (1. place 2 spots on P1, save a sheet -> repair-sheets/<slug>.json with sensor-px coords):');
  await openImage(P1);
  const readout = await readoutState();
  check('the RAW frame carries a readout window (RAW-only gate)', !!readout?.readoutOrigin, readout);
  await seedSpots(spotList([SPOT_A, SPOT_B]));
  check('P1 has exactly 2 spots placed', (await liveSpots()).length === 2, await liveSpots());

  await page.evaluate(() => window.__debug.saveRepairSheet('Dust Set'));
  await waitFor(async () => (await repairSheetsState()).some((s) => s.name === 'Dust Set'));
  const sheets = await repairSheetsState();
  const sheetSlug = sheets.find((s) => s.name === 'Dust Set')?.slug;
  check('the sheet appears in the store list', !!sheetSlug, sheets);
  check('repair-sheets/<slug>.json exists on disk', !!sheetSlug && existsSync(repairSheetPathFor(sheetSlug)), sheetSlug);

  const sheetDoc = sheetSlug ? JSON.parse(readFileSync(repairSheetPathFor(sheetSlug), 'utf8')) : {};
  check('the sheet holds 2 spots', sheetDoc.spots?.length === 2, sheetDoc.spots);
  // Sensor px: anchor 0.3 * fullWidth (thousands of px) is WAY above 1 —
  // proves the file stores sensor pixels, not normalized coords.
  const s0 = sheetDoc.spots?.[0];
  check('spot coords are physical sensor px (>> 1), not normalized', !!s0 && s0.dx > 1 && s0.dy > 1 && s0.radius > 1, s0);
  check('the sheet records the camera model', typeof sheetDoc.cameraModel === 'string' && sheetDoc.cameraModel.length > 0, sheetDoc.cameraModel);
  check('feather is carried verbatim (dimensionless ratio)', s0?.feather === 0.3, s0?.feather);

  // ---------------------------------------------------------------------
  console.log('verify-repairsheet (2. apply to selection P2(primary)+P3(secondary): both gain 2 spots at correct anchor coords; batch undo/redo):');
  await openImage(P2);
  await setSelection([P3]);
  const stackBefore = await undoStackState();
  await page.evaluate((slug) => window.__debug.applyRepairSheet(slug), sheetSlug);
  // P3's look file is written; P2's live graph gets the spots + a flush save.
  check('P3 (secondary) look file created', await waitFor(() => existsSync(lookPathFor(P3))), lookPathFor(P3));
  await waitFor(async () => (await liveSpots()).length === 2);

  const p2Spots = await liveSpots();
  const p3Spots = spotsOf(readLook(P3));
  check('P2 (open primary) gained 2 spots', p2Spots.length === 2, p2Spots);
  check('P3 (secondary) gained 2 spots', p3Spots.length === 2, p3Spots);
  // Same file => sensor->anchor round-trips back to the exact anchor coords.
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const matchesOriginal = (s) =>
    (near(s.dx, SPOT_A.dst.x) && near(s.dy, SPOT_A.dst.y)) || (near(s.dx, SPOT_B.dst.x) && near(s.dy, SPOT_B.dst.y));
  check('P2 spots round-trip to the original anchor coords', p2Spots.every(matchesOriginal), p2Spots);
  check('P3 spots round-trip to the original anchor coords', p3Spots.every(matchesOriginal), p3Spots);

  const stackAfter = await undoStackState();
  const topEntry = stackAfter.undo.at(-1);
  check('one batch sync undo entry covering P2+P3', topEntry?.kind === 'sync' && topEntry.targets.length === 2 && stackAfter.undo.length === stackBefore.undo.length + 1, topEntry);

  await page.keyboard.press('Meta+z');
  await waitFor(async () => (await liveSpots()).length === 0 && spotsOf(readLook(P3)).length === 0);
  check('undo removes the spots from P2 (live)', (await liveSpots()).length === 0, await liveSpots());
  check('undo removes the spots from P3 (disk)', spotsOf(readLook(P3)).length === 0, spotsOf(readLook(P3)));

  await page.keyboard.press('Meta+Shift+z');
  await waitFor(async () => (await liveSpots()).length === 2 && spotsOf(readLook(P3)).length === 2);
  check('redo restores the spots on P2 (live)', (await liveSpots()).length === 2, await liveSpots());
  check('redo restores the spots on P3 (disk)', spotsOf(readLook(P3)).length === 2, spotsOf(readLook(P3)));

  // ---------------------------------------------------------------------
  console.log('verify-repairsheet (5. applied spots are ORDINARY — one is deletable afterward via the spot tool):');
  await openImage(P3);
  await waitFor(async () => (await liveSpots()).length === 2);
  const p3NodeId = await activeSpotsNodeId();
  const keep = (await liveSpots())[0];
  await setSpots(p3NodeId, [keep]);
  await waitFor(async () => (await liveSpots()).length === 1);
  check('an applied spot deletes like any ordinary spot (2 -> 1)', (await liveSpots()).length === 1, await liveSpots());

  // ---------------------------------------------------------------------
  console.log('verify-repairsheet (3. cap refusal: P4 pre-seeded with 31 spots is REFUSED (file untouched), co-target P5 still applied):');
  await openImage(P4);
  await seedSpots(spotList(Array.from({ length: 31 }, (_, i) => ({ dst: { x: 0.1 + i * 0.02, y: 0.5 }, src: { x: 0.15 + i * 0.02, y: 0.5 }, radius: 0.02 }))));
  check('P4 pre-seeded with 31 spots', (await liveSpots()).length === 31, (await liveSpots()).length);
  await page.click('[data-testid="save-button"]');
  await waitFor(() => existsSync(lookPathFor(P4)) && spotsOf(readLook(P4)).length === 31);

  // Neutral primary P6; secondaries = P4 (refused) + P5 (applied).
  await openImage(P6);
  await setSelection([P4, P5]);
  const p4SnapshotBefore = readFileSync(lookPathFor(P4), 'utf8');
  await page.evaluate((slug) => window.__debug.applyRepairSheet(slug), sheetSlug);
  check('P5 (co-target) look file created', await waitFor(() => existsSync(lookPathFor(P5))), lookPathFor(P5));
  await waitFor(async () => spotsOf(readLook(P5)).length === 2);
  check('P5 (co-target) still gets 2 spots applied', spotsOf(readLook(P5)).length === 2, spotsOf(readLook(P5)));
  check('P4 refused: its look file is byte-identical (31 spots untouched, never truncated)', readFileSync(lookPathFor(P4), 'utf8') === p4SnapshotBefore, null);
  check('P4 still has 31 spots on disk (SPOTS_CAP never silently trimmed the apply)', spotsOf(readLook(P4)).length === 31, spotsOf(readLook(P4)).length);
  const capNotice = await projectNotice();
  check('a loud notice names P4 and the cap refusal', !!capNotice && capNotice.message.includes('d_cap.ARW') && capNotice.message.includes('拒否'), capNotice);

  // ---------------------------------------------------------------------
  console.log('verify-repairsheet (4. JPEG target: skipped with a loud notice, never written):');
  await openImage(P6);
  await setSelection([JPG]);
  check('the JPG has no look file before the apply', !existsSync(lookPathFor(JPG)), lookPathFor(JPG));
  await page.evaluate((slug) => window.__debug.applyRepairSheet(slug), sheetSlug);
  await waitFor(async () => {
    const n = await projectNotice();
    return !!n && n.message.includes('g_jpeg.JPG');
  });
  const jpgNotice = await projectNotice();
  check('a loud notice names the JPG as skipped', !!jpgNotice && jpgNotice.message.includes('g_jpeg.JPG'), jpgNotice);
  check('the JPG look file was never written (RAW-only v1)', !existsSync(lookPathFor(JPG)), lookPathFor(JPG));

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

rmSync(workDir, { recursive: true, force: true });
if (ownUserData) {
  rmSync(userDataDir, { recursive: true, force: true });
  if (libraryDir) rmSync(libraryDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
