import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SilverboxApi } from '../../shared/ipc';

const api: SilverboxApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  openImageDialog: () => ipcRenderer.invoke(IPC.openImageDialog),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  readSidecar: (path) => ipcRenderer.invoke(IPC.readSidecar, path),
  writeSidecar: (path, content) => ipcRenderer.invoke(IPC.writeSidecar, path, content),
  exportImageDialog: (defaultPath) => ipcRenderer.invoke(IPC.exportImageDialog, defaultPath),
  writeImageFile: (path, bytes) => ipcRenderer.invoke(IPC.writeImageFile, path, bytes),
};

contextBridge.exposeInMainWorld('silverbox', api);
