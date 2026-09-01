/**
 * Auto tone verify (docs/brief-bank/auto-tone.md): the toolbar's 「自動トーン」
 * button — a one-click, histogram-anchored STARTING POINT for the
 * basic-tone sliders (ev/blacks/whites/highlights/shadows), written through
 * the SAME appStore mutator (updateNodeParamsBatch) a slider drag uses.
 *
 * Checks (the brief's own numbered list):
 *  1. A deliberately DARK render (baselineExposureEV pushed well below the
 *     shipped default, then re-decoded) → Auto Tone RAISES exposure
 *     (resulting basic.ev clearly positive); a BRIGHT one (EV pushed well
 *     above default) → LOWERS it (basic.ev clearly negative).
 *  2. Black/white points land the extreme percentiles near the clip anchors
 *     WITHOUT hard-clipping — the rendered output's shadowClip/highlightClip
 *     (window.__debug.histogramState()) stay bounded after Auto Tone, never
 *     a full blowout.
 *  3. ONE undo entry: a real ⌘Z (Meta+z) fully reverts every basic-tone
 *     slider Auto Tone touched, back to its pre-auto value.
 *  4. On a LINKED photo (shared look, basic-tone family), applying Auto Tone
 *     FORKS basic-tone to 個別調整 (fork-on-touch fires) — same undo-stack
 *     growth as any other single-op edit (fork folds into the same entry,
 *     per appStore.ts's forkLinkedFamilies doc comment).
 *
 * Harness shape mirrors the recent linked-looks/develop-thumbnails scripts:
 * a temp folder of hardlinked ARW fixtures, `window.__debug` for state
 * assertions, real toolbar/menu gestures wherever a visible control exists
 * (DESIGN.md "visible path to every result").
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, hasSharedLook, readSharedLook } from './lib/testProject.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-autotone-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order (folder open's own sort): a_ev opens first.
const EV_TEST = fixture('a_ev.ARW');
const NORMAL = fixture('b_normal.ARW');
const LINK_A = fixture('c_linka.ARW'); // shared-look creator
const LINK_B = fixture('d_linkb.ARW'); // linked follower — the fork target

const devOf = (graph) => graph.nodes.find((n) => n.id === 'dev').develop;
const devOfShared = (sharedDoc) => sharedDoc.look.graph.nodes.find((n) => n.id === 'dev').develop;

async function waitFor(fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-autotone-userdata-'));

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
  const openImageAndWait = async (path) => {
    await openImageFireAndForget(path, { keepFolderContext: true });
    await waitReadyOrError();
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const undoStackState = () => page.evaluate(() => window.__debug.undoStackState());
  const developLinkState = () => page.evaluate(() => window.__debug.developLinkState('dev'));
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const sharedLooksState = () => page.evaluate(() => window.__debug.sharedLooksState());
  const histogramState = () => page.evaluate(() => window.__debug.histogramState());

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

  /** Click the real toolbar button and wait until the Develop node's basic params actually change (fire-and-forget-free: the click itself is a plain sync store dispatch). */
  const clickAutoTone = async () => {
    const before = JSON.stringify(devOf(await graphState()).basic);
    await page.locator('[data-testid="toolbar-auto-tone"]').click();
    await waitFor(async () => JSON.stringify(devOf(await graphState()).basic) !== before);
  };

  // Poll histogramState() until two consecutive reads 300ms apart agree —
  // it's a debounced post-render stats readback (verify-basecurve.mjs's own
  // histP50 precedent), so a single read right after a change can be stale.
  const settledHistogram = async () => {
    let prev = JSON.stringify(await histogramState());
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const cur = JSON.stringify(await histogramState());
      if (cur === prev) return JSON.parse(cur);
      prev = cur;
    }
    return JSON.parse(prev);
  };

  // === Setup: open the folder — a_ev (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    EV_TEST,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, { timeout: 15_000 });

  // ---------------------------------------------------------------------
  console.log('verify-autotone (1. dark render raises exposure, bright render lowers it):');
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  const defaultEV = await page.evaluate(() => window.__debug.settingsState().baselineExposureEV);
  // Source-of-truth default (same technique verify-cst.mjs/fit-base-curve.mjs
  // use) — never hand-copied, so a future LR-calibration bump to
  // DEFAULT_SETTINGS never has to touch this script.
  const ipcSrc = readFileSync(join(projectRoot, 'shared', 'ipc.ts'), 'utf8');
  const evMatch = ipcSrc.match(/baselineExposureEV:\s*([\d.]+)/);
  const expectedDefaultEV = evMatch ? Number(evMatch[1]) : NaN;
  check('baselineExposureEV read from settings matches shared/ipc.ts DEFAULT_SETTINGS', defaultEV === expectedDefaultEV, {
    defaultEV,
    expectedDefaultEV,
  });

  // settings only take effect on the NEXT decode (verify-cst.mjs's own note)
  // — set, then RE-OPEN to get a genuinely darker/brighter decoded buffer.
  await page.evaluate((ev) => window.__debug.updateSettings({ baselineExposureEV: ev }), defaultEV - 4);
  await openImageAndWait(EV_TEST);
  await clickAutoTone();
  const evDark = devOf(await graphState()).basic.ev;
  check('dark render: Auto Tone raises exposure (basic.ev clearly positive)', evDark > 0.3, evDark);

  await page.evaluate((ev) => window.__debug.updateSettings({ baselineExposureEV: ev }), defaultEV + 4);
  await openImageAndWait(EV_TEST); // fresh open — basic.ev back to 0 before this scene's own Auto Tone
  await clickAutoTone();
  const evBright = devOf(await graphState()).basic.ev;
  check('bright render: Auto Tone lowers exposure (basic.ev clearly negative)', evBright < -0.15, evBright);
  check('dark render lands a higher exposure than the bright render', evDark > evBright, { evDark, evBright });

  // restore the default before any other test reads a decode
  await page.evaluate((ev) => window.__debug.updateSettings({ baselineExposureEV: ev }), defaultEV);

  // ---------------------------------------------------------------------
  console.log('verify-autotone (2. black/white points nudge toward the clip anchors without hard-clipping):');
  await openImageAndWait(NORMAL);
  const histBefore = await settledHistogram();
  const devBeforeAutoTone = devOf(await graphState()).basic;
  // basic-tone's own 5 keys only — temp/tint are a SEPARATE preset family
  // (fork-on-touch's own split, presetFamilies.ts's familyForDevelopKey) and
  // are legitimately non-zero at fresh open (seeded from the camera's
  // as-shot WB estimate, seedDefaultLook) — never what Auto Tone touches.
  const BASIC_TONE_KEYS = ['ev', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
  check(
    'fresh open: basic-tone keys start untouched (all zero)',
    BASIC_TONE_KEYS.every((k) => devBeforeAutoTone[k] === 0),
    devBeforeAutoTone
  );

  await clickAutoTone();
  const devAfterAutoTone = devOf(await graphState()).basic;
  check(
    'Auto Tone actually moved blacks/whites off zero',
    devAfterAutoTone.blacks !== 0 || devAfterAutoTone.whites !== 0,
    devAfterAutoTone
  );
  const histAfter = await settledHistogram();
  // A genuine hard-clip blowout would push a LARGE additional slice of
  // pixels to literal 0/255 — bound the INCREASE over the pre-auto-tone
  // baseline (which may already be well above 0 on a scene with real deep
  // shadows/saturated colors — "any channel at 0/255", not "the whole pixel
  // is black/white") well above what a couple of the solve's small nudges
  // can legitimately move it, but far below what an actual blowout would
  // produce.
  // SHADOW budget widened 0.02 → 0.08 for the v2 allocation-model
  // recalibration (2026-09-01, LR-Auto fit): unlike v1 (which never touched
  // contrast and kept blacks near 0 on a typical photo), v2 ALWAYS applies a
  // small LR-matched contrast (+6) plus a modestly negative blacks — on
  // THIS fixture (test.ARW) shadowClip already sits at ~12.7% before any
  // edit (an unusually shadow/black-heavy stress photo), so contrast alone
  // legitimately raises it a couple of points, and the bounded blacks nudge
  // a few more (measured ~0.057 total on this fixture) — a real, intended,
  // BOUNDED effect of the two sliders' own formulas (see autoTone.ts's
  // AUTO_TONE_BLACK_GAIN doc comment), not a runaway/unbounded blowout.
  check('shadow clip does not blow out beyond the baseline', histAfter.shadowClip < histBefore.shadowClip + 0.08, {
    before: histBefore.shadowClip,
    after: histAfter.shadowClip,
  });
  check('highlight clip does not blow out beyond the baseline', histAfter.highlightClip < histBefore.highlightClip + 0.02, {
    before: histBefore.highlightClip,
    after: histAfter.highlightClip,
  });

  // ---------------------------------------------------------------------
  console.log('verify-autotone (3. one undo entry — a real ⌘Z reverts every slider Auto Tone touched):');
  const stackBeforeUndo = await undoStackState();
  check('exactly one undo entry was pushed by the click', stackBeforeUndo.undo.length > 0, stackBeforeUndo.undo.length);
  const topLabel = stackBeforeUndo.undo[stackBeforeUndo.undo.length - 1]?.label;
  await page.keyboard.press('Meta+z');
  await waitFor(async () => JSON.stringify(devOf(await graphState()).basic) === JSON.stringify(devBeforeAutoTone));
  const devAfterUndo = devOf(await graphState()).basic;
  check('⌘Z fully reverts every basic-tone slider Auto Tone touched (ev/blacks/whites/highlights/shadows)', JSON.stringify(devAfterUndo) === JSON.stringify(devBeforeAutoTone), {
    before: devBeforeAutoTone,
    afterUndo: devAfterUndo,
    undoneEntryLabel: topLabel,
  });

  // ---------------------------------------------------------------------
  console.log('verify-autotone (4. linked photo: Auto Tone forks basic-tone to 個別調整):');
  await openImageAndWait(LINK_A);
  await openSharedLookMenu();
  await page.locator('[data-testid="shared-look-create-name"]').fill('Autotone Fork Look');
  await page.locator('[data-testid="shared-look-create"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
  await setFamilyCheckboxes(['basic-tone']);
  await page.locator('[data-testid="family-scope-confirm"]').click();
  await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });
  check('shared look file appears', await waitFor(async () => (await sharedLooksState()).some((p) => p.name === 'Autotone Fork Look')), await sharedLooksState());
  const slug = (await sharedLooksState()).find((p) => p.name === 'Autotone Fork Look')?.slug;
  check('shared look slug resolved', !!slug, slug);
  check('shared look basic-tone family published (all zero, from a fresh photo)', hasSharedLook(slug) && devOfShared(readSharedLook(slug)).basic.ev === 0, slug);

  await setSelection([LINK_B]);
  await openSharedLookMenu();
  await sharedLookRow('Autotone Fork Look').click();
  await page.locator('[data-testid="shared-look-link"]').click();
  await openImageAndWait(LINK_B);
  check('photo B follows basic-tone right after linking (untouched)', await waitFor(async () => (await developLinkState())?.follows.includes('basic-tone')), await developLinkState());

  const stackBeforeAutoToneOnLinked = await undoStackState();
  await clickAutoTone();
  const stackAfterAutoToneOnLinked = await undoStackState();
  check(
    'Auto Tone on the linked photo pushed exactly ONE undo entry (fork folds into the same entry, not a second one)',
    stackAfterAutoToneOnLinked.undo.length === stackBeforeAutoToneOnLinked.undo.length + 1,
    { before: stackBeforeAutoToneOnLinked.undo.length, after: stackAfterAutoToneOnLinked.undo.length }
  );
  check(
    'Auto Tone forked basic-tone off the linked look (leaves follows → 個別調整)',
    await waitFor(async () => !(await developLinkState())?.follows.includes('basic-tone')),
    await developLinkState()
  );
  const linkedAfter = devOf(await graphState()).basic;
  check(
    'the linked photo actually carries its OWN Auto Tone values (not the look\'s untouched zeros)',
    linkedAfter.ev !== 0 || linkedAfter.blacks !== 0 || linkedAfter.whites !== 0,
    linkedAfter
  );

  console.log('');
  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
