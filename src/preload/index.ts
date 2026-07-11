import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type SilverboxApi } from '../../shared/ipc';

const api: SilverboxApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  openImageDialog: () => ipcRenderer.invoke(IPC.openImageDialog),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  readSidecar: (path) => ipcRenderer.invoke(IPC.readSidecar, path),
  writeSidecar: (path, content) => ipcRenderer.invoke(IPC.writeSidecar, path, content),
  exportImageDialog: (defaultPath) => ipcRenderer.invoke(IPC.exportImageDialog, defaultPath),
  exportEncode: (req) => ipcRenderer.invoke(IPC.exportEncode, req),
  exportLutDialog: (defaultPath) => ipcRenderer.invoke(IPC.exportLutDialog, defaultPath),
  exportLut: (req) => ipcRenderer.invoke(IPC.exportLut, req),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsUpdate: (partial) => ipcRenderer.invoke(IPC.settingsUpdate, partial),
  presetsList: () => ipcRenderer.invoke(IPC.presetsList),
  presetRead: (slug) => ipcRenderer.invoke(IPC.presetRead, slug),
  presetWrite: (slug, content) => ipcRenderer.invoke(IPC.presetWrite, slug, content),
  presetDelete: (slug) => ipcRenderer.invoke(IPC.presetDelete, slug),
};

contextBridge.exposeInMainWorld('silverbox', api);
