import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import {
  IPC,
  SIDECAR_SUFFIX,
  type ExportEncodeRequest,
  type ExportEncodeResult,
  type ExportLutRequest,
  type ExportLutResult,
  type OpenImageDialogResult,
  type PingResult,
  type Settings,
} from '../../shared/ipc';
import { encodeExport } from './imageExport';
import { encodeLutExport } from './lutExport';
import { readSettings, updateSettings } from './settings';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw', 'x3f', 'jpg', 'jpeg'];

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

  const assertSidecarPath = (path: unknown): string => {
    if (typeof path !== 'string' || !path.endsWith(SIDECAR_SUFFIX)) {
      throw new Error(`sidecar path must end with ${SIDECAR_SUFFIX}`);
    }
    return path;
  };

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
}

/**
 * Verify-harness mode: the suite launches dozens of app instances in a row,
 * and each one appearing on screen makes the machine unusable while it runs.
 * The window is never shown at all — WebGPU renders and readbacks don't need
 * a visible window, backgroundThrottling:false keeps timers/rAF at full
 * rate, and CDP screenshots force their own frame capture. The macOS
 * accessory policy also keeps the app out of the Dock.
 */
const testMode = process.env['SILVERBOX_TEST'] === '1';

// Verify-suite parallelism: every script that shows up here mutates
// <userData>/settings.json (autosave, presets, …). Running the suite's
// scripts concurrently against the OS-default userData dir means they'd
// stomp each other's settings.json. In test mode only, an explicit
// SILVERBOX_USER_DATA env var repoints Electron's userData dir before
// anything (readSettings included) touches it — the runner assigns each
// pooled script its own fresh temp directory here.
const testUserData = process.env['SILVERBOX_USER_DATA'];
if (testMode && testUserData) app.setPath('userData', testUserData);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: '#1e1e1e',
    show: !testMode,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // ESM preload requires an unsandboxed renderer; contextIsolation stays on.
      sandbox: false,
      // hidden/unfocused windows must keep timers and rAF at full rate
      backgroundThrottling: false,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  if (testMode && process.platform === 'darwin') app.setActivationPolicy('accessory');
  // Load (and, on first run, create) settings.json before the renderer can
  // possibly ask for it over IPC.
  await readSettings();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
