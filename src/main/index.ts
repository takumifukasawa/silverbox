import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import {
  IPC,
  SIDECAR_SUFFIX,
  type CliRenderJob,
  type CliRenderResult,
  type ExportEncodeRequest,
  type ExportEncodeResult,
  type ExportLutRequest,
  type ExportLutResult,
  type OpenImageDialogResult,
  type PingResult,
  type PresetSummary,
  type Settings,
} from '../../shared/ipc';
import { CLI_USAGE, buildCliRenderJob, formatCliProgress, parseCliArgs } from './cliArgs';
import { encodeExport } from './imageExport';
import { encodeLutExport } from './lutExport';
import { deletePreset, listPresets, readPreset, writePreset } from './presets';
import { readSettings, updateSettings } from './settings';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw', 'x3f', 'jpg', 'jpeg'];

/**
 * Headless CLI renderer: `electron . --render <args>` (see bin/silverbox-render
 * and the "render" npm script) — everything after `--render` is the CLI's
 * own argv, parsed in ./cliArgs. Detected from raw process.argv (before
 * Electron/Chromium have stripped their own flags) so this decision is made
 * BEFORE any window gets created.
 */
const RENDER_FLAG_INDEX = process.argv.indexOf('--render');
const isCliRenderMode = RENDER_FLAG_INDEX !== -1;
const cliArgv = isCliRenderMode ? process.argv.slice(RENDER_FLAG_INDEX + 1) : [];

function assertSidecarPath(path: unknown): string {
  if (typeof path !== 'string' || !path.endsWith(SIDECAR_SUFFIX)) {
    throw new Error(`sidecar path must end with ${SIDECAR_SUFFIX}`);
  }
  return path;
}

// --- Sidecar hot-reload watcher (the AI-editing loop) -----------------------
//
// One watch lives at a time, scoped to this window: armSidecarWatch tears
// down whatever was watched before it sets up the new one, so re-arming on
// every openImageByPath (renderer side) is exactly "watch whatever image is
// currently open, nothing else." Reference held at module scope (not inside
// registerIpc) so app-quit/window-close teardown can reach it too.
let mainWindow: BrowserWindow | null = null;
let sidecarWatcher: FSWatcher | null = null;
let sidecarWatchDebounce: ReturnType<typeof setTimeout> | null = null;

/** ~150ms: long enough to collapse a burst of writes (an editor's own atomic save, a multi-step AI edit) into one push, short enough to feel instant. */
const SIDECAR_WATCH_DEBOUNCE_MS = 150;

function teardownSidecarWatch(): void {
  if (sidecarWatchDebounce !== null) {
    clearTimeout(sidecarWatchDebounce);
    sidecarWatchDebounce = null;
  }
  sidecarWatcher?.close();
  sidecarWatcher = null;
}

/**
 * Arm the sidecar watcher for `sidecarPath`. We watch the CONTAINING
 * DIRECTORY, not the file itself: our own writeSidecar (above) and any
 * well-behaved external editor write atomically (temp file, then rename into
 * place), and `fs.watch` on a single file loses track of it across a rename
 * — the inode underneath changes identity. Events are filtered down to the
 * sidecar's own basename and debounced (SIDECAR_WATCH_DEBOUNCE_MS) before
 * pushing `sidecarChanged` to the renderer, which carries no payload — it
 * just tells the renderer "go re-read the sidecar and decide what changed"
 * (self-write suppression, dirty-vs-clean, malformed handling all live
 * renderer-side, see appStore.ts's handleExternalSidecarChange).
 */
function armSidecarWatch(sidecarPath: string): void {
  teardownSidecarWatch();
  const dir = dirname(sidecarPath);
  const base = basename(sidecarPath);
  try {
    sidecarWatcher = watch(dir, (_eventType, filename) => {
      // Some platforms don't always supply `filename` for a directory watch;
      // when absent, don't filter it out — worst case is one harmless extra
      // round-trip (the renderer's content compare is a no-op if nothing
      // relevant changed).
      if (filename !== null && filename !== base) return;
      if (sidecarWatchDebounce !== null) clearTimeout(sidecarWatchDebounce);
      sidecarWatchDebounce = setTimeout(() => {
        sidecarWatchDebounce = null;
        mainWindow?.webContents.send(IPC.sidecarChanged);
      }, SIDECAR_WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    // Directory vanished/unreadable — nothing to watch; the loop just never
    // gets a hot-reload push for this image (same net effect as no watcher).
    console.warn(`sidecar watch failed for ${dir}:`, err);
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.ping, (): PingResult => {
    return {
      pid: process.pid,
      versions: {
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
      },
    };
  });

  ipcMain.handle(IPC.openImageDialog, async (): Promise<OpenImageDialogResult> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images (RAW / JPEG)', extensions: IMAGE_EXTENSIONS }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    return { canceled: false, path, fileName: basename(path) };
  });

  ipcMain.handle(IPC.readFile, async (_ev, path: unknown): Promise<ArrayBuffer> => {
    if (typeof path !== 'string') throw new Error('readFile: path must be a string');
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  ipcMain.handle(IPC.readSidecar, async (_ev, path: unknown): Promise<string | null> => {
    try {
      return await readFile(assertSidecarPath(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.writeSidecar, async (_ev, path: unknown, content: unknown): Promise<void> => {
    if (typeof content !== 'string') throw new Error('writeSidecar: content must be a string');
    const target = assertSidecarPath(path);
    // Atomic write: a crash mid-save must not leave a truncated sidecar. The
    // temp dir lives next to the target so rename() stays on one filesystem.
    const tmpDir = await mkdtemp(join(dirname(target), '.silverbox-save-'));
    const tmpFile = join(tmpDir, basename(target));
    try {
      await writeFile(tmpFile, content, 'utf8');
      await rename(tmpFile, target);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle(IPC.watchSidecar, async (_ev, path: unknown): Promise<void> => {
    armSidecarWatch(assertSidecarPath(path));
  });

  ipcMain.handle(IPC.exportImageDialog, async (_ev, defaultPath: unknown): Promise<OpenImageDialogResult> => {
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      filters: [
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'PNG', extensions: ['png'] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: result.filePath, fileName: basename(result.filePath) };
  });

  ipcMain.handle(IPC.exportEncode, async (_ev, req: ExportEncodeRequest): Promise<ExportEncodeResult> => {
    return encodeExport(req);
  });

  ipcMain.handle(IPC.exportLutDialog, async (_ev, defaultPath: unknown): Promise<OpenImageDialogResult> => {
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      filters: [{ name: 'Adobe Cube LUT', extensions: ['cube'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: result.filePath, fileName: basename(result.filePath) };
  });

  ipcMain.handle(IPC.exportLut, async (_ev, req: ExportLutRequest): Promise<ExportLutResult> => {
    return encodeLutExport(req);
  });

  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => readSettings());

  ipcMain.handle(IPC.settingsUpdate, async (_ev, partial: unknown): Promise<Settings> => {
    if (typeof partial !== 'object' || partial === null) {
      throw new Error('settingsUpdate: partial must be an object');
    }
    return updateSettings(partial as Partial<Settings>);
  });

  ipcMain.handle(IPC.presetsList, async (): Promise<PresetSummary[]> => listPresets());

  ipcMain.handle(IPC.presetRead, async (_ev, slug: unknown): Promise<string | null> => readPreset(slug));

  ipcMain.handle(IPC.presetWrite, async (_ev, slug: unknown, content: unknown): Promise<void> => {
    await writePreset(slug, content);
  });

  ipcMain.handle(IPC.presetDelete, async (_ev, slug: unknown): Promise<void> => {
    await deletePreset(slug);
  });
}

/**
 * Verify-harness mode: the suite launches dozens of app instances in a row,
 * and each one appearing on screen makes the machine unusable while it runs.
 * The window is never shown at all — WebGPU renders and readbacks don't need
 * a visible window, backgroundThrottling:false keeps timers/rAF at full
 * rate, and CDP screenshots force their own frame capture. The macOS
 * accessory policy also keeps the app out of the Dock. `headless` folds in
 * the CLI's own `--render` mode too: it forces the exact same windowless path
 * WITHOUT requiring SILVERBOX_TEST (a real user running the CLI never sets
 * that env var).
 */
const testMode = process.env['SILVERBOX_TEST'] === '1';
const headless = testMode || isCliRenderMode;

if (isCliRenderMode) {
  // Force the real fresh-open defaults (lens profile, base curve) regardless
  // of SILVERBOX_TEST — see SilverboxApi.testFlags's `forceDefaults` doc
  // comment. Set here, in main, before any window/preload gets created:
  // preload reads process.env at renderer-process spawn time (the same
  // inheritance SILVERBOX_TEST itself already relies on), so this must land
  // before the first `new BrowserWindow(...)` call below.
  process.env['SILVERBOX_CLI_RENDER'] = '1';
}

// Verify-suite parallelism: every script that shows up here mutates
// <userData>/settings.json (autosave, presets, …). Running the suite's
// scripts concurrently against the OS-default userData dir means they'd
// stomp each other's settings.json. In test mode only, an explicit
// SILVERBOX_USER_DATA env var repoints Electron's userData dir before
// anything (readSettings included) touches it — the runner assigns each
// pooled script its own fresh temp directory here (verify-cli.mjs mints its
// own the same way for its --preset-by-name check).
const testUserData = process.env['SILVERBOX_USER_DATA'];
if (testMode && testUserData) app.setPath('userData', testUserData);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: '#1e1e1e',
    show: !headless,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // ESM preload requires an unsandboxed renderer; contextIsolation stays on.
      sandbox: false,
      // hidden/unfocused windows must keep timers and rAF at full rate
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    teardownSidecarWatch();
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * `--render`'s whole lifecycle: parse argv (already read before app.whenReady
 * — see cliArgv above), print usage/errors and exit for bad usage, else
 * create the hidden window, hand it the job once the renderer signals ready
 * (cli:ready — closes the mount race, see App.tsx), and stream results back
 * as they render (cli:progress) until the batch finishes (cli:done). Exit
 * code: 2 for bad usage, 1 if any file errored, 0 otherwise — set via
 * app.exit() (never process.exit(), which wouldn't flush Electron's own
 * teardown).
 */
async function runCliMode(): Promise<void> {
  const parsed = parseCliArgs(cliArgv);
  if ('error' in parsed) {
    console.error(`silverbox-render: ${parsed.error}\n`);
    console.error(CLI_USAGE);
    app.exit(2);
    return;
  }
  if (parsed.help) {
    console.log(CLI_USAGE);
    app.exit(0);
    return;
  }
  if (parsed.images.length === 0) {
    console.error('silverbox-render: no input images given\n');
    console.error(CLI_USAGE);
    app.exit(2);
    return;
  }

  const job = buildCliRenderJob(parsed, process.cwd());
  const win = createWindow();
  let hadError = false;

  const onProgress = (_ev: unknown, result: CliRenderResult): void => {
    if ('error' in result) hadError = true;
    const { stderr, line } = formatCliProgress(result, parsed.json);
    (stderr ? process.stderr : process.stdout).write(line + '\n');
  };
  ipcMain.on(IPC.cliProgress, onProgress);

  // A renderer crash / an unhandled hang must not wedge a CI job forever —
  // 10 minutes comfortably covers even a large batch on modest hardware.
  const CLI_TIMEOUT_MS = 10 * 60 * 1000;
  let timedOut = false;
  await new Promise<void>((resolveJob) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error('silverbox-render: timed out waiting for the render to finish');
      resolveJob();
    }, CLI_TIMEOUT_MS);
    ipcMain.once(IPC.cliDone, () => {
      clearTimeout(timeout);
      resolveJob();
    });
    ipcMain.once(IPC.cliReady, () => {
      win.webContents.send(IPC.cliRun, job);
    });
  });
  ipcMain.removeListener(IPC.cliProgress, onProgress);
  app.exit(timedOut || hadError ? 1 : 0);
}

void app.whenReady().then(async () => {
  if (headless && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  // No native menu bar for a batch CLI invocation (verify-cli.mjs's "runs
  // windowless, no focus/UI side effects" contract) — left untouched for the
  // normal app and the verify suite, both of which still want it.
  if (isCliRenderMode) Menu.setApplicationMenu(null);
  // Load (and, on first run, create) settings.json before the renderer can
  // possibly ask for it over IPC.
  await readSettings();
  registerIpc();

  if (isCliRenderMode) {
    await runCliMode();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  teardownSidecarWatch();
  if (process.platform !== 'darwin') app.quit();
});
