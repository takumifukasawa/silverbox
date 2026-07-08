import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SilverboxApi } from '../../shared/ipc';

const api: SilverboxApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  openImageDialog: () => ipcRenderer.invoke(IPC.openImageDialog),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
};

contextBridge.exposeInMainWorld('silverbox', api);
