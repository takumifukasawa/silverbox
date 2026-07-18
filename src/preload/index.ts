import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type CliJob, type SilverboxApi } from '../../shared/ipc';

const api: SilverboxApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  openImageDialog: (scope) => ipcRenderer.invoke(IPC.openImageDialog, scope),
  openFolderDialog: () => ipcRenderer.invoke(IPC.openFolderDialog),
  openDcpDialog: () => ipcRenderer.invoke(IPC.openDcpDialog),
  listImages: (dir) => ipcRenderer.invoke(IPC.listImages, dir),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  readSidecar: (path) => ipcRenderer.invoke(IPC.readSidecar, path),
  writeSidecar: (path, content) => ipcRenderer.invoke(IPC.writeSidecar, path, content),
  watchSidecar: (path) => ipcRenderer.invoke(IPC.watchSidecar, path),
  readProjectManifest: (dir) => ipcRenderer.invoke(IPC.projectRead, dir),
  writeProjectManifest: (dir, content) => ipcRenderer.invoke(IPC.projectWrite, dir, content),
  projectPhotosStatus: (dir, photos) => ipcRenderer.invoke(IPC.projectPhotosStatus, dir, photos),
  fingerprintFile: (path) => ipcRenderer.invoke(IPC.fingerprintFile, path),
  scanFolderForRelink: (dir, basenameHint, expectedFingerprint) =>
    ipcRenderer.invoke(IPC.scanFolderForRelink, dir, basenameHint, expectedFingerprint),
  listSidecarFiles: (dir) => ipcRenderer.invoke(IPC.listSidecarFiles, dir),
  moveProjectFiles: (srcDir, destDir, lookNames) => ipcRenderer.invoke(IPC.moveProjectFiles, srcDir, destDir, lookNames),
  onSidecarChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.sidecarChanged, listener);
    return () => ipcRenderer.removeListener(IPC.sidecarChanged, listener);
  },
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
  // Static env-derived flags (sandbox:false → preload has process.env). See
  // SilverboxApi.testFlags. Read once at preload time — the verify scripts set
  // these before launching electron.
  testFlags: {
    isTest: process.env.SILVERBOX_TEST === '1',
    lensProfileAutoDefault: process.env.SILVERBOX_TEST_LENS_PROFILE_DEFAULT === '1',
    baseCurveDefault: process.env.SILVERBOX_TEST_BASE_CURVE_DEFAULT === '1',
    forceDefaults: process.env.SILVERBOX_CLI_RENDER === '1',
    projectDirOverride: process.env.SILVERBOX_TEST_PROJECT ?? null,
  },
  onCliRun: (callback) => {
    const listener = (_ev: IpcRendererEvent, job: CliJob) => callback(job);
    ipcRenderer.on(IPC.cliRun, listener);
    return () => ipcRenderer.removeListener(IPC.cliRun, listener);
  },
  cliReady: () => ipcRenderer.send(IPC.cliReady),
  cliProgress: (result) => ipcRenderer.send(IPC.cliProgress, result),
  cliDone: () => ipcRenderer.send(IPC.cliDone),
  cliWarn: (message) => ipcRenderer.send(IPC.cliWarn, message),
  writeExtractedPreset: (path, content) => ipcRenderer.invoke(IPC.extractLookWrite, path, content),
  onOpenPath: (callback) => {
    const listener = (_ev: IpcRendererEvent, path: string) => callback(path);
    ipcRenderer.on(IPC.openPath, listener);
    return () => ipcRenderer.removeListener(IPC.openPath, listener);
  },
  appReady: () => ipcRenderer.send(IPC.appReady),
  checkGoldenImage: (req) => ipcRenderer.invoke(IPC.goldenCheck, req),
  diffRenderImages: (req) => ipcRenderer.invoke(IPC.diffRenderImages, req),
  runExternalTool: (req) => ipcRenderer.invoke(IPC.externalToolRun, req),
  externalToolSpawnCount: () => ipcRenderer.invoke(IPC.externalToolSpawnCount),
  runDenoise: (req) => ipcRenderer.invoke(IPC.denoiseRun, req),
  denoiseRunCount: () => ipcRenderer.invoke(IPC.denoiseRunCount),
};

contextBridge.exposeInMainWorld('silverbox', api);
