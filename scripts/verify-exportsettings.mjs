/**
 * settings.json + sidecar autosave + export metadata/color-space/presets
 * verify:
 *  1. settings.json is created with defaults on first run; an unknown extra
 *     field survives a settingsUpdate round-trip (DESIGN.md §9).
 *  2. Sidecar autosave: an edit (no ⌘S) writes the sidecar ~1s later and
 *     clears graphDirty; turning autosaveSidecar off stops it.
 *  3. Metadata policy: 'all' carries EXIF, 'none' carries none; both carry
 *     an ICC profile regardless (color-space correctness, not metadata).
 *  4. Color space: sRGB vs Display P3 exports differ in ICC profile and
 *     pixel bytes, with a sane (not garbage) P3 mean.
 *  5. Export presets: saving one via the UI persists to settings.json;
 *     re-selecting it restores the toolbar controls.
 *
 * Isolation: points Electron's userData dir at a fresh temp directory via
 * SILVERBOX_USER_DATA (see testUserData handling in src/main/index.ts;
 * confirmed via app.evaluate(app.getPath('userData')) to actually take
 * effect), so this run never touches the real installed settings.json. If
 * the runner already assigned SILVERBOX_USER_DATA (parallel suite run), that
 * directory is reused and left for the runner to clean up; standalone runs
 * create and clean up their own.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const OUT_ALL = join(projectRoot, 'test-artifacts', 'exportsettings-metadata-all.jpg');
const OUT_NONE = join(projectRoot, 'test-artifacts', 'exportsettings-metadata-none.jpg');
const OUT_SRGB = join(projectRoot, 'test-artifacts', 'exportsettings-srgb.jpg');
const OUT_P3 = join(projectRoot, 'test-artifacts', 'exportsettings-p3.jpg');

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

for (const p of [OUT_ALL, OUT_NONE, OUT_SRGB, OUT_P3]) if (existsSync(p)) unlinkSync(p);
mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });
if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

// reuse the runner's assignment when present (parallel run); otherwise mint
// our own, standalone-run temp dir and own its cleanup
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-settings-verify-'));
process.env.SILVERBOX_USER_DATA = userDataDir;

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // Confirm the isolation switch actually took effect before trusting
  // anything below — a silent fallback to the real userData dir would mean
  // this run pollutes the user's actual settings.json.
  const realUserData = await app.evaluate(({ app }) => app.getPath('userData'));
  // macOS resolves /var/folders/... through its /private symlink, so compare
  // by mkdtemp's own unique suffix rather than requiring an exact string
  // match — this is still specific enough to catch a silent fallback to the
  // real (non-isolated) userData directory.
  check(
    'Electron actually honored SILVERBOX_USER_DATA (isolated from the real settings.json)',
    basename(realUserData) === basename(userDataDir),
    { realUserData, userDataDir }
  );
  const settingsPath = join(realUserData, 'settings.json');

  const openAndWait = async (path) => {
    // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (1. settings.json defaults + unknown-field round-trip):');
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  const onDiskFirstRun = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null;
  check('settings.json exists on disk after first run', onDiskFirstRun !== null, onDiskFirstRun);
  check(
    'defaults match spec (autosaveSidecar/previewLongEdge/export/exportPresets)',
    onDiskFirstRun?.settingsVersion === 1 &&
      onDiskFirstRun?.autosaveSidecar === true &&
      onDiskFirstRun?.previewLongEdge === 2560 &&
      onDiskFirstRun?.export?.quality === 90 &&
      onDiskFirstRun?.export?.maxDim === null &&
      onDiskFirstRun?.export?.metadata === 'all' &&
      onDiskFirstRun?.export?.colorSpace === 'srgb' &&
      Array.isArray(onDiskFirstRun?.exportPresets) &&
      onDiskFirstRun.exportPresets.length === 0,
    onDiskFirstRun
  );

  const settingsAfterUnknown = await page.evaluate(async () => {
    await window.__debug.updateSettings({ futureFeature: { some: 'newer-build-only data' } });
    return window.__debug.settingsState();
  });
  check(
    'settingsUpdate resolves with the unknown field echoed back',
    JSON.stringify(settingsAfterUnknown.futureFeature) === JSON.stringify({ some: 'newer-build-only data' }),
    settingsAfterUnknown
  );
  const onDiskAfterUnknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
  check(
    'unknown top-level field survives the on-disk round-trip (DESIGN.md §9)',
    JSON.stringify(onDiskAfterUnknown.futureFeature) === JSON.stringify({ some: 'newer-build-only data' }),
    onDiskAfterUnknown
  );
  // a second settingsUpdate touching unrelated fields must not drop it
  await page.evaluate(() => window.__debug.updateSettings({ previewLongEdge: 3000 }));
  const onDiskAfterSecondUpdate = JSON.parse(readFileSync(settingsPath, 'utf8'));
  check(
    'unknown field still present after an unrelated settingsUpdate',
    JSON.stringify(onDiskAfterSecondUpdate.futureFeature) === JSON.stringify({ some: 'newer-build-only data' }),
    onDiskAfterSecondUpdate
  );
  check('the unrelated field itself did update', onDiskAfterSecondUpdate.previewLongEdge === 3000, onDiskAfterSecondUpdate);
  // restore previewLongEdge for the rest of the run (2560 keeps the preview
  // dims other checks may implicitly rely on unchanged)
  await page.evaluate(() => window.__debug.updateSettings({ previewLongEdge: 2560 }));

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (2. sidecar autosave):');
  await openAndWait(ARW_PATH);
  check('autosaveSidecar defaults to true', (await page.evaluate(() => window.__debug.settingsState().autosaveSidecar)) === true, true);
  check('freshly opened image is not dirty', !(await page.evaluate(() => window.__debug.graphDirty())), true);
  check('no sidecar on disk yet', !existsSync(SIDECAR), existsSync(SIDECAR));

  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.7));
  check('editing marks the graph dirty', await page.evaluate(() => window.__debug.graphDirty()), true);
  await page.waitForTimeout(1_800); // debounce is 1000ms after the LAST change
  check('graphDirty cleared itself (autosave fired without ⌘S)', !(await page.evaluate(() => window.__debug.graphDirty())), true);
  check('sidecar file exists on disk after the debounce', existsSync(SIDECAR), existsSync(SIDECAR));
  const sidecarEv = JSON.parse(readFileSync(SIDECAR, 'utf8')).graph.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev;
  check('sidecar on disk contains the exposure change', sidecarEv === 0.7, sidecarEv);

  console.log('verify-exportsettings (2. autosaveSidecar=false disables it):');
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: false }));
  const sidecarBeforeSecondEdit = readFileSync(SIDECAR, 'utf8');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 1.3));
  check('editing still marks the graph dirty', await page.evaluate(() => window.__debug.graphDirty()), true);
  await page.waitForTimeout(1_800);
  check(
    'graphDirty stays true (no autosave while the setting is off)',
    await page.evaluate(() => window.__debug.graphDirty()),
    true
  );
  const sidecarAfterSecondEdit = readFileSync(SIDECAR, 'utf8');
  check('sidecar file is byte-for-byte unchanged with autosave off', sidecarAfterSecondEdit === sidecarBeforeSecondEdit, {
    sidecarBeforeSecondEdit,
    sidecarAfterSecondEdit,
  });
  // re-enable for the rest of the run and clean the sidecar back up
  await page.evaluate(() => window.__debug.updateSettings({ autosaveSidecar: true }));
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(300);
  unlinkSync(SIDECAR);

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (autosave must never fire while sidecarUnreadable):');
  writeFileSync(SIDECAR, JSON.stringify({ schemaVersion: 999 }));
  const garbageBefore = readFileSync(SIDECAR, 'utf8');
  await openAndWait(ARW_PATH);
  const sidecarStateAfterGarbageOpen = await page.evaluate(() => window.__debug.sidecarState());
  check(
    'sidecarUnreadable guard is up for the unparseable sidecar',
    sidecarStateAfterGarbageOpen.unreadable,
    sidecarStateAfterGarbageOpen
  );
  // this edit must not schedule an autosave that overwrites the garbage sidecar
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.9));
  await page.waitForTimeout(1_800);
  const garbageAfter = readFileSync(SIDECAR, 'utf8');
  check('autosave left the unreadable sidecar untouched', garbageAfter === garbageBefore, { garbageBefore, garbageAfter });
  unlinkSync(SIDECAR);
  await openAndWait(ARW_PATH); // clean re-open (no sidecar) resets the guard for later checks

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (3. metadata policy):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.5));
  const exportAndWait = async (outPath, opts) => {
    await page.evaluate(([p, o]) => window.__debug.exportImageTo(p, o), [outPath, opts]);
    await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
    return page.evaluate(() => window.__debug.exportState());
  };

  const allState = await exportAndWait(OUT_ALL, { metadata: 'all', colorSpace: 'srgb' });
  check('metadata=all export completes', allState.status === 'idle', allState);
  const noneState = await exportAndWait(OUT_NONE, { metadata: 'none', colorSpace: 'srgb' });
  check('metadata=none export completes', noneState.status === 'idle', noneState);

  const metaAll = await sharp(OUT_ALL).metadata();
  const metaNone = await sharp(OUT_NONE).metadata();
  check('metadata=all: EXIF is present', !!metaAll.exif, { hasExif: !!metaAll.exif });
  check('metadata=all: carries an ICC profile', !!metaAll.icc, { hasIcc: !!metaAll.icc });
  check('metadata=none: EXIF is absent', !metaNone.exif, { hasExif: !!metaNone.exif });
  check('metadata=none: still carries an ICC profile (correctness, not metadata)', !!metaNone.icc, {
    hasIcc: !!metaNone.icc,
  });
  if (metaAll.exif) {
    const exifText = metaAll.exif.toString('latin1');
    check("metadata=all EXIF carries the camera model ('ILCE-7CM2')", exifText.includes('ILCE-7CM2'), {
      snippet: exifText.slice(0, 200),
    });
  }

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (4. color space):');
  const srgbState = await exportAndWait(OUT_SRGB, { metadata: 'all', colorSpace: 'srgb' });
  check('sRGB export completes', srgbState.status === 'idle', srgbState);
  const p3State = await exportAndWait(OUT_P3, { metadata: 'all', colorSpace: 'p3' });
  check('P3 export completes', p3State.status === 'idle', p3State);

  const metaSrgb = await sharp(OUT_SRGB).metadata();
  const metaP3 = await sharp(OUT_P3).metadata();
  check('both exports carry an ICC profile', !!metaSrgb.icc && !!metaP3.icc, {
    srgbIcc: !!metaSrgb.icc,
    p3Icc: !!metaP3.icc,
  });
  const iccDiffers = !!metaSrgb.icc && !!metaP3.icc && !metaSrgb.icc.equals(metaP3.icc);
  check("sRGB and P3 files' ICC profiles differ", iccDiffers, {
    srgbIccLength: metaSrgb.icc?.length,
    p3IccLength: metaP3.icc?.length,
  });

  const rawMeanAndSample = async (path) => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    const n = info.width * info.height;
    for (let i = 0; i < n; i++) {
      r += data[i * info.channels];
      g += data[i * info.channels + 1];
      b += data[i * info.channels + 2];
    }
    return { mean: (r / n + g / n + b / n) / 3 / 255, bytes: data };
  };
  const srgbPixels = await rawMeanAndSample(OUT_SRGB);
  const p3Pixels = await rawMeanAndSample(OUT_P3);
  check('sRGB and P3 exports have different pixel bytes', !srgbPixels.bytes.equals(p3Pixels.bytes), {
    same: srgbPixels.bytes.equals(p3Pixels.bytes),
  });
  check(
    'P3 mean is a sane (non-garbage) value within 0.1 of the sRGB mean',
    Math.abs(p3Pixels.mean - srgbPixels.mean) < 0.1,
    { srgbMean: srgbPixels.mean, p3Mean: p3Pixels.mean }
  );

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (5. export presets, via the UI):');
  await page.locator('[data-testid="export-quality"]').fill('72');
  await page.locator('[data-testid="export-maxdim"]').fill('1600');
  await page.locator('[data-testid="export-metadata"]').selectOption('minimal');
  await page.locator('[data-testid="export-colorspace"]').selectOption('p3');
  await page.locator('[data-testid="export-preset-name"]').fill('web-share');
  await page.locator('[data-testid="export-save-preset"]').click();
  await page.waitForFunction(
    () => window.__debug.settingsState().exportPresets.some((p) => p.name === 'web-share'),
    { timeout: 10_000 }
  );

  const onDiskPresets = JSON.parse(readFileSync(settingsPath, 'utf8')).exportPresets;
  const savedPreset = onDiskPresets.find((p) => p.name === 'web-share');
  check('preset lands in settings.json with the exact snapshotted values', !!savedPreset, onDiskPresets);
  check(
    'saved preset values match the controls at save time',
    savedPreset?.quality === 72 && savedPreset?.maxDim === 1600 && savedPreset?.metadata === 'minimal' && savedPreset?.colorSpace === 'p3',
    savedPreset
  );

  // change the controls away from the preset, then re-select it
  await page.locator('[data-testid="export-quality"]').fill('40');
  await page.locator('[data-testid="export-maxdim"]').fill('');
  await page.locator('[data-testid="export-metadata"]').selectOption('all');
  await page.locator('[data-testid="export-colorspace"]').selectOption('srgb');
  await page.locator('[data-testid="export-preset"]').selectOption('web-share');
  const restoredQuality = await page.locator('[data-testid="export-quality"]').inputValue();
  const restoredMaxDim = await page.locator('[data-testid="export-maxdim"]').inputValue();
  const restoredMetadata = await page.locator('[data-testid="export-metadata"]').inputValue();
  const restoredColorSpace = await page.locator('[data-testid="export-colorspace"]').inputValue();
  check(
    're-selecting the preset restores quality/maxDim/metadata/colorSpace on the controls',
    restoredQuality === '72' && restoredMaxDim === '1600' && restoredMetadata === 'minimal' && restoredColorSpace === 'p3',
    { restoredQuality, restoredMaxDim, restoredMetadata, restoredColorSpace }
  );

  check('no page errors across the exportsettings checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
