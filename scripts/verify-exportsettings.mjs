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
  console.log('verify-exportsettings (export controls moved into a dialog, off the persistent toolbar):');
  check(
    'the toolbar itself carries none of the export option controls (only the Export… button)',
    (await page.locator('.toolbar [data-testid="export-quality"]').count()) === 0 &&
      (await page.locator('.toolbar [data-testid="export-maxdim"]').count()) === 0 &&
      (await page.locator('.toolbar [data-testid="export-metadata"]').count()) === 0 &&
      (await page.locator('.toolbar [data-testid="export-colorspace"]').count()) === 0,
    {
      quality: await page.locator('.toolbar [data-testid="export-quality"]').count(),
      maxdim: await page.locator('.toolbar [data-testid="export-maxdim"]').count(),
      metadata: await page.locator('.toolbar [data-testid="export-metadata"]').count(),
      colorspace: await page.locator('.toolbar [data-testid="export-colorspace"]').count(),
    }
  );
  check(
    'the export controls do not exist anywhere before the dialog is opened',
    (await page.locator('[data-testid="export-quality"]').count()) === 0,
    await page.locator('[data-testid="export-quality"]').count()
  );
  await page.locator('[data-testid="export-button"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 5_000 });
  check(
    'clicking Export… opens the dialog with the option controls inside it',
    (await page.locator('[data-testid="export-dialog"] [data-testid="export-quality"]').count()) === 1,
    await page.locator('[data-testid="export-dialog"] [data-testid="export-quality"]').count()
  );

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (5. export presets, via the UI, inside the dialog):');
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

  console.log('verify-exportsettings (autosaveSidecar checkbox is reachable from the dialog footer):');
  const autosaveCheckbox = page.locator('[data-testid="export-autosave-checkbox"]');
  check('autosave checkbox reflects the current (default true) setting', await autosaveCheckbox.isChecked(), true);
  await autosaveCheckbox.click();
  await page.waitForFunction(() => window.__debug.settingsState().autosaveSidecar === false, { timeout: 5_000 });
  check('unchecking it turns settings.autosaveSidecar off', !(await page.evaluate(() => window.__debug.settingsState().autosaveSidecar)), true);
  await autosaveCheckbox.click();
  await page.waitForFunction(() => window.__debug.settingsState().autosaveSidecar === true, { timeout: 5_000 });

  await page.locator('[data-testid="export-close-button"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="export-dialog"]') === null, { timeout: 5_000 });

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (6. All outputs: two named outputs, both files written with the output-name suffix):');
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-output"]').click();
  const gWithSecondOutput = await page.evaluate(() => window.__debug.graphState());
  const secondOutputId = gWithSecondOutput.nodes.find((n) => n.kind === 'output' && n.id !== 'out').id;
  await page.locator(`.react-flow__node[data-id="${secondOutputId}"]`).click();
  await page.locator('[data-testid="output-name"]').fill('web');
  // wire the second output straight off the input node (bypassing Develop) so it visibly differs from 'main'
  const inSourceHandle = page.locator('.react-flow__node[data-id="in"] .react-flow__handle.source');
  const secondTargetHandle = page.locator(`.react-flow__node[data-id="${secondOutputId}"] .react-flow__handle.target`);
  const srcBox = await inSourceHandle.boundingBox();
  const dstBox = await secondTargetHandle.boundingBox();
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.locator('[data-testid="export-button"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 5_000 });
  const outputTargetOptions = await page.locator('[data-testid="export-output-target"]').locator('option').allTextContents();
  check(
    'the output-target selector appears once a second output exists, offering both names + "All outputs"',
    outputTargetOptions.includes('web') && outputTargetOptions.includes('All outputs'),
    outputTargetOptions
  );
  await page.locator('[data-testid="export-output-target"]').selectOption('all');
  await page.locator('[data-testid="export-quality"]').fill('81');
  await page.locator('[data-testid="export-colorspace"]').selectOption('srgb');

  const OUT_ALL_BASE = join(projectRoot, 'test-artifacts', 'exportsettings-alloutputs.jpg');
  const OUT_ALL_MAIN = join(projectRoot, 'test-artifacts', 'exportsettings-alloutputs-main.jpg');
  const OUT_ALL_WEB = join(projectRoot, 'test-artifacts', 'exportsettings-alloutputs-web.jpg');
  for (const p of [OUT_ALL_BASE, OUT_ALL_MAIN, OUT_ALL_WEB]) if (existsSync(p)) unlinkSync(p);
  // the dialog's real "Export" button goes through the native save dialog
  // (untestable headless) — exportOutputsTo mirrors exportImageTo's existing
  // convention of supplying the path directly to bypass it, while the UI
  // interaction above still proves the selector/controls work.
  await page.evaluate(
    ([base, opts]) => window.__debug.exportOutputsTo('all', base, opts),
    [OUT_ALL_BASE, { quality: 81, colorSpace: 'srgb' }]
  );
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  const allOutputsState = await page.evaluate(() => window.__debug.exportState());
  check('All-outputs export completes without error', allOutputsState.status === 'idle', allOutputsState);
  const batchInfo = await page.evaluate(() => window.__debug.exportBatchState());
  check('exportBatchState reports 2 files written', batchInfo?.count === 2, batchInfo);
  check('neither file is the unsuffixed base path (both outputs got a suffix)', !existsSync(OUT_ALL_BASE), existsSync(OUT_ALL_BASE));
  check('main output file exists (…-main.jpg)', existsSync(OUT_ALL_MAIN), existsSync(OUT_ALL_MAIN));
  check('second output file exists (…-web.jpg)', existsSync(OUT_ALL_WEB), existsSync(OUT_ALL_WEB));

  const metaMain = await sharp(OUT_ALL_MAIN).metadata();
  const metaWeb = await sharp(OUT_ALL_WEB).metadata();
  check('both files honor the chosen quality/colorspace (JPEG, sRGB ICC present)', metaMain.format === 'jpeg' && metaWeb.format === 'jpeg' && !!metaMain.icc && !!metaWeb.icc, {
    mainFormat: metaMain.format,
    webFormat: metaWeb.format,
    mainIcc: !!metaMain.icc,
    webIcc: !!metaWeb.icc,
  });
  const mainMean = (await rawMeanAndSample(OUT_ALL_MAIN)).mean;
  const webMean = (await rawMeanAndSample(OUT_ALL_WEB)).mean;
  check("the two outputs' pixels differ (second output bypasses Develop)", Math.abs(mainMean - webMean) > 0.01, {
    mainMean,
    webMean,
  });

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (7. All outputs with COLLIDING names still writes distinct files):');
  // Two unnamed outputs both fall back to 'main' (graphDoc.ts's outputName)
  // — the user's original report ("two outputs, only one file written") is
  // exactly this shape, so the suffixes must disambiguate (-main, -main-2).
  // Section 6 left the dialog open (its export ran via the debug hook); the
  // backdrop would swallow the node click below.
  await page.locator('[data-testid="export-close-button"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="export-dialog"]') === null, { timeout: 5_000 });
  await page.locator(`.react-flow__node[data-id="${secondOutputId}"]`).click();
  await page.locator('[data-testid="output-name"]').fill('');
  const OUT_DUP_BASE = join(projectRoot, 'test-artifacts', 'exportsettings-dupnames.jpg');
  const OUT_DUP_1 = join(projectRoot, 'test-artifacts', 'exportsettings-dupnames-main.jpg');
  const OUT_DUP_2 = join(projectRoot, 'test-artifacts', 'exportsettings-dupnames-main-2.jpg');
  for (const p of [OUT_DUP_BASE, OUT_DUP_1, OUT_DUP_2]) if (existsSync(p)) unlinkSync(p);
  await page.evaluate(
    ([base, opts]) => window.__debug.exportOutputsTo('all', base, opts),
    [OUT_DUP_BASE, { quality: 81, colorSpace: 'srgb' }]
  );
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  const dupBatch = await page.evaluate(() => window.__debug.exportBatchState());
  check(
    'colliding output names export 2 files at 2 DISTINCT paths',
    dupBatch?.count === 2 && new Set(dupBatch.paths).size === 2,
    dupBatch
  );
  check('first colliding output file exists (…-main.jpg)', existsSync(OUT_DUP_1), existsSync(OUT_DUP_1));
  check('second colliding output file exists (…-main-2.jpg)', existsSync(OUT_DUP_2), existsSync(OUT_DUP_2));

  // ---------------------------------------------------------------------
  console.log('verify-exportsettings (8. output nodes are deletable while another remains, never the last):');
  await page.locator(`.react-flow__node[data-id="${secondOutputId}"]`).click();
  const deleteButton = page.locator('[data-testid="delete-node-button"]');
  check('a second output is deletable (button enabled)', await deleteButton.isEnabled(), await deleteButton.isEnabled());
  await deleteButton.click();
  const gAfterOutputDelete = await page.evaluate(() => window.__debug.graphState());
  check(
    'deleting the second output removes it and its feeding edge',
    !gAfterOutputDelete.nodes.some((n) => n.id === secondOutputId) &&
      !gAfterOutputDelete.edges.some((e) => e.target === secondOutputId),
    gAfterOutputDelete.nodes.filter((n) => n.kind === 'output').map((n) => n.id)
  );
  await page.locator('.react-flow__node[data-id="out"]').click();
  check('the LAST output is not deletable (button disabled)', !(await deleteButton.isEnabled()), await deleteButton.isEnabled());
  await page.keyboard.press('Backspace');
  const gAfterLastDelete = await page.evaluate(() => window.__debug.graphState());
  check(
    'Backspace on the last output is a no-op too (removeOpNode guard)',
    gAfterLastDelete.nodes.some((n) => n.id === 'out'),
    gAfterLastDelete.nodes.filter((n) => n.kind === 'output').map((n) => n.id)
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
