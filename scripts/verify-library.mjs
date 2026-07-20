/**
 * The visible library verify (docs/brief-bank/linked-looks-stage-e.md):
 * `~/Silverbox/Library/` — a real, visible, git/sync-able folder holding
 * every develop preset AND shared-look TEMPLATE (one file format, one
 * folder — semantic 7), reachable via `settings.libraryDir`.
 *
 * Checks (the brief's own numbered list):
 *  1. Fresh userData with 2 seeded legacy presets + a fresh libraryDir (tmp
 *     override via settings pre-seed) -> launch -> both files COPIED into
 *     the library, originals intact; the presets list shows them once each
 *     (union, no duplicates).
 *  2. Save a new preset via the UI (`window.__debug.savePreset`, same
 *     shortcut verify-virtualcopy.mjs already uses) -> the file lands in
 *     the library, NOT the legacy `<userData>/presets` dir.
 *  3. Vendor a library look into the active project (real
 *     "プロジェクトに取り込む" button click) -> `shared-looks/` gains the
 *     file; SharedLookMenu (`sharedLooksState()`) lists it.
 *  4. Publish a project shared look to the library (real "ライブラリに反映"
 *     button click) -> the library file is created/updated with the
 *     project's current content.
 *  5. Drop a valid preset file directly into the library dir (a plain fs
 *     write, no app involvement) -> the list refreshes without a restart
 *     (the library's own dir-watch, armed once at boot).
 *  6. CLI: `--preset <library-slug>` resolves from the library; a
 *     legacy-only slug (written to the legacy dir AFTER migration already
 *     ran, so it was never copied) still resolves from `<userData>/presets`.
 *
 * Isolation: this script always mints its OWN userData + library dirs
 * (never reuses run-verify.mjs's pool assignment — same posture as
 * verify-project3.mjs's own quick-project-root checks) because check 1
 * needs precise control over BOTH dirs' exact contents BEFORE the very
 * first launch, which a shared/reused dir can't guarantee. The native
 * "ライブラリに取り込む…" file-picker (semantic 6's OTHER half) is not driven
 * here — this suite never drives a native OS dialog (see verify-dcp.mjs and
 * friends); its read+write plumbing is the same presetRead/presetWrite path
 * exercised by checks 2-4 already.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

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
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

async function waitForCondition(fn, timeoutMs = 10_000, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const nowIso = () => new Date().toISOString();

/** The default input->Develop->output chain (schemaVersion-4 wire shape — same recipe verify-cli.mjs's own simpleLook uses). */
function simpleLook() {
  return {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 } },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
}

/** A preset FILE: presetDoc.ts's wire shape — `look` embeds a whole schemaVersion-4 wrapper. */
function writePresetFile(path, name) {
  const { nodes, edges } = simpleLook();
  const wrapper = {
    presetVersion: 1,
    name,
    createdAt: nowIso(),
    look: { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph: { nodes, edges } },
  };
  writeFileSync(path, JSON.stringify(wrapper, null, 2) + '\n');
  return wrapper;
}

// --- isolation: this script always owns its userData + library dirs -------
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-library-work-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'silverbox-library-userdata-'));
const libraryDir = mkdtempSync(join(tmpdir(), 'silverbox-library-lib-'));
const legacyPresetsDir = join(userDataDir, 'presets');
mkdirSync(legacyPresetsDir, { recursive: true });

// Seed 2 legacy presets BEFORE the very first launch — migration (semantic
// 2) must copy both into the fresh library on this first boot.
writePresetFile(join(legacyPresetsDir, 'legacy-one.json'), 'Legacy One');
writePresetFile(join(legacyPresetsDir, 'legacy-two.json'), 'Legacy Two');

// Pre-seed settings.json with the isolated libraryDir — the "quickProjectDir
// test pattern" (verify-project3.mjs's own writeSettingsJson): without this,
// main resolves libraryDir from os.homedir() and would touch THIS MACHINE'S
// real ~/Silverbox/Library the moment the app boots.
writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ settingsVersion: 1, libraryDir }, null, 2) + '\n', 'utf8');

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const realUserData = await app.evaluate(({ app }) => app.getPath('userData'));
  check(
    'Electron actually honored SILVERBOX_USER_DATA (isolated from the real userData)',
    basename(realUserData) === basename(userDataDir),
    { realUserData, userDataDir }
  );

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };
  const presetsState = () => page.evaluate(() => window.__debug.presetsState());
  const sharedLooksState = () => page.evaluate(() => window.__debug.sharedLooksState());

  // -------------------------------------------------------------------
  console.log(
    'verify-library (1. migration: 2 legacy presets COPIED into a fresh library, originals intact, presets list shows each once):'
  );
  await waitForCondition(async () => (await presetsState()).length >= 2);

  check('the library gained legacy-one.json', existsSync(join(libraryDir, 'legacy-one.json')), libraryDir);
  check('the library gained legacy-two.json', existsSync(join(libraryDir, 'legacy-two.json')), libraryDir);
  check('the migration marker was written', existsSync(join(libraryDir, '.migrated-presets')), libraryDir);
  check(
    'the legacy originals are untouched (never deleted)',
    existsSync(join(legacyPresetsDir, 'legacy-one.json')) && existsSync(join(legacyPresetsDir, 'legacy-two.json')),
    legacyPresetsDir
  );
  const listAfterMigration = await presetsState();
  check(
    'the presets list shows each exactly once (union, no duplicates)',
    listAfterMigration.filter((p) => p.name === 'Legacy One').length === 1 &&
      listAfterMigration.filter((p) => p.name === 'Legacy Two').length === 1,
    listAfterMigration
  );

  // -------------------------------------------------------------------
  console.log('verify-library (2. Save a new preset -> lands in the library, NOT the legacy userData dir):');
  await openAndWait(ARW_PATH);
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: false }));
  await page.evaluate(() => window.__debug.savePreset('Fresh Save Test', ['basic-tone']));
  await waitForCondition(async () => (await presetsState()).some((p) => p.name === 'Fresh Save Test'));

  check('the new preset file landed in the library', existsSync(join(libraryDir, 'Fresh-Save-Test.json')), libraryDir);
  check(
    'it was NOT written into the legacy userData presets dir',
    !existsSync(join(legacyPresetsDir, 'Fresh-Save-Test.json')),
    legacyPresetsDir
  );

  // -------------------------------------------------------------------
  console.log('verify-library (3. Vendor a library look into the active project -> shared-looks/ gains it, SharedLookMenu lists it):');
  const projectDirActive = (await page.evaluate(() => window.__debug.projectState())).dir;
  check('an active project exists (needed for vendor-in)', !!projectDirActive, projectDirActive);

  const openPresetsMenu = async () => {
    if ((await page.locator('[data-testid="presets-menu"]').count()) === 0) {
      await page.locator('[data-testid="presets-button"]').click();
      await page.waitForSelector('[data-testid="presets-menu"]', { timeout: 5_000 });
    }
  };
  const presetRow = (name) => page.locator('[data-testid="preset-row"]').filter({ hasText: name });

  await openPresetsMenu();
  const legacyOneRow = presetRow('Legacy One');
  await legacyOneRow.scrollIntoViewIfNeeded();
  await legacyOneRow.click();
  await page.locator('[data-testid="preset-vendor-in"]').click();
  await waitForCondition(async () => (await sharedLooksState()).some((p) => p.name === 'Legacy One'));

  const vendoredPath = join(projectDirActive, 'shared-looks', 'legacy-one.json');
  check('shared-looks/ gained the vendored file (same slug as the library row)', existsSync(vendoredPath), vendoredPath);
  const sharedLooksAfterVendor = await sharedLooksState();
  check('SharedLookMenu (sharedLooksState) lists the vendored look', sharedLooksAfterVendor.some((p) => p.name === 'Legacy One'), sharedLooksAfterVendor);

  // PresetsMenu's own full-screen backdrop (z-index 20) would otherwise
  // intercept the click on SharedLookMenu's toolbar button below — close it
  // via its own click-away backdrop first (verify-presets.mjs's
  // closePresetsMenu precedent).
  if ((await page.locator('[data-testid="presets-menu"]').count()) > 0) {
    await page.locator('.add-node-menu-backdrop').click();
    await page.waitForSelector('[data-testid="presets-menu"]', { state: 'detached', timeout: 5_000 });
  }

  // -------------------------------------------------------------------
  console.log('verify-library (4. Publish a project shared look to the library -> library file created/updated):');
  // Simulate an edit to the project's own copy (a distinguishable marker,
  // not a real develop change — this check is about which BYTES land where,
  // not develop semantics) and confirm publishing overwrites the template.
  const vendoredOnDisk = JSON.parse(readFileSync(vendoredPath, 'utf8'));
  writeFileSync(vendoredPath, JSON.stringify({ ...vendoredOnDisk, publishMarker: 'stage-e-check-4' }, null, 2) + '\n');

  const openSharedLookMenu = async () => {
    if ((await page.locator('[data-testid="shared-look-menu"]').count()) === 0) {
      await page.locator('[data-testid="shared-look-button"]').click();
      await page.waitForSelector('[data-testid="shared-look-menu"]', { timeout: 5_000 });
    }
  };
  const sharedLookRow = (name) => page.locator('[data-testid="shared-look-row"]').filter({ hasText: name });

  await openSharedLookMenu();
  const legacyOneSharedRow = sharedLookRow('Legacy One');
  await legacyOneSharedRow.scrollIntoViewIfNeeded();
  await legacyOneSharedRow.click();
  await page.locator('[data-testid="shared-look-publish-to-library"]').click();
  await waitForCondition(() => {
    if (!existsSync(join(libraryDir, 'legacy-one.json'))) return false;
    const onDisk = JSON.parse(readFileSync(join(libraryDir, 'legacy-one.json'), 'utf8'));
    return onDisk.publishMarker === 'stage-e-check-4';
  });
  const libraryAfterPublish = JSON.parse(readFileSync(join(libraryDir, 'legacy-one.json'), 'utf8'));
  check(
    'the library file now carries the published marker (template overwritten, same slug)',
    libraryAfterPublish.publishMarker === 'stage-e-check-4',
    libraryAfterPublish
  );

  // -------------------------------------------------------------------
  console.log('verify-library (5. drop a valid preset file directly into the library dir -> list refreshes without a restart):');
  writePresetFile(join(libraryDir, 'dropped-in.json'), 'Dropped In');
  const refreshed = await waitForCondition(async () => (await presetsState()).some((p) => p.name === 'Dropped In'), 8_000);
  check('the externally-dropped file appears in the list without a restart (fs.watch)', refreshed, await presetsState());

  check('no page errors across the library checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

// ---------------------------------------------------------------------
// 6. CLI: --preset <library-slug> resolves from the library; a legacy-only
// slug (written AFTER migration already ran, so never copied) still
// resolves from <userData>/presets — the SAME dual-location presetsList()/
// presetRead() the GUI just exercised above, reached via the headless CLI's
// readCliPresetText (appStore.ts) instead.
// ---------------------------------------------------------------------
console.log('verify-library (6. CLI: --preset resolves from the library, and from the legacy dir for a legacy-only slug):');
writePresetFile(join(legacyPresetsDir, 'legacy-only-cli.json'), 'Legacy Only CLI');

const cliArw = join(workDir, 'cli.ARW');
linkSync(ARW_PATH, cliArw);
const outLibrary = join(workDir, 'out-library');
const outLegacy = join(workDir, 'out-legacy');
mkdirSync(outLibrary, { recursive: true });
mkdirSync(outLegacy, { recursive: true });

const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');
function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const r1 = runCli(['--preset', 'Fresh Save Test', '--out', outLibrary, cliArw]);
check('CLI resolves a library-only preset by name (exit 0)', r1.status === 0, { status: r1.status, stdout: r1.stdout, stderr: r1.stderr });
check('CLI wrote an output for the library-resolved preset', existsSync(join(outLibrary, 'cli.jpg')), join(outLibrary, 'cli.jpg'));

const r2 = runCli(['--preset', 'Legacy Only CLI', '--out', outLegacy, cliArw]);
check('CLI resolves a legacy-only preset by name (dual-location fallback, exit 0)', r2.status === 0, {
  status: r2.status,
  stdout: r2.stdout,
  stderr: r2.stderr,
});
check('CLI wrote an output for the legacy-resolved preset', existsSync(join(outLegacy, 'cli.jpg')), join(outLegacy, 'cli.jpg'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
