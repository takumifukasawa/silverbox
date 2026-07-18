/**
 * Typed IPC surface between main and renderer.
 *
 * The preload script exposes `window.silverbox` implementing SilverboxApi;
 * main registers a handler per channel. Keep channel names and signatures in
 * this one file so both sides stay in sync.
 */
import type { DeltaEStats } from './color/deltaE';

export const IPC = {
  ping: 'app:ping',
  openImageDialog: 'dialog:openImage',
  openFolderDialog: 'dialog:openFolder',
  listImages: 'fs:listImages',
  readFile: 'file:read',
  readSidecar: 'sidecar:read',
  writeSidecar: 'sidecar:write',
  watchSidecar: 'sidecar:watch',
  sidecarChanged: 'sidecar:changed',
  // Project storage (docs/brief-bank/project-storage.md, stage 1): the
  // project.silverbox manifest lives OUTSIDE looks/, so it gets its own
  // read/write pair rather than reusing readSidecar/writeSidecar (those are
  // now validated to only ever touch a look file or a legacy adjacent
  // sidecar — see main/index.ts's assertSidecarPath).
  projectRead: 'project:read',
  projectWrite: 'project:write',
  // Cheap per-photo status join for the filmstrip (hasLook/rating/missing),
  // given the project's already-resolved photo list — see FolderImageEntry's
  // doc comment and main/index.ts's handler.
  projectPhotosStatus: 'project:photosStatus',
  // Project storage, stage 3 (docs/brief-bank/project-storage.md — relink +
  // fingerprint + import-sidecars + save-as-move): see main/index.ts's
  // handlers (computeFingerprint's doc comment carries the fingerprint
  // recipe's forever-stable contract) and SilverboxApi's own doc comments.
  fingerprintFile: 'fs:fingerprintFile',
  scanFolderForRelink: 'fs:scanFolderForRelink',
  listSidecarFiles: 'fs:listSidecarFiles',
  moveProjectFiles: 'project:moveFiles',
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
  // Headless CLI renderer (`electron . --render …` — see main/index.ts):
  // main pushes ONE job to the renderer once it signals ready, then the
  // renderer streams results back one at a time as they render.
  cliReady: 'cli:ready',
  cliRun: 'cli:run',
  cliProgress: 'cli:progress',
  cliDone: 'cli:done',
  /**
   * One-way notice channel (renderer → main) for something that isn't a
   * per-file result — currently only the `--project` playlist-fallback case
   * (a photo not on the project's playlist renders with the default look;
   * see CliRenderJob.projectDir's doc comment): always written to STDERR by
   * main regardless of `--json`, since it's not part of any file's
   * structured result and must not get silently swallowed inside a JSON
   * payload nobody greps for warnings in.
   */
  cliWarn: 'cli:warn',
  /**
   * File-association open (project-storage migration, stage 2): main pushes
   * the launched/double-clicked path once the renderer is ready to receive
   * it (see `appReady` below) — packaged app only, see PROJECT_MANIFEST_NAME's
   * doc comment (dev mode `electron .` never gets an OS file-open event).
   */
  openPath: 'app:openPath',
  /**
   * Renderer → main: "I'm mounted and listening for `openPath`." Lets main
   * flush a file-open event it received before the window finished loading
   * (a cold launch via double-click) instead of dropping it — same
   * hold-until-ready shape `cliReady` already uses for the CLI job push.
   */
  appReady: 'app:ready',
  // Golden renders (`--check`/`--update` — see main/goldenRender.ts): the
  // renderer's job is producing pixels (same as any CLI render); main's job
  // is encoding, comparing against the golden PNG on disk, and reporting —
  // this one round-trip per image does all three, main-side.
  goldenCheck: 'golden:check',
  // Sidecar visual diff CLI (`--diff <sidecarA> <sidecarB> --image <arw>` —
  // see main/diffRender.ts): the renderer's job is producing BOTH docs'
  // pixels (renderToPixels, same as any CLI render); main's job is
  // resizing + computing the ΔE stats between them, same "renderer renders,
  // main does the sharp/color-math half" split goldenCheck already uses.
  diffRenderImages: 'cli:diffRender',
  // External-tool hook node (denoise v1 / task #41): main process spawns a
  // user-configured command over temp TIFFs (see src/main/externalTool.ts).
  externalToolRun: 'external:run',
  /** Verify-only: how many times this session actually spawned a subprocess (cache hits/failures-before-spawn don't count) — scripts/verify-external.mjs's "does not re-spawn on an unchanged upstream" check. */
  externalToolSpawnCount: 'external:spawnCount',
  // In-engine ML denoise (denoise v2, stage 1 — docs/brief-bank/denoise-v2.md):
  // main-process ONNX Runtime inference over post-demosaic linear pixels, the
  // SAME "pixels already travel render worker → main" contract v1's external
  // node uses (see src/main/denoise.ts).
  denoiseRun: 'denoise:run',
  /** Verify-only: how many times this session actually ran ORT inference (cache hits don't count) — scripts/verify-denoise.mjs's cache check, spawnCount-style. */
  denoiseRunCount: 'denoise:runCount',
  // Look extraction, mode 1 (docs/brief-bank/look-extraction.md — sidecar
  // consensus): `--extract-look` writes an arbitrary, CLI-chosen output
  // path, unlike presetWrite (userData/presets/<slug>.json only) or
  // writeSidecar (project looks/ only) — same "trust the CLI's own --out
  // argument" level exportEncode's outPath already operates at (see
  // main/index.ts's handler).
  extractLookWrite: 'cli:extractLookWrite',
} as const;

/** Suffix of the GraphDoc sidecar written next to the image file. Retired as a WRITE target by the project-storage migration (stage 1) — still READ forever (principle 9) for legacy adjacent sidecars and CLI import. */
export const SIDECAR_SUFFIX = '.silverbox.json';

/**
 * Filename of a project's manifest (docs/brief-bank/project-storage.md):
 * `<projectDir>/project.silverbox` — JSON, schemaVersion + name + playlist
 * (see engine/graph/projectDoc.ts). Double-clicking one in Finder opens the
 * app on that project once electron-builder's fileAssociations ship
 * (packaged app only, stage 2+); drag-drop and "Open project…" work
 * regardless (see App.tsx / window.__openProjectByPath).
 */
export const PROJECT_MANIFEST_NAME = 'project.silverbox';

/**
 * Suffix of the golden reference render written next to the image file
 * (ROADMAP "Golden renders" — `<image>.silverbox.golden.png`, e.g.
 * `photo.ARW.silverbox.golden.png`). Ends in `.png`, a different basename
 * than SIDECAR_SUFFIX, so the sidecar hot-reload watcher's exact-basename
 * filter (main/index.ts's armSidecarWatch) never mistakes a golden write for
 * a sidecar change.
 */
export const GOLDEN_SUFFIX = '.silverbox.golden.png';

/** Long edge (px) every golden PNG is rendered/resized to — fixed, not user-configurable (see CliCheckJob's doc comment). */
export const GOLDEN_LONG_EDGE = 512;

export interface PingResult {
  pid: number;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export type OpenImageDialogResult = { canceled: true } | { canceled: false; path: string; fileName: string };

/**
 * Pick/reject flag (reject-flag pack, docs/brief-bank/reject-flag.md):
 * independent metadata axis from `rating` — a photo can be rejected AND
 * still keep its stars (LR-consistent). Lives on the look wrapper's `flag`
 * key, identity-omission convention (absent = unflagged, never a written
 * `null`) — see graphDoc.ts's `SidecarDoc.flag`/`sanitizeFlag`. Shared here
 * (rather than defined once in graphDoc.ts and imported back) because
 * `FolderImageEntry.flag` below needs it and main/index.ts's cheap wrapper
 * read can't import renderer engine code, the same reason
 * `ExportMetadataPolicy`/`ExportColorSpace` already live in this file.
 */
export type PhotoFlag = 'pick' | 'reject';

/**
 * One entry in the filmstrip (ROADMAP "Folder filmstrip" — nothing here is
 * written anywhere, it's recomputed every time the strip refreshes).
 * Post-project-storage-migration (stage 1), the strip renders the ACTIVE
 * PROJECT's playlist, not a raw directory listing: `main/index.ts`'s
 * `listImages` handler still enumerates a folder's images (used to discover
 * what to ADD to the playlist — see appStore.ts's openFolder), but
 * `hasLook`/`rating`/`flag`/`missing` below come from the project's own
 * `projectPhotosStatus` handler instead (a photo's look lives in
 * `<projectDir>/looks/`, never next to the photo — see docs/brief-bank/
 * project-storage.md). The renderer never polls the filesystem itself.
 */
export interface FolderImageEntry {
  /** Basename (e.g. "DSC02993.ARW") — the cell's hover title. */
  name: string;
  /** Absolute path — what openImageByPath / the thumbnail cache key off of. */
  path: string;
  /** A look exists for this photo in the active project's `looks/` (renamed from `hasSidecar` — project-storage migration; the filmstrip's "edited" dot). */
  hasLook: boolean;
  /** mtime in ms; 0 when `missing` (nothing to stat). Not used for sorting today (filename order is — see listImages's doc comment), kept for a possible future "sort by date". */
  mtimeMs: number;
  /**
   * Star rating 0..5 (ratings pack), read cheaply off the look's wrapper
   * (never the full GraphDoc schema, and never throws on a malformed look
   * file; see extractWrapperMeta in src/main/index.ts). 0 for both "no
   * look yet" and "look has no/invalid rating" — the filmstrip cell and the
   * ★n+ filter treat those identically (unrated).
   */
  rating: number;
  /**
   * Pick/reject flag (reject-flag pack), read cheaply off the look's
   * wrapper the same way `rating` is (never the full GraphDoc schema, never
   * throws on a malformed look file — see `extractWrapperMeta` in
   * src/main/index.ts). `null` for both "no look yet" and "look has no/
   * invalid flag" — same "absent == unflagged" fallback `rating`'s `0` uses.
   */
  flag: PhotoFlag | null;
  /**
   * This playlist entry's photo path did not resolve to a readable file
   * (moved/deleted since it was added) — shown as a placeholder cell, never
   * silently dropped (project-storage migration §"Missing photos"). Full
   * relink UI is stage 3; here it's display-only.
   */
  missing: boolean;
}

/**
 * Per-file outcome of moveProjectFiles (NG fix pack — "Save as project…"
 * used to abort the whole batch on the first row with no look file to
 * move). `moved` and `missingLook` are both counts because the CALLER
 * (appStore.ts's saveQuickProjectAs) treats them identically for playlist
 * migration purposes — only `failed` needs the individual look names, since
 * those rows stay behind in the source project and the reason is worth
 * showing.
 */
export interface MoveProjectFilesResult {
  /** Looks (and, where present, their golden/ PNG) that physically moved. */
  moved: number;
  /** Rows with no look file at all yet (an opened-but-never-edited photo) — the row still migrates, there's just nothing to rename. */
  missingLook: number;
  /** Looks that exist but could not be moved (permissions, an unreadable file, …) — the row stays in the SOURCE project untouched. */
  failed: { name: string; reason: string }[];
}

export interface SilverboxApi {
  ping(): Promise<PingResult>;
  /**
   * Show the native open dialog filtered to supported image types. The main
   * photo-open path (Toolbar's "Open…", openImageViaDialog) always calls
   * this with no argument and MUST keep seeing exactly IMAGE_EXTENSIONS
   * (RAW + JPEG) — unchanged since before the Image node existed. Pass
   * `scope: 'imageNode'` ONLY from the Image node's own "Choose…" picker
   * (round-9 fix pack item 4, "maskはpngも許容でいい気がする"): it reuses
   * this same channel but additionally offers PNG, since the Image node's
   * decode path (decodeWorker.ts's prepareJpeg) already handles PNG natively
   * via createImageBitmap — RAW isn't a sensible reference/mask file, but
   * nothing stops IMAGE_EXTENSIONS' RAW kinds from still being offered here
   * too (the filter is additive, not a narrowing).
   */
  openImageDialog(scope?: 'imageNode'): Promise<OpenImageDialogResult>;
  /** Show the native folder-picker dialog (folder filmstrip, ROADMAP "nice to have"). */
  openFolderDialog(): Promise<OpenImageDialogResult>;
  /**
   * List `dir`'s supported images (IMAGE_EXTENSIONS, no recursion), sorted by
   * filename — folder filmstrip's one piece of main-process surface. Throws
   * (ENOTDIR/ENOENT etc.) if `dir` isn't a readable directory; callers that
   * need to distinguish "dropped a folder" from "dropped a file" rely on
   * that (see App.tsx's drop handler).
   */
  listImages(dir: string): Promise<FolderImageEntry[]>;
  /** Read a file's bytes (used after dialog / drag-and-drop resolves a path). */
  readFile(path: string): Promise<ArrayBuffer>;
  /**
   * Read a look/sidecar file; null if it does not exist. Accepts a legacy
   * adjacent `<image>.silverbox.json` path OR a project look path
   * (`<projectDir>/looks/<name>.json`) — see main/index.ts's assertSidecarPath.
   */
  readSidecar(path: string): Promise<string | null>;
  /**
   * Write a look file. Main accepts ONLY a path inside some project's
   * `looks/` directory (project-storage migration's absolute etiquette
   * rule: the app never writes into a photo folder — see
   * assertSidecarPath's write-mode check); anything else throws.
   */
  writeSidecar(path: string, content: string): Promise<void>;
  /** Read `<dir>/project.silverbox`'s raw text; null if it does not exist (including when `dir` itself isn't a directory yet). */
  readProjectManifest(dir: string): Promise<string | null>;
  /**
   * Atomically write `<dir>/project.silverbox` (mkdtemp+rename, same
   * discipline as writeSidecar/settings.ts); also ensures `dir` and
   * `dir/looks` exist first (mkdir recursive), so this ONE call is what lets
   * the quick-project flow "create dir + manifest if missing" — an
   * already-existing project directory is a harmless no-op.
   */
  writeProjectManifest(dir: string, content: string): Promise<void>;
  /**
   * Cheap per-photo status for the filmstrip: `photos` is the project's
   * playlist with each `path` ALREADY RESOLVED to absolute (see
   * engine/graph/projectDoc.ts's resolveProjectPath) — main stays
   * project-path-agnostic, just stats each resolved path (existence →
   * `missing`) and reads `<dir>/looks/<look>` cheaply for `hasLook`/`rating`/
   * `flag` (extractWrapperMeta — never the full GraphDoc schema, never
   * throws on a malformed look file).
   */
  projectPhotosStatus(dir: string, photos: { path: string; look: string }[]): Promise<FolderImageEntry[]>;
  /**
   * Cheap content fingerprint of a photo file (project-storage migration,
   * stage 3 — relink's verification anchor): see main/index.ts's
   * computeFingerprint doc comment for the exact byte recipe (a forever-
   * stable contract once shipped) and SidecarDoc.fingerprint's doc comment
   * for where the result gets stored. null when `path` doesn't resolve to a
   * readable file (same "not there" convention as readSidecar).
   */
  fingerprintFile(path: string): Promise<string | null>;
  /**
   * "Scan folder for candidates" (Missing photos, stage 3): one round trip
   * walks `dir` non-recursively (IMAGE_EXTENSIONS filter, same as
   * listImages), checking basename-matching files first then the rest,
   * fingerprinting each against `expectedFingerprint` until a match — or,
   * when the row's look never had a fingerprint to verify against
   * (`expectedFingerprint === null`), falling back to an unverified exact
   * `basenameHint` match. Returns the matching candidate's absolute path, or
   * null when nothing matches.
   */
  scanFolderForRelink(dir: string, basenameHint: string, expectedFingerprint: string | null): Promise<string | null>;
  /**
   * "Import sidecars from folder…" (Migration & compatibility, stage 3):
   * absolute paths of every adjacent legacy sidecar (`*.silverbox.json`) in
   * `dir`, non-recursive, sorted. Pure enumeration — appStore.ts's
   * importSidecarsFromFolder reads/parses/rewrites each one into the active
   * project's `looks/`.
   */
  listSidecarFiles(dir: string): Promise<string[]>;
  /**
   * "Save as project…" (Quick project → real project, MOVE not copy — user
   * decision, docs/brief-bank/project-storage.md's "Quick project" section):
   * physically relocates each `lookNames` entry's look file (and its
   * `golden/` PNG, if any) from `<srcDir>/looks/` into `<destDir>/looks/`.
   * Manifest writes are NOT this call's job — the renderer writes both
   * projects' manifests itself through writeProjectManifest, same as every
   * other playlist mutation; this is purely the filesystem move.
   *
   * NG fix pack (per-file tolerance — a real user hit an ENOENT that aborted
   * the WHOLE batch mid-way, because a playlist row can be a photo that was
   * only ever OPENED, never edited: autosave writes a look only on a dirty
   * session, so that row simply has no file at `<srcDir>/looks/<name>.json`
   * yet): a look with nothing to move is `missingLook`, not a thrown error —
   * the row itself still migrates (appStore.ts's saveQuickProjectAs treats
   * `missingLook` the same as `moved`, since there's no file left behind
   * either way). Only a genuinely unexpected per-file error (permissions, a
   * directory where a file should be, …) lands in `failed`, and even then
   * every OTHER file in the batch still gets its own attempt — this call
   * never throws for a single file's problem, only for something
   * batch-level (e.g. `destDir` itself can't be created).
   */
  moveProjectFiles(srcDir: string, destDir: string, lookNames: string[]): Promise<MoveProjectFilesResult>;
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
   * `forceDefaults` mirrors SILVERBOX_CLI_RENDER, set by main ONLY for the
   * `--render` CLI mode (see main/index.ts) — it forces BOTH auto-defaults
   * on regardless of `isTest`, because the CLI must match a fresh open's
   * real look (base curve + lens profile) even when verify-cli.mjs itself
   * runs under SILVERBOX_TEST=1 for its own windowless/userData isolation.
   * `projectDirOverride` mirrors SILVERBOX_TEST_PROJECT (project-storage
   * migration's verify-suite lever): when set, it WINS over the
   * `quickProjectDir` setting as the quick-project directory, used EXACTLY
   * as given (no subdir) — null in normal use, where the setting applies.
   */
  testFlags: {
    isTest: boolean;
    lensProfileAutoDefault: boolean;
    baseCurveDefault: boolean;
    forceDefaults: boolean;
    projectDirOverride: string | null;
  };
  /**
   * Subscribe to main's ONE-TIME `--render`/`--check` job push (headless CLI
   * mode only — see main/index.ts). `job.mode` selects which of
   * runCliRender/runCliCheck (appStore.ts) handles it. Returns an
   * unsubscribe function; the renderer calls `cliReady()` right after
   * registering so main knows it's safe to send (avoids a race against
   * React mount).
   */
  onCliRun(callback: (job: CliJob) => void): () => void;
  /** Tell main the renderer's CLI listener is registered and ready for the job. */
  cliReady(): void;
  /** Stream one rendered/checked file's result (or error) back to main as it completes. */
  cliProgress(result: CliProgressResult): void;
  /** Tell main every image in the job has been attempted; main prints the summary and exits. */
  cliDone(): void;
  /** Send a `cli:warn` notice (see IPC.cliWarn's doc comment) — always printed to main's stderr, independent of `--json`. */
  cliWarn(message: string): void;
  /**
   * Write the extracted-preset JSON to an ARBITRARY path (`--extract-look
   * … --out <path>` — docs/brief-bank/look-extraction.md mode 1): atomic
   * write (mkdtemp+rename, same discipline as writeSidecar/settings.ts),
   * `dirname(path)` created on demand. Deliberately UNRESTRICTED (unlike
   * writeSidecar/presetWrite's path guards) — the path comes straight from
   * the CLI invoker's own `--out` argument, the same trust level
   * ExportEncodeRequest.outPath already operates at; only ever called from
   * runCliExtractLook, never reachable from the interactive app.
   */
  writeExtractedPreset(path: string, content: string): Promise<void>;
  /**
   * Subscribe to main's file-association open push (project-storage
   * migration, stage 2 — see IPC.openPath's doc comment): `path` is the
   * launched/double-clicked `project.silverbox` (or a directory containing
   * one). Returns an unsubscribe function; App.tsx registers this once at
   * mount, then calls `appReady()`.
   */
  onOpenPath(callback: (path: string) => void): () => void;
  /** Tell main the renderer is mounted and ready to receive an `openPath` push (flushes one queued from before the window finished loading). */
  appReady(): void;
  /**
   * Golden-render check/update for one image (`--check`/`--update` — see
   * main/goldenRender.ts): hands main the full-resolution rendered pixels
   * (same shape as ExportEncodeRequest's `data`); main resizes to the
   * golden's fixed 512px long edge, then either writes the golden PNG
   * (`update: true`) or decodes the existing one and compares. All the
   * encode/compare/report work is main-side — see runCliCheck's doc comment.
   */
  checkGoldenImage(req: CliCheckImageRequest): Promise<CliCheckOutcome>;
  /**
   * Sidecar visual diff CLI (`--diff`): given both docs' already-rendered
   * full-resolution RGBA8 sRGB pixels (SAME width/height — the caller
   * (appStore.ts's runCliDiff) already checked that and reports
   * `dims-changed` itself otherwise, same as golden's own dims-changed
   * short-circuit), resize both to the golden long edge and report CIE76 ΔE
   * stats between them.
   */
  diffRenderImages(req: CliDiffImageRequest): Promise<CliDiffImageResult>;
  /**
   * Run an external-tool hook node's command over temp TIFFs (task #41).
   * SECURITY: the caller (externalNodeRunner.ts) is the ONLY gate — it must
   * never call this for a (doc, command) pair the user (or `--allow-external`)
   * hasn't explicitly confirmed this session. Resolves `{ok:false,reason}`
   * rather than throwing on a subprocess failure/timeout/malformed output, so
   * a broken command never surfaces as an unhandled rejection.
   */
  runExternalTool(req: ExternalToolRequest): Promise<ExternalToolResult>;
  /** Verify-only: real subprocess spawn count this session (cache hits don't count) — scripts/verify-external.mjs. */
  externalToolSpawnCount(): Promise<number>;
  /**
   * In-engine ML denoise (denoise v2, stage 1): run the pinned NAFNet ONNX
   * model (tiled, see src/main/denoiseInfer.ts) over one denoise node's
   * upstream pixels. SECURITY (defense in depth, unlike v1's external node):
   * main re-checks `denoiseModelConsent` itself before ever downloading —
   * the caller passing a request is NOT sufficient authorization for a
   * network fetch, only for using an ALREADY-present model. Resolves
   * `{ok:false,...}` rather than throwing on any failure (missing model, no
   * consent, download/hash-verify failure, ORT init/inference error) — same
   * "never throws, caller does passthrough+badge" contract as
   * runExternalTool.
   */
  runDenoise(req: DenoiseRunRequest): Promise<DenoiseRunResult>;
  /** Verify-only: real ORT inference run count this session (cache hits don't count) — scripts/verify-denoise.mjs. */
  denoiseRunCount(): Promise<number>;
}

/**
 * A preset reference resolved by main from the CLI's `--preset <name|path>`
 * argument (see src/main/cliArgs.ts): a value ending in `.json` is a FILE
 * PATH (already resolved absolute against the launch cwd); anything else is
 * a NAME looked up against `<userData>/presets` (by display name, falling
 * back to slug) — same two-way lookup semantics as the UI's preset picker.
 */
export type CliRenderPresetRef = { kind: 'path'; value: string } | { kind: 'name'; value: string };

/**
 * The whole batch job for one `--render` invocation, built by main
 * (src/main/cliArgs.ts's buildCliJob) from parsed argv + the launch
 * cwd — every path here is already absolute, so the renderer never needs to
 * know what directory the CLI was invoked from.
 */
export interface CliRenderJob {
  mode: 'render';
  /**
   * Absolute paths, in argv order. An entry ending in `.json` is a LOOK FILE
   * (`<project>/looks/<name>.json`, or any standalone look carrying a
   * `photo` field — CLI tooling parity, project-storage.md stage 2), not an
   * image: appStore.ts's runCliRender parses it, resolves its `photo` field
   * relative to the look's own project dir (parent of `looks/`), and renders
   * THAT photo with the look's own graph verbatim (geometry included — unlike
   * `--preset`, a look file is a real per-photo document, not a foreign look
   * being merged onto identity geometry). A look with no `photo` field
   * (including a legacy adjacent sidecar passed by mistake) is a per-file
   * error naming the field and the fix.
   */
  images: string[];
  /**
   * `--project <dir>` (CLI tooling parity, project-storage.md stage 2):
   * every plain-image entry in `images` resolves its look from THIS
   * project's playlist (`<projectDir>/looks/`) instead of the legacy
   * adjacent sidecar — a photo not on the playlist renders with the default
   * look and a `cliWarn` notice (never auto-added to the playlist; a
   * headless batch must not silently mutate someone's project). null =
   * today's legacy behavior, byte-identical: each image reads/renders its
   * own adjacent `<image>.silverbox.json` if any (openImageByPath's
   * `legacySidecarOnly`).
   */
  projectDir: string | null;
  /** Absolute output directory; null = alongside each input. */
  outDir: string | null;
  /** null = use each image's own sidecar (or the default look if none). */
  preset: CliRenderPresetRef | null;
  /** A named output, `'all'` (every output, suffixed), or null = the doc's first. */
  output: string | null;
  quality: number;
  maxDim: number | null;
  metadata: ExportMetadataPolicy;
  colorSpace: ExportColorSpace;
  /**
   * `--min-rating n` (ratings pack): skip any input whose sidecar rating is
   * absent or < n, reported via cliProgress as `{input,status:"skipped-
   * rating"}` rather than rendered — read cheaply (readSidecar + a bare
   * JSON.parse of the wrapper's `rating` key, see appStore.ts's
   * readSidecarWrapperMetaCheap) BEFORE the expensive decode/render, so a
   * `--min-rating` batch over a folder full of unrated images never pays for
   * decoding any of them. null = no filtering (every image renders).
   */
  minRating: number | null;
  /**
   * `--skip-rejected` (reject-flag pack): skip any input whose sidecar/look
   * is flagged `reject`, reported via cliProgress as `{input,status:
   * "skipped-rejected"}` — read the same cheap wrapper way `minRating` reads
   * `rating` (see appStore.ts's readSidecarWrapperMetaCheap), BEFORE the
   * expensive decode/render. Unlike `minRating` this ALSO applies to
   * `--check` (see CliCheckJob.skipRejected) — a batch job over someone
   * else's rejects shouldn't render OR golden-check them either. false = no
   * filtering (today's behavior, unchanged — a user flagging photos in the
   * GUI must never silently change an existing script's output without this
   * explicit opt-in).
   */
  skipRejected: boolean;
  /**
   * `--allow-external` (external-tool hook node, task #41): a doc's
   * `external` nodes are non-realtime, opaque subprocess invocations — the
   * CLI never runs one without this explicit opt-in (SECURITY: a batch job
   * over someone else's sidecars must not silently execute arbitrary
   * commands). Without it, every external node renders pass-through and a
   * warning is appended to that file's CliRenderResult (see `warnings`
   * below); with it, the SAME confirm-free trust the flag itself grants
   * applies — no interactive confirm button (that's a UI-only concept, see
   * externalNodeRunner.ts).
   */
  allowExternal: boolean;
}

/**
 * One rendered file's result, one skipped-by-rating (`--min-rating`) or
 * skipped-rejected (`--skip-rejected`) input — neither ever counted as a
 * failure, see main/index.ts's runCliMode — or one image's failure —
 * streamed via cliProgress, one per line under `--json` (NDJSON).
 */
export type CliRenderResult =
  | {
      input: string;
      output: string;
      width: number;
      height: number;
      bytes: number;
      ms: number;
      /** Non-fatal notes for this file (currently only "external node bypassed — pass `--allow-external`"). Never affects the exit code. */
      warnings?: string[];
    }
  | { input: string; status: 'skipped-rating' | 'skipped-rejected' }
  | { input: string; error: string };

/**
 * The whole batch job for one `--check` invocation (golden renders, ROADMAP
 * "Golden renders" — see main/goldenRender.ts), built by main
 * (src/main/cliArgs.ts's buildCliJob). Unlike CliRenderJob there is no
 * outDir/preset/output/quality/maxDim/metadata/colorSpace: the golden always
 * lives at `<image>.silverbox.golden.png` (next to the image/sidecar),
 * always at the fixed 512px long edge, always the image's own sidecar-or-
 * default look, always the doc's first output — the whole point is that a
 * check run reproduces exactly what an ordinary `--render` of that image
 * would look like, so there is nothing else to configure.
 */
export interface CliCheckJob {
  mode: 'check';
  /** Absolute paths, in argv order. */
  images: string[];
  /**
   * `--project <dir>` (CLI tooling parity, project-storage.md stage 2): same
   * playlist resolution as CliRenderJob.projectDir, PLUS it relocates where
   * the golden itself lives — `<projectDir>/golden/<look-name>.png` instead
   * of the legacy `<image>.silverbox.golden.png` next to the photo (the
   * etiquette rule applies to goldens too: the app never writes into a photo
   * folder). `<look-name>` is the resolved look's filename with `.json`
   * dropped — the playlist row's own look name when the photo is on it, else
   * the same deterministic name `deriveLookName` would assign (never
   * written to the manifest — a `--check` run must not mutate the playlist
   * either). null = legacy adjacent golden, unchanged (main prints a
   * one-line stderr note that this path is legacy — see main/index.ts's
   * runCliMode).
   */
  projectDir: string | null;
  /** `--update`: (re)write the golden instead of comparing against it. */
  update: boolean;
  /** `--threshold`: max mean ΔE (CIE76) to still call it a pass; see CliCheckOutcome. */
  threshold: number;
  /**
   * `--skip-rejected` (reject-flag pack): unlike `--min-rating` (render-only,
   * rejected outright with `--check`), this ALSO applies here — see
   * CliRenderJob.skipRejected's doc comment for why. Reported as
   * `{input,status:"skipped-rejected"}`, same never-a-failure bucket as
   * `no-golden`/`dims-changed` is NOT in.
   */
  skipRejected: boolean;
}

/**
 * The whole job for one `--diff <sidecarA> <sidecarB> [--image <arw>]`
 * invocation (sidecar visual diff, git-native completion brief §1), built by
 * main (src/main/cliArgs.ts's buildCliJob). Unlike CliRenderJob/CliCheckJob
 * this is never a batch over multiple images — the brief's own CLI shape is
 * singular: two sidecar FILES (however the caller obtained them — the CLI's
 * `--help` documents the `git show rev:path > tmp` recipe; this job never
 * shells to git itself) compared against ONE image.
 */
export interface CliDiffJob {
  mode: 'diff';
  /**
   * `--project <dir>` (CLI tooling parity, project-storage.md stage 2): lets
   * a relative `sidecarA`/`sidecarB` path resolve against the project dir
   * instead of the launch cwd (src/main/cliArgs.ts's buildCliJob) — the diff
   * itself never mutates or even reads the project's manifest.
   */
  projectDir: string | null;
  /** Absolute path to sidecar A's JSON text (the "before" side of the arrow in every diffLook line). */
  sidecarA: string;
  /** Absolute path to sidecar B's JSON text (the "after" side). */
  sidecarB: string;
  /**
   * Absolute path to the image both sidecars are rendered against; null when
   * `--image` was omitted (CLI tooling parity, project-storage.md stage 2)
   * — appStore.ts's runCliDiff then derives it from both sidecars' `photo`
   * field (resolved relative to each one's own project dir): if both agree
   * on the same resolved path, that's the image; if either lacks `photo` or
   * they disagree, it's a clear per-run error (never a silent guess).
   */
  image: string | null;
}

/**
 * The whole job for one `--extract-look <look…> --out <path>` invocation
 * (look extraction mode 1 — sidecar-consensus distillation, docs/brief-bank/
 * look-extraction.md), built by main (src/main/cliArgs.ts's buildCliJob).
 * Unlike CliRenderJob/CliCheckJob this is never a per-image batch — like
 * CliDiffJob it's ONE job producing ONE outcome: N look/sidecar files in,
 * one consensus preset file out. Never decodes/renders anything (pure JSON
 * math over each look's Develop params — see engine/look/consensus.ts), so
 * there is no `image` field at all, unlike CliDiffJob.
 */
export interface CliExtractLookJob {
  mode: 'extract-look';
  /** Absolute paths to each input look/sidecar JSON file, in argv order (parseCliArgs' own positional-argument bucket, shared with CliRenderJob.images — see its own doc comment for why that's fine here too). At least one, enforced at parse time. */
  looks: string[];
  /** Absolute path to the preset FILE this job writes (`--out <path>`, required for this mode — unlike CliRenderJob.outDir, which is a DIRECTORY and optional). */
  outPath: string;
  /**
   * `--families id1,id2,…` (shape-validated only by cliArgs.ts — plain
   * strings, not `PresetFamilyId[]`, same isomorphic-file reason
   * Settings.presetSaveFamilies is a plain string[]; the renderer's
   * runCliExtractLook validates against the real vocabulary and rejects an
   * unknown/structural id with a clear error). null = every 'develop'-group
   * family is considered (presetFamilies.ts's own default set).
   */
  families: string[] | null;
  /** `--min-agreement <0-1>` — per-family inclusion gate; null = engine/look/consensus.ts's own DEFAULT_AGREEMENT_THRESHOLD. */
  minAgreement: number | null;
}

/** Either job shape `cli:run` can carry; the renderer branches on `mode`. */
export type CliJob = CliRenderJob | CliCheckJob | CliDiffJob | CliExtractLookJob;

/** Golden-render outcome for one status that isn't a pass/fail ΔE comparison. */
export type CliCheckStatus =
  /** No golden exists next to this image and `--update` was not given — always a FAILURE (see CliCheckOutcome). */
  | 'no-golden'
  /** `--update`: the golden was (re)written. */
  | 'updated'
  /** The current render's dimensions differ from the stored golden's (the image's aspect ratio changed — a crop
   *  edit since the golden was made) — reported as a FAILURE rather than resampled to compare, because a changed
   *  aspect ratio IS look drift by definition. */
  | 'dims-changed'
  /**
   * `--skip-rejected` (reject-flag pack, CliCheckJob.skipRejected): this
   * input's sidecar/look is flagged `reject` — never opened/rendered/golden-
   * compared at all, and (unlike `no-golden`/`dims-changed` above) never a
   * FAILURE — same never-a-failure bucket `skipped-rating` already has for
   * `--render` (see main/cliArgs.ts's formatCliProgress).
   */
  | 'skipped-rejected';

/** One `--check` image's outcome: a real ΔE comparison, or a status that short-circuits it. */
export type CliCheckOutcome =
  | { input: string; deltaE: DeltaEStats; pass: boolean }
  | { input: string; status: CliCheckStatus };

/** CliCheckOutcome plus the same {input,error} failure shape CliRenderResult uses — streamed via cliProgress. */
export type CliCheckResult = CliCheckOutcome | { input: string; error: string };

/**
 * One `--diff` outcome: `lines` is diffLook's param-language summary
 * (`engine/look/diffLook.ts`) between sidecarA and sidecarB — always present,
 * even on a dims mismatch, since the PARAM diff needs no successful pixel
 * comparison at all (`lines` is the load-bearing half; `deltaE` is the
 * garnish, see the brief). `status: 'dims-changed'` mirrors CliCheckStatus's
 * own case: the two docs' geometry (e.g. a crop) renders to different
 * dimensions, so there is nothing to compare pixel-for-pixel — reported
 * rather than resampled to force a comparison.
 */
export type CliDiffOutcome =
  | { input: string; lines: string[]; deltaE: DeltaEStats }
  | { input: string; lines: string[]; status: 'dims-changed' };

/** CliDiffOutcome plus the same {input,error} failure shape every other CLI result uses — streamed via cliProgress. */
export type CliDiffResult = CliDiffOutcome | { input: string; error: string };

/**
 * The one `--extract-look` outcome (see CliExtractLookJob's doc comment).
 * `input` holds the WRITTEN output path (same as `outputPath`) rather than
 * an input file — there is no single "input" for a consensus job, and every
 * CliProgressResult variant needs an `input` for formatCliProgress's uniform
 * addressing. `report` is engine/look/consensus.ts's formatConsensusReport
 * output — per-family agreement + per-param spread lines (the brief's "fit
 * report"), never a raw curve point dump (same restraint diffLook.ts's own
 * curve summary uses).
 */
export interface CliExtractLookOutcome {
  input: string;
  outputPath: string;
  /** Family ids that made it into the written preset's `includes`. */
  includes: string[];
  /** Family ids considered but excluded (below the agreement threshold, or filtered out by `--families`). */
  excluded: string[];
  report: string[];
}

/** CliExtractLookOutcome plus the same {input,error} failure shape every other CLI result uses — streamed via cliProgress. */
export type CliExtractLookResult = CliExtractLookOutcome | { input: string; error: string };

/** Whatever cliProgress carries — main's formatter (cliArgs.ts's formatCliProgress) branches on shape. */
export type CliProgressResult = CliRenderResult | CliCheckResult | CliDiffResult | CliExtractLookResult;

/**
 * Request for one image's golden check/update (`window.silverbox.checkGoldenImage`
 * — see main/goldenRender.ts). `data`/`width`/`height` are the SAME
 * full-resolution display-encoded RGBA8 sRGB pixels a normal export would
 * produce (renderScale 1, colorSpace 'srgb') — main resizes to the golden's
 * fixed long edge itself, reusing the export pipeline's own resize, so a
 * check run's render is byte-for-byte the same pipeline as `--render`.
 */
export interface CliCheckImageRequest {
  input: string;
  data: ArrayBuffer;
  width: number;
  height: number;
  update: boolean;
  threshold: number;
  /**
   * `--project <dir>`'s golden relocation (CliCheckJob.projectDir's doc
   * comment): when set, main reads/writes THIS path instead of deriving
   * `${input}${GOLDEN_SUFFIX}` — appStore.ts's runCliCheck computes it as
   * `<projectDir>/golden/<look-name>.png` once the image's look is resolved.
   * Main creates `<projectDir>/golden/` on demand (mkdir recursive) since
   * it's inside the project, not a photo folder.
   */
  goldenPath?: string;
}

/**
 * Request for one `--diff` comparison's ΔE half
 * (`window.silverbox.diffRenderImages` — see main/diffRender.ts). `dataA`/
 * `dataB` are the SAME full-resolution display-encoded RGBA8 sRGB pixels a
 * normal export would produce, for sidecarA's and sidecarB's renders
 * respectively — both MUST already share `width`/`height` (the caller checks
 * this itself and reports `dims-changed` without ever calling this when they
 * don't, see CliDiffOutcome's doc comment).
 */
export interface CliDiffImageRequest {
  dataA: ArrayBuffer;
  dataB: ArrayBuffer;
  width: number;
  height: number;
}

export interface CliDiffImageResult {
  deltaE: DeltaEStats;
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
  /**
   * Quick-project directory (project-storage migration, stage 1): where a
   * photo lands when no project is active yet — a real, VISIBLE folder the
   * user can open/inspect/git, NOT an app-internal cache (the hidden-
   * central-library failure mode docs/brief-bank/project-storage.md
   * explicitly rejects). Empty string here means "not yet resolved" — this
   * file (shared/ipc.ts) is isomorphic (renderer + preload + main) and can't
   * call `os.homedir()`; main's sanitizeSettings (src/main/settings.ts)
   * computes the real default (`join(homedir(), 'Silverbox', 'Quick')`)
   * whenever this field is absent/blank, so by the time settingsGet()
   * resolves in the renderer it's always a real path. `SILVERBOX_TEST_PROJECT`
   * overrides this at the testFlags level (see its own doc comment) for the
   * verify suite.
   */
  quickProjectDir: string;
  /**
   * In-engine ML denoise (denoise v2, stage 1): "Download denoise model
   * (~112 MB)?" one-time consent (docs/brief-bank/denoise-v2.md's SECURITY
   * section) — false until the user explicitly clicks the Inspector's
   * consent button ONCE, ever; true persists across every future doc/session
   * ("once per install, not per session"). main's model-ensure logic
   * (src/main/denoiseModel.ts) is the ONLY place this gates an actual
   * network download — it re-reads this field itself rather than trusting
   * the renderer's call site, so a doc opened from the internet can never
   * trigger a silent download even if some future caller forgot to check
   * first (defense in depth, unlike v1 external node's fully-trusting model,
   * because "may we hit the network for 112MB" is a materially different
   * risk than "run a command the user already typed in").
   */
  denoiseModelConsent: boolean;
  /**
   * Self-hoster override for DENOISE_MODEL_URL (shared/denoiseModel.ts) —
   * empty string = use the default GitHub release asset. Never bypasses the
   * sha256 verification (DENOISE_MODEL_SHA256 is fixed regardless of URL), so
   * an override can only point at a mirror of the SAME pinned artifact, not
   * an arbitrary substitute model.
   */
  denoiseModelUrl: string;
  /**
   * Preset scoping (docs/brief-bank/preset-scoping-and-export-overrides.md
   * §1): last-used family checkbox state in the preset Save dialog
   * (FamilyScopeDialog.tsx via PresetsMenu.tsx), remembered LR-style across
   * saves/sessions. Plain family-id strings, not `PresetFamilyId[]` — this
   * file is isomorphic and deliberately doesn't import the renderer-only
   * engine/graph/presetFamilies.ts module; src/main/settings.ts's
   * sanitizeSettings only checks the array/string SHAPE, the same lenient
   * "malformed value degrades quietly" convention as every other field
   * here. An id this build doesn't recognize is preserved rather than
   * dropped (same forward-compat reasoning as a preset file's own
   * `includes` — see presetDoc.ts). A test in presetFamilies.test.ts pins
   * this array equal to presetFamilies.ts's own DEFAULT_CHECKED_FAMILY_IDS
   * so the two can never silently drift apart.
   */
  presetSaveFamilies: string[];
  /**
   * Multi-select sync (docs/brief-bank/multi-select-sync.md): last-used
   * family checkbox state in the Sync… dialog — the SAME FamilyScopeDialog
   * component as presetSaveFamilies above (see its own doc comment for why
   * this is a plain `string[]`, not `PresetFamilyId[]`, and why an unknown
   * id round-trips rather than being dropped). A separate field from
   * presetSaveFamilies on purpose: a "which families define my saved preset"
   * habit and a "which families do I usually push to other photos" habit
   * are different questions, so remembering them independently matches how
   * a user actually uses the two dialogs. Pinned equal to
   * presetFamilies.ts's DEFAULT_CHECKED_FAMILY_IDS by the same test that
   * already pins presetSaveFamilies.
   */
  syncFamilies: string[];
}

/** Defaults for a fresh install / a settings.json that fails to parse. */
export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  autosaveSidecar: true,
  previewLongEdge: 2560,
  baselineExposureEV: 0.5,
  export: { quality: 90, maxDim: null, metadata: 'all', colorSpace: 'srgb' },
  exportPresets: [],
  quickProjectDir: '',
  denoiseModelConsent: false,
  denoiseModelUrl: '',
  // Keep in sync with presetFamilies.ts's DEFAULT_CHECKED_FAMILY_IDS (the
  // "develop" group: basic tone / WB / curves / HSL / B&W / grading /
  // effects / detail) — pinned equal by a unit test, see this field's doc
  // comment.
  presetSaveFamilies: ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail'],
  // Same default set as presetSaveFamilies above (also pinned to
  // presetFamilies.ts's DEFAULT_CHECKED_FAMILY_IDS) — a fresh install's Sync
  // dialog starts checked exactly like the Save-preset dialog does.
  syncFamilies: ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail'],
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

/**
 * External-tool hook node (denoise v1, task #41): one round trip through a
 * user-configured command over temp TIFFs — see src/main/externalTool.ts.
 * `data` is tightly-packed RGBA float32 pixels (alpha unused, always 1):
 * sRGB-encoded (the SAME WORK_TO_SRGB matrix + exact OETF curve every other
 * export/preview exit uses — see graphRenderer.ts's ENCODE_SHADER) when
 * `encoded` is true, else raw linear Rec.2020 — the renderer applies/reverses
 * that conversion on the GPU with the shared helpers; this module only ever
 * sees already-converted numbers, so it stays pure I/O + subprocess plumbing.
 * `cacheKey` is the renderer's content hash (see externalNode.ts) — main
 * checks the on-disk cache by it BEFORE spawning anything.
 */
export interface ExternalToolRequest {
  command: string;
  encoded: boolean;
  cacheKey: string;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export type ExternalToolResult =
  | { ok: true; width: number; height: number; data: ArrayBuffer }
  | { ok: false; reason: string };

/**
 * In-engine ML denoise (denoise v2, stage 1) — see src/main/denoise.ts.
 * `data` is tightly-packed RGBA float32 pixels, ALWAYS sRGB-encoded (unlike
 * ExternalToolRequest there is no linear-mode toggle: the pipeline-placement
 * contract (docs/brief-bank/denoise-v2.md option (a)) always encodes before
 * inference and decodes after — the weights are trained on display-encoded
 * noise). `cacheKey` deliberately EXCLUDES strength (hash of input-pixel
 * hash + the pinned model's sha256 + nodeId only) — the full-strength
 * denoised result is what gets cached; the interactive strength blend
 * (output = lerp(input, denoised, strength/100)) happens GPU-side at
 * re-entry (graphRenderer.ts), cheap enough to redo per render rather than
 * fold into the cache key (see the brief's cache section).
 */
export interface DenoiseRunRequest {
  cacheKey: string;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export type DenoiseRunResult =
  | {
      ok: true;
      width: number;
      height: number;
      /** sRGB-encoded RGBA float32 — the FULL-STRENGTH inference result (strength blend happens at GPU re-entry, not here). */
      data: ArrayBuffer;
      /** Which ONNX Runtime execution provider actually initialized ('coreml' | 'cpu') — reproducibility-stamp material (see docs/brief-bank/denoise-v2.md's Determinism section); CoreML/GPU EPs are not bitwise-deterministic run-to-run, this is diagnostic, never golden-compared. */
      ep: string;
    }
  | {
      ok: false;
      reason: string;
      /** True when the failure is specifically "model not downloaded and consent was never given" — lets the UI show the consent button instead of a plain error badge; false for every other failure (missing/corrupt file after consent, ORT init error, inference error — all still passthrough+badge, just a different badge). */
      needsConsent: boolean;
    };

declare global {
  interface Window {
    silverbox: SilverboxApi;
  }
}
