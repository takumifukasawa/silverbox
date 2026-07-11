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
  watchSidecar: 'sidecar:watch',
  sidecarChanged: 'sidecar:changed',
  exportImageDialog: 'dialog:exportImage',
  exportEncode: 'export:encode',
  exportLutDialog: 'dialog:exportLut',
  exportLut: 'export:lut',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  presetsList: 'presets:list',
  presetRead: 'presets:read',
  presetWrite: 'presets:write',
  presetDelete: 'presets:delete',
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
  /**
   * Arm the main-process sidecar watcher for `path` (sidecar hot-reload —
   * the AI-editing loop). Re-armed on every image open; each call tears down
   * whatever this window was previously watching first (see main/index.ts's
   * armSidecarWatch), so there is never more than one live watch per window.
   */
  watchSidecar(path: string): Promise<void>;
  /**
   * Subscribe to main's debounced "the watched sidecar's directory saw a
   * write to its basename" push (~150ms after the last event in a burst —
   * see armSidecarWatch). Carries no payload: the renderer re-reads the
   * sidecar itself via readSidecar and decides what changed. Returns an
   * unsubscribe function.
   */
  onSidecarChanged(callback: () => void): () => void;
  /** Native save dialog for the developed image (.jpg/.png). */
  exportImageDialog(defaultPath: string): Promise<OpenImageDialogResult>;
  /** Encode + write the developed pixels via sharp in the main process. */
  exportEncode(req: ExportEncodeRequest): Promise<ExportEncodeResult>;
  /** Native save dialog for a LUT export base path (suggests a .cube name; the other 3 files land alongside it). */
  exportLutDialog(defaultPath: string): Promise<OpenImageDialogResult>;
  /** Write the .cube + Unity/UE strip PNGs + WebGL snippet computed in the renderer. */
  exportLut(req: ExportLutRequest): Promise<ExportLutResult>;
  /** Filesystem path of a dropped File (webUtils; File.path is gone in Electron 32+). */
  getPathForFile(file: File): string;
  /** Read `<userData>/settings.json` (sanitized; created with defaults on first run). */
  settingsGet(): Promise<Settings>;
  /** Merge `partial` into the persisted settings; returns the full, sanitized result. */
  settingsUpdate(partial: Partial<Settings>): Promise<Settings>;
  /** List `<userData>/presets/*.json` summaries; a malformed file is skipped (never crashes the list). */
  presetsList(): Promise<PresetSummary[]>;
  /** Read one preset's raw JSON text by slug; null if it doesn't exist. */
  presetRead(slug: string): Promise<string | null>;
  /** Write (create or overwrite) one preset's raw JSON text by slug. */
  presetWrite(slug: string, content: string): Promise<void>;
  /** Delete one preset file by slug. */
  presetDelete(slug: string): Promise<void>;
  /**
   * Test-harness flags read from the main-process env at preload time; all
   * false in normal use. `isTest` mirrors SILVERBOX_TEST (the verify suite);
   * `lensProfileAutoDefault` (SILVERBOX_TEST_LENS_PROFILE_DEFAULT) re-enables
   * the "embedded profile ON for fresh opens" default INSIDE the suite — off
   * for the 20 pre-F3b scripts (so their bit-exact CPU baselines are intact),
   * on only for verify-lensprofile which exercises that default.
   * `baseCurveDefault` (SILVERBOX_TEST_BASE_CURVE_DEFAULT) re-enables the
   * "default base curve seeded on fresh ARW opens" default INSIDE the suite —
   * off for every other script (so seeding a tone curve never shifts their
   * fresh-ARW baselines), on only for verify-basecurve which exercises it.
   */
  testFlags: { isTest: boolean; lensProfileAutoDefault: boolean; baseCurveDefault: boolean };
}

/**
 * `<userData>/presets/<slug>.json` listing entry (task #37): individual
 * whole-look JSON files, text-first and git-shareable — same philosophy as
 * the sidecars (ROADMAP.md "Presets"). The renderer owns the file's actual
 * shape (presetVersion/name/createdAt/look — see engine/graph/presetDoc.ts);
 * main only reads/writes bytes and surfaces this minimal summary for the UI.
 */
export interface PresetSummary {
  /** Filename stem (`<slug>.json`), filesystem-safe (letters/digits/_/-). */
  slug: string;
  /** User-facing display name (may differ from slug after sanitization). */
  name: string;
  createdAt: string;
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
  /**
   * Fixed linear gain (in EV, i.e. multiply by 2^EV) applied to RAW decodes
   * ONLY, at decode time — see librawDecoder.ts's noAutoBright doc comment
   * for why LibRaw's own auto-bright is unusable (colorspace-dependent), and
   * decodeWorker.ts's prepareRaw for where this is applied. JPEG ingest is
   * display-referred already and is never touched. 0.5 is a provisional
   * Lightroom/Resolve-style "baseline exposure" pending a side-by-side
   * calibration session against Lightroom (see the Lightroom-reference
   * memory note) — a named, tunable "feel" constant, not derived from math
   * (raised 0.35 → 0.5 after a round-3 hand test still read slightly dark).
   */
  baselineExposureEV: number;
  export: ExportSettingsShape;
  exportPresets: ExportPreset[];
}

/** Defaults for a fresh install / a settings.json that fails to parse. */
export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  autosaveSidecar: true,
  previewLongEdge: 2560,
  baselineExposureEV: 0.5,
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

/**
 * LUT export (task #33): the renderer computes every deliverable's bytes
 * (pure color math — see engine/color/lutExport.ts) and hands them to the
 * main process purely to write files (sharp for the PNGs, plain fs for the
 * text ones) — same division of labor as ExportEncodeRequest.
 */
export interface ExportLutRequest {
  /** `<dir>/<name>` with no extension; the 4 files are written as `<basePath>.cube` / `-unity.png` / `-ue.png` / `-webgl.txt`. */
  basePath: string;
  /** .cube TITLE + webgl snippet comment. */
  name: string;
  cubeText: string;
  /** 1024×32 RGBA8 raw bytes (see lutExport.ts's buildStripPixels). */
  unityRgba: ArrayBuffer;
  /** 256×16 RGBA8 raw bytes. */
  ueRgba: ArrayBuffer;
  webglText: string;
}

export interface ExportLutResult {
  /** [cubePath, unityPngPath, uePngPath, webglTxtPath], in that order. */
  paths: string[];
}

declare global {
  interface Window {
    silverbox: SilverboxApi;
  }
}
