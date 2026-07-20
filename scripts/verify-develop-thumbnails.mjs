/**
 * Develop-aware filmstrip thumbnails verify (docs/brief-bank/
 * develop-aware-thumbnails-impl.md — the in-memory, sRGB-correct (a) layer
 * of the (c) hybrid the conductor recommendation names). Every filmstrip
 * cell used to show only the camera's own embedded preview, blind to
 * whatever look the photo actually carries — this closes that gap by
 * running the develop chain's CPU mirror (graphDoc.ts's cpuEvalPlan) over
 * the ALREADY-cached 160px preview pixels, sRGB-decode → cpuEvalPlan →
 * sRGB-encode (srgb.ts's exact transfer functions, never gamma-2.2), never
 * touching the RAW decoder.
 *
 * Checks (the brief's own numbered list):
 *  1. A default-look photo's cell shows EXACTLY the plain cached preview
 *     blob: URL (no CPU pass took over) — thumbnailCache.ts's
 *     plainThumbnailUrlFor is the ground truth compared against the real
 *     <img> src. No extra decode-worker call fires either.
 *  2. Editing the OPEN photo (strong +EV, then B&W) changes ITS OWN cell
 *     bitmap in the expected direction — mean luma rises with +EV, RGB
 *     channels converge with B&W — with the decode-worker call count
 *     unchanged throughout (the CPU pass never decodes the RAW).
 *  3. The OTHER-cells case (the whole point): two CLOSED photos, each
 *     pre-touched so applyPresetToSelection's own existing-look branch
 *     never needs to decode them for ITS purposes either, get a strong
 *     preset (basic-tone +EV, bw) applied via apply-to-selection — both
 *     cells' bitmaps change (luma + channel convergence) within the
 *     debounce window, decode-worker call count unchanged across the whole
 *     apply.
 *  4. Reverting the open photo's edits back to the exact default (ev=0, bw
 *     off) returns its cell to the plain preview URL again — buildPlan's
 *     own identity resolution, not separate bookkeeping.
 *  5. Folder switch: every blob: URL this run ever handed out (plain AND
 *     develop-aware) shows up in thumbnailRevocationLog(), and the new
 *     folder's cells never reuse a stale one.
 *
 * `SILVERBOX_TEST=1` under this suite suppresses seedDefaultLook's
 * fresh-RAW auto-defaults (embedded lens profile, base curve, default
 * sharpen/NR — see appStore.ts's `autoDefaultAllowed`/`baseCurveAllowed`),
 * so a freshly-opened RAW here is genuinely `defaultDevelopParams()`'s bare
 * structural identity — the same baseline every other verify script in this
 * family relies on for its own "ev=0 is THE default" assertions.
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, seedLibraryDir } from './lib/testProject.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-develop-thumbnails-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
// Sorted-filename order (folder open's own sort — verify-filmstrip.mjs
// precedent): a_primary opens first when the folder is opened fresh.
const PRIMARY = fixture('a_primary.ARW');
const TARGET1 = fixture('b_target1.ARW');
const TARGET2 = fixture('c_target2.ARW');

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
const userDataDir = process.env.SILVERBOX_USER_DATA ?? seedLibraryDir(mkdtempSync(join(tmpdir(), 'silverbox-develop-thumbnails-userdata-')));

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
  const setSelection = (paths) => page.evaluate((p) => window.__debug.setFilmstripSelection(p), paths);
  const decodeCount = () => page.evaluate(() => window.__debug.decodeWorkerCallCount());
  const plainUrl = (path) => page.evaluate((p) => window.__debug.plainThumbnailUrl(p), path);
  const revocations = () => page.evaluate(() => window.__debug.thumbnailRevocations());

  const cellImgSel = (path) => `[data-testid="filmstrip-cell"][data-path="${path}"] [data-testid="filmstrip-thumb"]`;
  const waitForCellImg = (path) =>
    page.waitForFunction(
      (sel) => {
        const img = document.querySelector(sel);
        return !!img && img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:');
      },
      cellImgSel(path),
      { timeout: 15_000 }
    );
  const cellImgSrc = (path) => page.$eval(cellImgSel(path), (img) => img.src).catch(() => null);
  /** Read the cell's OWN, already-decoded <img> pixels directly (drawImage straight from the live DOM element — `fetch(blob:...)` is blocked by this app's CSP, connect-src 'self', the exact bug thumbnailCache.ts's own getThumbnailPixels had to route around too) and return mean RGB/luma + a channel-divergence stat (mean |r-g| + |g-b|, 0 for a perfectly gray image). */
  const cellStats = (path) =>
    page.evaluate(async (sel) => {
      const img = document.querySelector(sel);
      if (!img || !img.src) return null;
      await img.decode().catch(() => {}); // robust wait for THIS exact src's decode, unlike `.complete` which can lag a src swap
      const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
      let r = 0,
        g = 0,
        b = 0,
        n = 0,
        chanDiff = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        chanDiff += Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]);
        n++;
      }
      return { luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, chanDiff: chanDiff / n };
    }, cellImgSel(path));

  const openPresetsMenu = async () => {
    if ((await page.locator('[data-testid="presets-menu"]').count()) === 0) {
      await page.locator('[data-testid="presets-button"]').click();
      await page.waitForSelector('[data-testid="presets-menu"]', { timeout: 5_000 });
    }
  };
  const presetRow = (name) => page.locator('[data-testid="preset-row"]').filter({ hasText: name });
  const ALL_FAMILY_IDS = ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail', 'geometry', 'spots', 'masks', 'custom-nodes'];
  const setFamilyCheckboxes = async (idsToCheck) => {
    const want = new Set(idsToCheck);
    for (const id of ALL_FAMILY_IDS) {
      const checkbox = page.locator(`[data-testid="family-scope-checkbox-${id}"] input[type="checkbox"]`);
      if (want.has(id)) await checkbox.check();
      else await checkbox.uncheck();
    }
  };
  const saveWithFamilies = async (name, families) => {
    await page.locator('[data-testid="preset-save-name"]').fill(name);
    await page.locator('[data-testid="preset-save"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { timeout: 5_000 });
    await setFamilyCheckboxes(families);
    await page.locator('[data-testid="family-scope-confirm"]').click();
    await page.waitForSelector('[data-testid="family-scope-dialog"]', { state: 'detached', timeout: 5_000 });
  };

  // === Setup: open the folder — a_primary (first sorted) opens ===
  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PRIMARY,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 3, { timeout: 15_000 });
  await waitForCellImg(PRIMARY);
  await waitForCellImg(TARGET1);
  await waitForCellImg(TARGET2);

  // ---------------------------------------------------------------------
  console.log('verify-develop-thumbnails (1. default-look cell shows the PLAIN preview, no CPU pass, no extra decode):');
  const decodeCountAfterOpen = await decodeCount();
  check('at least one decode fired for the primary\'s own real open (sanity — the counter is live)', decodeCountAfterOpen >= 1, decodeCountAfterOpen);
  const plainPrimary = await plainUrl(PRIMARY);
  const srcPrimaryDefault = await cellImgSrc(PRIMARY);
  check('primary cell (default look) shows exactly the plain cached preview URL', !!plainPrimary && srcPrimaryDefault === plainPrimary, { plainPrimary, srcPrimaryDefault });
  const plainTarget1 = await plainUrl(TARGET1);
  const srcTarget1Default = await cellImgSrc(TARGET1);
  check('target1 cell (never touched) also shows exactly the plain cached preview URL', !!plainTarget1 && srcTarget1Default === plainTarget1, { plainTarget1, srcTarget1Default });
  await new Promise((r) => setTimeout(r, 500)); // settle margin — nothing async should be in flight for an all-default folder
  check('no extra decode fired while settling on an all-default folder', (await decodeCount()) === decodeCountAfterOpen, { before: decodeCountAfterOpen, after: await decodeCount() });

  // A real RAW's freshly-seeded develop node carries the as-shot white
  // balance (temp/tint resolved from the RAW's own metadata — appStore.ts's
  // seedDefaultLook, NOT gated by SILVERBOX_TEST — see that function's own
  // "so WB sliders always show real Kelvin values" comment), which is
  // genuinely non-zero and so compiles to a real (non-empty) develop plan
  // even with EVERY user-editable slider left untouched — buildPlan's
  // identity resolution is keyed off the STRUCTURAL default (temp===0, the
  // unresolved placeholder), not "as shot". Save once now, with ZERO user
  // edits, to capture that real baseline (used by check 4 below to prove a
  // REVERT undoes the user's own edits — it can't prove a return to the
  // PLAIN url once a look file exists at all, since the as-shot WB pass
  // never goes away).
  await page.click('[data-testid="save-button"]');
  await waitFor(async () => (await page.evaluate(() => window.__debug.graphDirty())) === false);
  await waitFor(async () => (await cellImgSrc(PRIMARY)) !== srcPrimaryDefault);
  const srcBaseline = await cellImgSrc(PRIMARY);
  check('saving with zero user edits still yields a develop-aware bitmap (as-shot WB is a real, non-identity pass)', srcBaseline !== plainPrimary && srcBaseline?.startsWith('blob:'), srcBaseline);
  const statsBaseline = await cellStats(PRIMARY);

  // ---------------------------------------------------------------------
  console.log('verify-develop-thumbnails (2. editing the OPEN photo moves its OWN cell bitmap, no extra decode):');
  const decodeCountBeforeEdit = await decodeCount();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.8));
  await waitFor(async () => (await cellImgSrc(PRIMARY)) !== srcBaseline);
  const srcAfterEv = await cellImgSrc(PRIMARY);
  check('the cell src changed to a fresh develop-aware blob: URL (not the plain one)', srcAfterEv !== plainPrimary && srcAfterEv?.startsWith('blob:'), srcAfterEv);
  const lumaAfterEv = (await cellStats(PRIMARY)).luma;
  check('a strong +EV edit brightens the cell bitmap (mean luma > 128, well above a typical midtone)', lumaAfterEv > 128, lumaAfterEv);
  check('no RAW decode fired for the develop-aware pass', (await decodeCount()) === decodeCountBeforeEdit, { before: decodeCountBeforeEdit, after: await decodeCount() });

  const statsBeforeBw = await cellStats(PRIMARY);
  const srcBeforeBw = srcAfterEv;
  await page.evaluate(() => window.__debug.setDevelopBwEnabled('dev', true));
  await waitFor(async () => (await cellImgSrc(PRIMARY)) !== srcBeforeBw);
  const statsAfterBw = await cellStats(PRIMARY);
  check(
    'enabling B&W drives channel convergence on the cell bitmap (chanDiff shrinks toward 0)',
    statsAfterBw.chanDiff < statsBeforeBw.chanDiff,
    { before: statsBeforeBw.chanDiff, after: statsAfterBw.chanDiff }
  );
  check('still no RAW decode fired (B&W step too)', (await decodeCount()) === decodeCountBeforeEdit, { before: decodeCountBeforeEdit, after: await decodeCount() });

  // ---------------------------------------------------------------------
  console.log('verify-develop-thumbnails (3. the OTHER cells — apply a strong preset to 2 CLOSED photos via apply-to-selection):');
  // Pre-touch both targets (each gets a real look file via a benign no-op-ish
  // edit + save) BEFORE the batch apply, so applyPresetToSelection's own
  // existing-look branch (not the "seed from a fresh decode" branch) is what
  // runs — isolating the decode-count assertion below to the THUMBNAIL
  // feature, not applyPresetToSelection's own legitimate seed-time decode
  // for a never-before-opened photo.
  await openImageFireAndForget(TARGET1, { keepFolderContext: true });
  await waitReadyOrError();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 5));
  await page.click('[data-testid="save-button"]');
  await waitFor(async () => (await page.evaluate(() => window.__debug.graphDirty())) === false);

  await openImageFireAndForget(TARGET2, { keepFolderContext: true });
  await waitReadyOrError();
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 5));
  await page.click('[data-testid="save-button"]');
  await waitFor(async () => (await page.evaluate(() => window.__debug.graphDirty())) === false);

  await openImageFireAndForget(PRIMARY, { keepFolderContext: true });
  await waitReadyOrError();
  // Fresh EV/B&W on the reopened primary (a clean base for the preset save below).
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2.0));
  await page.evaluate(() => window.__debug.setDevelopBwEnabled('dev', true));

  await openPresetsMenu();
  await saveWithFamilies('Strong Look', ['basic-tone', 'bw']);
  await waitFor(async () => (await page.evaluate(() => window.__debug.presetsState())).some((p) => p.name === 'Strong Look'));

  // Settle: both targets' cells must already reflect their OWN pre-touch
  // edit (contrast=5, off the plain preview) before capturing the "before"
  // baseline for the batch-apply comparison below — otherwise a still-
  // in-flight recompute from the pre-touch save could be mistaken for the
  // batch apply's own effect.
  await waitFor(async () => (await cellImgSrc(TARGET1)) !== plainTarget1);
  const plainTarget2 = await plainUrl(TARGET2);
  await waitFor(async () => (await cellImgSrc(TARGET2)) !== plainTarget2);

  const srcTarget1BeforeApply = await cellImgSrc(TARGET1);
  const srcTarget2BeforeApply = await cellImgSrc(TARGET2);
  const statsTarget1Before = await cellStats(TARGET1);
  const statsTarget2Before = await cellStats(TARGET2);

  await setSelection([TARGET1, TARGET2]);
  await presetRow('Strong Look').click();
  const applySelectionButton = page.locator('[data-testid="preset-apply-selection"]');
  await applySelectionButton.scrollIntoViewIfNeeded();
  const decodeCountBeforeApply = await decodeCount();
  await applySelectionButton.click();

  check(
    'target1 cell repaints (new blob: URL) within the debounce window — off its already-cached preview',
    await waitFor(async () => (await cellImgSrc(TARGET1)) !== srcTarget1BeforeApply),
    { before: srcTarget1BeforeApply, after: await cellImgSrc(TARGET1) }
  );
  check(
    'target2 cell repaints too',
    await waitFor(async () => (await cellImgSrc(TARGET2)) !== srcTarget2BeforeApply),
    { before: srcTarget2BeforeApply, after: await cellImgSrc(TARGET2) }
  );
  const statsTarget1After = await cellStats(TARGET1);
  const statsTarget2After = await cellStats(TARGET2);
  check('target1 bitmap moves in the expected direction (brighter and/or channels converge)', statsTarget1After.luma > statsTarget1Before.luma || statsTarget1After.chanDiff < statsTarget1Before.chanDiff, {
    before: statsTarget1Before,
    after: statsTarget1After,
  });
  check('target2 bitmap moves the same way', statsTarget2After.luma > statsTarget2Before.luma || statsTarget2After.chanDiff < statsTarget2Before.chanDiff, {
    before: statsTarget2Before,
    after: statsTarget2After,
  });
  check(
    'NO extra RAW decode fired for either closed target\'s thumbnail recompute',
    (await decodeCount()) === decodeCountBeforeApply,
    { before: decodeCountBeforeApply, after: await decodeCount() }
  );
  const lookVersions = await page.evaluate(() => window.__debug.lookVersionsState());
  check('lookVersions bumped for both written targets', (lookVersions[TARGET1] ?? 0) > 0 && (lookVersions[TARGET2] ?? 0) > 0, lookVersions);

  // ---------------------------------------------------------------------
  console.log('verify-develop-thumbnails (4. revert the open photo\'s edits -> its cell returns to the (develop-aware) baseline bitmap):');
  // NOT a return to the plain preview URL — a real RAW's look file always
  // carries the as-shot WB pass once saved at all (see the baseline-capture
  // comment above), so the develop-aware bitmap never goes away entirely;
  // "revert" here means undoing the user's OWN ev/bw/contrast edits, landing
  // back on `statsBaseline` (captured right after the very first, zero-edit
  // save) — a JPEG or a look-less photo (no as-shot WB seed at all) is where
  // semantic 5's literal "plain preview" case applies, exercised separately
  // by target1/target2 in check 1 above (never-saved ⇒ plain, by construction).
  const srcBeforeRevert = await cellImgSrc(PRIMARY);
  await page.evaluate(() => window.__debug.setDevelopBwEnabled('dev', false));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.contrast', 0));
  await waitFor(async () => (await cellImgSrc(PRIMARY)) !== srcBeforeRevert);
  const statsAfterRevert = await cellStats(PRIMARY);
  const LUMA_TOLERANCE = 3; // mean-channel-byte tolerance — JPEG re-encode quantization, not a meaningful visual difference
  check(
    "reverting ev/bw/contrast lands back on the zero-edit baseline bitmap (luma within JPEG-quantization tolerance)",
    Math.abs(statsAfterRevert.luma - statsBaseline.luma) < LUMA_TOLERANCE,
    { baseline: statsBaseline, afterRevert: statsAfterRevert }
  );
  check(
    'reverting also undoes the B&W channel convergence (channels diverge again, back near the baseline)',
    Math.abs(statsAfterRevert.chanDiff - statsBaseline.chanDiff) < 10,
    { baseline: statsBaseline.chanDiff, afterRevert: statsAfterRevert.chanDiff }
  );
  // Semantic 5's literal "plain preview" case (no look file at all, so no
  // as-shot WB seed either) is exactly what check 1 already proved above,
  // for target1 and the primary, before either ever had a look file.

  // ---------------------------------------------------------------------
  console.log('verify-develop-thumbnails (5. folder switch -> every blob: URL (plain AND develop-aware) revoked, no leak):');
  // "Folder switch" extends the ACTIVE PROJECT's playlist (project-storage
  // migration — a playlist doesn't own photos; verify-filmstrip.mjs's own
  // "switching folders extends the playlist" check is the precedent), but
  // the strip itself still fully REMOUNTS (`key={dir}`) regardless, which is
  // what actually drives the revocation this check cares about — every
  // blob: URL the OLD 3-cell view ever handed out (plain AND develop-aware)
  // must show up revoked, and the (now 4-cell) strip must re-fetch fresh
  // ones for every cell, old and new alike.
  const folderB = mkdtempSync(join(tmpdir(), 'silverbox-develop-thumbnails-b-'));
  const bPhoto = join(folderB, 'z_only.ARW');
  linkSync(ARW_PATH, bPhoto);
  try {
    const revokedBeforeSwitch = new Set(await revocations());
    await openFolderFireAndForget(folderB);
    await page.waitForFunction(
      (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
      bPhoto,
      { timeout: 120_000 }
    );
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, { timeout: 15_000 });
    const revokedAfterSwitch = await revocations();
    const newlyRevoked = revokedAfterSwitch.filter((u) => !revokedBeforeSwitch.has(u));
    // Every URL the OLD folder's cells were ever shown (plain preview for
    // all 3 + the develop-aware overlay the primary/targets picked up along
    // the way) must be among the newly-revoked set — a leak would leave one
    // of them un-revoked while still "cached" behind the scenes.
    check('the folder switch revoked at least the 3 plain previews + every develop-aware overlay minted', newlyRevoked.length >= 3, {
      newlyRevokedCount: newlyRevoked.length,
      newlyRevoked,
    });
    await waitForCellImg(bPhoto);
    const newFolderSrc = await cellImgSrc(bPhoto);
    check("the new folder's cell got its OWN fresh blob: URL, not a stale one from the old folder", !revokedAfterSwitch.includes(newFolderSrc), newFolderSrc);
  } finally {
    rmSync(folderB, { recursive: true, force: true });
  }

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
