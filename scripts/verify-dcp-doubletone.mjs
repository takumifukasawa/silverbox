/**
 * DCP double-tone fix verify (docs/brief-bank/dcp-double-tone-fix.md, option
 * a'). The bug: a fresh RAW open seeds the camera base curve into
 * toneCurve.rgb (seedDefaultLook), while a tone-carrying DCP bakes its OWN
 * ProfileToneCurve INTO the profile lattice — so switching that photo to the
 * DCP applied tone TWICE. The fix flattens the SEEDED base curve to identity
 * when a tone-CARRYING DCP becomes active, GUARDED so it never eats a
 * tone-less DCP's only tone, nor a curve the user edited themselves.
 *
 * These are renderer-store behaviors (appStore.refreshDcpProfile's flatten),
 * so this drives the real app under Playwright (verify-basecurve.mjs's idiom),
 * NOT the headless CLI — the CLI renders sidecars, it never runs the
 * interactive source-switch/dcpPath-choose flow the flatten lives on.
 *
 * SILVERBOX_TEST_BASE_CURVE_DEFAULT=1 so the base-curve seeding actually
 * fires inside the suite (same gate verify-basecurve.mjs opts into) — without
 * the seed there is nothing for the flatten to match.
 *
 * Fixtures: scripts/fixtures/build-dcp-fixture.mjs — the tone-CARRYING
 * fixture (buildFixtureDcp, carries a ProfileToneCurve) and a tone-LESS
 * variant (buildTonelessFixtureDcp, same bytes minus tag 50940). Both OURS,
 * zero Adobe content (the DCP brief's hard legal line).
 *
 * Checks:
 *  1. Tone-carrying DCP → the seeded base curve in toneCurve.rgb becomes
 *     identity, graphDirty goes true, a Japanese projectNotice explains it.
 *     Proven for BOTH trigger paths: (A) dcpPath set FIRST, then source→dcp;
 *     (B) source→dcp FIRST (no path — a no-op bake), then dcpPath chosen.
 *  2. Tone-LESS DCP → toneCurve.rgb is UNCHANGED (base curve kept — a
 *     tone-less DCP is color-only, so its base curve is the sole tone).
 *  3. User-edited curve guard → a curve edited away from the seed is NOT
 *     flattened when a tone-carrying DCP becomes active.
 *  4. One ⌘Z after a flatten restores the base curve.
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { buildFixtureDcp, buildTonelessFixtureDcp } from './fixtures/build-dcp-fixture.mjs';
import { ensureTestProjectEnv, seedLibraryDir } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';
process.env.SILVERBOX_TEST_BASE_CURVE_DEFAULT = '1'; // seed the base curve inside the suite (verify-basecurve.mjs's gate)

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();

// Mint an isolated userData dir + libraryDir (playbook hazard — a self-minted
// userData dir must seed its own libraryDir, or the app writes into this
// machine's real ~/Silverbox/Library on boot; see seedLibraryDir's doc).
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-dcp2t-userdata-'));
if (ownUserData) seedLibraryDir(userDataDir);

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

// The base-curve seed is the source of truth — read the a7C II points straight
// from baseCurve.ts (verify-basecurve.mjs's exact trick) so a refit never has
// to touch this script. test.ARW resolves to this curve whether its model has
// its own entry or falls back to DEFAULT_BASE_CURVE (both are A7C2 today).
const baseCurveSrc = readFileSync(join(projectRoot, 'src', 'renderer', 'engine', 'color', 'baseCurve.ts'), 'utf8');
const curveMatch = baseCurveSrc.match(/A7C2_BASE_CURVE[^=]*=\s*(\[[\s\S]*?\]);/);
const SEED_POINTS = JSON.parse(curveMatch[1].replace(/,(\s*[\]])/g, '$1'));
const IDENTITY = [[0, 0], [255, 255]];

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};
const pointsEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-dcp2t-'));
const toneCarryingDcp = join(workDir, 'tone-carrying.dcp');
const tonelessDcp = join(workDir, 'toneless.dcp');
writeFileSync(toneCarryingDcp, buildFixtureDcp());
writeFileSync(tonelessDcp, buildTonelessFixtureDcp());
// A distinct on-disk photo per check so each starts from a clean fresh-open
// seed (linkSync keeps them cheap — same as verify-undo.mjs's fixtures).
const photo = (name) => {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
};
const PHOTO_PATH_FIRST = photo('dcp2t-path-first.ARW'); // trigger path A
const PHOTO_SOURCE_FIRST = photo('dcp2t-source-first.ARW'); // trigger path B
const PHOTO_TONELESS = photo('dcp2t-toneless.ARW');
const PHOTO_EDITED = photo('dcp2t-edited.ARW');
const PHOTO_UNDO = photo('dcp2t-undo.ARW');

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openImage = async (p) => {
    await page.evaluate((path) => {
      void window.__openImageByPath(path);
    }, p);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const devId = () => page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.id ?? null);
  const devCurve = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.develop?.toneCurve?.rgb ?? null);
  const devChannel = (ch) =>
    page.evaluate((c) => window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.develop?.toneCurve?.[c] ?? null, ch);
  const graphDirty = () => page.evaluate(() => window.__debug.graphDirty());
  const notice = () => page.evaluate(() => window.__debug.projectNoticeState());
  const dcpRev = () => page.evaluate(() => window.__debug.dcpProfileState().rev);
  const topUndoLabel = () => page.evaluate(() => window.__debug.undoStackState().undo.at(-1)?.label ?? null);
  const FLATTEN_LABEL = 'Flatten tone curve for DCP profile'; // appStore.refreshDcpProfile's pushHistory label
  const setSource = (id, src) => page.evaluate(([i, s]) => window.__debug.setDevelopProfileSource(i, s), [id, src]);
  const setDcpPath = (id, p) => page.evaluate(([i, dp]) => window.__debug.setDevelopProfileDcpPath(i, dp), [id, p]);
  // A successful bake ticks dcpProfileRev AND leaves status 'ready'; the
  // flatten (if it applies) runs synchronously right after that same set(), so
  // once we observe ready+rev-advanced the flatten has already landed. (An
  // idle no-op bake — source=dcp with no path — ticks rev but leaves status
  // 'idle', so it never satisfies this wait.)
  const waitBaked = async (revBefore) => {
    await page.waitForFunction(
      (rb) => {
        const st = window.__debug.dcpProfileState();
        return st.status === 'ready' && st.rev > rb;
      },
      revBefore,
      { timeout: 30_000 }
    );
  };

  // === 1A. tone-carrying DCP, trigger path A (dcpPath first, then source) ====
  console.log('verify-dcp-doubletone (1A. tone-carrying DCP flattens the seed — path A: dcpPath, then source→dcp):');
  await openImage(PHOTO_PATH_FIRST);
  const idA = await devId();
  check('fresh ARW seeded the base curve into toneCurve.rgb', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  check('fresh open is not dirty (the seed IS the default look)', (await graphDirty()) === false, await graphDirty());
  // dcpPath set while source is still builtin: refreshDcpProfile early-returns
  // (idle), no bake, no flatten yet — the curve stays the seed.
  await setDcpPath(idA, toneCarryingDcp);
  check('setting dcpPath alone (source still builtin) does NOT flatten', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  const revA = await dcpRev();
  await setSource(idA, 'dcp'); // NOW the bake + flatten fire
  await waitBaked(revA);
  check('path A: toneCurve.rgb is now identity (single tone — DCP only)', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  check('path A: the flatten made the graph dirty', (await graphDirty()) === true, await graphDirty());
  const noticeA = await notice();
  check('path A: a Japanese projectNotice explains the flatten', !!noticeA && /フラット/.test(noticeA.message), noticeA);
  check('path A: the flatten is its OWN, distinctly-labeled undo entry (top of stack)', (await topUndoLabel()) === FLATTEN_LABEL, await topUndoLabel());

  // === 1B. tone-carrying DCP, trigger path B (source first, then dcpPath) ====
  console.log('verify-dcp-doubletone (1B. same flatten — path B: source→dcp first, then dcpPath chosen):');
  await openImage(PHOTO_SOURCE_FIRST);
  const idB = await devId();
  check('fresh ARW seeded the base curve (path B photo)', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  // source→dcp with NO path yet: refreshDcpProfile hits its idle guard (no
  // path), no bake, no flatten — the seed stays.
  await setSource(idB, 'dcp');
  check('source→dcp with no path does NOT flatten (nothing baked yet)', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  const revB = await dcpRev();
  await setDcpPath(idB, toneCarryingDcp); // choosing the path bakes + flattens
  await waitBaked(revB);
  check('path B: toneCurve.rgb is now identity — the dcpPath-choose flow reaches the flatten too', pointsEqual(await devCurve(), IDENTITY), await devCurve());

  // === 2. tone-LESS DCP: base curve MUST be kept =============================
  console.log('verify-dcp-doubletone (2. tone-less DCP keeps the base curve — it is the only tone):');
  await openImage(PHOTO_TONELESS);
  const idT = await devId();
  check('fresh ARW seeded the base curve (tone-less photo)', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  await setDcpPath(idT, tonelessDcp);
  const revT = await dcpRev();
  await setSource(idT, 'dcp');
  await waitBaked(revT);
  check('tone-less DCP leaves toneCurve.rgb UNCHANGED (base curve kept)', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());
  // No flatten entry was pushed (the projectNotice can't be asserted here — it
  // is a global, auto-expiring banner a prior check's success notice still
  // occupies; the undo stack is the precise per-action discriminator).
  check('tone-less DCP pushed NO flatten undo entry (top is the source switch)', (await topUndoLabel()) !== FLATTEN_LABEL, await topUndoLabel());

  // === 3. user-edited curve guard: only the untouched seed is flattened =====
  console.log('verify-dcp-doubletone (3. a user-edited curve is never flattened):');
  await openImage(PHOTO_EDITED);
  const idE = await devId();
  const EDITED = [[0, 0], [64, 40], [192, 210], [255, 255]]; // deliberately not the seed
  await page.evaluate(([id, pts]) => window.__debug.setToneCurvePoints(id, 'rgb', pts), [idE, EDITED]);
  check('the edited curve took (differs from the seed)', pointsEqual(await devCurve(), EDITED), await devCurve());
  await setDcpPath(idE, toneCarryingDcp);
  const revE = await dcpRev();
  await setSource(idE, 'dcp');
  await waitBaked(revE);
  check('a tone-carrying DCP does NOT flatten the user-edited curve', pointsEqual(await devCurve(), EDITED), await devCurve());
  check('user-edited case pushed NO flatten undo entry', (await topUndoLabel()) !== FLATTEN_LABEL, await topUndoLabel());

  // === 4. one ⌘Z restores the base curve after a flatten ====================
  console.log('verify-dcp-doubletone (4. one ⌘Z restores the base curve):');
  await openImage(PHOTO_UNDO);
  const idU = await devId();
  await setDcpPath(idU, toneCarryingDcp);
  const revU = await dcpRev();
  await setSource(idU, 'dcp');
  await waitBaked(revU);
  check('flattened to identity before the undo', pointsEqual(await devCurve(), IDENTITY), await devCurve());
  // Only toneCurve.rgb (the master) is ever touched — r/g/b channel curves stay identity.
  check('r/g/b channel curves were left untouched (only the master flattened)',
    pointsEqual(await devChannel('r'), IDENTITY) && pointsEqual(await devChannel('g'), IDENTITY) && pointsEqual(await devChannel('b'), IDENTITY),
    { r: await devChannel('r'), g: await devChannel('g'), b: await devChannel('b') });
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    (seed) => {
      const rgb = window.__debug.graphState().nodes.find((n) => n.kind === 'Develop')?.develop?.toneCurve?.rgb;
      return Array.isArray(rgb) && rgb.length === seed.length && rgb.every((p, i) => p[0] === seed[i][0] && p[1] === seed[i][1]);
    },
    SEED_POINTS,
    { timeout: 10_000 }
  );
  check('one ⌘Z restored the base curve', pointsEqual(await devCurve(), SEED_POINTS), await devCurve());

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
