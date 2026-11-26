/**
 * Preset on RAW open verify (docs/decisions/0004):
 *  1. Settings › "Preset on RAW open" writes the test twin, never the real field.
 *  2. A RAW with no look file opens with that preset applied, and opening
 *     alone leaves the doc clean (nothing is written).
 *  3. "Reset all edits" returns to the preset, not to bare neutral.
 *  4. A JPEG opens as before (RAW only).
 *  5. A preset that no longer exists opens neutral, says so once, and the
 *     setting value is kept.
 *  6. The headless CLI (`--render`) follows the same setting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';
import { ensureTestProjectEnv, seedLibraryDir } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
ensureTestProjectEnv();

// Own userData + library unless the pooled runner already assigned one, so
// the presets written below never touch a real library.
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-rawopenpreset-verify-'));
if (!process.env.SILVERBOX_USER_DATA) {
  process.env.SILVERBOX_USER_DATA = userDataDir;
  seedLibraryDir(userDataDir);
}

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

const PRESET_EV = 0.7;
const nowIso = () => new Date().toISOString();
const presetJson = (name, develop) =>
  JSON.stringify({
    presetVersion: 1,
    name,
    createdAt: nowIso(),
    look: {
      schemaVersion: 4,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      graph: {
        nodes: [
          { id: 'in', type: 'input', position: { x: 20, y: 60 } },
          { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop },
          { id: 'out', type: 'output', position: { x: 420, y: 60 } },
        ],
        edges: [
          { id: 'e0', from: 'in', to: 'dev' },
          { id: 'e1', from: 'dev', to: 'out' },
        ],
      },
    },
  });

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  // reopening must always start from "no look file on disk"
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: false }));
  const libraryDir = await page.evaluate(() => window.__debug.settingsState().libraryDir);
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(join(libraryDir, 'bright.json'), presetJson('Bright', { basic: { ev: PRESET_EV } }));

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', null, { timeout: 120_000 });
  };
  const devEv = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.develop)?.develop?.basic?.ev);

  console.log('verify-rawopenpreset (1. setting):');
  await openAndWait(ARW_PATH);
  check('baseline: a fresh RAW opens neutral (EV 0) with no preset set', (await devEv()) === 0, await devEv());
  await page.locator('[data-testid="settings-button"]').first().click();
  const select = page.locator('[data-testid="settings-raw-open-preset"]');
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="settings-raw-open-preset"] option')].some((o) => o.value === 'bright'),
    null,
    { timeout: 15_000 }
  );
  await select.selectOption('bright');
  await page.waitForFunction(() => window.__debug.settingsState().rawOpenPresetTest === 'bright', null, { timeout: 5_000 });
  const settings = await page.evaluate(() => window.__debug.settingsState());
  check('the dropdown writes the test twin', settings.rawOpenPresetTest === 'bright', settings.rawOpenPresetTest);
  check('and never the real field', settings.rawOpenPreset === '', settings.rawOpenPreset);
  const onDisk = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'));
  check('it is persisted to settings.json', onDisk.rawOpenPresetTest === 'bright', onDisk.rawOpenPresetTest);
  await page.locator('[data-testid="settings-close-button"]').click();

  console.log('verify-rawopenpreset (2. fresh RAW open):');
  await openAndWait(JPG_PATH);
  await openAndWait(ARW_PATH);
  check('a RAW with no look file opens with the preset (EV 0.7)', (await devEv()) === PRESET_EV, await devEv());
  check('opening alone leaves the doc clean', (await page.evaluate(() => window.__debug.graphDirty())) === false, null);

  console.log('verify-rawopenpreset (3. reset all edits):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.2));
  check('edit lands', (await devEv()) === 0.2, await devEv());
  await page.locator('[data-testid="toolbar-reset-all"]').click();
  await page.waitForFunction((ev) => window.__debug.graphState().nodes.find((n) => n.develop)?.develop?.basic?.ev === ev, PRESET_EV, {
    timeout: 5_000,
  }).catch(() => {});
  check('Reset all edits returns to the preset, not to neutral', (await devEv()) === PRESET_EV, await devEv());

  console.log('verify-rawopenpreset (4. JPEG):');
  await openAndWait(JPG_PATH);
  check('a JPEG opens as before (EV 0)', (await devEv()) === 0, await devEv());

  console.log('verify-rawopenpreset (5. missing preset):');
  await page.evaluate(() => window.__debug.updateSettings({ rawOpenPresetTest: 'gone' }));
  await openAndWait(ARW_PATH);
  check('a missing preset opens neutral', (await devEv()) === 0, await devEv());
  const notice = page.locator('[data-testid="project-notice"]');
  const noticeText = (await notice.count()) ? await notice.getAttribute('title') : null;
  check('and says so, naming the preset', !!noticeText && noticeText.includes('"gone"'), noticeText);
  if (await page.locator('[data-testid="project-notice-dismiss"]').count()) await page.locator('[data-testid="project-notice-dismiss"]').click();
  await openAndWait(JPG_PATH);
  await openAndWait(ARW_PATH);
  check('only once per session', (await notice.count()) === 0, await notice.count());
  check('the setting value is kept', (await page.evaluate(() => window.__debug.settingsState().rawOpenPresetTest)) === 'gone', null);
} finally {
  await app.close();
}

console.log('verify-rawopenpreset (6. CLI --render):');
{
  // a copy in a fresh dir, so no adjacent sidecar can stand in for the default
  const workDir = mkdtempSync(join(tmpdir(), 'silverbox-rawopenpreset-cli-'));
  const arw = join(workDir, basename(ARW_PATH));
  copyFileSync(ARW_PATH, arw);
  const settingsPath = join(userDataDir, 'settings.json');
  const renderMean = async (slug, outName) => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    writeFileSync(settingsPath, JSON.stringify({ ...settings, rawOpenPresetTest: slug }, null, 2));
    const outDir = join(workDir, outName);
    mkdirSync(outDir, { recursive: true });
    const r = spawnSync(join(projectRoot, 'node_modules', '.bin', 'electron'), [projectRoot, '--render', '--out', outDir, arw], {
      env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) return { error: (r.stderr || r.stdout || '').slice(-400) };
    const { data } = await sharp(join(outDir, basename(arw).replace(/\.[^.]+$/, '.jpg'))).raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return { mean: sum / data.length / 255 };
  };
  const neutral = await renderMean('', 'neutral');
  const bright = await renderMean('bright', 'bright');
  check('CLI renders a RAW with no look file', neutral.mean !== undefined && bright.mean !== undefined, { neutral, bright });
  check('and applies the preset-on-open (+0.7 EV renders brighter)', bright.mean > neutral.mean + 0.02, { neutral, bright });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
