import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SilverboxApi } from '../../shared/ipc';

const api: SilverboxApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
};

contextBridge.exposeInMainWorld('silverbox', api);
