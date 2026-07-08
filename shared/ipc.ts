/**
 * Typed IPC surface between main and renderer.
 *
 * The preload script exposes `window.silverbox` implementing SilverboxApi;
 * main registers a handler per channel. Keep channel names and signatures in
 * this one file so both sides stay in sync.
 */

export const IPC = {
  ping: 'app:ping',
} as const;

export interface PingResult {
  pid: number;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export interface SilverboxApi {
  ping(): Promise<PingResult>;
}

declare global {
  interface Window {
    silverbox: SilverboxApi;
  }
}
