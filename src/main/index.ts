import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { IPC, type PingResult } from '../../shared/ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
