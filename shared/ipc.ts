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
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
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
  /** Filesystem path of a dropped File (webUtils; File.path is gone in Electron 32+). */
  getPathForFile(file: File): string;
  /** Read `<userData>/settings.json` (sanitized; created with defaults on first run). */
  settingsGet(): Promise<Settings>;
  /** Merge `partial` into the persisted settings; returns the full, sanitized result. */
  settingsUpdate(partial: Partial<Settings>): Promise<Settings>;
}

/** EXIF policy for exported images (Toolbar's "export-metadata" select). */
export type ExportMetadataPolicy = 'all' | 'minimal' | 'none';

/** Export color space (Toolbar's "export-colorspace" select); both use the sRGB transfer curve. */
export type ExportColorSpace = 'srgb' | 'p3';

export interface ExportSettingsShape {
  quality: number;
  maxDim: number | null;
  metadata: ExportMetadataPolicy;
  colorSpace: ExportColorSpace;
}

/** A named, saved snapshot of the export controls (Toolbar's "export-preset" select). */
export interface ExportPreset extends ExportSettingsShape {
  name: string;
}

/** Schema version of `<userData>/settings.json`; bump + sanitize on breaking changes (DESIGN.md §9). */
export const SETTINGS_VERSION = 1;

/**
 * Text-first app preferences, persisted at `<userData>/settings.json`. Unknown
 * top-level fields (a newer Silverbox's not-yet-understood keys) are preserved
 * through a load→settingsUpdate→save round-trip by an older build — the same
 * "documents outlive versions" promise DESIGN.md §9 makes for sidecars.
 */
export interface Settings {
  settingsVersion: typeof SETTINGS_VERSION;
  /** Debounced (1s after the last change) sidecar autosave while an image is open. */
  autosaveSidecar: boolean;
  /** Long-edge cap (px) for the interactive decode preview; export always decodes full-res. */
  previewLongEdge: number;
  export: ExportSettingsShape;
  exportPresets: ExportPreset[];
}

/** Defaults for a fresh install / a settings.json that fails to parse. */
export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  autosaveSidecar: true,
  previewLongEdge: 2560,
  export: { quality: 90, maxDim: null, metadata: 'all', colorSpace: 'srgb' },
  exportPresets: [],
};

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
  /** Tightly packed display-encoded RGBA8 pixels (sRGB or Display P3 primaries per `colorSpace`, same transfer curve). */
  data: ArrayBuffer;
  width: number;
  height: number;
  /** Output path; extension picks the format (.jpg/.jpeg/.png). */
  outPath: string;
  /** JPEG quality 1–100 (ignored for PNG). */
  quality: number;
  /** Long-edge resize in px; null = full resolution. */
  maxDim: number | null;
  /** EXIF policy; defaults to 'all' (today's behavior) when omitted. */
  metadata?: ExportMetadataPolicy;
  /** ICC profile attached to the output; defaults to 'srgb' when omitted. */
  colorSpace?: ExportColorSpace;
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
