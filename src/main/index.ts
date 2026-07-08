import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { IPC, SIDECAR_SUFFIX, type OpenImageDialogResult, type PingResult } from '../../shared/ipc';

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
    await writeFile(assertSidecarPath(path), content, 'utf8');
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

  ipcMain.handle(IPC.writeImageFile, async (_ev, path: unknown, bytes: unknown): Promise<void> => {
    if (typeof path !== 'string' || !/\.(jpg|jpeg|png)$/i.test(path)) {
      throw new Error('writeImageFile: path must end with .jpg/.jpeg/.png');
    }
    if (!(bytes instanceof ArrayBuffer)) throw new Error('writeImageFile: bytes must be an ArrayBuffer');
    await writeFile(path, Buffer.from(bytes));
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // ESM preload requires an unsandboxed renderer; contextIsolation stays on.
      sandbox: false,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
