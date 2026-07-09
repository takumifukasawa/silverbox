/**
 * Typed IPC surface between main and renderer.
 *
 * The preload script exposes `window.silverbox` implementing SilverboxApi;
 * main registers a handler per channel. Keep channel names and signatures in
 * this one file so both sides stay in sync.
 */

export const IPC = {
  ping: 'app:ping',
  openImageDialog: 'dialog:openImage',
  readFile: 'file:read',
  readSidecar: 'sidecar:read',
  writeSidecar: 'sidecar:write',
  exportImageDialog: 'dialog:exportImage',
  exportEncode: 'export:encode',
} as const;

/** Suffix of the GraphDoc sidecar written next to the image file. */
export const SIDECAR_SUFFIX = '.silverbox.json';

export interface PingResult {
  pid: number;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export type OpenImageDialogResult = { canceled: true } | { canceled: false; path: string; fileName: string };

export interface SilverboxApi {
  ping(): Promise<PingResult>;
  /** Show the native open dialog filtered to supported image types. */
  openImageDialog(): Promise<OpenImageDialogResult>;
  /** Read a file's bytes (used after dialog / drag-and-drop resolves a path). */
  readFile(path: string): Promise<ArrayBuffer>;
  /** Read a `.silverbox.json` sidecar; null if it does not exist. */
  readSidecar(path: string): Promise<string | null>;
  /** Write a `.silverbox.json` sidecar (main rejects other paths). */
  writeSidecar(path: string, content: string): Promise<void>;
  /** Native save dialog for the developed image (.jpg/.png). */
  exportImageDialog(defaultPath: string): Promise<OpenImageDialogResult>;
  /** Encode + write the developed pixels via sharp in the main process. */
  exportEncode(req: ExportEncodeRequest): Promise<ExportEncodeResult>;
}

/** EXIF fields copied from the decode metadata into the exported JPEG. */
export interface ExportExifMeta {
  cameraMake?: string;
  cameraModel?: string;
  isoSpeed?: number;
  shutter?: number;
  aperture?: number;
  focalLength?: number;
  timestampIso?: string;
}

export interface ExportEncodeRequest {
  /** Tightly packed display-encoded sRGB RGBA8 pixels. */
  data: ArrayBuffer;
  width: number;
  height: number;
  /** Output path; extension picks the format (.jpg/.jpeg/.png). */
  outPath: string;
  /** JPEG quality 1–100 (ignored for PNG). */
  quality: number;
  /** Long-edge resize in px; null = full resolution. */
  maxDim: number | null;
  meta?: ExportExifMeta;
}

export interface ExportEncodeResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

declare global {
  interface Window {
    silverbox: SilverboxApi;
  }
}
