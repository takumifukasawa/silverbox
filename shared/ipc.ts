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
} as const;

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
}

declare global {
  interface Window {
    silverbox: SilverboxApi;
  }
}
