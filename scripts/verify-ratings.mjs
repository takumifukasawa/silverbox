/**
 * Sidecar-resident ratings verify (docs/brief-bank/compare-view-and-ratings.md,
 * "Ratings" half). `rating: 0..5` lives on the sidecar WRAPPER (metadata about
 * the PHOTO, next to `createdAt`) — not inside `graph` — so setting it never
 * pushes a develop-history entry, unlike every other edit in this app. It
 * still marks the doc dirty (autosave persists it, same debounce as any other
 * edit) and flows through hot-reload/the filmstrip/the headless CLI exactly
 * like the rest of the sidecar wrapper does.
 *
 * Checks:
 *  1. A fresh open (no sidecar) is unrated (0), toolbar shows it.
 *  2. Keys 1-5 set / 0 clears the rating; the toolbar reflects it; it marks
 *     graphDirty but pushes NO history entry (deliberate divergence from
 *     every other graph mutation — see appStore.ts's setRating).
 *  3. isTextEntry guards it: a focused text input swallows the digit.
 *  4. Autosave writes it to disk (polling the FILE/its parsed content, never
 *     `graphDirty === false` alone — see verify-filmstrip.mjs's own fix for
 *     why that specific race exists); it survives a fresh reopen of the same
 *     image. An explicit ⌘S also persists a rating-only change.
 *  5. Hot-reload: an external sidecar edit that changes ONLY `rating` still
 *     auto-reloads on a clean session (one history entry — the whole-graph
 *     swap every hot-reload does, not something special to ratings).
 *  6. Filmstrip: listImages' cheap per-file rating read shows up as a tiny
 *     star glyph per cell (absent for an unrated file), and the local ★n+
 *     filter narrows the visible cells.
 *  7. Headless CLI `--min-rating n`: skips inputs whose sidecar rating is
 *     absent or below n as `{input,status:"skipped-rating"}`, NEVER as a
 *     failure (exit 0 with only skips; a skip alongside a real failure still
 *     exits 1); rejected together with `--check`; rejected out of 0-5 range.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor, resetTestProject, writeLookFixture } from './lib/testProject.mjs';

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

// === Fixtures: one hardlink for the app-driven checks (sections 1-5) ===
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-ratings-'));
const arwMain = join(workDir, 'rating-main.ARW');
linkSync(ARW_PATH, arwMain);
// project-storage migration: an interactive open's rating lives in the
// active test project's looks/, not next to the photo — see
// scripts/lib/testProject.mjs's doc comment for the no-collision assumption
// this basename-keyed path relies on (arwMain's basename is unique here).
const sidecarMain = lookPathFor(arwMain);

/** Atomic external rewrite (verify-hotreload.mjs's own atomicWrite pattern) — simulates an AI/editor touching the sidecar out from under the running app. */
function atomicWrite(path, content) {
  const tmp = `${path}.ext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function externalWriteRating(rating) {
  const doc = JSON.parse(readFileSync(sidecarMain, 'utf8'));
  if (rating > 0) doc.rating = rating;
  else delete doc.rating;
  atomicWrite(sidecarMain, JSON.stringify(doc, null, 2) + '\n');
}

function readDiskRating() {
  if (!existsSync(sidecarMain)) return 0;
  try {
    const doc = JSON.parse(readFileSync(sidecarMain, 'utf8'));
    return typeof doc.rating === 'number' ? doc.rating : 0;
  } catch {
    return 0;
  }
}

/**
 * Poll the FILE's own parsed content, never `graphDirty === false` alone: a
 * fresh/already-clean doc's graphDirty is ALREADY false before any write
 * happens, so waiting on that flag races the async sidecar write (see
 * verify-filmstrip.mjs's own fix for this exact class of bug). Polling what
 * autosave actually produces on disk has no such race.
 */
async function waitForDiskRating(expected, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readDiskRating() === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** schemaVersion-4 wire wrapper carrying a `rating` — the exact shape serializeGraphDoc writes (graphDoc.ts). */
function ratingWrapper(rating) {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(rating > 0 ? { rating } : {}),
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 } },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  };
}

/**
 * CLI fixture (section 7 ONLY): the headless `--render --min-rating` CLI
 * still reads the LEGACY adjacent sidecar (`legacySidecarOnly` in
 * appStore.ts's openImageByPath — project-aware CLI resolution is a stage-2
 * item, docs/brief-bank/project-storage.md), so this fixture must STAY next
 * to the image, unlike every interactive-open fixture in this file.
 */
function writeRatingSidecar(path, rating) {
  writeFileSync(path + '.silverbox.json', JSON.stringify(ratingWrapper(rating), null, 2) + '\n');
}

/** Interactive-open fixture (section 6, the filmstrip/folder test): lands in the active project's looks/, matching what a real folder-open + look read actually does. */
function writeRatingLook(path, rating) {
  writeLookFixture(path, ratingWrapper(rating));
}

function cleanupMain() {
  if (existsSync(sidecarMain)) unlinkSync(sidecarMain);
  rmSync(workDir, { recursive: true, force: true });
}

const app = await electron.launch({ args: [projectRoot] });
let folderDir = null;
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
  const openImageFireAndForget = (path) =>
    page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);

  const rating = () => page.evaluate(() => window.__debug.sidecarState().rating);
  const dirty = () => page.evaluate(() => window.__debug.graphDirty());
  const historyState = () => page.evaluate(() => window.__debug.historyState());
  const hotReload = () => page.evaluate(() => window.__debug.hotReloadState());
  const toolbarRatingAttr = () => page.$eval('[data-testid="toolbar-rating"]', (el) => el.getAttribute('data-rating'));
  const toolbarFilledStars = () =>
    page.$$eval('[data-testid="toolbar-rating"] .star--filled', (els) => els.length);

  await openImageFireAndForget(arwMain);
  await waitReadyOrError();
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  // === 1. Fresh open is unrated ===
  console.log('verify-ratings (1. a fresh open — no sidecar — is unrated):');
  check('fresh open has rating 0', (await rating()) === 0, await rating());
  check('toolbar shows data-rating="0"', (await toolbarRatingAttr()) === '0', await toolbarRatingAttr());
  check('toolbar shows 0 filled stars', (await toolbarFilledStars()) === 0, await toolbarFilledStars());

  // === 2. Keys 1-5 set / 0 clears; marks dirty; NOT a history entry ===
  console.log('verify-ratings (2. keys 1-5/0 set/clear the rating; marks the doc dirty; pushes no history entry):');
  const histBefore = await historyState();
  await page.keyboard.press('4');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 4, { timeout: 5_000 });
  check('pressing 4 sets rating to 4', (await rating()) === 4, await rating());
  check('toolbar reflects 4 (data-rating + filled-star count)', (await toolbarRatingAttr()) === '4' && (await toolbarFilledStars()) === 4, {
    attr: await toolbarRatingAttr(),
    filled: await toolbarFilledStars(),
  });
  check('rating edit marks graphDirty', (await dirty()) === true, await dirty());

  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 2, { timeout: 5_000 });
  check('pressing 2 changes rating to 2', (await rating()) === 2, await rating());

  await page.keyboard.press('0');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 0, { timeout: 5_000 });
  check('pressing 0 clears the rating', (await rating()) === 0, await rating());

  await page.keyboard.press('9'); // outside 0-5 — not bound to anything
  await page.waitForTimeout(200);
  check('digit 9 (outside the 0-5 range) is not bound — rating unchanged', (await rating()) === 0, await rating());

  const histAfterRatingEdits = await historyState();
  check(
    'none of the rating edits above pushed a history entry',
    histAfterRatingEdits.past === histBefore.past && histAfterRatingEdits.future === histBefore.future,
    { histBefore, histAfterRatingEdits }
  );

  // === 2b. Clicking the toolbar stars (round-9 fix pack item 3 — RatingStars
  // was display-only, a visible-path violation per DESIGN.md) ===
  console.log('verify-ratings (2b. clicking a toolbar star sets the rating; clicking it again clears to 0):');
  const histBeforeStarClick = await historyState();
  await page.locator('[data-testid="toolbar-star-3"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 3, { timeout: 5_000 });
  check('clicking star 3 sets rating to 3', (await rating()) === 3, await rating());
  check('toolbar reflects 3 after the click', (await toolbarRatingAttr()) === '3' && (await toolbarFilledStars()) === 3, {
    attr: await toolbarRatingAttr(),
    filled: await toolbarFilledStars(),
  });
  await page.locator('[data-testid="toolbar-star-3"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 0, { timeout: 5_000 });
  check('clicking star 3 again (== current rating) clears it to 0 (LR-style toggle)', (await rating()) === 0, await rating());
  const histAfterStarClick = await historyState();
  check(
    'star clicks push no history entry either (same metadata-not-a-look-edit semantics as the 1-5/0 keys)',
    histAfterStarClick.past === histBeforeStarClick.past && histAfterStarClick.future === histBeforeStarClick.future,
    { histBeforeStarClick, histAfterStarClick }
  );

  // set to 3 for the next sections (via a star click — keeps both input paths exercised across the file)
  await page.locator('[data-testid="toolbar-star-3"]').click();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 3, { timeout: 5_000 });

  // === 3. isTextEntry guard ===
  console.log('verify-ratings (3. digit keys are ignored while a text input is focused):');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-testid', 'ratings-verify-text-probe');
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press('5');
  await page.waitForTimeout(300);
  check('rating unaffected while a text input is focused', (await rating()) === 3, await rating());
  await page.evaluate(() => document.querySelector('[data-testid="ratings-verify-text-probe"]')?.remove());

  // === 4. Autosave persists it; survives reopen; explicit ⌘S also persists it ===
  console.log('verify-ratings (4. autosave writes the rating to disk; survives a fresh reopen; ⌘S also persists it):');
  check('autosave eventually writes rating 3 to disk', await waitForDiskRating(3, 10_000), readDiskRating());

  await openImageFireAndForget(arwMain);
  await waitReadyOrError();
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 3, { timeout: 10_000 });
  check('rating survives a fresh reopen (restored from the sidecar)', (await rating()) === 3, await rating());

  await page.keyboard.press('1');
  await page.waitForFunction(() => window.__debug.sidecarState().rating === 1, { timeout: 5_000 });
  check('graphDirty true right after a rating-only edit', (await dirty()) === true, await dirty());
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('rating 1 is on disk right after an explicit ⌘S', readDiskRating() === 1, readDiskRating());

  // === 5. Hot-reload: an external rating-only edit auto-reloads on a clean session ===
  console.log('verify-ratings (5. hot-reload: an external rating-only edit auto-reloads on a clean session):');
  check('session is clean before the external edit', (await dirty()) === false, await dirty());
  const histBeforeHotReload = await historyState();
  externalWriteRating(5);
  await page.waitForFunction(() => window.__debug.hotReloadState()?.kind === 'reloaded', { timeout: 5_000 });
  check('rating updates from the external, rating-only edit', (await rating()) === 5, await rating());
  const histAfterHotReload = await historyState();
  check(
    'the hot-reload itself is still exactly ONE history entry (the whole-graph swap every hot-reload does — not special to ratings)',
    histAfterHotReload.past === histBeforeHotReload.past + 1,
    { histBeforeHotReload, histAfterHotReload }
  );

  check('no page errors across the app-driven sections', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

cleanupMain();

// === 6. Filmstrip: tiny stars per cell + the local ★n+ filter ===
//
// Project-storage migration: the playlist now ACCUMULATES across opens
// within one session (folder-open EXTENDS it, it doesn't replace it) —
// unlike the old per-folder folderEntries, arwMain's entry from sections
// 1-5 above would still be sitting in the SAME project's playlist here,
// throwing off every exact-cell-count assertion below. Fresh app + a
// resetTestProject() wipe (looks/ + the manifest) gives this section its
// own clean playlist, exactly like "a folder just opened" should look.
console.log('verify-ratings (6. filmstrip: per-cell rating stars + the ★n+ filter):');
resetTestProject();
folderDir = mkdtempSync(join(tmpdir(), 'silverbox-ratings-folder-'));
const cellUnrated = join(folderDir, 'a_unrated.ARW'); // no look at all
const cellTwo = join(folderDir, 'b_two.ARW');
const cellFour = join(folderDir, 'c_four.ARW');
const cellFive = join(folderDir, 'd_five.ARW');
linkSync(ARW_PATH, cellUnrated);
linkSync(ARW_PATH, cellTwo);
linkSync(ARW_PATH, cellFour);
linkSync(ARW_PATH, cellFive);
writeRatingLook(cellTwo, 2);
writeRatingLook(cellFour, 4);
writeRatingLook(cellFive, 5);

const folderApp = await electron.launch({ args: [projectRoot] });
try {
  const page = await folderApp.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  const openFolderFireAndForget = (dir) =>
    page.evaluate((d) => {
      void window.__openFolderByPath(d);
    }, dir);

  await openFolderFireAndForget(folderDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    cellUnrated,
    { timeout: 120_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, {
    timeout: 15_000,
  });

  const folderRatings = await page.evaluate(() =>
    window.__debug.folderState().entries.map((e) => ({ path: e.path, rating: e.rating }))
  );
  check(
    "the project's per-photo look read reports the right rating for each entry (unrated = 0)",
    folderRatings.find((e) => e.path === cellUnrated)?.rating === 0 &&
      folderRatings.find((e) => e.path === cellTwo)?.rating === 2 &&
      folderRatings.find((e) => e.path === cellFour)?.rating === 4 &&
      folderRatings.find((e) => e.path === cellFive)?.rating === 5,
    folderRatings
  );

  const cellDom = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="filmstrip-cell"]')].map((c) => {
      const el = c.querySelector('[data-testid="filmstrip-rating"]');
      return { path: c.dataset.path, rating: el ? Number(el.dataset.rating) : 0, stars: el?.textContent ?? '' };
    })
  );
  check('the unrated cell shows no star glyph at all', cellDom.find((c) => c.path === cellUnrated)?.stars === '', cellDom);
  check(
    "each rated cell's tiny stars match its rating (glyph count == rating)",
    cellDom.find((c) => c.path === cellTwo)?.stars === '★★' &&
      cellDom.find((c) => c.path === cellFour)?.stars === '★★★★' &&
      cellDom.find((c) => c.path === cellFive)?.stars === '★★★★★',
    cellDom
  );

  const filterSelect = page.locator('[data-testid="filmstrip-rating-filter"]');
  await filterSelect.selectOption('3');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 2, {
    timeout: 5_000,
  });
  const filtered3 = (await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path))).sort();
  check(
    '★3+ filter narrows the strip to the 4- and 5-star cells only',
    JSON.stringify(filtered3) === JSON.stringify([cellFive, cellFour].sort()),
    filtered3
  );

  await filterSelect.selectOption('5');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 1, {
    timeout: 5_000,
  });
  const filtered5 = await page.$$eval('[data-testid="filmstrip-cell"]', (els) => els.map((e) => e.dataset.path));
  check('★5+ filter narrows the strip to the 5-star cell only', JSON.stringify(filtered5) === JSON.stringify([cellFive]), filtered5);

  await filterSelect.selectOption('0');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="filmstrip-cell"]').length === 4, {
    timeout: 5_000,
  });
  check('back to "All" shows every cell again', true, null);
} finally {
  await folderApp.close();
}

if (folderDir) rmSync(folderDir, { recursive: true, force: true });
resetTestProject();

// === 7. Headless CLI --min-rating: skips low/absent ratings, never as a failure ===
console.log('verify-ratings (7. CLI --min-rating skips low/absent-rated inputs without failing the batch):');
const cliWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-ratings-cli-'));
const cliOutDir = join(cliWorkDir, 'out');
mkdirSync(cliOutDir, { recursive: true });
const ownCliUserData = !process.env.SILVERBOX_USER_DATA;
const cliUserData = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-ratings-cli-userdata-'));
const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

function cliLink(name) {
  const dst = join(cliWorkDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}

function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: cliUserData },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function expectedOutPath(inputPath, dir) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, '');
  return join(dir, `${stem}.jpg`);
}

try {
  const cliHigh = cliLink('cli-high.ARW'); // rating 4 — meets --min-rating 3
  const cliLow = cliLink('cli-low.ARW'); // rating 1 — below threshold
  const cliNone = cliLink('cli-none.ARW'); // no sidecar at all — treated as 0
  writeRatingSidecar(cliHigh, 4);
  writeRatingSidecar(cliLow, 1);

  const r7 = runCli(['--out', cliOutDir, '--min-rating', '3', '--json', cliHigh, cliLow, cliNone]);
  check('a batch of only skips + one qualifying render exits 0', r7.status === 0, {
    status: r7.status,
    stdout: r7.stdout,
    stderr: r7.stderr,
  });
  check('the >=3-rated image renders', existsSync(expectedOutPath(cliHigh, cliOutDir)), expectedOutPath(cliHigh, cliOutDir));
  check('the <3-rated image is skipped — no output file', !existsSync(expectedOutPath(cliLow, cliOutDir)), expectedOutPath(cliLow, cliOutDir));
  check(
    'the unrated image is skipped too (absent rating == 0 < 3)',
    !existsSync(expectedOutPath(cliNone, cliOutDir)),
    expectedOutPath(cliNone, cliOutDir)
  );

  const jsonLines = r7.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  check('every NDJSON line parses', jsonLines.every((l) => l !== null), r7.stdout);
  const skipLow = jsonLines.find((l) => l?.input === cliLow);
  const skipNone = jsonLines.find((l) => l?.input === cliNone);
  const successHigh = jsonLines.find((l) => l?.input === cliHigh);
  check('NDJSON reports the low-rated input as {status:"skipped-rating"}', skipLow?.status === 'skipped-rating', skipLow);
  check('NDJSON reports the unrated input as {status:"skipped-rating"} too', skipNone?.status === 'skipped-rating', skipNone);
  check(
    'NDJSON reports the qualifying input as a normal render ({output,width,height,bytes,ms})',
    !!successHigh && typeof successHigh.output === 'string' && typeof successHigh.bytes === 'number',
    successHigh
  );

  const r7h = runCli(['--out', cliOutDir, '--min-rating', '3', cliHigh, cliLow]);
  check(
    'human mode prints a SKIPPED line (not an ERROR) for the low-rated input, exit 0',
    r7h.status === 0 && /SKIPPED/.test(r7h.stdout) && !/ERROR/.test(r7h.stdout),
    { status: r7h.status, stdout: r7h.stdout }
  );

  // A rating-only sidecar can exist for a path whose IMAGE file doesn't (the
  // cheap rating read is a bare readSidecar+JSON.parse, independent of the
  // image itself existing) — give this one a HIGH rating so it passes the
  // --min-rating filter and fails for a REAL reason (openImageByPath can't
  // read the missing bytes) rather than being coincidentally skipped too,
  // which would conflate "skip" and "failure" in this check.
  const cliMissing = join(cliWorkDir, 'missing.ARW'); // deliberately never linked
  writeRatingSidecar(cliMissing, 5);
  const r7f = runCli(['--out', cliOutDir, '--min-rating', '3', cliLow, cliMissing]);
  check('a skip alongside a REAL failure still exits 1 (skips alone never do)', r7f.status === 1, {
    status: r7f.status,
    stdout: r7f.stdout,
    stderr: r7f.stderr,
  });

  const rBadRange = runCli(['--out', cliOutDir, '--min-rating', '9', cliHigh]);
  check('--min-rating out of the 0-5 range is bad usage (exit 2)', rBadRange.status === 2, rBadRange);

  const rBadCheck = runCli(['--check', '--min-rating', '3', cliHigh]);
  check('--min-rating is rejected together with --check (exit 2)', rBadCheck.status === 2, rBadCheck);
} finally {
  rmSync(cliWorkDir, { recursive: true, force: true });
  if (ownCliUserData) rmSync(cliUserData, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
