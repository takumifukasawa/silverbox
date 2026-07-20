import { create } from 'zustand';
import { OpenSession, StaleOpenError } from './openSession';
import {
  emptyUndoStackState,
  moveTopToRedo,
  moveTopToUndo,
  nextUndoSeq,
  peekRedo,
  peekUndo,
  pushUndoEntry,
  type ArrangeUndoEntry,
  type FlagUndoEntry,
  type GraphEntryKind,
  type GraphUndoEntry,
  type RatingUndoEntry,
  type DeleteSharedLookUndoEntry,
  type PublishUndoEntry,
  type RemovePhotosUndoEntry,
  type SyncUndoEntry,
  type UndoEntry,
  type UndoStackState,
} from './undoStack';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import { extractSonyEmbeddedPreview } from '../engine/lens/sonyLensProfile';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import {
  buildPlan,
  clampGeometry,
  clampLens,
  defaultGraphDoc,
  defaultLensParams,
  defaultParams,
  DEVELOP_KIND,
  isBypassableNodeKind,
  nextId,
  outputName,
  parseGraphDoc,
  resolveExportSettings,
  sanitizeExportOverrides,
  sanitizeFlag,
  sanitizeRating,
  serializeGraphDoc,
  type AddableKind,
  type DevelopLink,
  type ExportOverrides,
  type GeometryParams,
  type GraphDoc,
  type GraphNode,
  type LensParams,
  type SidecarDoc,
  type SidecarSource,
} from '../engine/graph/graphDoc';
import {
  defaultProjectManifest,
  deriveLookName,
  parseProjectManifest,
  PROJECT_SCHEMA_VERSION,
  relativizeProjectPath,
  resolveProjectPath,
  serializeProjectManifest,
  type ProjectManifest,
  type ProjectPhoto,
} from '../engine/graph/projectDoc';
import { defaultDevelopParams, identityCurvePoints, profileSource, type CurvePoints, type DevelopParams } from '../engine/graph/developNode';
import { PROFILE_LATTICE_N } from '../engine/color/profileFit';
import { parseDcp, bakeDcpLattice, cameraFromWorkingMatrix, type Mat3 as DcpMat3 } from '../engine/color/dcp';
import { clampMaskShape, defaultMaskParams, MASK_KIND, type MaskShape } from '../engine/graph/maskNode';
import { clampSpot, defaultSpotsParams, SPOTS_CAP, SPOTS_KIND, type Spot } from '../engine/graph/spotsNode';
import {
  anchorSpotToSensor,
  sensorSpotToAnchor,
  type ReadoutWindow,
} from '../engine/graph/repairSheetTransform';
import { parseRepairSheet, serializeRepairSheet, type RepairSheetDoc } from '../engine/graph/repairSheetDoc';
import { defaultImageParams, dirnameOf, IMAGE_KIND } from '../engine/graph/imageNode';
import { clearImageNodeSourceCache } from '../engine/graph/imageNodeSource';
import { defaultExternalParams, EXTERNAL_KIND } from '../engine/graph/externalNode';
import { confirmAndRetry, pendingExternalRequest } from '../engine/graph/externalNodeRunner';
import { defaultDenoiseParams, DENOISE_KIND } from '../engine/graph/denoiseNode';
import { retryPendingDenoise } from '../engine/graph/denoiseNodeRunner';
import { DENOISE_MODEL_SHA256 } from '../../../shared/denoiseModel';
import { sha256Hex, type HistogramData, type ScopeSamples } from '../engine/gpu/graphRenderer';
import { RenderWorkerClient, mirrorShaderArtifactClear, mirrorShaderArtifactSet, mirrorDcpLattice } from '../engine/gpu/renderClient';
import { BLEND_KIND, CUSTOM_KIND } from '../engine/graph/ops';
import {
  buildCustomShaderWgsl,
  clearCustomShaderArtifacts,
  createDefaultCustomShaderParams,
  makeCustomShaderArtifact,
  seedDefaultCustomShaderArtifact,
  setCustomShaderArtifact,
  WGSL_IDENT_RE,
  type CustomShaderParams,
} from '../engine/graph/customShaderNode';
import { validateWgsl } from '../engine/shader/validateWgsl';
import { clearNodeThumbs, pruneNodeThumb } from '../engine/thumbnail/nodeThumbCache';
import { createWbModel, DEFAULT_WB_MODEL, type WbModel } from '../engine/color/whiteBalance';
import { sanitizeCurvePoints } from '../engine/color/toneCurve';
import { baseCurveForModel } from '../engine/color/baseCurve';
import { buildLutExport } from '../engine/color/lutExport';
import { parsePresetFile, serializePreset, type ParsedPreset } from '../engine/graph/presetDoc';
import {
  ALL_FAMILY_IDS,
  buildScopedLook,
  familyForDevelopKey,
  isDevelopFamily,
  isKnownFamilyId,
  LOOK_FAMILY_IDS,
  mergeScopedLook,
  pickDevelopFamilies,
  structuralFamilyCompatible,
  type PresetFamilyId,
} from '../engine/graph/presetFamilies';
import { diffLook } from '../engine/look/diffLook';
import { computeLookConsensus, formatConsensusReport } from '../engine/look/consensus';
import { aggregateSignature } from '../engine/look/signature';
import { PLACEHOLDER_BASELINE_SIGNATURE, formatToneSolveReport, solveToneCurve } from '../engine/look/solve';
import {
  DEFAULT_SETTINGS,
  PROJECT_MANIFEST_NAME,
  SIDECAR_SUFFIX,
  type CliCheckJob,
  type CliCheckResult,
  type CliDiffJob,
  type CliDiffResult,
  type CliExtractLookJob,
  type CliExtractLookResult,
  type CliExtractReferencesJob,
  type CliExtractReferencesResult,
  type CliRenderJob,
  type CliRenderResult,
  type FolderImageEntry,
  type MoveProjectFilesResult,
  type PhotoFlag,
  type PresetSummary,
  type Settings,
} from '../../../shared/ipc';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

/** NG2 fix pack — see raiseNotice's doc comment: how long a 'success'-kind dismissable notice stays visible before auto-clearing. */
const NOTICE_AUTO_EXPIRE_MS = 8000;

/**
 * The active project's in-memory bookkeeping (project-storage migration,
 * stage 1 — docs/brief-bank/project-storage.md): a thin mirror of
 * project.silverbox's own shape (ProjectManifest) plus the resolved `dir` it
 * lives in. `unknown` carries unrecognized manifest wrapper keys (DESIGN §9
 * passthrough) so a rewrite (the debounced playlist-save subscriber near the
 * bottom of this file) never drops a newer Silverbox's fields.
 */
interface ActiveProject {
  dir: string;
  name: string;
  photos: ProjectPhoto[];
  unknown: Record<string, unknown> | null;
}

interface AppState {
  imageStatus: ImageStatus;
  image: PreparedImage | null;
  fileName: string | null;
  imagePath: string | null;
  imageError: string | null;
  /**
   * Round-12 fix pack item 3 ("設定変更が反映されるまで無反応に見える"):
   * reloadImageForSettings' own re-decode (~1s, a full RAW read+decode, not
   * a cheap pixel tweak) has no feedback of its own — `imageStatus` stays
   * 'ready' throughout (deliberately: it's a pixel refresh, not a re-open,
   * so the canvas must stay visible and interactive, unlike a real open's
   * `overlayVisible`-hiding 'loading' state). Set true at the start of
   * reloadImageForSettings, cleared unconditionally in its `finally` —
   * success, failure, AND superseded-by-a-newer-session all clear it, since
   * `finally` runs on every one of those paths. CanvasView shows the same
   * `.canvas-loading-chip` (round-10 fix pack item 4) keyed off this flag
   * OUTSIDE the `overlayVisible` block that owns the 'loading' case.
   */
  settingsReloading: boolean;
  /**
   * The active PROJECT (project-storage migration, stage 1 — see
   * docs/brief-bank/project-storage.md): every interactive photo open
   * belongs to one, activating the quick project on demand if none is open
   * yet (see ensureActiveProject in this store's body). null for a
   * CLI-headless session — runCliRender/runCliCheck/runCliDiff open images
   * via `legacySidecarOnly`, bypassing the whole project system entirely
   * (stage 2 note, see openImageByPath's own doc comment) — or before the
   * very first photo of an interactive session has been opened.
   */
  project: ActiveProject | null;
  /**
   * Per-launch quick project (UX pack round 2, item A): mirrors the store
   * body's own module-scope `quickSessionDir` cache — the resolved dated
   * subdirectory (`<settings.quickProjectDir>/<date><letter>`) THIS session
   * activated, or null before the first quick-project need this session (or
   * whenever `testFlags.projectDirOverride` is set, which bypasses this
   * entirely). Exists so callers OUTSIDE the store body (Toolbar.tsx's "Save
   * as project…" gating, saveQuickProjectAs) can compare `project.dir`
   * against it reactively — `settings.quickProjectDir` alone no longer
   * identifies the quick project now that it's a ROOT, not a single fixed
   * directory (a real project's own dir is never equal to it, but neither is
   * the quick session's — the session lives one level DEEPER, under it).
   */
  quickSessionDir: string | null;
  /**
   * "New Project" (UX pack round 2, item A — answers the user's own "new
   * project が必要なのかな"): closes the current project/photo (flushing any
   * pending autosave first — openProject's own awaited-flush precedent) and
   * resets the quick-session cache so the NEXT photo open/drop mints a
   * FRESH dated subdirectory under `settings.quickProjectDir` instead of
   * resuming whatever was active. Lands the app back at the boot-time empty
   * state (no project, no image) — same shape openImageByPath's own
   * per-photo reset fields use, plus the project-level ones it doesn't touch.
   */
  newProject(): Promise<void>;
  /**
   * Open the project at `dir` (a directory containing project.silverbox):
   * activates it, loads its playlist into the filmstrip, and opens the
   * first playlist photo whose path still resolves (or leaves the empty
   * state if none do). Returns false — touching nothing — when `dir` has no
   * readable/valid project.silverbox: the drag-drop handler's own
   * file-vs-folder-vs-project disambiguation relies on that (App.tsx),
   * exactly the same shape openFolder's own false return has for "not
   * actually a directory". The verify harness's `__openProjectByPath` debug
   * hook (App.tsx) is the other caller.
   */
  openProjectByPath(dir: string): Promise<boolean>;
  /**
   * Toolbar banner for project-level outcomes: a FAILED openProjectByPath
   * (unreadable directory or a project.silverbox that doesn't parse), a
   * completion report from importSidecarsFromFolder/saveQuickProjectAs, or a
   * scanFolderForRelink "no match" — "fail soft, never crash": the app just
   * doesn't do the thing, but the user gets told why instead of silent
   * nothing. `kind: 'success'` (a clean completion, nothing needs the user's
   * attention) auto-clears after ~8s via raiseNotice's shared lifecycle (NG2
   * fix pack — the reported bug was exactly this notice staying forever);
   * `kind: 'error'` persists until dismissed (Toolbar's ✕, `dismissNotice`)
   * or superseded by a fresh attempt. Cleared at the START of every
   * openProjectByPath attempt (a fresh try — including a fixed/retried one —
   * deserves a clean slate).
   */
  projectNotice: { kind: 'success' | 'error'; message: string } | null;
  /**
   * Absolute path of the CURRENT photo's look/sidecar file — inside the
   * active project's `looks/` for an ordinary interactive open, or the
   * legacy adjacent `<image>.silverbox.json` for a `legacySidecarOnly` CLI
   * open (`project` stays null there — see its own doc comment). Every
   * read/write/watch of "the current sidecar" (saveGraph, the hot-reload
   * trio, watchSidecar) goes through this ONE field rather than
   * recomputing the path per call site. null before any image has been
   * opened.
   */
  currentLookPath: string | null;
  /**
   * Legacy-adjacent-sidecar import offer (project-storage migration,
   * coupling point 7): set when the just-opened photo has no look yet in
   * the active project but an old `<image>.silverbox.json` sits next to it
   * on disk — the app opens with defaults rather than silently treating
   * that file as live state (one source of truth per photo), and offers
   * this one-click import instead. Cleared on every image open and once
   * imported. Never auto-expires (an offer the user hasn't acted on yet is
   * not a "success" — see raiseNotice's doc comment) — dismissable via
   * Toolbar's ✕ (`dismissNotice`), same as projectNotice/relinkMismatchNotice.
   */
  legacySidecarImportNotice: { imagePath: string; sidecarPath: string; lookPath: string } | null;
  /**
   * The toolbar's "Import sidecar" button: copies the offered legacy
   * sidecar into the active project's `looks/` (adding `photo`) and
   * re-opens the image so it picks it up through the normal path. No-op if
   * the offer is stale (a different image is open now) or the file
   * vanished meanwhile.
   */
  importLegacySidecar(): Promise<void>;
  /**
   * "Import sidecars from folder…" (Migration & compatibility, project-
   * storage migration stage 3): a toolbar/menu action, NOT the single-photo
   * one-click offer above — walks `dir` for adjacent legacy sidecars and
   * copies each one not already on the active project's playlist into
   * `looks/` (deriveLookName collision rules), adding `photo`+`fingerprint`
   * and appending the photo to the playlist. Originals untouched (a copy,
   * never a move). Returns the completion counts (also surfaced as
   * `projectNotice`, same banner the toolbar already shows for other project
   * notices — no new modal framework); `kind: 'error'` (persistent) when
   * anything came back unreadable, `'success'` (~8s auto-clear) otherwise.
   */
  importSidecarsFromFolder(dir: string): Promise<{ imported: number; skippedExisting: number; skippedUnreadable: number }>;
  /**
   * Relink mismatch notice (Missing photos, stage 3): set by relinkPhoto
   * when the row's look already has a `fingerprint` that DISAGREES with the
   * candidate the user just picked — "fingerprint differs — relink anyway?"
   * (reusing the notice+button pattern legacySidecarImportNotice/
   * sidecarHotReloadNotice already established, no new modal framework).
   * The Toolbar's "Relink anyway" button re-calls relinkPhoto with
   * `force: true` using these exact fields. Cleared on every successful
   * relink and whenever a fresh relink attempt starts. Never auto-expires
   * (an unresolved mismatch needs a decision, not a timeout) — dismissable
   * via Toolbar's ✕ (`dismissNotice`).
   */
  relinkMismatchNotice: { playlistIndex: number; newPath: string; message: string } | null;
  /**
   * Toolbar ✕ button for projectNotice/relinkMismatchNotice/
   * legacySidecarImportNotice (NG2 fix pack — "one shared mechanism, not
   * four copies"): always just nulls `field`, regardless of what's in it
   * right now. The other half of the lifecycle — a 'success' projectNotice's
   * own ~8s auto-clear — lives in raiseNotice, not here (this is ONLY the
   * manual-dismiss path).
   */
  dismissNotice(field: 'projectNotice' | 'relinkMismatchNotice' | 'legacySidecarImportNotice'): void;
  /**
   * Relink (Missing photos, stage 3): point playlist row `playlistIndex` at
   * `newPath` — the Filmstrip's "Relink…" button's answer to the native file
   * dialog, or scanFolderForRelink's already-verified candidate below. When
   * the row's look has a stored `fingerprint` that disagrees with
   * `newPath`'s own and `force` isn't set, this refuses and sets
   * `relinkMismatchNotice` instead of writing anything (`'mismatch'`); a
   * look with no stored fingerprint at all can't be verified, so it always
   * proceeds. On success (`'relinked'`), rewrites the playlist row's `path`
   * (re-relativized) and — when the row already has a look on disk — that
   * look's own `photo` + `fingerprint` fields (kept in lockstep so a LATER
   * relink of the same row can verify against the right file), then
   * refreshes `folderEntries` so the cell's thumbnail/rating/missing-badge
   * update immediately. `'error'` covers an out-of-range index or an
   * unreadable candidate file.
   */
  relinkPhoto(playlistIndex: number, newPath: string, force?: boolean): Promise<'relinked' | 'mismatch' | 'error'>;
  /**
   * "Scan folder for candidates" (Missing photos, stage 3): the Filmstrip's
   * second missing-cell affordance — hands the row's own expected
   * fingerprint (if any) and last-known basename to main's one-round-trip
   * scanFolderForRelink IPC, then relinks immediately (`force: true`) on a
   * hit, since main already did whatever verification is possible. Sets
   * `projectNotice` (not relinkMismatchNotice — there's no "anyway" to
   * confirm, just nothing found) when the folder holds no match.
   */
  scanFolderForRelink(playlistIndex: number, dir: string): Promise<'relinked' | 'no-match' | 'error'>;
  /**
   * "Save as project…" (Quick project → real project, MOVE not copy — user
   * decision, docs/brief-bank/project-storage.md's "Quick project" section):
   * only meaningful when the ACTIVE project IS the quick project (the
   * Toolbar disables the action otherwise; this re-checks defensively and
   * returns `ok: false` rather than silently doing nothing). Moves every
   * playlist row's look file (+ golden/ PNG, if any) into `destDir`, writes
   * a fresh manifest there (destDir's own basename as the project name,
   * every photo path re-relativized), switches the active project to it,
   * and empties the quick project's OWN manifest back to zero rows — Quick
   * stays a real, usable directory for the next no-ceremony open, just with
   * nothing on its playlist anymore.
   */
  saveQuickProjectAs(destDir: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Folder filmstrip (ROADMAP "nice to have" — browse a folder, NOT a
   * catalog): non-null whenever a PROJECT is active (UX pack round 2, item B
   * — "any photo open activates a project, so the strip must show it"),
   * holding that project's directory; its only remaining job is the
   * `key={dir}` remount trick (see Filmstrip.tsx) — the CELLS shown are the
   * active project's whole playlist, not a raw directory listing (see
   * `folderEntries`). Set by openImageByPath's own success commit on EVERY
   * resolved photo open (folder/project drop, toolbar "Open Folder…",
   * __openProjectByPath, and — since item B — a standalone Open…/single-
   * file-drop open too, which used to clear this to null and leave it there
   * forever: a lone opened photo now shows a 1-cell strip that grows as more
   * are opened/dropped, instead of hiding the strip entirely). null only
   * while NO project is active yet (CLI-headless session, or before the
   * very first interactive photo open) — see `project`'s own doc comment for
   * exactly when that is.
   */
  folderDir: string | null;
  /**
   * The active project's WHOLE playlist, joined with cheap per-photo status
   * (see shared/ipc.ts's FolderImageEntry and appStore.ts's
   * buildPlaylistEntries) — empty when folderDir is null. Project-storage
   * migration (stage 1): no longer one folder's raw directory listing (a
   * playlist doesn't own photos, they can come from anywhere).
   */
  folderEntries: FolderImageEntry[];
  /**
   * Multi-select + sync (docs/brief-bank/multi-select-sync.md): filmstrip
   * cells ⌘/⇧-selected ALONGSIDE the primary — session state only, never
   * persisted, absolute playlist paths. The PRIMARY (LR's "most selected",
   * the photo actually open in the canvas) is always `imagePath` itself and
   * is deliberately NOT stored in this array — Filmstrip.tsx's existing
   * `current` prop (`entry.path === imagePath`) already renders it
   * distinctly, so this is the SECONDARY membership only; total selection
   * size (the toolbar's "N selected" badge / the Sync… button's 2+ gate) is
   * `imagePath ? filmstripSelection.length + 1 : filmstripSelection.length`.
   * Cleared by Esc (App.tsx) or a plain click (Filmstrip.tsx's own
   * click handler) — both collapse back to single-select, today's unchanged
   * behavior.
   */
  filmstripSelection: string[];
  /**
   * ⇧-click's range anchor: the last PLAIN-clicked filmstrip path (LR
   * muscle memory — "⇧-click extends a range from the last plain-clicked
   * cell"). Untouched by ⌘/⇧-clicks themselves; only a plain click moves it.
   */
  filmstripSelectionAnchor: string | null;
  /**
   * Replace the SECONDARY selection wholesale — the verify-harness hook
   * (`setFilmstripSelection(paths)`, driven via `window.__debug`) and the
   * real ⌘-click/⇧-click handlers both funnel through this. `imagePath` is
   * filtered out of `paths` automatically (it's always the implicit
   * primary — see this field's own doc comment above).
   */
  setFilmstripSelection(paths: string[]): void;
  /** ⌘-click: toggle one path's secondary-selection membership. A no-op for `imagePath` itself — the primary can't be toggled OUT of the selection, it's always in it by virtue of being open. */
  toggleFilmstripSelection(path: string): void;
  /** Plain click (Filmstrip.tsx): move the range anchor to `path` ahead of opening it — a SEPARATE call from `setFilmstripSelection([])` (both fire together from the click handler) so a verify script or a future caller can move the anchor without also touching the selection. */
  setFilmstripSelectionAnchor(path: string | null): void;
  /**
   * ⇧-click: replace the secondary selection with the INCLUSIVE range from
   * `filmstripSelectionAnchor` (falling back to `imagePath` when no anchor
   * has been set yet this session) to `path`, walked over `order` — the
   * filmstrip's own currently-VISIBLE path list (so a range never silently
   * reaches through a cell hidden by the ★n+/pick-reject filters). Falls
   * back to selecting just `path` alone if either end can't be found in
   * `order` (a stale anchor from a since-filtered-out cell, say).
   */
  rangeSelectFilmstrip(path: string, order: string[]): void;
  /**
   * Resolve a playlist photo's absolute path to its own look/sidecar file
   * (`<project>/looks/<name>`) — App.tsx's rating/flag key fan-out uses this
   * to turn `filmstripSelection`'s photo paths into the explicit look paths
   * `setRating`/`setFlag` take. `null` without an active project or a
   * matching playlist row (defensive; every real caller only ever passes a
   * path drawn from the current project's own `folderEntries`).
   */
  lookPathForPhoto(photoPath: string): string | null;
  /**
   * Develop-aware filmstrip thumbnails (docs/brief-bank/
   * develop-aware-thumbnails-impl.md, semantic 3 — "the OTHER cells" trigger):
   * a per-PATH counter, bumped by `bumpLookVersion` every time THIS session
   * writes that path's look file. Filmstrip.tsx's FilmstripCell subscribes to
   * its own path's entry and recomputes its develop-aware bitmap off the
   * ALREADY-CACHED embedded preview (thumbnailCache.ts's
   * getDevelopAwareThumbnail) whenever it changes — never a RAW decode.
   * Session-only, never persisted, never read anywhere except that
   * subscription (same spirit as `nodeThumbs`). Absent key reads as 0.
   */
  lookVersions: Record<string, number>;
  /**
   * Bump every path in `paths`'s `lookVersions` counter by 1 — the ONE write
   * point every look-file-writing action calls (directly, or transitively
   * through `saveGraph`/`writeGraphSaveSnapshot` for the currently open
   * photo — see those call sites' own comments for exactly which). No-op for
   * an empty list (every batch writer's own "nothing actually changed"
   * shortcut already returns early with `after` empty, so this stays cheap).
   */
  bumpLookVersion(paths: string[]): void;
  /**
   * "Remove from project" (UX pack round 2, item C — ⌫/Delete on the
   * filmstrip selection, or a cell's context-menu item): drops `paths` from
   * the ACTIVE project's playlist only. NEVER deletes/moves the original
   * photo file, and the look file (if any) stays exactly where it is on disk
   * — an orphaned row, recoverable by simply re-dropping the same photo
   * (project-storage.md's playlist-doesn't-own-photos model already makes
   * that trivial). If the CURRENTLY OPEN photo is among `paths`, opens the
   * nearest remaining neighbor by the strip's own sort order (folderEntries,
   * pre-removal), or falls to the empty state (project stays active, just
   * with nothing open) if none survive. Pushes ONE RemovePhotosUndoEntry
   * (multi-select removal removes all selected as a single batch, one undo
   * step) restoring the removed rows at their original playlist positions;
   * redo re-removes them. No-op without an active project or a `paths` list
   * that resolves to zero playlist rows.
   */
  removeFromProject(paths: string[]): Promise<void>;
  /**
   * NG3 fix pack ("renaming an OPEN photo's file shows nothing"): missing-
   * photo status used to be computed only on project/folder open — an
   * externally renamed/moved/deleted CURRENT photo showed nothing at all
   * until the next open. Set by refreshPlaylistStatus (below) when the
   * playlist's freshly-rechecked status says the CURRENTLY OPEN photo no
   * longer resolves; cleared the moment it resolves again, or when a
   * different image opens (openImageByPath resets it unconditionally, same
   * as the other per-image notices).
   */
  currentPhotoMissingNotice: string | null;
  /**
   * Re-run projectPhotosStatus (the existing per-cell IPC join — see
   * buildPlaylistEntries) against the active project's WHOLE playlist and
   * refresh `folderEntries` (only while a strip is actually showing —
   * `folderDir !== null`, preserving folderEntries' own "empty when
   * folderDir is null" invariant) — then check whether the CURRENTLY OPEN
   * photo is among the rows that came back missing, setting/clearing
   * `currentPhotoMissingNotice` accordingly. This is the ONE shared refresh
   * relinkPhoto/importSidecarsFromFolder/saveQuickProjectAs all call after
   * their own playlist mutation (rather than each re-deriving `entries`
   * itself), and what App.tsx's window-focus listener calls too (NG3: "an
   * externally renamed photo shows its missing cell within one alt-tab") —
   * a plain missing-cell repaint reuses the SAME status a real relink action
   * needs anyway, so one IPC round trip serves both. No-op without an
   * active project.
   */
  refreshPlaylistStatus(): Promise<void>;
  /**
   * List every image in `dir` (no recursion — see main's listImages),
   * EXTEND the active project's playlist with whichever of them aren't on
   * it yet (creating/activating the quick project first if none is active —
   * project-storage migration, stage 1), show the filmstrip (now the whole
   * playlist, not just this folder — see `folderEntries`), and open the
   * FIRST (sorted) entry from `dir`. The drop handler (App.tsx), the
   * toolbar's "Open Folder…" dialog action, and the verify harness's
   * `__openFolderByPath` debug hook (dialogs are untestable) all funnel
   * through this one action. Returns false (and touches nothing) if `dir`
   * can't be listed as a directory — callers that need to distinguish "this
   * wasn't actually a folder" (the drop handler's file-vs-folder-vs-project
   * ambiguity) branch on that; a real folder with zero images still returns
   * true (the strip just renders whatever the playlist already had).
   */
  openFolder(dir: string): Promise<boolean>;
  /**
   * Multi-file drop (UX pack, hand-test 2026-07-17 item 1): App.tsx's own
   * drop handler funnels every N>1-file drop here (a single-file drop keeps
   * going through `openPathSmart` unchanged — see App.tsx's onDrop doc
   * comment). Mirrors `openFolder`'s own shape (add-to-playlist, show the
   * strip, open the first) but for an explicit list of dropped PATHS rather
   * than one directory's `listImages` scan — each path is added via
   * `ensureProjectAndAddPhoto` (creating/activating the quick project first
   * if none is active, same as `openFolder`), `folderDir` is set to the
   * ACTIVE PROJECT's own directory (there is no single "this folder" for a
   * multi-drop — `folderDir`'s only remaining job post-project-storage-
   * migration is gating the strip's visibility + Filmstrip's remount key,
   * not naming a directory whose raw listing is shown — see its own doc
   * comment), and `paths[0]` (drop order, not RAW-preference — the OLD
   * single-open pickDropFile behavior this replaces) opens.
   *
   * Edge case (kept deliberately simple/explicit, per the brief): if ANY
   * dropped path is itself a project.silverbox — either the manifest file
   * directly, or (the realistic case) a dropped FOLDER that already
   * contains one — that project wins outright: it opens via
   * `openProjectByPath`, exactly as a lone project drop would, and every
   * OTHER dropped path is ignored (a `projectNotice` says so). No attempt is
   * made to also add the other dropped images afterward, and a project that
   * fails to open (a corrupt manifest) reports its own error notice and
   * stops there too — a mixed drop either resolves to "the project", full
   * stop, or to "all images", never a partial mix of both.
   */
  openMultiDrop(paths: string[]): Promise<void>;
  /** ←/→ filmstrip navigation (folder context only): steps to the prev/next sorted entry, clamped at the ends (no wraparound). No-op without a folder context, with no entries, or while an image is already loading. */
  stepFilmstrip(delta: 1 | -1): void;
  /**
   * Embedded-preview-first opening (the Lightroom trick): the ARW's own
   * embedded camera JPEG, shown as a CanvasView overlay the instant it's
   * sliced out — no decode — while the real libraw decode + GPU render runs
   * behind it. Set only for a fresh RAW open (extractSonyEmbeddedPreview);
   * null for JPEGs (they decode fast enough that a preview overlay would
   * itself be the bottleneck) and non-Sony RAWs. Cleared (URL revoked — see
   * clearOpeningPreview) once the real image reaches 'ready', the open
   * fails, or another open starts.
   *
   * `flip`: the SAME rotation code space as PreparedImage.flip (0/3/5/6) —
   * round-8 fix: unlike the real decode (LibRaw pre-rotates its output), this
   * bare JPEG stream has no orientation baked in, so CanvasView's overlay
   * must apply it itself (see extractSonyEmbeddedPreview's doc comment).
   */
  openingPreview: { url: string; width: number; height: number; flip: number } | null;
  graph: GraphDoc;
  /** Graph differs from what the sidecar holds (or would hold). */
  graphDirty: boolean;
  selectedNodeId: string | null;
  /**
   * Live ~64px thumbnail blob: URLs by nodeId (per-node-preview pack, tier
   * 1) — RENDER OUTPUT, not doc input, so this deliberately lives OUTSIDE
   * GraphDoc/history (undo/redo never touches it; CanvasView.tsx's debounced
   * post-render effect is the only writer). See engine/thumbnail/nodeThumbCache.ts
   * for the revocation-audit discipline every writer of this map follows.
   */
  nodeThumbs: Record<string, string>;
  setNodeThumbs(thumbs: Record<string, string>): void;
  /**
   * Inspect mode (per-node-preview pack, tier 2): previews THIS node's own
   * output on the main canvas instead of the active output — null = normal.
   * Mutually exclusive with compareMode in BOTH directions (see
   * setCompareMode/setInspectNode below): both answer "what should the
   * canvas show", so only one gets to at a time; unlike compare, inspect
   * isn't a canvas POINTER tool (no gesture of its own), so it does NOT go
   * through deactivateOtherTools. Cleared on image switch (openImageByPath)
   * and whenever the inspected node itself disappears (see this file's
   * inspectNodeId-prune subscribe, near the bottom).
   */
  inspectNodeId: string | null;
  setInspectNode(id: string | null): void;
  /** WGSL compile errors by node id (custom nodes render identity meanwhile). */
  shaderErrors: Record<string, string>;
  /** The live render-worker client (registered by CanvasView; used for export). */
  renderer: RenderWorkerClient | null;
  exportStatus: 'idle' | 'working' | 'error';
  exportError: string | null;
  /** Stats of the current render (updated debounced after each render). */
  histogram: HistogramData | null;
  /** Selected scope display in the histogram panel; 'histogram' is the default. */
  scopeMode: 'histogram' | 'waveform' | 'parade' | 'vectorscope';
  setScopeMode(mode: 'histogram' | 'waveform' | 'parade' | 'vectorscope'): void;
  /** Strided RGB samples for Wave/Parade/Vec, fetched only outside 'histogram' mode. */
  scopeSamples: ScopeSamples | null;
  setScopeSamples(samples: ScopeSamples | null): void;
  /**
   * Global undo (docs/brief-bank/global-undo.md): ONE LIFO timeline shared by
   * every photo and every batch action — replaces the old per-open-photo
   * `history: { past, future }` GraphDoc arrays entirely (`undo()`/`redo()`
   * below dispatch per entry `kind`, jumping to a different photo first when
   * an entry targets one that isn't open — see their own doc comments).
   * Session-scoped, bounded (see undoStack.ts's UNDO_STACK_LIMIT) — never
   * reset on an image switch/open (see openImageByPath), unlike the old
   * per-photo `history` this replaces.
   */
  undoStack: UndoStackState;
  /** Yellow toolbar notice when a sidecar existed but could not be used. */
  sidecarNotice: string | null;
  /**
   * True when the image's sidecar file EXISTS on disk but parseGraphDoc threw
   * at open time (e.g. a newer schema this build doesn't understand).
   * saveGraph() refuses to write while this is set — otherwise a later ⌘S
   * would silently overwrite a document this build can't actually read.
   * Cleared whenever a (different) image is opened.
   */
  sidecarUnreadable: boolean;
  /** createdAt carried through sidecar round-trips (set on first save). */
  sidecarCreatedAt: string | null;
  /**
   * Star rating 0..5 (ratings pack): sidecar WRAPPER metadata about the
   * PHOTO, not the look — lives next to sidecarCreatedAt, not in `graph`.
   * Global-undo (docs/brief-bank/global-undo.md, decision 2): rating IS now
   * in the undoable scope — setRating below pushes a `'rating'` entry onto
   * the SAME global stack every graph edit uses, just keyed by this field
   * instead of `graph`. 0 = unrated; reset to 0 on every image open before a
   * sidecar (if any) restores it, same as sidecarCreatedAt.
   */
  sidecarRating: number;
  /**
   * Set (1-5) or clear (0) a photo's rating — the toolbar's star display and
   * App.tsx's 1-5/0 key handler both call this for the CANVAS photo
   * (`lookPath` omitted); the same key handler fans out over the whole
   * filmstrip selection when 2+ are selected by passing each OTHER selected
   * look's path explicitly (multi-select-sync.md: "each per-photo change
   * pushes its own undo entry") — same explicit-look-path shape `setFlag`
   * already uses, extended here to match. Omitted/matching `currentLookPath`
   * rides the existing in-memory + autosave pipeline (marks graphDirty,
   * pushes a `'rating'` undo entry targeting the open photo — global-undo
   * decision 2, superseding the old "ratings never undo" contract);
   * otherwise reads/patches/writes that OTHER look file directly off disk
   * (mirroring setFlag's own OTHER-look branch), pushing a `'rating'` entry
   * targeting THAT photo's path so ⌘Z jumps to it before reverting. No-op
   * without an open image (when `lookPath` is omitted) or without a
   * resolvable project photo (when it's given).
   */
  setRating(rating: number, lookPath?: string): Promise<void>;
  /**
   * Pick/reject flag (reject-flag pack, docs/brief-bank/reject-flag.md):
   * sidecar WRAPPER metadata about the PHOTO, same shape as sidecarRating
   * just above — an INDEPENDENT axis (rejecting never clears the rating,
   * and vice versa). `null` = unflagged (identity-omission, never a written
   * `flag: null` — see graphDoc.ts's SidecarDoc.flag). Reset to `null` on
   * every image open before a sidecar (if any) restores it, same as
   * sidecarRating.
   */
  sidecarFlag: PhotoFlag | null;
  /**
   * Set ('pick'/'reject') or clear (null) a photo's flag — App.tsx's p/x/u
   * key handler calls this for the CANVAS photo, fanning out over the whole
   * filmstrip selection when 2+ are selected (multi-select-sync.md: "each
   * per-photo change pushes its own undo entry"). Deliberately takes an
   * explicit `lookPath`, not "the current photo" implicitly: when `lookPath`
   * IS the open canvas photo (`currentLookPath`), this rides the same
   * in-memory + autosave pipeline `setRating` uses (marks graphDirty, pushes
   * a `'flag'` undo entry — global-undo decision 2, superseding the old
   * "flags never undo" contract); otherwise it reads/patches/writes that
   * OTHER look file directly off disk (mirroring relinkPhoto's own
   * read-patch-write shape), since that photo isn't necessarily
   * open/decoded at all — ALSO pushing a `'flag'` entry targeting that
   * OTHER photo's path (resolved via the active project's playlist), so
   * ⌘Z on a fan-out entry JUMPS to it before reverting, same as any other
   * per-photo entry. This is the seam multi-select's key fan-out calls per
   * selected playlist entry without any change to this action's signature.
   */
  setFlag(lookPath: string, flag: PhotoFlag | null): Promise<void>;
  /** Unrecognized wrapper-level sidecar keys (DESIGN §9 passthrough) — round-tripped verbatim on save. */
  sidecarUnknownFields: Record<string, unknown> | null;
  /**
   * The current look's `fingerprint` wrapper field, as last read from/
   * written to disk this session (project-storage migration, stage 3) —
   * null before it's ever been computed (a pre-stage-3 look, or a brand-new
   * one that hasn't been saved yet). saveGraph reads this to decide whether
   * a fresh fingerprint computation is needed (see its own doc comment); set
   * from the parsed look at open time and refreshed after every save.
   */
  sidecarFingerprint: string | null;
  /**
   * The current look's `photo` wrapper field, exactly as read from disk at
   * open time (before this session's own saves rewrite it) — saveGraph's
   * "photo path changed" signal for whether a stale fingerprint needs
   * recomputing (see its own doc comment). Refreshed after every save to
   * whatever was just written, so a SECOND save in the same session doesn't
   * re-trigger the "changed" branch off a now-stale open-time snapshot.
   */
  sidecarPhotoAtOpen: string | null;
  /**
   * Raw sidecar TEXT this session has already accounted for — set on image
   * open (whatever was on disk then, or null if no sidecar existed), on
   * save (exactly what we just wrote), and on a hot-reload apply (exactly
   * what we just loaded). A fresh disk read is compared against THIS field,
   * not against `serializeGraphDoc(currentGraph, …)` recomputed on the fly:
   * the live graph can move on (further edits) between our own write and the
   * fs-watch echo of it arriving, which would make a live-recompute compare
   * unequal and misreport our own save as an external change. A frozen
   * snapshot from the moment of the write has no such race.
   */
  lastSidecarText: string | null;
  /**
   * Sidecar hot-reload notice (the AI-editing loop): 'reloaded' is
   * transient (connectNotice's 4s auto-clear pattern) after a clean-session
   * auto-reload; 'pending' is persistent (an inline Reload action) while the
   * session has unsaved edits a hot-reload must not clobber; 'malformed'
   * warns that external content on disk could not be parsed and the in-app
   * graph was left untouched. Cleared on reload, on save, and on image
   * switch (openImageByPath resets it).
   */
  sidecarHotReloadNotice: { kind: 'reloaded' | 'pending' | 'malformed'; message: string } | null;
  /**
   * Re-read + re-parse the sidecar and apply it now — the 'pending' notice's
   * "Reload" button (one undo entry, same as the clean-session auto-reload).
   * No-op without an open image.
   */
  reloadSidecarNow(): Promise<void>;
  /**
   * Route a debounced external-sidecar-change push from main (see preload's
   * onSidecarChanged, subscribed once at module scope below): reads the
   * sidecar, compares it against `lastSidecarText` (self-write suppression),
   * and — for genuinely different content — either auto-reloads (clean
   * session) or raises the 'pending' notice (dirty session), or raises
   * 'malformed' if the new content doesn't parse.
   */
  handleExternalSidecarChange(): Promise<void>;
  /**
   * Sidecar visual diff ("code review for looks" brief §1): the hot-reload
   * notice's "Show diff" review moment. `lines` is diffLook's param-language
   * summary between the CURRENT in-app graph+rating and the parsed disk
   * content; `externalGraph` is that disk content's graph, kept around only
   * so the dialog's "Compare visually" button can feed it to
   * `setCompareDocOverride` without re-reading the file. Null = dialog
   * closed. Transient UI state — never serialized, never pushed to history.
   */
  sidecarDiffDialog: { lines: string[]; externalGraph: GraphDoc } | null;
  /**
   * Re-read + re-parse the sidecar (same helper reloadSidecarNow uses) and
   * open the diff dialog against the CURRENT in-app graph — the "Show diff"
   * button next to a 'pending' hot-reload notice. No-op if the file can't be
   * read/parsed right now (readAndParseSidecar's existing malformed/removed
   * handling already keeps the toolbar notice honest about that) or if no
   * image is open.
   */
  showSidecarDiff(): Promise<void>;
  /** Close the diff dialog; also clears any visual compareDocOverride it turned on (see setCompareDocOverride's doc comment) so the compare pane cleanly falls back to its normal Mode A/B selection. */
  closeSidecarDiff(): void;
  /** Result line for the toolbar after a successful export. */
  exportInfo: { width: number; height: number; bytes: number } | null;
  /** Per-image Kelvin/Tint model (as-shot estimate + relative gains). */
  wbModel: WbModel;
  /** Viewer-only: show the unedited decode instead of the graph result. */
  showBefore: boolean;
  toggleBefore(): void;
  /** Viewer-only: display the render as luminance (tone/contrast check). */
  grayscaleView: boolean;
  toggleGrayscaleView(): void;
  /**
   * Compare view (compare pack): splits the canvas into two synced panes
   * sharing ONE viewport (pan/zoom moves both — LR behavior). Mode A
   * (compareOutputId === null, the default): CURRENT vs BEFORE, reusing the
   * exact same "before" render showBefore drives. Mode B (compareOutputId
   * set, only reachable once the doc has 2+ outputs): the active output vs
   * a second output picked from the compare strip's dropdown. A modal
   * canvas tool like crop/spot/maskDraw/the eyedroppers — activating it
   * deactivates them (deactivateOtherTools gains 'compare') and vice versa.
   */
  compareMode: boolean;
  setCompareMode(active: boolean): void;
  /** Mode B's picked second output id; null = Mode A (before). Cleared on a fresh image open, same as the other modal tools. */
  compareOutputId: string | null;
  setCompareOutputId(id: string | null): void;
  /**
   * Sidecar visual diff's "Compare visually" (git-native completion brief
   * §1): a TRANSIENT whole-graph override for compare Mode B, the same
   * "ride the existing machinery with a foreign doc" trick previewLook uses
   * for the preset hover preview — see CanvasView.tsx's graphForBuild (for
   * the main pane) and its compareRender call (for this one). When set,
   * Mode B renders THIS graph's own first output instead of the
   * compareOutputId-based second-output selection, regardless of
   * compareOutputId. Never serialized, never pushed to history, cleared by
   * closeSidecarDiff and on a fresh image open.
   */
  compareDocOverride: GraphDoc | null;
  setCompareDocOverride(doc: GraphDoc | null): void;
  /** Crop/straighten tool active — the canvas previews the full (uncropped) rotated frame while true. */
  cropMode: boolean;
  toggleCropMode(): void;
  /** WB eyedropper picking mode — the next canvas click samples a pixel and solves temp/tint. */
  wbPicking: boolean;
  setWbPicking(picking: boolean): void;
  /** ColorKey mask eyedropper picking mode (same pattern as wbPicking) — the next canvas click seeds shapes[0]'s hue/sat/lum. */
  colorKeyPicking: boolean;
  setColorKeyPicking(picking: boolean): void;
  /** ⌘⇧C/⌘⇧V in-session develop-settings clipboard (nodes+edges; input geometry stripped). */
  developClipboard: GraphDoc | null;
  copyDevelopSettings(): void;
  pasteDevelopSettings(): void;
  /**
   * "Reset all edits" (round-8 NG fix pack item 2, Presets menu / ⇧⌘R): replaces
   * the graph with exactly what a FRESH OPEN of this same image would produce —
   * defaultGraphDoc() run through the same seedDefaultLook() call
   * openImageByPath makes (same testFlags, `usedSidecar: false` so the default
   * look seeds in), as ONE undo entry (⌘Z restores everything, including any
   * added nodes). Confirm-free — undo is the safety net, same reasoning as
   * every other one-undo-entry action here. No-op without a ready image.
   * Rating is metadata on the sidecar wrapper, not `graph` — never touched.
   */
  resetAllEdits(): void;
  /**
   * "Reset Develop" (Develop inspector button, per-node — distinct from
   * `resetAllEdits`'s whole-photo scope): writes the FRESH-OPEN seeded
   * develop params onto ONE develop node (`nodeId`, the one the inspector is
   * currently showing) — same seeded-defaults source as `resetAllEdits`
   * (defaultGraphDoc() through seedDefaultLook with `usedSidecar: false`, so
   * RAW vs JPEG still get their own real defaults — camera-matched base
   * curve + LR-calibrated NR/sharpen seeds for RAW, flat for JPEG — never
   * hand-copied constants), but ONLY that node's `develop` field is replaced:
   * graph structure, edges, every other node (including a second develop
   * node, if the doc has one) are untouched. One undo entry, same idiom as
   * resetAllEdits. No-op without a ready image or if `nodeId` isn't a
   * develop node.
   */
  resetDevelopNode(nodeId: string): void;
  /**
   * The library ∪ legacy-userData preset/template summaries (task #37;
   * dual-location since docs/brief-bank/linked-looks-stage-e.md — see
   * main/presets.ts's listPresets); refreshed after save/delete/vendor-in/
   * import, once at boot, and on the library's own external-drop watch
   * (onLibraryChanged).
   */
  presets: PresetSummary[];
  /** Re-read the library ∪ legacy dir into `presets` — the boot load + every write path's own refresh factored out so the external-drop watch (onLibraryChanged) can reuse it too. */
  refreshPresets(): Promise<void>;
  /**
   * "プロジェクトに取り込む" (vendor in — linked-looks-stage-e.md semantic 4,
   * parent spec §6): copy library row `slug`'s raw file text into the ACTIVE
   * PROJECT's `shared-looks/` dir verbatim (no parsing/rescoping — presets
   * and shared-look templates are the same file format, semantic 7). A
   * project-slug collision auto-suffixes (-2, -3…, same disambiguation as
   * savePreset/createSharedLook) rather than overwriting a differently-
   * sourced project look that happens to share the name; either way a
   * completion notice names the destination slug actually used. The vendored
   * copy then shows up in `sharedLooks`/SharedLookMenu — linking happens
   * against it via the ordinary `linkPhotosToLook` flow, unchanged. No undo
   * entry (additive file copy, render-neutral until something is explicitly
   * linked to it — notice only, per the brief). No-op (with an error notice)
   * without an active project or a slug this build can't read.
   */
  vendorPresetIntoProject(slug: string): Promise<void>;
  /**
   * "ライブラリに反映" (publish to library — linked-looks-stage-e.md semantic
   * 5, parent spec §6): copy the ACTIVE PROJECT's shared look `slug`'s raw
   * file text OUT to the library verbatim, at the SAME slug — overwriting
   * the library template if it already exists (that IS "updating the
   * template"; every OTHER project that vendored a copy earlier is
   * untouched, since vendoring already made them independent files). No
   * undo entry — the library is a visible, git/sync-able folder, the safety
   * net per parent spec §9-7's RESOLVED decision, same reasoning as
   * deleteSharedLook's own file-deletion half. No-op (with an error notice)
   * without an active project or a slug that fails to read.
   */
  publishSharedLookToLibrary(slug: string): Promise<void>;
  /**
   * "ライブラリに取り込む…" (Import — linked-looks-stage-e.md semantic 6):
   * opens a native file picker (filtered to .json) and copies the picked
   * file's raw text into the library. The slug is derived from the picked
   * file's OWN basename (sanitized via slugifyPresetName — same identity a
   * plain Finder drop into the folder would keep, matching "putting a file
   * in the folder IS the import"), auto-suffixed on a slug collision (same
   * disambiguation as vendorPresetIntoProject/savePreset) rather than
   * silently overwriting an unrelated same-named library file. The content
   * is still validated parseable (parsePresetFile) before writing — every
   * other save path in this store validates before it writes, and a picker-
   * driven import is no different — an unparseable pick is rejected with an
   * error notice, nothing is written. A no-dialog external drop straight
   * into the library folder (the OTHER half of "putting a file in the
   * folder IS the import") is unvalidated by contrast — it goes through
   * main's fs.watch (onLibraryChanged) untouched, exactly like a hand-edited
   * sidecar. No-op if the picker is canceled.
   */
  importPresetFile(): Promise<void>;
  /**
   * Save the CURRENT graph as a preset file named `name`. Same display name
   * as an existing preset overwrites it (its slug/createdAt/unknown wrapper
   * keys are reused — DESIGN §9 passthrough); a different name that
   * sanitizes to the same slug disambiguates (-2, -3…).
   *
   * `families` (preset scoping, docs/brief-bank/
   * preset-scoping-and-export-overrides.md §1): when provided (the Save
   * flow, via FamilyScopeDialog), the preset is written SCOPED — only the
   * checked families' data lands in the file (presetFamilies.ts's
   * buildScopedLook), and the wrapper's `includes` records exactly that set
   * (plus any unknown ids preserved from an overwritten file — see this
   * method's implementation). When omitted (the "Update with current look"
   * button, which does not re-prompt for families), the file being
   * overwritten's OWN existing scope is reused verbatim — a whole-look
   * preset stays whole-look, a scoped one stays scoped to the same
   * families, refreshed with the current graph's values. A brand new
   * preset saved with no `families` arg and no prior file at its slug is
   * the historical whole-look shape (captureLook, no `includes` key) —
   * back-compat for any caller that predates this feature.
   */
  savePreset(name: string, families?: PresetFamilyId[]): Promise<void>;
  /**
   * Apply a saved preset by slug, one undo entry. No-op without an open
   * image. A whole-look preset (`includes` absent — every preset saved
   * before this feature existed, or saved without ever touching a family
   * checkbox) follows the historical applyLook path unchanged. A
   * family-scoped preset merges ONLY its checked families onto the
   * CURRENTLY open graph (presetFamilies.ts's mergeScopedLook) — every
   * other family is left exactly as it already was, never reset toward
   * some default. Unknown family ids in `includes` (a newer build's) are
   * ignored here, per the brief's forward-compat rule.
   */
  applyPreset(slug: string): Promise<void>;
  /**
   * Apply a saved preset to the WHOLE filmstrip selection (primary + every
   * secondary — docs/brief-bank/apply-preset-to-selection.md, linked-looks
   * stage A): the one-shot no-asset batch case of linked-looks.md §6,
   * REQUIRED for both look presets and repair-sheet-style spot batches
   * («写真を複数選択してプリセットを一気に適用できる»). Composes a
   * target-iteration/batch-undo/look-file-write pattern with applyPreset's
   * own preset-parse/includes/merge path — SHARES both halves
   * (mergeFamiliesWithSkipDetection, the shared per-target scoped-merge
   * helper below) rather than re-deriving either.
   *
   * No secondary selection (`filmstripSelection` empty): delegates to
   * `applyPreset` UNCHANGED — bit-identical behavior, no batch undo entry,
   * exactly today's single-photo apply (brief's explicit "no behavior
   * change for the 1-photo case").
   *
   * 2+ selected: the preset's OWN saved `includes` governs — NO apply-time
   * dialog, one click. Develop families merge via mergeScopedLook;
   * structural families (spots/masks/custom-nodes) graft via the same
   * graftStructuralFamily machinery applyPreset already uses, skipped
   * per-target (and counted in the notice) when that target's own chain
   * isn't structurally compatible. A preset with
   * no `includes` (a pre-scoping whole-look file) is treated as every
   * family except geometry — the same "whole look, geometry excluded" shape
   * applyLook's own historical behavior has always had for a single photo;
   * this is the one case the brief doesn't pin down explicitly (every preset
   * saved through the UI today carries `includes`).
   *
   * The PRIMARY (the currently open photo) is a target too: its live graph
   * is merged in memory (same scoped-merge path applyPreset's own scoped
   * branch uses), applied immediately (canvas updates live), and flushed to
   * disk right away via saveGraph() — "flush discipline included", so the
   * open photo's look file is never left lagging the in-memory edit the way
   * the ordinary 1000ms autosave debounce would leave it.
   *
   * ONE SyncUndoEntry (kind 'sync', the same batch-undo shape every
   * multi-target write in this file uses) covers primary + every secondary
   * that actually got written — ⌘Z reverts all of them in place (no
   * cherry-picking), redo re-applies. A completion `projectNotice` reports
   * the target count + any structural skips/errors. No-op without an open
   * primary, an active project, or a slug that fails to read/parse.
   */
  applyPresetToSelection(slug: string): Promise<void>;
  /** Delete a saved preset's file; refreshes the list. No confirm dialog (see PresetsMenu's low-friction-but-not-accidental design). */
  deletePreset(slug: string): Promise<void>;
  /**
   * `<projectDir>/shared-looks/*.json` summaries (docs/brief-bank/
   * linked-looks-stage-b.md) — the SAME preset file format, project-scoped.
   * Refreshed on project open/create/close and after create/delete; empty
   * with no active project.
   */
  sharedLooks: PresetSummary[];
  /** Re-read `<projectDir>/shared-looks/` into `sharedLooks`; no-op without an active project. */
  refreshSharedLooks(): Promise<void>;
  /**
   * Repair sheets (ゴミ取りセット — docs/brief-bank/linked-looks-stage-f.md
   * semantic 8): `<projectDir>/repair-sheets/*.json` summaries in the store,
   * refreshed on every project switch (project-scoped, same as `sharedLooks`).
   */
  repairSheets: PresetSummary[];
  /** Re-read `<projectDir>/repair-sheets/` into `repairSheets`; no-op without an active project. */
  refreshRepairSheets(): Promise<void>;
  /**
   * "ゴミ取りセットを保存" (create — semantic 4): map the OPEN photo's CURRENT
   * spots (all of them, across the active chain's spots node) from anchor space
   * into PHYSICAL SENSOR PX (repairSheetTransform.ts) and write them as a new
   * sheet file. Requires a ready RAW photo carrying a readout window
   * (image.readoutOrigin) AND ≥1 spot — else a notice, nothing written. Photo
   * files are untouched (the sheet is a create-time transform, not storage).
   */
  saveRepairSheet(name: string): Promise<void>;
  /**
   * "ゴミ取りセットを適用" (apply, one-shot per-frame — semantic 5): stamp the
   * sheet's sensor-px spots onto the whole filmstrip selection (primary + every
   * secondary, stage A's batch shape), mapping sensor → each target's OWN
   * anchor space through that target's readout window ∘ orientation. Spots
   * whose destination maps outside a target's frame are DROPPED for it
   * (semantic 3). Non-RAW / no-readout-window targets are SKIPPED with a loud
   * per-target notice (semantic 5). If a target's existing spots + mapped sheet
   * spots would exceed SPOTS_CAP the target is REFUSED loudly, never truncated
   * (semantic 6). Applied spots become ordinary photo-local spots. ONE batch
   * SyncUndoEntry covers every photo written; a completion notice reports the
   * per-target skips/refusals.
   */
  applyRepairSheet(slug: string): Promise<void>;
  /** Delete a repair sheet's file (semantic 8: file delete, notice, no undo — the apply itself is what's undoable). */
  deleteRepairSheet(slug: string): Promise<void>;
  /**
   * "Create shared look" (共通ルック — linked-looks-stage-b.md semantic 1):
   * captures the CURRENTLY OPEN photo's checked develop families (SAME
   * capture path buildScopedLook/savePreset use, restricted to develop-group
   * families only — presetFamilies.ts's LOOK_FAMILY_IDS; structural
   * families are refused/ignored, never offered) into a NEW file at
   * `<projectDir>/shared-looks/<slug>.json` (presetDoc.ts's serializePreset,
   * the exact preset-file shape — one format for presets and shared looks),
   * then LINKS the open photo to it (creating a look you don't follow
   * yourself is meaningless, per the brief) — internally delegates to
   * `linkPhotosToLook([imagePath], slug)` so the two features share one
   * materialization implementation. No-op without a ready image or an
   * active project, or an empty/whitespace-only `name`.
   */
  createSharedLook(name: string, families: PresetFamilyId[]): Promise<void>;
  /**
   * "Link photo(s) to look" (共通ルックを使う — linked-looks-stage-b.md
   * semantic 2): attach `targets` (1..N photo paths, batch shape copied from
   * applyPresetToSelection — stage A) to the shared look
   * `slug`. Per photo, per family the look OFFERS (its own `includes`,
   * develop-only): if that family's CURRENT value differs from this
   * target's own FRESH-SEED DEFAULTS (seeded via the same decode +
   * seedDefaultLook path used elsewhere in this file for an absent look), the photo
   * already edited it — it stays 個別調整 (excluded from `follows`, values
   * untouched); an untouched family gets the look's own values WRITTEN in
   * (materialization) and enters `follows`. A target whose Develop node is
   * ALREADY linked (to this look or a different one) is skipped and counted
   * — constraint 3's "at most one linked Develop, refuse rather than
   * silently double-link" enforced per-target rather than aborting the
   * whole batch (same "skip, don't corrupt, report" posture as
   * mergeFamiliesWithSkipDetection's structural skip). ONE SyncUndoEntry
   * covers every photo actually written; a completion notice reports
   * per-photo followed/individual counts (the brief's "only feedback the
   * no-dialog default gets"). No-op without an active project or a slug
   * that fails to read/parse.
   */
  linkPhotosToLook(targets: string[], slug: string): Promise<void>;
  /**
   * "共通ルックに合わせる" (revert one family to the look — semantic 5): on
   * the CURRENTLY OPEN photo's Develop node `nodeId`, re-write `family`'s
   * values from the shared look's current body and re-add it to `follows`.
   * One undo entry (reuses the 'sync' shape, single-target). No-op unless
   * the node is linked and the look file still reads/parses.
   */
  revertFamilyToLook(nodeId: string, family: PresetFamilyId): Promise<void>;
  /**
   * "共通ルックにリセット" (revert ALL offered families to the look, force-
   * overwrite case 2 of the parent spec's §6 — one button): same as calling
   * `revertFamilyToLook` for every family the look offers, but as one undo
   * entry instead of N.
   */
  resetAllFamiliesToLook(nodeId: string): Promise<void>;
  /**
   * "共通ルックから外す" (unlink — semantic 6): strip `link` from the
   * CURRENTLY OPEN photo's Develop node `nodeId`; values untouched (見た目は
   * 変わらない). One undo entry. No-op unless the node is linked.
   */
  unlinkLook(nodeId: string): Promise<void>;
  /**
   * "ルックがなかったら全部ローカル化" (look deletion — semantic 7): delete
   * the shared look file itself, then strip `link` from every follower found
   * across the ACTIVE PROJECT's playlist (their values were already
   * materialized — render never changes). One batch undo entry (targets =
   * every follower actually rewritten) plus the file deletion (not itself
   * undoable, same "undo doesn't cover file deletion" posture as
   * deletePreset — but stripping the `link` fields IS covered, so undo
   * restores every follower's link state; the file staying gone is the one
   * irreversible part, same as re-creating a deleted preset isn't undo's
   * job either).
   */
  deleteSharedLook(slug: string): Promise<void>;
  /**
   * The currently open photo's linked Develop node, scoped to the ACTIVE
   * CHAIN (parent spec §4.3 / linked-looks-stage-c.md semantic 2 — publish
   * must read ONLY this node, never an added local tweak Develop sharing the
   * same chain). A plain synchronous getter (not stateful) so the UI
   * (SharedLookMenu's Publish button) and publishToSharedLook itself resolve
   * the exact same node rather than risking two independent chainScope
   * computations drifting apart. Filters on `n.link` truthy, NOT merely
   * "first Develop node in scope" — a chain can hold a linked Develop PLUS
   * one or more unlinked tweak-layer Develop nodes (§4.3's "added Develop
   * nodes are local tweak layers"), and array order between them is not
   * meaningful. `null` when no image is ready, or the active chain has no
   * linked Develop node at all.
   */
  activeLinkedDevelopNode(): GraphNode | null;
  /**
   * "この写真の調整を共通ルックに反映" (publish — linked-looks-stage-c.md,
   * parent spec §4.4/§9-2): write `families` (checked develop families,
   * FamilyScopeDialog reuse — checking one the look doesn't yet offer
   * EXTENDS its `includes`; unchecking an already-offered one only omits it
   * from THIS publish, never removes it from the look) from the OPEN
   * photo's linked Develop node — activeLinkedDevelopNode's ACTIVE-CHAIN
   * node ONLY, never an added local tweak Develop (semantic 2) — into the
   * shared look it's linked to, then re-materializes every follower of that
   * look across the project (semantic 4): each follower's (`follows` ∩
   * `families`) values are rewritten from the new look body, and EVERY
   * follower's `materializedFrom` is bumped to the new look file's hash —
   * including a follower whose intersection is empty (stage D's future
   * drift detection depends on this). The publisher re-follows every
   * published family (semantic 5: those values equal the look's own by
   * construction); families it didn't publish keep their current
   * follow/fork state untouched, and so does every OTHER follower's
   * `follows` list (only the publisher re-follows). Flushes the open
   * photo's own pending autosave state BEFORE writing anything (semantic
   * 3), then writes the shared-look file, then fans out. One
   * PublishUndoEntry covers the whole operation. No-op (with a notice,
   * never a crash) without an active project, a linked Develop in the
   * active chain, at least one checked develop family, or a readable/
   * parseable look file (semantic 8) — silently returns (no notice, same as
   * every sibling shared-look action) when no image is ready, since the UI
   * gates the button on that already.
   */
  publishToSharedLook(families: PresetFamilyId[]): Promise<void>;
  /**
   * Per-slug last-seen shared-look TEXT cache (linked-looks-stage-d.md
   * semantic 2) — the per-slug analog of `lastSidecarText`: self-write
   * suppression for the shared-looks watch (a slug's cache entry is updated
   * on every app-side read/write/publish/materialization of that look, so
   * the watch's own echo of our own write compares equal and is ignored)
   * AND the source of `lookTextBefore` for the re-materialization undo entry
   * below. A slug with NO entry yet is "unknown this session" — the watch
   * handler primes it silently rather than treating a first sighting as a
   * change to fan out (there is nothing to have drifted FROM). Reset to `{}`
   * on every project switch (project-scoped, same as `sharedLooks`).
   */
  sharedLookTexts: Record<string, string>;
  /**
   * Shared-look hot-reload/drift notice (linked-looks-stage-d.md semantics
   * 3/4/7) — the per-slug analog of `sidecarHotReloadNotice`. `'applied'` is
   * transient (auto-clears, like the sidecar notice's `'reloaded'`) after an
   * automatic re-materialization (watch-triggered or drift-at-open).
   * `'pending'` is persistent (the clean/dirty guard, semantic 4): the OPEN
   * photo is a follower of the changed look AND the session is dirty, so the
   * fan-out is deferred behind a reflect button — `lookTextBefore`/
   * `lookTextAfter`/`label` carry exactly what `reflectPendingSharedLook`
   * needs to run the SAME re-materialization the moment the user asks for
   * it. `'missing'` is persistent (until superseded) — a link whose slug has
   * no backing file at load (semantic 7); metadata is kept, never
   * auto-stripped. Cleared on every image switch, same as
   * `sidecarHotReloadNotice`. Single-slot (the newest notice wins) — same
   * simplification `sidecarHotReloadNotice` already makes.
   */
  sharedLookHotReloadNotice:
    | { kind: 'applied'; slug: string; message: string }
    | { kind: 'pending'; slug: string; message: string; label: string; lookTextBefore: string; lookTextAfter: string }
    | { kind: 'missing'; slug: string; message: string }
    | null;
  /**
   * The `'pending'` notice's reflect button (semantic 4): runs the deferred
   * re-materialization using the EXACT before/after text captured at
   * detection time (not a fresh re-read — the notice already named a
   * specific transition). No-op without a pending notice.
   */
  reflectPendingSharedLook(): Promise<void>;
  /**
   * Route a debounced shared-looks-directory-change push from main (see
   * preload's onSharedLooksChanged, subscribed once at module scope below):
   * re-reads every KNOWN look (one with an entry in `sharedLookTexts`) and
   * re-materializes followers of any whose content genuinely changed
   * (semantics 2/3) — the SAME fan-out path drift-at-open (semantic 5) uses.
   * A look with no cache entry yet is primed silently, never fanned out (see
   * `sharedLookTexts`'s own doc comment). No-op without an active project.
   */
  handleSharedLooksChanged(): Promise<void>;
  /**
   * LR-style preset hover preview (round-7 UX pack G §4): the RAW captured
   * look (pre-geometry-merge) a preset row is currently hovered over, or null
   * between hovers. Transient UI state ONLY — never serialized, never pushed
   * to history, never touched by autosave (those all key off `graph`, which
   * this never writes to). CanvasView's graphForBuild reads
   * `previewLook ?? graph` at the top of its derivation so the preview rides
   * the exact same render path a real apply would.
   */
  previewLook: GraphDoc | null;
  /**
   * Set (or clear, with null) the hover preview. Internally merges `look`
   * with the CURRENT input node's geometry via the same helper applyLook
   * uses (mergeLookWithCurrentGeometry) — so what's stored here, and what
   * CanvasView renders, is bit-for-bit what an actual Apply would produce,
   * minus the history push.
   */
  setPreviewLook(look: GraphDoc | null): void;
  /**
   * Preset-scoping-aware hover preview (PresetsMenu.tsx's handleRowEnter):
   * preview exactly what Apply would produce for `parsed`, family-scoped
   * merge included — a whole-look preset (`includes` absent) previews via
   * the same raw-swap setPreviewLook always used; a scoped preset previews
   * the SAME mergeScopedLook applyPreset itself uses, so hovering never
   * shows a different result than actually clicking Apply would.
   */
  previewParsedPreset(parsed: ParsedPreset): void;
  /** Replace the input node's geometry (crop + straighten); `coalesceKey` null = its own undo entry. */
  setGeometry(geo: GeometryParams, coalesceKey: string | null): void;
  /** Replace the input node's lens corrections; `coalesceKey` null = its own undo entry. */
  setLens(lens: LensParams, coalesceKey: string | null): void;
  /**
   * `opts.skipSidecar` (headless CLI's `--preset` path only — see
   * runCliRender): open as if no sidecar existed at all, even if one is on
   * disk — the fresh-open defaults (lens profile, base curve) still apply
   * exactly as a truly-fresh open would, and the input node's geometry stays
   * identity, which is what a preset's applyLook then preserves.
   *
   * `opts.keepFolderContext` (folder filmstrip, ROADMAP "nice to have"): by
   * default this function clears folderDir/folderEntries at the very TOP,
   * before the (possibly slow) decode/project-resolution work below — but
   * (UX pack round 2, item B) the SUCCESS commit re-sets `folderDir` to the
   * resolved project's own directory regardless of this flag, since ANY
   * resolved photo open activates/re-affirms a project and the strip must
   * show it. What this flag actually controls now is a brief MID-FLIGHT
   * flicker of the OLD strip during the switch (cleared at the top, restored
   * a moment later) — true keeps the strip's stale content from flashing
   * away and back for callers that already know they're staying in the same
   * project (a filmstrip cell click, ←/→ (stepFilmstrip), openFolder's own
   * "open the first entry", and every other project-aware caller).
   *
   * `opts.legacySidecarOnly` (headless CLI ONLY — runCliRender/runCliCheck/
   * runCliDiff's own internal calls, WITHOUT `--project`): bypasses the
   * project system entirely and reads/watches the LEGACY adjacent
   * `<image>.silverbox.json` exactly as before the project-storage
   * migration — no project is resolved/created, nothing is added to any
   * playlist. Never set by interactive UI code.
   *
   * `opts.cliProjectDir` (headless CLI ONLY, `--project <dir>` — CLI tooling
   * parity, project-storage.md stage 2): resolves `path`'s look from THAT
   * project's playlist, READ-ONLY — unlike the interactive path's
   * `ensureProjectAndAddPhoto`, this NEVER adds a playlist row or writes
   * anything; a photo not already on the playlist opens with the default
   * look and a `window.silverbox.cliWarn` notice instead (see
   * resolveCliProjectLook). Mutually exclusive with `legacySidecarOnly` —
   * exactly one of the two is set by the CLI runners, based on whether
   * `--project` was given.
   */
  openImageByPath(
    path: string,
    opts?: { skipSidecar?: boolean; keepFolderContext?: boolean; legacySidecarOnly?: boolean; cliProjectDir?: string }
  ): Promise<void>;
  openImageViaDialog(): Promise<void>;
  selectNode(id: string | null): void;
  updateNodeParam(nodeId: string, key: string, value: number): void;
  /**
   * B&W enable toggle (docs/brief-bank/bw-mixer.md) — a boolean, so it can't
   * ride updateNodeParam's numeric `value` (n.develop.bw.enabled: boolean).
   * `mix` is left untouched either way (toggling off/on round-trips it — see
   * BwParams' doc comment). No-op on a non-Develop nodeId.
   */
  setDevelopBwEnabled(nodeId: string, enabled: boolean): void;
  /**
   * Node bypass toggle (Resolve calls this "mute"; plain `m` / the node
   * body's bypass button): flips `disabled` on `nodeId`, one plain undo entry
   * per toggle (unlike updateNodeParam's coalescing param-drag key — every
   * keypress/click is its own discrete edit, not a continuous drag). No-op on a kind
   * the toggle doesn't apply to (isBypassableNodeKind — 'input'/'output'/
   * 'image' have nothing sensible to bypass to) or a missing nodeId.
   */
  toggleNodeDisabled(nodeId: string): void;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
  /**
   * "Arrange" (node-editor-ux.md's auto-layout-toggle successor, decided
   * 2026-07-18): writes `positions` (a node id -> computed-layout-position
   * map — NodeEditorPanel.tsx feeds this straight from computeAutoLayout,
   * dagre unchanged) into the doc's nodes. Real graph mutation: dirty ->
   * autosave, ONE `arrange` undo entry covering every node whose position
   * actually moved (>= 1px on either axis — anything smaller is dagre/float
   * noise, not a real move). Idempotent: if nothing moved beyond that
   * tolerance, this is a true no-op — no entry, no dirty, so re-clicking
   * Arrange on an already-arranged graph does nothing (brief's "idempotent
   * re-click"). `positions` may reference nodes no longer in the graph (a
   * stale computation racing a delete) — silently ignored, same defensive
   * stance nodeAutoLayout.ts's own `g.hasNode` guard takes.
   *
   * Returns whether anything actually moved — NodeEditorPanel.tsx uses this
   * to decide whether to request a fitView. That's load-bearing, not just an
   * optimization: `pendingFitRef` is only ever CONSUMED by the effect that
   * watches `rfNodes`, which itself only changes when `graph` gets a new
   * reference. Setting the flag on a true no-op (unchanged `graph`) would
   * leave it "banked" unconsumed until some LATER, unrelated `rfNodes`
   * change (e.g. a subsequent undo/redo) — which would then wrongly refit
   * the viewport against whatever positions happen to be current at THAT
   * point, not the ones Arrange computed.
   */
  arrangeNodes(positions: Record<string, { x: number; y: number }>): boolean;
  addOpNode(kind: AddableKind): void;
  removeOpNode(nodeId: string): void;
  /**
   * "Duplicate output" (docs/brief-bank/virtual-copy.md — the everyday
   * virtual-copy creation gesture): clones the ACTIVE output's own upstream
   * chain (every node reachable from it, minus the doc's single shared
   * 'input' node — never cloned) with fresh ids, wires the clone's root(s)
   * to the SAME source(s) the original chain started from, and appends a new
   * output node (name `"<active's name> copy"`, deduplicated against every
   * existing output name) wired to the clone's tail. One undo entry (default
   * kind 'photo-edit'); selects the new output node and makes it active —
   * the "just added, now editing it" convention addOpNode already follows
   * for every other kind. No-op if the doc somehow has no output at all.
   */
  duplicateOutput(): void;
  /** Rewire an input: replaces whatever currently feeds (target, handle). */
  connectEdge(source: string, target: string, targetHandle?: 'a' | 'b' | 'mask'): void;
  /** Delete an edge (allowed to break the path — the preview passes through). */
  removeEdge(edgeId: string): void;
  /** Selected output node id when the doc has more than one (named outputs); null = the doc's first. */
  activeOutputId: string | null;
  setActiveOutputId(id: string | null): void;
  /** Rename an output node (kind 'output' only); coalesced per keystroke run like a text field. */
  renameOutput(nodeId: string, name: string, coalesceKey: string | null): void;
  /**
   * Replace an output node's export-setting overrides wholesale (kind
   * 'output' only; per-output export settings design note). An empty object
   * normalizes to `undefined` on the node (same "no overrides" shape
   * parseGraphDoc produces), keeping a fully-inherited output's sidecar
   * free of a stray `"export": {}`. `coalesceKey` null = its own undo entry
   * (InspectorPanel's per-field checkboxes are discrete toggles; a typed
   * number field passes its own per-drag/typing session key, renameOutput's
   * convention).
   */
  setExportOverrides(nodeId: string, overrides: ExportOverrides, coalesceKey: string | null): void;
  /** Replace shapes[0] of a mask node; `coalesceKey` null = its own undo entry (see CropOverlay's setGeometry precedent). */
  setMaskShape(nodeId: string, shape: MaskShape, coalesceKey: string | null): void;
  /** LR-style red mask-select overlay (canvas-only, present-time); toggled by 'O' while a mask node is selected. */
  maskOverlay: boolean;
  toggleMaskOverlay(): void;
  /**
   * "+ Local Adjustment" (spec §4): in ONE undo entry, takes the node
   * currently feeding the ACTIVE output and builds Develop D (defaults) +
   * Mask M (default radial) + Blend B (a = that node, b = D, mask = M),
   * rewires the output to B, and selects M.
   */
  addLocalAdjustment(): void;
  /**
   * Draw-to-create variant (UX pack B §1): identical one-history-entry D/M/B
   * rig, but `shape` (the user's drag on the canvas — see CanvasView.tsx's
   * mask-draw gesture) becomes Mask M's shapes[0] instead of the default
   * centered radial. `addLocalAdjustment()` above stays available unchanged
   * for callers that just want the default rig (verify scripts included).
   */
  addLocalAdjustmentWithShape(shape: MaskShape): void;
  /**
   * LR-style draw-to-create mask mode (UX pack B §1): non-null while the
   * canvas is in "draw a new local-adjustment shape" mode (crosshair cursor,
   * pan suppressed) — set by the toolbar's "+ Radial"/"+ Linear" buttons,
   * cleared on commit (mouseup) or cancel (Escape, see App.tsx).
   */
  maskDrawMode: 'radial' | 'linear' | null;
  setMaskDrawMode(mode: 'radial' | 'linear' | null): void;
  /**
   * Spot-removal tool mode (task #50): toggled by the toolbar's "Spots"
   * button (like cropMode) — canvas cursor crosshair, pan suppressed, wheel
   * repurposed to adjust spotBrushRadius instead of zoom. Escape exits (see
   * App.tsx's Escape chain). Leaving the mode also clears selectedSpotIndex
   * (its handles only render while the mode is active — see SpotOverlay).
   */
  spotMode: boolean;
  setSpotMode(active: boolean): void;
  /** Index into the ACTIVE spots node's list (see findActiveSpotsNodeId) currently selected on-canvas; null = none. */
  selectedSpotIndex: number | null;
  setSelectedSpotIndex(index: number | null): void;
  /** Normalized (by max output dimension) brush radius used for the NEXT spot creation; adjustable via the spot-mode control strip slider or the canvas wheel while spotMode is active. */
  spotBrushRadius: number;
  setSpotBrushRadius(radius: number): void;
  /** Transient toolbar notice (4s auto-clear, connectNotice's pattern) shown when an add is refused past SPOTS_CAP. */
  spotsCapNotice: string | null;
  /**
   * Commit ONE spot-creation gesture (mousedown-drag-mouseup on the canvas
   * in spot mode): `dst`/`src` are normalized 0..1 image-space points,
   * `radius` is the current brush radius. If no spots node exists in the
   * active chain yet, auto-inserts one right after the input node (retouch
   * before color/develop) and adds the first spot — ONE combined undo entry.
   * If a spots node already exists anywhere in the active chain, the spot is
   * appended to its (the first such node's) list — still one undo entry.
   * Refuses (with spotsCapNotice) past SPOTS_CAP without mutating anything.
   */
  commitSpot(dst: { x: number; y: number }, src: { x: number; y: number }, radius: number): void;
  /** Move/resize one spot of a spots node; `coalesceKey` null = its own undo entry (drag handles pass a per-gesture session key — MaskOverlay's pattern). */
  updateSpot(nodeId: string, index: number, patch: Partial<Spot>, coalesceKey: string | null): void;
  /** Remove one spot by index — one undo entry; clears selectedSpotIndex. */
  removeSpot(nodeId: string, index: number): void;
  /** Wholesale-replace a spots node's list (verify __debug hook + the inspector's "clear all"; mirrors setMaskShape's pattern). Truncates to SPOTS_CAP. */
  setSpots(nodeId: string, spots: Spot[], coalesceKey: string | null): void;
  /** Async GPU failure surfaced from the render worker (device loss etc.) — mirrors the pre-worker GraphRenderer rejection UI. */
  gpuError: string | null;
  setGpuError(message: string | null): void;
  /** Rejected-connection notice for the node editor (auto-clears after 4s). */
  connectNotice: string | null;
  /** True while input→output does not resolve (preview shows pass-through). */
  graphBroken: boolean;
  setGraphBroken(broken: boolean): void;
  /**
   * Bumped whenever a customShader artifact is (re)compiled — the render
   * effect keys on it so validation results reach the screen even when the
   * GraphDoc itself did not change.
   */
  shaderRev: number;
  /** Replace an image node's referenced-file path (Inspector's "Choose…"); `coalesceKey` null = its own undo entry, same convention as setMaskShape/renameOutput. */
  setImagePath(nodeId: string, path: string, coalesceKey: string | null): void;
  /**
   * nodeId → true once that image node's referenced-file decode has
   * actually FAILED (missing/unreadable) — never true merely while a decode
   * is still in flight or before one has started (see imageNodeSource.ts's
   * syncImageNodeSources). Drives the node-editor badge (image node
   * feature); an absent/empty path is never "missing", just gray.
   */
  imageNodeMissing: Record<string, boolean>;
  setImageNodeMissing(nodeId: string, missing: boolean): void;
  /**
   * Bumped whenever an image-node decode settles (success or failure) —
   * imageNodeSource.ts's decode is fire-and-forget from the render effect's
   * own point of view, so this is what makes CanvasView's render effect
   * re-run (and post a fresh 'render'/texture) once the referenced file's
   * pixels are actually ready, mirroring shaderRev's role for async custom-
   * shader validation.
   */
  imageNodeRev: number;
  bumpImageNodeRev(): void;
  /**
   * Round-11 fix pack item 4 ("PNG chosen on an Image node showed no node
   * thumbnail"): nodeId → a SOURCE-FILE thumbnail blob: URL for image nodes,
   * fetched via the folder filmstrip's own machinery (thumbnailCache.ts —
   * CanvasView.tsx's own effect is the only writer). Purely a FALLBACK: an
   * image node reachable from the resolved output already gets a sharper
   * plan-derived thumbnail in `nodeThumbs` above, which NodeEditorPanel
   * always prefers; this map only fills the gap for an image node that isn't
   * wired to anything (nodeSteps, and therefore the render-worker thumbnail
   * batch, never covers a disconnected node). Unlike nodeThumbs, these blob:
   * URLs are owned/revoked by thumbnailCache.ts's own path-keyed cache
   * (shared with the filmstrip), not by this store — dropping a node's entry
   * here never revokes anything itself.
   */
  imageNodeSourceThumbs: Record<string, string>;
  setImageNodeSourceThumb(nodeId: string, url: string): void;
  /** Drop a node's source-file thumbnail entry (path cleared, or the node was removed) — no URL to revoke, see imageNodeSourceThumbs' doc comment. */
  clearImageNodeSourceThumb(nodeId: string): void;
  // --- External-tool hook node (denoise v1, task #41) ------------------------
  /** Replace an external node's command template (Inspector's command input); `coalesceKey` null = its own undo entry, same convention as setImagePath. */
  setExternalCommand(nodeId: string, command: string, coalesceKey: string | null): void;
  /** Toggle an external node's color-boundary mode (encoded sRGB vs linear Rec.2020 — see externalNode.ts's ExternalParams doc comment). */
  setExternalEncoded(nodeId: string, encoded: boolean): void;
  /** nodeId → the command awaiting the user's explicit "Run external tool" confirm (SECURITY gate, see externalNodeRunner.ts) — absent once confirmed or with nothing pending. */
  externalNodeNeedsConfirm: Record<string, string>;
  setExternalNodeNeedsConfirm(nodeId: string, command: string | null): void;
  /** Inspector's confirm button: marks (doc, command) confirmed for this session and immediately retries the last pending request for this node. */
  confirmExternalNode(nodeId: string): void;
  /** nodeId → the most recent round-trip failure reason (pass-through + badge on ANY failure) — absent = no error, or cleared by a subsequent success. */
  externalNodeErrors: Record<string, string>;
  setExternalNodeError(nodeId: string, error: string | null): void;
  /** nodeId → true while its subprocess round trip is actually in flight (spinner badge) — set right before the IPC call, cleared on settle; see externalNodeRunner.ts's onStarted callback. Absent/false = not running. */
  externalNodeRunning: Record<string, boolean>;
  setExternalNodeRunning(nodeId: string, running: boolean): void;
  /** Bumped whenever an external-tool round trip settles (success or failure) or a cached result becomes ready with no run needed — mirrors imageNodeRev's role in re-running CanvasView's render effect. */
  externalNodeRev: number;
  bumpExternalNodeRev(): void;
  // --- In-engine ML denoise (denoise v2, stage 1) ----------------------------
  /** Replace a denoise node's strength (Inspector's slider); `coalesceKey` null = its own undo entry, same convention as setExternalCommand. */
  setDenoiseStrength(nodeId: string, strength: number, coalesceKey: string | null): void;
  /** nodeId → true while the model isn't downloaded and consent hasn't been granted yet (SECURITY gate, see denoiseModel.ts) — absent/false once consent is granted or the model was already present. */
  denoiseNodeNeedsConsent: Record<string, boolean>;
  setDenoiseNodeNeedsConsent(nodeId: string, needsConsent: boolean): void;
  /** Inspector's "Download denoise model" button: persists consent (settingsUpdate) then immediately retries the last pending request for this node. */
  consentDenoiseModel(nodeId: string): Promise<void>;
  /** nodeId → the most recent round-trip failure reason (pass-through + badge on ANY failure, EXCEPT a needsConsent failure — that's `denoiseNodeNeedsConsent`'s own badge, not this one) — absent = no error. */
  denoiseNodeErrors: Record<string, string>;
  setDenoiseNodeError(nodeId: string, error: string | null): void;
  /** nodeId → true while its ORT inference round trip is actually in flight (spinner badge) — same role as externalNodeRunning. */
  denoiseNodeRunning: Record<string, boolean>;
  setDenoiseNodeRunning(nodeId: string, running: boolean): void;
  /** Bumped whenever a denoise round trip settles or a cached result becomes ready with no run needed — mirrors externalNodeRev's role. */
  denoiseNodeRev: number;
  bumpDenoiseNodeRev(): void;
  // --- DCP camera-profile mode (docs/brief-bank/dcp-profile.md, stage 1) -----
  /** 'idle' (no DCP configured), 'loading' (readFile+parse+bake in flight), 'ready' (a lattice was baked and posted to the worker), 'error' (see dcpProfileError). Drives the minimal Inspector UI's status line. */
  dcpProfileStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Actionable message from the last failed load (bad path, not a DCP, malformed structure — see engine/color/dcp/parser.ts) — null when status isn't 'error'. */
  dcpProfileError: string | null;
  /** Bumped once a DCP bake lands worker-side — mirrors imageNodeRev's "an async op settled, re-render" role (the bake itself needs file IO, so it can't happen inside buildPlan). */
  dcpProfileRev: number;
  /**
   * Read+parse+bake the Develop node's currently-configured DCP file (no-op,
   * status 'idle', if profile.source isn't 'dcp' or dcpPath is empty) and
   * mirror the resulting lattice into the render worker. Called after
   * opening an image (so a saved DCP config takes effect immediately,
   * including under the headless CLI, which shares this same store) and
   * after the user changes profile.source/dcpPath.
   */
  refreshDcpProfile(): Promise<void>;
  /** Update the Develop node's profile source/DCP path (Inspector's minimal UI); `amount` keeps riding updateNodeParam like every other numeric slider. */
  setDevelopProfileSource(nodeId: string, source: 'builtin' | 'dcp'): void;
  setDevelopProfileDcpPath(nodeId: string, dcpPath: string): void;
  /** Validate `src` for a custom node; on success apply it (one undo step). */
  applyShaderSource(nodeId: string, src: string): Promise<void>;
  /** Replace one tone-curve channel; `session` coalesces a drag into 1 undo. */
  setToneCurvePoints(
    nodeId: string,
    channel: 'rgb' | 'r' | 'g' | 'b',
    points: [number, number][],
    session: number
  ): void;
  /** Set several Develop params at once (a wheel drag = hue+sat, 1 undo). */
  updateNodeParamsBatch(nodeId: string, entries: [string, number][], coalesceKey: string): void;
  /** Declare a new GUI param; returns an error message or null. */
  addShaderParam(nodeId: string, def: { name: string; min: number; max: number; default: number }): string | null;
  removeShaderParam(nodeId: string, name: string): void;
  updateShaderParam(nodeId: string, name: string, value: number): void;
  setRenderer(renderer: RenderWorkerClient): void;
  /**
   * The live preview viewport's animated-fit trigger (round-7 UX pack G §2,
   * Space): CanvasView registers useCanvasViewport's `fitAnimated` here on
   * mount (same "component-local imperative thing, reachable from the
   * window-level shortcut chain in App.tsx" pattern as `renderer` above) and
   * clears it on unmount. Null whenever no canvas is mounted (or before it
   * mounts) — App.tsx's Space handler just no-ops in that case.
   */
  viewportFitAnimated: ((durationMs?: number) => void) | null;
  setViewportFitAnimated(fn: ((durationMs?: number) => void) | null): void;
  setHistogram(histogram: HistogramData | null): void;
  /** Write the graph to the image's sidecar (`<image>.silverbox.json`). */
  saveGraph(): Promise<void>;
  /**
   * Develop at full resolution and write .jpg/.png (dialog when no path).
   * Exports the ACTIVE output (`opts.outputId` overrides it) — the single-
   * file path every verify script's `exportImageTo`/toolbar "Export…" used
   * before the export dialog existed; unaffected by the dialog's "All
   * outputs" mode, which goes through `exportSelectedOutputs` instead.
   */
  exportImage(path?: string, opts?: ExportOverrides & { outputId?: string }): Promise<void>;
  /**
   * Export dialog's "output" selector (UX pack B §4): `target` is a specific
   * output node id, `'active'` (the currently previewed output — the
   * dialog's default selection), or `'all'` (every output node, one file
   * each). A single resolved target reuses `path` as-is (current behavior,
   * no suffix); 2+ targets get `<path>-<outputName>.<ext>` per file (see
   * `suffixExportPath`). One native save-dialog prompt for the whole batch
   * (unless `path` is pre-supplied, e.g. by a verify script). Per-output
   * `opts` here are the FALLBACKS (dialog controls / CLI flags) — a target
   * node's own `node.export` overrides win per field (resolveExportSettings,
   * applied inside exportOnePath).
   */
  exportSelectedOutputs(target: 'active' | 'all' | string, path?: string, opts?: ExportOverrides): Promise<void>;
  /**
   * Headless CLI renderer's whole batch (main/index.ts's `--render` mode):
   * opens each image fresh (its own sidecar, or `job.preset` applied on the
   * default doc — see openImageByPath's `skipSidecar`), resolves
   * `job.output` against the doc's output nodes (a name, `'all'`, or the
   * first when null), and writes one file per resolved output via the same
   * `exportOnePath` body every other export path shares. Never throws for a
   * single image's failure — `onResult` receives a `{input,error}` object
   * instead and the loop continues to the next image (CLI contract: exit 1,
   * not abort). `onResult` fires once per rendered FILE (so `output: 'all'`
   * on a multi-output doc reports one line per output, all sharing the same
   * `input`), streamed as the render completes rather than batched at the
   * end, so main can print progress live.
   */
  runCliRender(job: CliRenderJob, onResult: (result: CliRenderResult) => void): Promise<void>;
  /**
   * Golden-render check/update (main/index.ts's `--check` mode, ROADMAP
   * "Golden renders"): opens each image fresh with its OWN sidecar-or-
   * default look (no preset support — a golden always represents that
   * image's real look, per the CLI contract), renders the doc's first
   * output at full resolution, and hands the pixels to
   * `window.silverbox.checkGoldenImage` — main resizes to the golden's
   * fixed long edge, then either writes the golden (`job.update`) or
   * compares against the one on disk and reports. Same never-throws-per-
   * image contract as runCliRender: a failure becomes `{input,error}` and
   * the loop continues.
   */
  runCliCheck(job: CliCheckJob, onResult: (result: CliCheckResult) => void): Promise<void>;
  /**
   * Sidecar visual diff CLI (main/index.ts's `--diff` mode, git-native
   * completion brief §1): reads `job.sidecarA`/`job.sidecarB` as raw text
   * (arbitrary files — neither has to be the image's own on-disk sidecar),
   * decodes `job.image` TWICE (renderToPixels transfers its PreparedImage's
   * data buffer — see exportOnePath's own doc comment — so each render needs
   * its own fresh `loadImage()`, same discipline exportSelectedOutputs'
   * per-output loop already follows), parses both docs with that image's own
   * dims (anchor-space migration, same as any real open), and reports
   * diffLook's lines plus either the ΔE stats between the two renders or
   * `status:'dims-changed'` if their geometry disagrees badly enough to
   * render different pixel dimensions. Same never-throws-per-job contract as
   * runCliRender/runCliCheck: a failure becomes `{input,error}`; unlike those
   * two, `job` is never a batch (see CliDiffJob's doc comment), so `onResult`
   * fires exactly once.
   */
  runCliDiff(job: CliDiffJob, onResult: (result: CliDiffResult) => void): Promise<void>;
  /**
   * Look extraction, mode 1 (main/index.ts's `--extract-look` mode,
   * docs/brief-bank/look-extraction.md — sidecar-consensus distillation):
   * reads every `job.looks` file as raw text, `parseGraphDoc`s each (no
   * `srcDims` — this mode only ever reads a Develop node's own params,
   * never masks/spots/geometry, so there is no anchor-space migration to
   * feed dims into), pulls out each doc's first Develop node's params, and
   * hands them to engine/look/consensus.ts's computeLookConsensus. Never
   * opens an image, never touches the GPU — same "pure JSON math, one job,
   * one outcome" shape as runCliDiff, `onResult` fires exactly once. A
   * `job.families` entry this build doesn't recognize (or a structural one,
   * always out of scope for a look — see the brief) is a hard failure
   * naming the bad id, same "explicit error over silent guess" cliArgs.ts
   * convention.
   */
  runCliExtractLook(job: CliExtractLookJob, onResult: (result: CliExtractLookResult) => void): Promise<void>;
  /**
   * Look extraction, MODE 2 stage 1 (main/index.ts's `--from-references` mode,
   * docs/brief-bank/look-extraction-mode2-stage1.md — reference-set statistical
   * solve): DECODES each `job.references` image (loadImage, no GPU/graph — the
   * signature reads raw decoded pixels, exactly like the base-curve fitter
   * samples the neutral decode), aggregates a luma signature
   * (engine/look/signature.ts's aggregateSignature), solves the freeze-stage-1
   * tone curve against the PLACEHOLDER neutral baseline
   * (engine/look/solve.ts's solveToneCurve), and writes a `curves`-only preset.
   * ONE job, ONE outcome (same shape as runCliExtractLook — `onResult` fires
   * exactly once). Never renders; the color/grain freeze stages are stage 2
   * (reported as deferred).
   */
  runCliExtractReferences(job: CliExtractReferencesJob, onResult: (result: CliExtractReferencesResult) => void): Promise<void>;
  /** Export dialog open/closed (Toolbar's "Export…" button / ⌘E — see App.tsx). */
  exportDialogOpen: boolean;
  setExportDialogOpen(open: boolean): void;
  /** Settings dialog open/closed (Toolbar's "Settings…" gear button — see App.tsx's Escape chain). */
  settingsDialogOpen: boolean;
  setSettingsDialogOpen(open: boolean): void;
  /** Set after a successful exportSelectedOutputs batch — how many files, and their paths (dialog display / verify). */
  exportBatchInfo: { count: number; paths: string[] } | null;
  /**
   * LUT export (task #33): captures the ACTIVE output's color pipeline as a
   * .cube + Unity/UE strip PNGs + WebGL snippet — pure function of the graph
   * + wbModel (engine/color/lutExport.ts), no re-decode needed. `path` (a
   * base path with no extension) bypasses the native save dialog, same
   * convention as exportImage/exportSelectedOutputs's own `path` param.
   */
  exportLut(path?: string): Promise<void>;
  /** Set after a successful exportLut — file count, their paths, and any color ops the LUT could not capture. */
  exportLutInfo: { count: number; paths: string[]; skipped: string[] } | null;
  /**
   * Undo the top entry of the global stack (docs/brief-bank/global-undo.md).
   * Async now: an entry belonging to a DIFFERENT (not currently open) photo
   * JUMPS — `openImageByPath`s that photo first (decision 1: "状態や画面が
   * 戻ってる必要があるから" — undo must restore the visible state, not just
   * the file), THEN applies the entry's `before` value and rides the normal
   * dirty-or-direct-write path (decision 4). If the target file is missing
   * (relink pending), the undo is BLOCKED — a `projectNotice` explains why,
   * and the entry stays on the stack untouched (not silently skipped, not
   * applied blind). A no-op with an empty stack.
   */
  undo(): Promise<void>;
  /** Redo — symmetric with `undo()` above (same jump/block semantics, reversed direction). */
  redo(): Promise<void>;
  /** `<userData>/settings.json`, loaded at boot; DEFAULT_SETTINGS until that IPC round-trip resolves. */
  settings: Settings;
  /** Merge `partial` into the persisted settings via IPC; updates local state with the sanitized result. */
  updateSettings(partial: Partial<Settings>): Promise<void>;
  /**
   * Round-10 fix pack item 3 ("変えたけど反映されてないかも？" — baselineExposureEV
   * silently did nothing until the NEXT open): re-decode the CURRENTLY open
   * image at the interactive preview resolution with the live settings and
   * swap in the result, WITHOUT touching graph/history/dirty/sidecar state —
   * only `image` (and whatever CanvasView's own effect derives from it, i.e.
   * the render worker's texture) changes. No-op if no image is open. Called
   * by updateSettings when baselineExposureEV actually changes; exposed on
   * the interface (rather than folded silently into updateSettings) so a
   * genuine re-open racing it is easy to reason about via the same
   * OpenSession epoch guard openImageByPath uses.
   */
  reloadImageForSettings(): Promise<void>;
}

// --- Sidecar autosave (settings.autosaveSidecar, default ON) ---------------
//
// Debounced 1000ms after the LAST graph mutation (⌘S saves immediately and
// cancels this timer instead of racing it). Declared at module scope, above
// the store, so both `openImageByPath` (cancel on image switch) and the
// post-creation subscriber below (schedule on mutation) close over the same
// timer handle without a definition-order problem.
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
function cancelAutosaveTimer(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

// --- Fingerprint (project-storage migration, stage 3) ----------------------
//
// The sha256 recipe itself lives main-side (src/main/index.ts's
// computeFingerprint — the stability contract's home); this module only
// ever ASKS for it and memoizes the answer per photo PATH for the lifetime
// of the session, so N autosaves in a row of the SAME open photo cost one
// IPC round trip (a head+tail disk read), not N ("cache per photo per
// session" — docs/brief-bank/project-storage.md's fingerprint section).
// Module scope (not store state): it's a pure cache, never itself part of
// any document, and every caller (saveGraph, relinkPhoto, the folder-import
// batch) reaches it the same way regardless of which store action is running.
const fingerprintCache = new Map<string, string>();
async function computeFingerprintCached(photoPath: string): Promise<string | null> {
  const cached = fingerprintCache.get(photoPath);
  if (cached !== undefined) return cached;
  const fingerprint = await window.silverbox.fingerprintFile(photoPath);
  if (fingerprint !== null) fingerprintCache.set(photoPath, fingerprint);
  return fingerprint;
}

// --- Autosave flush-on-switch (conductor review finding, data loss) --------
//
// saveGraph reads its own `get()` lazily, mid-flight, which is exactly right
// for its ordinary callers (⌘S, the debounce timer) — but wrong for a flush
// that has to survive a photo switch racing it: by the time an awaited
// `writeSidecar` resolves, `get()` could already belong to the NEW photo.
// So the serialization is split into a pure capture step (everything
// saveGraph needs, pulled out of state synchronously, before anything else
// runs) and an async write step (no state reads at all — only what's in the
// snapshot). saveGraph and flushPendingAutosave below both go
// capture-then-write; only what happens with the *result* differs (see each
// one's own guard).

/** Pure snapshot of everything saveGraph needs to serialize ONE photo's look. */
interface GraphSaveSnapshot {
  imagePath: string;
  currentLookPath: string;
  source: SidecarSource;
  graph: GraphDoc;
  sidecarCreatedAt: string | null;
  sidecarRating: number;
  sidecarFlag: PhotoFlag | null;
  sidecarUnknownFields: Record<string, unknown> | null;
  sidecarFingerprint: string | null;
  sidecarPhotoAtOpen: string | null;
  project: ActiveProject | null;
}

/**
 * Capture step — mirrors saveGraph's own early-return guard exactly
 * (`imagePath`/`fileName`/`sidecarUnreadable`/`currentLookPath`), so a caller
 * gets `null` in precisely the cases saveGraph itself would silently no-op
 * for. Callers that stand in for the debounced autosave timer (rather than
 * an explicit save) additionally check `graphDirty && settings.autosaveSidecar`
 * themselves first — see flushPendingAutosave.
 */
function captureGraphSaveSnapshot(state: AppState): GraphSaveSnapshot | null {
  const {
    imagePath,
    fileName,
    image,
    graph,
    sidecarCreatedAt,
    sidecarRating,
    sidecarFlag,
    sidecarUnreadable,
    sidecarUnknownFields,
    sidecarFingerprint,
    sidecarPhotoAtOpen,
    project,
    currentLookPath,
  } = state;
  if (!imagePath || !fileName || sidecarUnreadable || !currentLookPath) return null;
  return {
    imagePath,
    currentLookPath,
    source: {
      fileName,
      ...(image?.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
      kind: isRawFileName(fileName) ? 'raw' : 'jpg',
    },
    graph,
    sidecarCreatedAt,
    sidecarRating,
    sidecarFlag,
    sidecarUnknownFields,
    sidecarFingerprint,
    sidecarPhotoAtOpen,
    project,
  };
}

/**
 * Write step — serializes `snapshot` and writes it to disk. Reads nothing
 * from the store (only the snapshot itself), so it's safe to run arbitrarily
 * long after capture, racing whatever the store does meanwhile. Returns what
 * the post-write bookkeeping needs; the caller decides whether the snapshot
 * it captured is still the store's current photo before applying it (see
 * saveGraph and flushPendingAutosave).
 */
async function writeGraphSaveSnapshot(
  snapshot: GraphSaveSnapshot
): Promise<{ createdAt: string; fingerprint: string | null; photo: string | null; content: string }> {
  const createdAt = snapshot.sidecarCreatedAt ?? new Date().toISOString();
  // `photo` (project-storage migration): only meaningful inside a project —
  // see saveGraph's own doc comment on this and the fingerprint fallback
  // below, which this mirrors exactly.
  const photo = snapshot.project ? relativizeProjectPath(snapshot.project.dir, snapshot.imagePath) : undefined;
  let fingerprint = snapshot.sidecarFingerprint ?? undefined;
  if (snapshot.project && photo !== undefined && (fingerprint === undefined || snapshot.sidecarPhotoAtOpen !== photo)) {
    fingerprint = (await computeFingerprintCached(snapshot.imagePath)) ?? undefined;
  }
  const content = serializeGraphDoc(
    snapshot.graph,
    snapshot.source,
    createdAt,
    snapshot.sidecarUnknownFields ?? undefined,
    snapshot.sidecarRating,
    photo,
    fingerprint,
    snapshot.sidecarFlag ?? undefined
  );
  await window.silverbox.writeSidecar(snapshot.currentLookPath, content);
  // Develop-aware filmstrip thumbnails (develop-aware-thumbnails-impl.md,
  // semantic 3's single-photo-autosave trigger): this is the ONE low-level
  // write shared by saveGraph, the autosave debounce, and
  // flushPendingAutosave, so bumping here covers all three — plus every
  // OTHER action that persists ITS primary photo through get().saveGraph()
  // (revertFamilyToLook, resetAllFamiliesToLook, unlinkLook, and the primary
  // leg of publishToSharedLook/applyPresetToSelection/applyRepairSheet/
  // linkPhotosToLook — those four ALSO bump their own written SECONDARY
  // targets separately, at their own `refreshPlaylistStatus()` call site,
  // since this snapshot only ever covers the ONE currently-open photo).
  // `writeGraphSaveSnapshot` is a free function (no `get()`/`set()` closure —
  // see this function's own doc comment), so it reaches the store via
  // `useAppStore.getState()`, the same idiom this file's module-level
  // `subscribe` blocks already use.
  useAppStore.getState().bumpLookVersion([snapshot.imagePath]);
  return { createdAt, fingerprint: fingerprint ?? null, photo: photo ?? null, content };
}

/** Order-insensitive canonical form of a develop `link`, for comparing two link snapshots (`follows` is a set — element order is not significant). */
function canonicalDevelopLink(link: DevelopLink | undefined): string {
  if (!link) return '';
  return JSON.stringify({ look: link.look, follows: [...link.follows].sort(), materializedFrom: link.materializedFrom });
}

/**
 * True when the open photo's live graph carries a develop-link change (a FORK
 * — `link.follows` shrinking via forkLinkedFamilies, or any other link edit)
 * that is NOT yet on disk, measured against the exact text last read/written
 * for this photo (`lastSidecarText`). Only the link METADATA is compared —
 * ordinary develop value edits are deliberately excluded, so this gates ONLY
 * the fork/link case (see flushPendingAutosave's caller for why value edits
 * keep riding the autosave setting).
 *
 * Conservative on any uncertainty (no baseline, or an unparseable one ⇒
 * false): a never-saved photo has no on-disk look file for a later publish to
 * misread, so an unflushed fork on it is not at risk regardless.
 */
function graphHasUnsavedDevelopLinkChange(state: AppState): boolean {
  if (!state.lastSidecarText) return false;
  let baseline: SidecarDoc;
  try {
    baseline = parseGraphDoc(state.lastSidecarText);
  } catch {
    return false;
  }
  const baselineLinks = new Map<string, string>();
  for (const n of baseline.graph.nodes) {
    if (n.kind === DEVELOP_KIND) baselineLinks.set(n.id, canonicalDevelopLink(n.link));
  }
  for (const n of state.graph.nodes) {
    if (n.kind !== DEVELOP_KIND) continue;
    if (canonicalDevelopLink(n.link) !== (baselineLinks.get(n.id) ?? '')) return true;
  }
  return false;
}

/**
 * Flush whatever autosave the timer `cancelAutosaveTimer` is about to cancel
 * would have performed for the photo that's closing (openImageByPath /
 * openProjectByPath's own doc comments on their cancel calls) — conductor
 * review finding: without this, an edit made <1000ms before switching photos
 * (a slider move, a rating, a flag — anything that only marks `graphDirty`)
 * was silently lost, because nothing else ever gets another chance to save
 * it once the new open replaces `graph`/`imagePath` in memory.
 *
 * CALLER CONTRACT — do not call this for a same-path reopen. A first version
 * of this fix called it unconditionally from openImageByPath, including when
 * the path being opened is the SAME one already open; that write races the
 * reopen's OWN upcoming read of the identical look file and can hand it back
 * the very in-memory edit the reopen is supposed to discard (a same-path
 * "reopen" is a reload-from-disk gesture, not a switch — verify-basecurve's
 * "reopening re-seeds" / "deleted-curve sidecar is not re-seeded" checks
 * caught this regression: the flushed identity-curve edit got persisted and
 * read straight back, so the curve was never re-seeded and a later Reset to
 * that SAME identity curve was a no-op that hung waiting for a histogram
 * change that could never come). openImageByPath's own call site guards
 * this; openProjectByPath's own look file is always project-scoped
 * (`currentLookPath`), which a project switch always changes even when the
 * underlying photo path repeats, so it has no same-path case to guard.
 *
 * `state` must be captured by the CALLER before its own first `set()` — this
 * function itself never reads the store except inside the write's `.then`,
 * by which point a newer open may already own it (see the guard there).
 * Returns the write's own promise (resolved immediately if there was nothing
 * to flush) so a caller with an ordering requirement of its own (currently
 * only openProjectByPath, for the `project` reference — see its call site)
 * can await it; openImageByPath's own call site does NOT await it, on
 * purpose — the write targets the OLD photo's look file, a different path
 * than whatever the new open is about to touch, so nothing on disk races,
 * and awaiting it would slow down every ordinary filmstrip switch for
 * nothing.
 */
function flushPendingAutosave(state: AppState): Promise<void> {
  if (!state.graphDirty) return Promise.resolve();
  // Ordinary develop VALUE edits ride the autosave setting — with autosave
  // off they are intentionally discarded on switch (verify-exportsettings's
  // own contract). A pending FORK (docs/brief-bank/linked-looks-forkbug.md),
  // by contrast, must persist on switch REGARDLESS of the setting: it is a
  // deliberate 個別調整 that publish / re-materialize read straight off the
  // follower's file on disk (they never see this photo's in-memory graph once
  // it's switched away), so a fork left only in memory is silently overwritten
  // by the next publish, which re-follows the family and clobbers the photo
  // with the look's value — the exact user-reported bug. This project's own
  // settings ship autosaveSidecar OFF, so that is the primary path here.
  if (!state.settings.autosaveSidecar && !graphHasUnsavedDevelopLinkChange(state)) return Promise.resolve();
  const snapshot = captureGraphSaveSnapshot(state);
  if (!snapshot) return Promise.resolve();
  // Epoch token (conductor review finding #2): `imagePath` equality alone
  // can't tell "the session this flush belongs to" apart from "a LATER
  // reopen of that same path" — e.g. A (dirty) → switch to B (this flush
  // fires, fire-and-forget) → switch back to A before the write resolves.
  // By the time it resolves, `imagePath` reads A again — coincidentally
  // matching — even though a brand-new session now owns A. Snapshotting the
  // current OpenSession epoch here and comparing it after the write closes
  // that gap: any open (same path or not) constructed after this moment
  // bumps the epoch, so a real "still current" check needs both this AND
  // the imagePath check below (imagePath alone would wrongly apply a stale
  // flush's bookkeeping onto a *different* photo that hasn't superseded the
  // epoch yet — see openImageByPath, which constructs its OpenSession
  // before calling this).
  const epochAtCapture = OpenSession.currentEpoch();
  return writeGraphSaveSnapshot(snapshot).then((result) => {
    // The disk write already happened — that's the point, the edit is safe.
    // Only the in-memory bookkeeping is stale if a newer session has since
    // claimed the epoch, OR a different photo now owns `imagePath` (same
    // idea as saveGraph's own post-write guard); skipping lastSidecarText
    // here is correct too — the hot-reload watcher has re-armed onto the
    // new photo's look by the time this resolves.
    if (OpenSession.currentEpoch() !== epochAtCapture) return;
    if (useAppStore.getState().imagePath !== snapshot.imagePath) return;
    useAppStore.setState({
      graphDirty: false,
      sidecarCreatedAt: result.createdAt,
      sidecarFingerprint: result.fingerprint,
      sidecarPhotoAtOpen: result.photo,
      lastSidecarText: result.content,
      sidecarHotReloadNotice: null,
    });
  });
}

/**
 * Shared core between importLegacySidecar (the single-photo one-click offer,
 * for the CURRENTLY open photo) and importSidecarsFromFolder (the toolbar's
 * batch action, stage 3): parse an adjacent legacy sidecar's raw text and
 * re-serialize it as a project look — adding `photo` (relative to the
 * project dir) and a freshly computed `fingerprint`. Throws on anything
 * parseGraphDoc itself rejects; callers decide what "unreadable" means for
 * their own UI (importLegacySidecar surfaces one notice, the folder batch
 * just counts it and moves on to the next file). `srcDims` is the decoded
 * image's dims, when known (see parseGraphDoc's own doc comment on the
 * pre-v4 mask/spot coordinate migration this enables) — the folder batch has
 * no decoded dims for photos it hasn't opened, so it omits this, same as any
 * other dimensionless caller.
 */
async function buildImportedLookContent(
  project: ActiveProject,
  imagePath: string,
  text: string,
  srcDims?: { width: number; height: number }
): Promise<string> {
  const parsed = parseGraphDoc(text, srcDims);
  const photo = relativizeProjectPath(project.dir, imagePath);
  const fingerprint = (await computeFingerprintCached(imagePath)) ?? undefined;
  return serializeGraphDoc(
    parsed.graph,
    parsed.source ?? null,
    parsed.createdAt ?? null,
    parsed.unknown,
    parsed.rating,
    photo,
    fingerprint,
    parsed.flag
  );
}

// --- Baseline-exposure re-decode debounce (round-13 fix pack item 2) -------
//
// baselineExposureEV is the only setting whose change re-decodes the open
// image (~1s, a full RAW read+decode) — see reloadImageForSettings' own doc
// comment. A spinner click or a keystroke mid-typing ("1" then "1.5") each
// used to trigger one full re-decode; this collapses a burst into ONE
// reloadImageForSettings call for the LAST value, 300ms after the burst goes
// quiet. Only the re-decode is delayed — updateSettings persists the setting
// (settingsUpdate + set({settings})) synchronously as before. All callers
// awaiting the same debounce window share its single reload via
// `waiters`, so `await updateSettings(...)` still resolves once the pixels
// it asked for are actually on screen (or the reload was superseded/failed).
let settingsReloadTimer: ReturnType<typeof setTimeout> | null = null;
let settingsReloadWaiters: Array<() => void> = [];
function scheduleSettingsReload(): Promise<void> {
  if (settingsReloadTimer !== null) clearTimeout(settingsReloadTimer);
  return new Promise((resolve) => {
    settingsReloadWaiters.push(resolve);
    settingsReloadTimer = setTimeout(() => {
      settingsReloadTimer = null;
      const waiters = settingsReloadWaiters;
      settingsReloadWaiters = [];
      // reloadImageForSettings early-returns if the image closed meanwhile
      // (its own imagePath/imageStatus check) and carries its own
      // OpenSession epoch guard against a real open racing it — nothing
      // extra needed here for either case.
      void useAppStore
        .getState()
        .reloadImageForSettings()
        .finally(() => waiters.forEach((resolve) => resolve()));
    }, 300);
  });
}

// --- Embedded-preview-first opening (AppState.openingPreview) --------------
//
// Revoke the overlay's blob: URL and drop it — call sites: a new open
// starting (openImageByPath's top) and the open failing both still revoke
// immediately here (nothing will ever hand that URL off to a completed
// switch). The real image reaching 'ready' is DIFFERENT since item F
// (decode-completion flash fix): that commit only nulls the FIELD — the URL
// itself is released later, by CanvasView, via releaseOpeningPreviewUrl
// below, once the real frame has actually presented (see that commit's own
// doc comment for why revoking synchronously with 'ready' reintroduced the
// flash this whole mechanism exists to prevent).
//
// Verify-only: every URL actually revoked here, in order (REGARDLESS of
// which of the paths above did it) — lets verify-preview.mjs prove a rapid
// second open revoked the FIRST open's URL specifically (not just that
// openingPreview is now null, which a leaked URL sitting unreferenced would
// also show).
const revokedOpeningPreviewUrls: string[] = [];
export function openingPreviewRevocationLog(): readonly string[] {
  return revokedOpeningPreviewUrls;
}

/**
 * Item F: CanvasView calls this once it's actually done showing a preview it
 * froze past the 'ready' transition — either the real frame finally
 * presented (pendingSwitch cleared) or the component unmounted with one
 * still pending. The ONLY revocation path for a URL that made it to a
 * completed switch (see the section doc comment above); logged into the
 * SAME ledger every other revocation path uses.
 */
export function releaseOpeningPreviewUrl(url: string): void {
  URL.revokeObjectURL(url);
  revokedOpeningPreviewUrls.push(url);
}

function clearOpeningPreview(state: Pick<AppState, 'openingPreview'>): { openingPreview: null } {
  if (state.openingPreview) {
    URL.revokeObjectURL(state.openingPreview.url);
    revokedOpeningPreviewUrls.push(state.openingPreview.url);
  }
  return { openingPreview: null };
}

/**
 * The per-PHOTO fields openImageByPath's own success commit resets on every
 * switch (image, graph, sidecar fields, selectedNodeId, … — see that
 * commit's own field list), factored out here so "close the open photo back
 * to nothing"
 * has ONE definition shared by `newProject` (item A: closes the whole
 * project too — see its own call site) and `removeFromProject`'s own
 * "removed the last remaining neighbor too" fallback (item C, which must
 * NOT touch project/folderDir — the project stays active, just emptied).
 * Deliberately excludes anything openImageByPath itself doesn't touch
 * (undoStack, exportStatus, histogram, renderer, …) — same scope discipline.
 */
function emptyPhotoFields(): Partial<AppState> {
  return {
    imageStatus: 'idle',
    image: null,
    fileName: null,
    imagePath: null,
    imageError: null,
    settingsReloading: false,
    currentLookPath: null,
    currentPhotoMissingNotice: null,
    graph: defaultGraphDoc(),
    graphDirty: false,
    selectedNodeId: null,
    nodeThumbs: {},
    imageNodeMissing: {},
    imageNodeSourceThumbs: {},
    inspectNodeId: null,
    shaderErrors: {},
    sidecarNotice: null,
    sidecarUnreadable: false,
    sidecarCreatedAt: null,
    sidecarRating: 0,
    sidecarFlag: null,
    sidecarUnknownFields: null,
    sidecarFingerprint: null,
    sidecarPhotoAtOpen: null,
    lastSidecarText: null,
    sidecarHotReloadNotice: null,
    sidecarDiffDialog: null,
    sharedLookHotReloadNotice: null,
    exportInfo: null,
    wbModel: DEFAULT_WB_MODEL,
    activeOutputId: null,
    maskOverlay: false,
    maskDrawMode: null,
    cropMode: false,
    wbPicking: false,
    colorKeyPicking: false,
    spotMode: false,
    selectedSpotIndex: null,
    compareMode: false,
    compareOutputId: null,
    compareDocOverride: null,
  };
}

/**
 * Global-undo stack advance for a graph mutation (docs/brief-bank/
 * global-undo.md) — the direct successor of the old per-photo `pushHistory`
 * (whole-`GraphDoc` `past`/`future` arrays): `key` still coalesces a slider-
 * drag run into ONE entry, exactly as before, but the entry itself now lands
 * on the GLOBAL stack, tagged with the currently open photo (`target`) and a
 * `kind`/`label` pair the undo/redo dispatcher and the tooltip surface use.
 * No-op (leaves the stack untouched) if no image is open — every call site
 * below only ever runs while one is, so this is defensive, not load-bearing.
 */
function pushHistory(
  s: AppState,
  key: string | null,
  opts?: { kind?: GraphEntryKind; label?: string }
): { undoStack: UndoStackState } {
  const target = s.imagePath;
  if (!target) return { undoStack: s.undoStack };
  const kind = opts?.kind ?? 'photo-edit';
  const label = opts?.label ?? 'Edit';
  const top = peekUndo(s.undoStack);
  const coalesce = key !== null && top?.kind === kind && top.target === target && top.coalesceKey === key;
  if (coalesce) return { undoStack: { ...s.undoStack, redo: [] } };
  const entry: GraphUndoEntry = {
    seq: nextUndoSeq(),
    at: Date.now(),
    kind,
    label,
    target,
    before: s.graph,
    coalesceKey: key,
  };
  return { undoStack: pushUndoEntry(s.undoStack, entry) };
}

export function isJpegFileName(name: string): boolean {
  return /\.(jpg|jpeg)$/i.test(name);
}

/**
 * Exact point-by-point curve equality. The base-curve seed
 * (seedDefaultLook) and identityCurvePoints() both live in integer point
 * space, so a plain compare is enough — used to decide whether a Develop
 * node's `toneCurve.rgb` is STILL the untouched fresh-open seed (safe to
 * flatten for DCP mode) or a curve the user has since edited (never touch).
 */
function curvePointsEqual(a: CurvePoints, b: CurvePoints): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);
}

/**
 * Fresh-open default-look seeding (OpenSession extraction — architecture
 * audit risk #1): a pure graph transform, no I/O, no `set()` — openImageByPath
 * calls this once per open, right after the sidecar (or the lack of one) is
 * known, and folds the result straight into its commit. Split out so "what
 * does a fresh open look like" reads independently of the epoch/preview/
 * sidecar bookkeeping around it; unchanged formulas/gating from their
 * previous inline home.
 *
 * - `wbModel` is always computed from the image's camera color info, and any
 *   DEVELOP/whitebalance node still holding the as-shot placeholder (temp 0
 *   — a fresh doc, or a defensively-unresolved sidecar node) gets its real
 *   Kelvin/tint value resolved in, so WB sliders never show 0.
 * - Embedded lens profile default-on and the base curve + default
 *   sharpen/color-NR seeding are FRESH-OPEN only (`!opts.usedSidecar`),
 *   suppressed under the verify suite except for the scripts that opt in —
 *   see the two `Allowed` flags below.
 */
export function seedDefaultLook(
  graph: GraphDoc,
  image: PreparedImage,
  opts: { usedSidecar: boolean; kind: 'raw' | 'jpg'; testFlags: Window['silverbox']['testFlags'] }
): { graph: GraphDoc; wbModel: WbModel } {
  const { usedSidecar, kind, testFlags: flags } = opts;
  // per-image WB model; resolve the as-shot placeholder (temp 0) in the
  // loaded/default doc so WB sliders always show real Kelvin values
  const wbModel = createWbModel({ camMul: image.color?.camMul, camXyz: image.color?.camXyz, rgbCam: image.color?.rgbCam });
  let out: GraphDoc = {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.kind === DEVELOP_KIND && n.develop && n.develop.basic.temp === 0) {
        return {
          ...n,
          develop: {
            ...n.develop,
            basic: { ...n.develop.basic, temp: wbModel.asShot.temp, tint: wbModel.asShot.tint },
          },
        };
      }
      if (n.kind === 'whitebalance' && (n.params?.temp ?? 0) === 0) {
        return { ...n, params: { ...n.params, temp: wbModel.asShot.temp, tint: wbModel.asShot.tint } };
      }
      return n;
    }),
  };
  // Embedded lens profile (task #34): default it ON for a FRESH open (no
  // sidecar on disk) when the image actually carries correction splines —
  // matching the camera/LR out-of-box behavior. A restored sidecar keeps
  // whatever it stored (older sidecars with no `profile` key sanitize to
  // enabled:false, so their renders never change).
  // Suppressed inside the verify suite (testFlags.isTest) except for
  // verify-lensprofile (lensProfileAutoDefault) and the headless CLI
  // renderer (forceDefaults — see SilverboxApi.testFlags's doc comment; the
  // CLI must match a fresh open's real look even under verify-cli.mjs's own
  // SILVERBOX_TEST=1 isolation), so the other scripts keep their
  // resample-free, CPU-referenceable baselines.
  const autoDefaultAllowed = !flags.isTest || flags.lensProfileAutoDefault || flags.forceDefaults;
  if (autoDefaultAllowed && !usedSidecar && image.profile) {
    out = {
      ...out,
      nodes: out.nodes.map((n) =>
        n.kind === 'input' ? { ...n, lens: { ...(n.lens ?? defaultLensParams()), profile: { enabled: true } } } : n
      ),
    };
  }
  // Default BASE CURVE (COLOR.md "default rendering"): a fresh RAW open (no
  // sidecar) seeds the Develop node's toneCurve.rgb with the camera-matched
  // base curve — the visible, editable, deletable second stage of the
  // default look (baseline exposure is the first, at decode). JPEG opens and
  // restored sidecars are never touched (a restored doc keeps whatever it
  // stored, so a user who deleted the curve reopens without it).
  // Suppressed inside the verify suite (testFlags.isTest) except for
  // verify-basecurve (baseCurveDefault) and the headless CLI renderer
  // (forceDefaults), so the other scripts keep their untouched fresh-ARW
  // baselines — same mechanism as the lens default.
  const baseCurveAllowed = !flags.isTest || flags.baseCurveDefault || flags.forceDefaults;
  if (baseCurveAllowed && !usedSidecar && kind === 'raw') {
    const curve = baseCurveForModel(image.capture?.cameraModel);
    out = {
      ...out,
      nodes: out.nodes.map((n) =>
        n.kind === DEVELOP_KIND && n.develop
          ? {
              ...n,
              develop: {
                ...n.develop,
                // Fitted camera PROFILE (Adobe-Color character — profileFit.ts):
                // amount 100 on a fresh RAW open, applied FIRST in the Develop
                // chain (before the base curve). The lattice is resolved from
                // the camera model at render time; only `amount` is stored.
                // Dial-able in the Basic panel; 0 removes it entirely.
                profile: { ...n.develop.profile, amount: 100 },
                toneCurve: { ...n.develop.toneCurve, rgb: curve.map((p) => [p[0], p[1]] as [number, number]) },
                // Default RAW sharpening (LR-calibration 2026-07-12): LR
                // Classic seeds RAW imports with amount 40 / radius 1.0 /
                // masking 0 (JPEGs get 0 — they were sharpened in-camera),
                // and with DETAIL_SHARPEN_GAIN aligning the slider scale, our
                // 40 ≈ LR's 40. Visible/editable in the Detail section like
                // every other piece of the default look.
                // Default color NR (manual-noise-reduction pack): LR
                // Classic also seeds RAW imports with Color 25 (Detail 50 /
                // Smoothness 50 — the sub-slider defaults already reproduce
                // today's fixed formula, so only `amount` needs to move);
                // Luminance NR stays 0, same as LR.
                detail: {
                  ...n.develop.detail,
                  sharpen: { ...n.develop.detail.sharpen, amount: 40, radius: 1.0, masking: 0 },
                  noiseColor: { ...n.develop.detail.noiseColor, amount: 25 },
                },
              },
            }
          : n
      ),
    };
  }
  return { graph: out, wbModel };
}

/**
 * Shared body of addLocalAdjustment()/addLocalAdjustmentWithShape(): one
 * undo entry builds Develop D (defaults) + Mask M (`shape`, or the default
 * centered radial when omitted) + Blend B (a = the node currently feeding
 * the active output, b = D, mask = M), rewires the output to B, and selects
 * M. Pure function of state (no `set`/`get`) so both store actions — and the
 * draw-to-create gesture in CanvasView.tsx, indirectly, via
 * addLocalAdjustmentWithShape — share exactly one implementation.
 */
function buildLocalAdjustmentPatch(s: AppState, shape?: MaskShape): Partial<AppState> {
  const g = s.graph;
  const outputs = g.nodes.filter((n) => n.kind === 'output');
  const activeOutput = (s.activeOutputId && outputs.find((n) => n.id === s.activeOutputId)) || outputs[0];
  if (!activeOutput) return {};
  const inEdge = g.edges.find((e) => e.target === activeOutput.id);
  if (!inEdge) return {};
  const sourceId = inEdge.source;

  // Layout (spec-aligned left-to-right reading order): the Blend takes
  // the OUTPUT's old slot; the output itself shifts right ~200px to make
  // room. Develop sits above the blend, Mask below it — so the chain
  // reads source → (D above / M below) → blend → output, not blend
  // stranded to the right of a stationary output (#pointer-drag-lag's
  // sibling UX bug — the old layout had Blend land right of Output).
  const outX = activeOutput.position.x;
  const outY = activeOutput.position.y;

  const devId = nextId(g, 'dev');
  const devNode: GraphNode = {
    id: devId,
    kind: DEVELOP_KIND,
    position: { x: outX, y: outY - 130 },
    develop: defaultDevelopParams(),
  };
  const maskId = nextId({ ...g, nodes: [...g.nodes, devNode] }, 'mask');
  const maskNode: GraphNode = {
    id: maskId,
    kind: MASK_KIND,
    position: { x: outX, y: outY + 130 },
    mask: { shapes: shape ? [shape] : defaultMaskParams().shapes },
  };
  const blendId = nextId({ ...g, nodes: [...g.nodes, devNode, maskNode] }, 'blend');
  const blendNode: GraphNode = {
    id: blendId,
    kind: BLEND_KIND,
    position: { x: outX, y: outY },
    // Masked blend: `amount` now acts as an adjustment strength (spec
    // §3), defaulting to 1 (full D within the mask, none outside) — the
    // Lightroom-style local-adjustment behavior, distinct from a plain
    // unmasked Blend node's 0.5 straight-mix default (BLEND_PARAM_DEFS,
    // untouched — this only changes what THIS auto-created node starts at).
    params: { amount: 1 },
  };

  let scratch: GraphDoc = {
    ...g,
    nodes: [
      ...g.nodes.map((n) => (n.id === activeOutput.id ? { ...n, position: { x: outX + 200, y: outY } } : n)),
      devNode,
      maskNode,
      blendNode,
    ],
    edges: g.edges.filter((e) => e.id !== inEdge.id),
  };
  const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
    const edge = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
    scratch = { ...scratch, edges: [...scratch.edges, edge] };
  };
  addEdge(sourceId, devId);
  addEdge(sourceId, maskId);
  addEdge(sourceId, blendId, 'a');
  addEdge(devId, blendId, 'b');
  addEdge(maskId, blendId, 'mask');
  addEdge(blendId, activeOutput.id);

  return {
    ...pushHistory(s, null, { label: 'Add local adjustment' }),
    graph: scratch,
    graphDirty: true,
    selectedNodeId: maskId,
  };
}

/** Default brush radius for a fresh spot (task #50): ~1.5% of the max output dimension. */
const DEFAULT_SPOT_BRUSH_RADIUS = 0.015;

type CanvasTool = 'crop' | 'spot' | 'maskDraw' | 'wbPick' | 'colorKeyPick' | 'compare';

/**
 * One modal canvas tool at a time (Lightroom behavior): ACTIVATING any of
 * crop / spot removal / mask draw / the two eyedroppers / compare view
 * deactivates the others, so the canvas pointer, wheel, and cursor are never
 * contested by two tools at once (e.g. a WB-pick click must not also start a
 * spot gesture, and crop's full-viewport overlay must not sit over an armed
 * spot mode; compare's split view must not fight a crop/mask-draw overlay
 * drawn against only the LEFT pane's coordinates). Every tool ACTIVATION
 * spreads this patch; deactivation paths never need it.
 */
function deactivateOtherTools(except: CanvasTool): Partial<AppState> {
  return {
    ...(except !== 'crop' ? { cropMode: false } : {}),
    ...(except !== 'spot' ? { spotMode: false, selectedSpotIndex: null } : {}),
    ...(except !== 'maskDraw' ? { maskDrawMode: null } : {}),
    ...(except !== 'wbPick' ? { wbPicking: false } : {}),
    ...(except !== 'colorKeyPick' ? { colorKeyPicking: false } : {}),
    ...(except !== 'compare' ? { compareMode: false } : {}),
  };
}

/** The output node the preview/export currently targets — same "selected or first" rule used throughout (addOpNode, exportSelectedOutputs, buildLocalAdjustmentPatch). */
function activeOutputNode(graph: GraphDoc, activeOutputId: string | null): GraphNode | undefined {
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  return (activeOutputId && outputs.find((n) => n.id === activeOutputId)) || outputs[0];
}

/** Every node id reachable by walking edges BACKWARD from `outputId` — "the active chain" spot removal's brief refers to. */
function reachableToOutput(graph: GraphDoc, outputId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [outputId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) {
      if (e.target === id) stack.push(e.source);
    }
  }
  return seen;
}

/**
 * Node-id scope for the multi-output preset/paste/sync scoping fixes
 * (docs/brief-bank/virtual-copy.md): every id reachable from `activeOutputId`
 * (falling back to the doc's first output when null/missing — the same rule
 * activeOutputNode always applies), fed straight into presetFamilies.ts's
 * mergeScopedLook/buildScopedLook `scope` parameter (that module stays pure
 * and ignorant of "which output is active" — this is where that resolution
 * happens, per the brief). Always computed, even for a single-output doc
 * (where `reachableToOutput` trivially covers every node), so every call
 * site shares one code path instead of branching on `outputs.length`.
 */
function chainScope(graph: GraphDoc, activeOutputId: string | null): Set<string> {
  const out = activeOutputNode(graph, activeOutputId);
  return out ? reachableToOutput(graph, out.id) : new Set(graph.nodes.map((n) => n.id));
}

/** `doc` restricted to exactly the node ids in `ids` (nodes AND edges) — the standalone single-chain extraction the multi-output scoping fixes share. */
function restrictToChain(doc: GraphDoc, ids: ReadonlySet<string>): GraphDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => ids.has(n.id)),
    edges: doc.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
}

/**
 * Fork-on-touch (docs/brief-bank/linked-looks-stage-b.md semantic 4):
 * editing ANY param inside a FOLLOWED family forks that family local —
 * metadata-only (the values are already local; only `link.follows`
 * shrinks), folded into the SAME undo entry as the edit itself rather than
 * a separate op, per the brief ("fork is a metadata-only change"). Shared
 * by every Develop-param mutator (updateNodeParam/updateNodeParamsBatch/
 * setDevelopBwEnabled/setDevelopProfileSource/setDevelopProfileDcpPath/
 * setToneCurvePoints) so the rule can never drift between them. No-op
 * (returns `node` unchanged, same reference when nothing moves) when the
 * node isn't linked, or none of `touchedKeys` maps to a currently-followed
 * family.
 */
function forkLinkedFamilies(node: GraphNode, touchedKeys: readonly string[]): GraphNode {
  if (!node.link) return node;
  const touchedFamilies = new Set(
    touchedKeys.map(familyForDevelopKey).filter((f): f is PresetFamilyId => f !== null)
  );
  if (touchedFamilies.size === 0) return node;
  const nextFollows = node.link.follows.filter((f) => !touchedFamilies.has(f as PresetFamilyId));
  if (nextFollows.length === node.link.follows.length) return node; // nothing actually followed was touched
  return { ...node, link: { ...node.link, follows: nextFollows } };
}

/**
 * Strip `link` from node `nodeId` entirely (unlink — semantic 6, and look
 * deletion — semantic 7): values untouched (見た目は変わらない), only the
 * metadata is dropped. Deletes the property rather than setting it to
 * `undefined` so the in-memory node object matches exactly what a doc that
 * never had `link` looks like.
 */
function stripDevelopLink(graph: GraphDoc, nodeId: string): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const { link: _link, ...rest } = n;
      return rest as GraphNode;
    }),
  };
}

/**
 * Which develop family a `PresetFamilyId` slice of `develop` equals the
 * SAME family slice of `fresh` — used by linkPhotosToLook (link-time
 * default, semantic 2) to tell "untouched since fresh-open" (family
 * follows) from "already edited" (stays 個別調整). Both slices are picked
 * against the SAME identity base (defaultDevelopParams()) so a plain
 * structural equality of the picked result is a true per-family compare —
 * every OTHER family's data is identically the default on both sides.
 */
function developFamilyUntouched(develop: DevelopParams, fresh: DevelopParams, family: PresetFamilyId): boolean {
  const base = defaultDevelopParams();
  const a = pickDevelopFamilies(develop, base, new Set([family]));
  const b = pickDevelopFamilies(fresh, base, new Set([family]));
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A shared-look file's own Develop node's params (defaulting for a look body that, oddly, has none — same defensive fallback publishToSharedLook/revertFamilyToLook already use inline). */
function lookDevelopOf(parsed: ParsedPreset): DevelopParams {
  return parsed.look.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
}

/**
 * Value-drift-implies-fork (linked-looks-stage-d.md semantic 6, parent spec
 * §9-6): a FOLLOWER's own file was changed externally (its develop values
 * for a followed family no longer match what the look body they claim to
 * follow actually contains) while `node.link.materializedFrom` still equals
 * `referenceHash` — i.e. nothing has re-materialized this node since, so the
 * disagreement can only be an independent hand-edit of the follower itself,
 * not staleness. Normalize by UNLISTING those families from `follows`
 * (個別調整) rather than clobbering them at the next re-materialization —
 * "editing a followed group means also unlisting it; the sanitizer forgives
 * the omission in this direction" (parent spec's documented contract for
 * external editors).
 *
 * `referenceDevelop`/`referenceHash` must be the ACTUAL content the node's
 * `materializedFrom` claims to point at — callers pass either "whatever the
 * shared look currently contains on disk" (photo-load/hot-reload path) or
 * "the look's content immediately before this particular re-materialization
 * pass" (the watch-triggered fan-out's own `lookTextBefore`, still what
 * every not-yet-bumped follower's marker points at). A node whose marker
 * doesn't match `referenceHash` at all is untouched here — that mismatch is
 * drift-at-open/the fan-out's OWN job (catching the node up), not this
 * check's; without the matching content this function has nothing sound to
 * compare against anyway.
 *
 * No-op (returns `node` unchanged, `forked: []`) when the node isn't linked,
 * its marker doesn't match `referenceHash`, or every followed family still
 * agrees.
 */
function forkValueDriftedFamilies(
  node: GraphNode,
  referenceDevelop: DevelopParams,
  referenceHash: string
): { node: GraphNode; forked: PresetFamilyId[] } {
  if (!node.link || node.link.materializedFrom !== referenceHash) return { node, forked: [] };
  const develop = node.develop ?? defaultDevelopParams();
  const forked: PresetFamilyId[] = [];
  const nextFollows = node.link.follows.filter((f) => {
    if (!isDevelopFamily(f)) return true; // non-develop family ids (shouldn't occur on a develop link, forward-compat only) pass through untouched
    const same = developFamilyUntouched(develop, referenceDevelop, f);
    if (!same) forked.push(f);
    return same;
  });
  if (forked.length === 0) return { node, forked: [] };
  return { node: { ...node, link: { ...node.link, follows: nextFollows } }, forked };
}

/**
 * Per-target scoped-family merge with structural skip-detection — shared by
 * applyPresetToSelection, linkPhotosToLook, and the other batch writers in
 * this file (docs/brief-bank/apply-preset-to-selection.md): each walks a
 * target list, copying `families` from one shared `source` doc onto each
 * target's own graph, and all need the SAME "don't graft an orphaned
 * structural node" guard. Any family in
 * `masks`/`spots`/`custom-nodes` whose graft would be structurally
 * incompatible with `baseGraph`'s own chain (structuralFamilyCompatible) is
 * dropped from the merge for THIS target and reported back in `skipped`, so
 * the caller can count it into its own completion notice — the exact rule
 * multi-select-sync's brief documents ("skipped for structurally
 * incompatible target"). A develop family is never skipped (pickDevelopFamilies
 * is pure scalar/array param data, always compatible).
 */
function mergeFamiliesWithSkipDetection(
  baseGraph: GraphDoc,
  source: GraphDoc,
  families: ReadonlySet<PresetFamilyId>,
  scope: ReadonlySet<string> | null
): { merged: GraphDoc; skipped: PresetFamilyId[] } {
  const structuralFamilies = (['masks', 'spots', 'custom-nodes'] as const).filter((f) => families.has(f));
  const effective = new Set(families);
  const skipped: PresetFamilyId[] = [];
  for (const fam of structuralFamilies) {
    if (!structuralFamilyCompatible(baseGraph, source, fam)) {
      effective.delete(fam);
      skipped.push(fam);
    }
  }
  return { merged: structuredClone(mergeScopedLook(baseGraph, source, effective, scope)), skipped };
}

/**
 * Multi-output whole-look apply/paste fix (virtual-copy.md — "the real
 * hazard" the brief ships alongside "Duplicate output"): applyLook's old
 * mergeLookWithCurrentGeometry wholesale-replaces `graph.nodes`/`edges`,
 * which on a 2+-output doc silently deletes every output besides whatever
 * `look` itself contains. This instead removes ONLY the active output's own
 * chain — reachableToOutput minus the doc's single shared 'input' node,
 * which is NEVER removed or replaced (every output's chain shares the one
 * input/geometry — see duplicateOutput's own "minus the input node" carve-
 * out for the same reasoning) — and splices in `look`'s own corresponding
 * chain (fresh ids, so they can never collide with an untouched sibling
 * copy's own ids) between the shared input and the doc's (unmoved, un-
 * renamed) active output node. Every other output's nodes/edges never enter
 * `removeIds` at all, so they come out byte-identical by construction. Only
 * reached when the CURRENT graph has 2+ outputs — applyLook's own fast path
 * (mergeLookWithCurrentGeometry, unchanged) covers <= 1 output, staying
 * bit-identical to today's behavior for the overwhelming common case.
 */
function replaceActiveChainWithLook(graph: GraphDoc, look: GraphDoc, activeOutputId: string | null): GraphDoc {
  const inputNode = graph.nodes.find((n) => n.kind === 'input');
  const activeOut = activeOutputNode(graph, activeOutputId);
  if (!inputNode || !activeOut) return graph;

  const reach = reachableToOutput(graph, activeOut.id);
  const removeIds = new Set(reach);
  removeIds.delete(activeOut.id);
  removeIds.delete(inputNode.id);

  const lookOutput = look.nodes.find((n) => n.kind === 'output');
  const lookInput = look.nodes.find((n) => n.kind === 'input');
  if (!lookOutput) return graph; // defensive — parseGraphDoc's own guard rejects any doc with zero outputs

  const lookReach = reachableToOutput(look, lookOutput.id);
  const chainIds = new Set(lookReach);
  chainIds.delete(lookOutput.id);
  if (lookInput) chainIds.delete(lookInput.id);

  let scratch: GraphDoc = {
    ...graph,
    nodes: graph.nodes.filter((n) => !removeIds.has(n.id)),
    edges: graph.edges.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target) && e.target !== activeOut.id),
  };

  const idMap = new Map<string, string>();
  for (const n of look.nodes) {
    if (!chainIds.has(n.id)) continue;
    const prefix = n.kind === DEVELOP_KIND ? 'dev' : n.kind;
    const freshId = nextId(scratch, prefix);
    idMap.set(n.id, freshId);
    scratch = { ...scratch, nodes: [...scratch.nodes, { ...structuredClone(n), id: freshId }] };
  }

  const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
    const edge = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
    scratch = { ...scratch, edges: [...scratch.edges, edge] };
  };
  for (const e of look.edges) {
    const srcIn = chainIds.has(e.source);
    const tgtIn = chainIds.has(e.target);
    if (srcIn && tgtIn) {
      addEdge(idMap.get(e.source)!, idMap.get(e.target)!, e.targetHandle);
    } else if (!srcIn && tgtIn && lookInput && e.source === lookInput.id) {
      // edge FROM look's own input TO the chain's root — reconnect from the shared graph input node instead
      addEdge(inputNode.id, idMap.get(e.target)!, e.targetHandle);
    } else if (srcIn && !tgtIn && e.target === lookOutput.id) {
      // edge FROM the chain's tail TO look's own output — reconnect to the graph's own active output node instead
      addEdge(idMap.get(e.source)!, activeOut.id, e.targetHandle);
    }
  }
  return scratch;
}

/**
 * The spots node "in the active chain" (spec: edits target the FIRST one
 * found, in doc.nodes array order, that's upstream of the active output) —
 * null when none exists yet, in which case commitSpot auto-inserts one.
 */
export function findActiveSpotsNodeId(graph: GraphDoc, activeOutputId: string | null): string | null {
  const out = activeOutputNode(graph, activeOutputId);
  if (!out) return null;
  const reach = reachableToOutput(graph, out.id);
  const node = graph.nodes.find((n) => n.kind === SPOTS_KIND && reach.has(n.id));
  return node?.id ?? null;
}

/** What resolveSpotInsertion produces on success — the resulting doc plus what commitSpot needs to select. */
interface SpotInsertion {
  graph: GraphDoc;
  nodeId: string;
  spotIndex: number;
}

/**
 * Pure target resolution shared by commitSpot (below, which wraps this in
 * set()/pushHistory/selection) and buildSpotPreviewDoc (round-14 live-drag
 * preview, which just wants the resulting doc with no store side effects):
 * append to the active chain's spots node, or auto-insert a fresh one RIGHT
 * AFTER the input node when none exists yet (retouch before color — see
 * spotsNode.ts's file doc comment), rewiring input→X to input→spots→X.
 * Returns 'capped' when the active node already holds SPOTS_CAP spots, or
 * null when there's no sane target (no output/input node, or no edge to
 * splice into).
 */
function resolveSpotInsertion(
  graph: GraphDoc,
  activeOutputId: string | null,
  spot: Spot
): SpotInsertion | 'capped' | null {
  const existingId = findActiveSpotsNodeId(graph, activeOutputId);
  if (existingId) {
    const node = graph.nodes.find((n) => n.id === existingId)!;
    const list = node.spots?.spots ?? [];
    if (list.length >= SPOTS_CAP) return 'capped';
    return {
      graph: {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === existingId ? { ...n, spots: { spots: [...list, spot] } } : n)),
      },
      nodeId: existingId,
      spotIndex: list.length,
    };
  }
  const out = activeOutputNode(graph, activeOutputId);
  const inputNode = graph.nodes.find((n) => n.kind === 'input');
  if (!out || !inputNode) return null;
  const reach = reachableToOutput(graph, out.id);
  const edge = graph.edges.find((e) => e.source === inputNode.id && reach.has(e.target));
  if (!edge) return null;
  const spotsId = nextId(graph, 'spots');
  const spotsNode: GraphNode = {
    id: spotsId,
    kind: SPOTS_KIND,
    position: { x: inputNode.position.x + 110, y: inputNode.position.y + 90 },
    spots: { spots: [spot] },
  };
  let scratch: GraphDoc = {
    ...graph,
    nodes: [...graph.nodes, spotsNode],
    edges: graph.edges.filter((e) => e.id !== edge.id),
  };
  const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
    const e = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
    scratch = { ...scratch, edges: [...scratch.edges, e] };
  };
  addEdge(inputNode.id, spotsId);
  addEdge(spotsId, edge.target, edge.targetHandle);
  return { graph: scratch, nodeId: spotsId, spotIndex: 0 };
}

/**
 * Preview-only counterpart to commitSpot (round-14 live-drag preview): same
 * target resolution as commitSpot (resolveSpotInsertion above), but returns
 * the resulting doc directly with NO store side effects — no set(), no
 * history entry, no selection change. CanvasView renders this doc while a
 * real spot drag is in progress; the committed doc/history is untouched
 * until pointer-up calls commitSpot as before. Returns null when there's
 * nothing sane to preview against (at the spot cap, or no output/input node
 * to splice into) — the caller falls back to rendering the doc unmodified
 * for that frame.
 */
export function buildSpotPreviewDoc(graph: GraphDoc, activeOutputId: string | null, spot: Spot): GraphDoc | null {
  const result = resolveSpotInsertion(graph, activeOutputId, spot);
  return result === 'capped' || result === null ? null : result.graph;
}

/**
 * Append `spots` to the active chain's spots node (auto-creating one when
 * absent, exactly like resolveSpotInsertion), with the SPOTS_CAP check done
 * UPFRONT over the whole batch — used by repair-sheet apply
 * (docs/brief-bank/linked-looks-stage-f.md semantic 6). Returns 'capped' when
 * existing + `spots.length` would exceed SPOTS_CAP (so the caller can REFUSE
 * that target loudly rather than let sanitizeSpotsParams's silent slice(0,32)
 * be what trims it), or 'no-target' when there's no output/input/edge to splice
 * into. An empty `spots` list is a no-op returning the graph unchanged.
 */
export function insertSpotsIntoChain(
  graph: GraphDoc,
  activeOutputId: string | null,
  spots: Spot[]
): { graph: GraphDoc } | 'capped' | 'no-target' {
  if (spots.length === 0) return { graph };
  const existingId = findActiveSpotsNodeId(graph, activeOutputId);
  const existingCount = existingId ? (graph.nodes.find((n) => n.id === existingId)?.spots?.spots.length ?? 0) : 0;
  if (existingCount + spots.length > SPOTS_CAP) return 'capped';
  let g = graph;
  for (const spot of spots) {
    const result = resolveSpotInsertion(g, activeOutputId, spot);
    if (result === 'capped') return 'capped'; // can't happen after the upfront check, but stays honest
    if (result === null) return 'no-target';
    g = result.graph;
  }
  return { graph: g };
}

/**
 * Sanitize to a filesystem/slug-safe token: letters/digits/underscore/hyphen
 * only, runs of anything else collapse to a single hyphen, and a result
 * that's empty after trimming falls back to `fallback`. Shared by
 * suffixExportPath (output-file suffixes) and slugifyPresetName (preset
 * filenames) — same sanitization family, different fallback words.
 */
function sanitizeToken(raw: string, fallback: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

/**
 * Insert `-<name>` before the extension of an export path, e.g.
 * `/x/DSC02993.jpg` + "second copy" -> `/x/DSC02993-second-copy.jpg` — used
 * only when exportSelectedOutputs resolves to 2+ output nodes (a single
 * target keeps the path exactly as given, today's behavior).
 */
export function suffixExportPath(path: string, name: string): string {
  const safe = sanitizeToken(name, 'output');
  const m = /^(.*)(\.[^./\\]+)$/.exec(path);
  return m ? `${m[1]}-${safe}${m[2]}` : `${path}-${safe}`;
}

/**
 * Headless CLI renderer's default output path for one input (main/index.ts's
 * `--render` mode, job.outDir): `<input-stem>.jpg`, either alongside the
 * input (outDir null, matching exportImage's own dialog-default naming) or
 * inside `outDir` (basename only — the input's own directory is dropped, not
 * mirrored). Plain string ops rather than node's `path` module: this file is
 * renderer code (bundled for the browser-like renderer process), and macOS
 * paths are POSIX regardless (DESIGN.md's macOS-only scope for now).
 */
export function cliOutputPath(input: string, outDir: string | null): string {
  const stem = input.replace(/\.[^./]+$/, '');
  const base = `${stem}.jpg`;
  if (!outDir) return base;
  const name = base.slice(base.lastIndexOf('/') + 1);
  return `${outDir.replace(/\/+$/, '')}/${name}`;
}

/**
 * `--extract-look --families` validation (main/index.ts's own mode):
 * true only for a family id BOTH this build recognizes AND that lives in
 * the 'develop' group — a structural family (geometry/spots/masks/
 * custom-nodes) is always out of scope for a look (docs/brief-bank/
 * look-extraction.md: "per-photo, not look"), so naming one here is a
 * caller error, not a silent no-op.
 */
function isValidDevelopFamilyId(id: string): id is PresetFamilyId {
  return isKnownFamilyId(id) && isDevelopFamily(id);
}

/**
 * Preset filename slug (task #37): same sanitization family as
 * suffixExportPath, 'preset' fallback for an empty/fully-stripped name.
 * Collision disambiguation (-2, -3…) against a DIFFERENT same-slug preset
 * happens in savePreset — this just produces the base candidate.
 */
export function slugifyPresetName(name: string): string {
  return sanitizeToken(name, 'preset');
}

/**
 * Whole-look capture (task #37 / copyDevelopSettings): strip the input
 * node's geometry (crop/straighten/orientation stay per-photo) but keep its
 * lens corrections (optical, not photo-specific the same way). This is the
 * ENTIRE copyDevelopSettings body — both it and savePreset call this, so a
 * preset is exactly "a named, persisted develop clipboard" the brief asks
 * for, not a second implementation of the same idea.
 */
export function captureLook(graph: GraphDoc): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.kind === 'input' ? { ...n, geometry: undefined } : n)),
  };
}

/**
 * Merge a captured look with a CURRENT graph's own geometry: `look`'s
 * nodes/edges replace the current graph wholesale, except the input node's
 * geometry, which is preserved from whatever's open right now — a look must
 * never carry another photo's crop. Shared by applyLook (below, the real
 * paste/apply — one undo entry) and setPreviewLook (the hover-preview
 * action, no history push) so the preview is bit-for-bit what an apply would
 * produce, not a second implementation of the same merge.
 */
function mergeLookWithCurrentGeometry(currentGraph: GraphDoc, look: GraphDoc): GraphDoc {
  const currentInput = currentGraph.nodes.find((n) => n.kind === 'input');
  const currentGeometry = currentInput?.geometry;
  return structuredClone({
    ...look,
    nodes: look.nodes.map((n) => (n.kind === 'input' ? { ...n, geometry: currentGeometry } : n)),
  });
}

/**
 * Apply a captured look to `s`'s CURRENT graph, as one undo entry
 * (pushHistory's `null` = its own discrete entry, coalescing nothing). This
 * is the entire body of pasteDevelopSettings; applyParsedPreset's whole-look
 * branch shares it unchanged, so paste and preset-apply are one
 * implementation with one merge semantics — `opts` distinguishes the two
 * only for the undo entry's kind/label (global-undo decision: preset-apply
 * is its own entry kind, distinct from a plain paste).
 *
 * Single-output docs (`outputs.length <= 1`, the overwhelming common case)
 * use mergeLookWithCurrentGeometry unchanged — bit-identical to before this
 * feature existed. A 2+-output doc instead goes through
 * replaceActiveChainWithLook (virtual-copy.md's scoping fix): the OLD
 * wholesale-replace here used to silently delete every output besides
 * whatever `look` itself contained — a real data-loss hazard the brief
 * documents as CONFIRMED REAL, not cosmetic.
 */
function applyLook(
  s: AppState,
  look: GraphDoc,
  opts: { kind?: GraphEntryKind; label: string } = { label: 'Paste develop settings' }
): Partial<AppState> & { graph: GraphDoc } {
  const outputs = s.graph.nodes.filter((n) => n.kind === 'output');
  const graph =
    outputs.length <= 1
      ? mergeLookWithCurrentGeometry(s.graph, look)
      : structuredClone(replaceActiveChainWithLook(s.graph, look, s.activeOutputId));
  return { ...pushHistory(s, null, opts), graph, graphDirty: true };
}

/**
 * Preset scoping's apply-time branch (appStore.ts's applyPreset): a
 * whole-look preset (`parsed.includes` absent) goes through applyLook
 * unchanged — bit-for-bit the historical behavior, so every preset saved
 * before this feature existed keeps applying exactly as it always did
 * (applyLook's own fork covers the multi-output case now too). A scoped
 * preset merges ONLY its checked, KNOWN families onto the CURRENT graph
 * (presetFamilies.ts's mergeScopedLook), scoped to the nodes reachable from
 * `activeOutputId` (virtual-copy.md — chainScope) so a 2+-output doc's
 * inactive copy is never touched even if its Develop node's id happens to
 * collide with `parsed.look`'s own; everything else on `s.graph` is left
 * untouched, never reset toward `parsed.look`'s own values. Like applyLook,
 * this is one undo entry (pushHistory's `null`) — kind 'preset-apply' either
 * way (global-undo decision: preset apply is its own labeled entry kind, not
 * a generic photo-edit).
 */
function applyParsedPreset(s: AppState, parsed: ParsedPreset): Partial<AppState> & { graph: GraphDoc } {
  const opts: { kind: GraphEntryKind; label: string } = { kind: 'preset-apply', label: 'Apply preset' };
  if (!parsed.includes) return applyLook(s, parsed.look, opts);
  const families = new Set(parsed.includes.filter(isKnownFamilyId));
  const scope = chainScope(s.graph, s.activeOutputId);
  const graph = structuredClone(mergeScopedLook(s.graph, parsed.look, families, scope));
  return { ...pushHistory(s, null, opts), graph, graphDirty: true };
}

/**
 * Sidecar hot-reload apply (the AI-editing loop): swap in `parsed.graph`
 * wholesale as ONE history entry — unlike applyLook, geometry is NOT
 * preserved from the current session, because `parsed` IS a full read of
 * THIS image's own sidecar (its geometry is exactly as valid as anything
 * else in it, not a foreign look being pasted in). `graphDirty: false` is
 * deliberate (see AppState.lastSidecarText's doc comment and ROADMAP item
 * #6 in the brief): the freshly loaded graph now matches disk exactly, so
 * there is nothing for autosave to echo back. Also clears sidecarUnreadable
 * / sidecarNotice — a successful external parse proves the file is
 * readable now, and leaving a stale open-time guard in place would block
 * saving a graph that's demonstrably good (the malformed-content path in
 * handleExternalSidecarChange/reloadSidecarNow never reaches this
 * function, so it can never clear the guard on genuinely bad content).
 */
/**
 * Read + parse the CURRENT image's sidecar off disk — the shared "malformed
 * / deleted / parses fine" three-way split hot-reload's two entry points
 * both need (the automatic push handler and the dirty-session "Reload"
 * button), so it lives once here instead of twice inline. `image` supplies
 * the anchor-space migration dims exactly like openImageByPath's own
 * parseGraphDoc call. `sidecarPath` is the resolved path to read (project
 * look or legacy adjacent sidecar — see AppState.currentLookPath's doc
 * comment); this function itself stays project-agnostic, same division of
 * labor as before the project-storage migration.
 */
async function readAndParseSidecar(
  sidecarPath: string,
  image: { width: number; height: number }
): Promise<{ ok: true; text: string; parsed: SidecarDoc } | { ok: false; notice: string }> {
  const unreadable = (detail: string): { ok: false; notice: string } => ({
    ok: false,
    notice: `sidecar on disk is unreadable — keeping the in-app state (${detail})`,
  });
  let text: string | null;
  try {
    text = await window.silverbox.readSidecar(sidecarPath);
  } catch (err) {
    return unreadable(err instanceof Error ? err.message : String(err));
  }
  if (text === null) {
    // Deleted externally (`rm`, or a `git checkout` of a commit predating
    // the sidecar) — same "keep the good in-app copy" policy as malformed
    // content: there is nothing valid on disk to load.
    return { ok: false, notice: 'sidecar removed from disk — keeping the in-app state' };
  }
  try {
    const parsed = parseGraphDoc(text, { width: image.width, height: image.height });
    return { ok: true, text, parsed };
  } catch (err) {
    return unreadable(err instanceof Error ? err.message : String(err));
  }
}

function applyExternalGraph(s: AppState, parsed: SidecarDoc, rawText: string): Partial<AppState> & { graph: GraphDoc } {
  const graph = parsed.graph;
  return {
    ...pushHistory(s, null, { label: 'Reload from disk' }),
    graph,
    graphDirty: false,
    selectedNodeId: graph.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
    selectedSpotIndex: null,
    sidecarCreatedAt: parsed.createdAt ?? null,
    sidecarRating: parsed.rating,
    sidecarFlag: parsed.flag ?? null,
    sidecarUnknownFields: parsed.unknown ?? null,
    sidecarUnreadable: false,
    sidecarNotice: null,
    lastSidecarText: rawText,
    // Resolves whatever hot-reload notice was showing (this function IS the
    // "apply" step of both the automatic clean-session reload and the
    // dirty-session Reload button). handleExternalSidecarChange's clean-path
    // caller sets its own transient 'reloaded' notice in a SEPARATE set()
    // right after this patch lands, so that still wins there; reloadSidecarNow
    // has nothing further to set, so this null is what actually clears it.
    sidecarHotReloadNotice: null,
  };
}

function getShader(graph: GraphDoc, nodeId: string): CustomShaderParams | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node?.kind === CUSTOM_KIND ? (node.shader ?? null) : null;
}

function withShader(
  graph: GraphDoc,
  nodeId: string,
  fn: (shader: CustomShaderParams) => CustomShaderParams
): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId && n.kind === CUSTOM_KIND ? { ...n, shader: fn(n.shader ?? createDefaultCustomShaderParams()) } : n
    ),
  };
}

export const useAppStore = create<AppState>((set, get) => {
  /** Supersede stale validations: per-node sequence + a global epoch bumped on open/undo/redo. */
  const validationSeq = new Map<string, number>();
  let shaderEpoch = 0;

  /**
   * Validate `src` against the node's current param list on the dedicated
   * device. Success commits the artifact and moves `src`/`lastValidSrc` in
   * the doc (its own history entry when `opts.history`); failure publishes
   * the error while the last valid shader keeps rendering.
   */
  const validateShaderSource = async (nodeId: string, src: string, opts: { history: boolean }): Promise<void> => {
    const shader = getShader(get().graph, nodeId);
    if (!shader) return;
    const paramList = shader.params;
    const { wgsl, userLineOffset } = buildCustomShaderWgsl(src, paramList.map((p) => p.name));
    const seq = (validationSeq.get(nodeId) ?? 0) + 1;
    validationSeq.set(nodeId, seq);
    const epoch = shaderEpoch;

    let error: string | null;
    try {
      error = await validateWgsl(wgsl, userLineOffset);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (validationSeq.get(nodeId) !== seq || shaderEpoch !== epoch) return;
    const now = getShader(get().graph, nodeId);
    if (!now) return; // node deleted while validating

    if (error === null) {
      const artifact = makeCustomShaderArtifact(wgsl, paramList);
      setCustomShaderArtifact(nodeId, artifact);
      mirrorShaderArtifactSet(nodeId, artifact);
      if (now.code.src !== src || now.code.lastValidSrc !== src) {
        set((s) => ({
          ...(opts.history ? pushHistory(s, null, { label: 'Edit shader source' }) : {}),
          graph: withShader(s.graph, nodeId, (p) => ({ ...p, code: { src, lastValidSrc: src } })),
          graphDirty: true,
        }));
      }
      set((s) => {
        const { [nodeId]: _cleared, ...rest } = s.shaderErrors;
        return { shaderErrors: rest, shaderRev: s.shaderRev + 1 };
      });
    } else {
      set((s) => ({ shaderErrors: { ...s.shaderErrors, [nodeId]: error } }));
    }
  };

  /**
   * Re-seed artifacts for every custom node of a (re)loaded / jumped-to doc:
   * validate `lastValidSrc` and set ONLY the artifact (no doc mutation — this
   * must never clobber a differing editing source). A doc saved mid-edit then
   * gets its editing source surfaced through the normal path.
   */
  const revalidateShaders = (graph: GraphDoc): void => {
    for (const node of graph.nodes) {
      if (node.kind !== CUSTOM_KIND || !node.shader) continue;
      const { code, params } = node.shader;
      const nodeId = node.id;
      const { wgsl, userLineOffset } = buildCustomShaderWgsl(code.lastValidSrc, params.map((p) => p.name));
      const seq = (validationSeq.get(nodeId) ?? 0) + 1;
      validationSeq.set(nodeId, seq);
      const epoch = shaderEpoch;
      void (async () => {
        let error: string | null;
        try {
          error = await validateWgsl(wgsl, userLineOffset);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (validationSeq.get(nodeId) !== seq || shaderEpoch !== epoch) return;
        if (!getShader(get().graph, nodeId)) return;
        if (error === null) {
          const artifact = makeCustomShaderArtifact(wgsl, params);
          setCustomShaderArtifact(nodeId, artifact);
          mirrorShaderArtifactSet(nodeId, artifact);
          set((s) => ({ shaderRev: s.shaderRev + 1 }));
        } else {
          set((s) => ({ shaderErrors: { ...s.shaderErrors, [nodeId]: error } }));
        }
        if (code.src !== code.lastValidSrc) {
          void validateShaderSource(nodeId, code.src, { history: false });
        }
      })();
    }
  };

  /**
   * Decode the source image fresh at full resolution, render ONE output, and
   * encode+write it to `targetPath` — the whole body of the pre-dialog
   * exportImage, factored out so both the single-output path (exportImage,
   * unchanged behavior) and the export dialog's multi-output batch
   * (exportSelectedOutputs) share it. A fresh `loadImage()` per call is
   * required, not just convenient: renderToPixels TRANSFERS the prepared
   * image's data buffer to the render worker (see renderClient.ts), so a
   * `PreparedImage` is single-use and can't be reused across output nodes.
   *
   * `opts` are the FALLBACK settings (export dialog controls, or CLI flags);
   * the actually-resolved output node's own `node.export` overrides win per
   * field via resolveExportSettings — this is the ONE call site every export
   * path (exportImage, exportSelectedOutputs, and the headless CLI's
   * runCliRender, which all funnel through exportOnePath) shares, so there is
   * exactly one place effective settings get computed.
   */
  /**
   * External-tool hook node export cut point (task #41): rewrite `baseGraph`
   * so every 'external' node it resolves to becomes an ordinary IMAGE_KIND
   * node wired to a synthetic, already-decoded texture — reusing the
   * image-node upload/composite machinery wholesale rather than teaching
   * renderToPixels a third node shape. One node at a time (rebuilding the
   * plan after each rewrite, same bounded "fix one, re-check" loop
   * lutExport.ts's reduceGraphForLut uses), because removing one node can
   * reveal another upstream of it. CACHE KEY mirrors
   * GraphRenderer.checkExternalNodes' own scheme (pixel hash | command |
   * encoded | nodeId) so an export can land on the SAME on-disk cache tier a
   * preview edit already populated — a coincidence when it happens (preview
   * and export render at different resolutions, so their pixel hashes
   * normally differ), never a requirement: a cache MISS just spawns fresh at
   * full res. ANY per-node failure (see externalTool.ts) bypasses that ONE
   * node (pass-through, same invariant the interactive node upholds) with a
   * console warning — a broken external command must never fail the whole
   * export.
   */
  const resolveExternalNodesForExport = async (baseGraph: GraphDoc, full: PreparedImage): Promise<GraphDoc> => {
    const renderer = get().renderer;
    if (!renderer) return baseGraph;
    let working = baseGraph;
    for (let pass = 0; pass < 8; pass++) {
      let plan: ReturnType<typeof buildPlan>;
      try {
        plan = buildPlan(working, { srcWidth: full.width, srcHeight: full.height });
      } catch {
        break;
      }
      const step = plan.steps.find((s) => s.type === 'external');
      if (step === undefined) break;
      if (step.type !== 'external') break; // narrows step for TS below; unreachable in practice
      const inEdge = working.edges.find((e) => e.target === step.nodeId);
      if (!inEdge) break; // an external node always has exactly one input once it reaches buildPlan's own validation
      const nodeId = step.nodeId;
      const command = step.command;
      const encoded = step.encoded;
      const bypass = (doc: GraphDoc): GraphDoc => ({
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== nodeId),
        edges: doc.edges
          .filter((e) => e.target !== nodeId)
          .map((e) => (e.source === nodeId ? { ...e, source: inEdge.source } : e)),
      });
      try {
        const captured = await renderer.captureExternalInput(full, working, 1, encoded, inEdge.source, undefined);
        const pixelHash = await sha256Hex(captured.data.buffer as ArrayBuffer);
        const cacheKey = await sha256Hex(
          new TextEncoder().encode(`${pixelHash}|${command}|${encoded ? 1 : 0}|${nodeId}`).buffer
        );
        const result = await window.silverbox.runExternalTool({
          command,
          encoded,
          cacheKey,
          width: captured.width,
          height: captured.height,
          data: captured.data.buffer as ArrayBuffer,
        });
        if (!result.ok) {
          console.warn(`external tool node ${nodeId} failed during export, passing through: ${result.reason}`);
          working = bypass(working);
          continue;
        }
        const linear = await renderer.decodeExternalResult(new Float32Array(result.data), result.width, result.height, encoded);
        const syntheticPath = `external:${nodeId}:${cacheKey}`;
        renderer.setImageNodeSource(syntheticPath, {
          data: linear,
          width: result.width,
          height: result.height,
          fullWidth: result.width,
          fullHeight: result.height,
          flip: 0,
          decodeMs: 0,
        });
        working = {
          ...working,
          nodes: working.nodes.map((n) =>
            n.id === nodeId ? { id: n.id, kind: IMAGE_KIND, position: n.position, image: { path: syntheticPath } } : n
          ),
        };
      } catch (err) {
        console.warn(`external tool node ${nodeId} failed during export, passing through:`, err);
        working = bypass(working);
      }
    }
    return working;
  };

  /**
   * In-engine ML denoise export cut point (denoise v2, stage 1) — the SAME
   * "rewrite one node at a time into a synthetic image node" mechanism
   * resolveExternalNodesForExport uses, adapted for denoise's two
   * differences: (1) no CLI opt-in flag at all — this always runs,
   * unconditionally, for every export (interactive or CLI); "bypassed" here
   * means specifically "model unavailable/no consent yet", reported as a
   * `warnings` entry so the CLI's contract ("passes through with a warning
   * line") is satisfied without a new flag; (2) a genuine STRENGTH blend —
   * the cached result is always FULL-STRENGTH (see DenoiseRunResult's doc
   * comment), so this blends it against the node's own LINEAR input by
   * strength/100 (mirrors denoiseTiling.ts's `lerp`) BEFORE wrapping the
   * blended pixels as the synthetic image-node source — unlike the
   * interactive preview's GPU re-entry blend (graphRenderer.ts's
   * DENOISE_BLEND_SHADER), this one is a plain CPU loop since export re-
   * enters through a full pixel replacement, not a live GPU pass.
   */
  const resolveDenoiseNodesForExport = async (baseGraph: GraphDoc, full: PreparedImage): Promise<{ graph: GraphDoc; warnings: string[] }> => {
    const renderer = get().renderer;
    if (!renderer) return { graph: baseGraph, warnings: [] };
    let working = baseGraph;
    const warnings: string[] = [];
    for (let pass = 0; pass < 8; pass++) {
      let plan: ReturnType<typeof buildPlan>;
      try {
        plan = buildPlan(working, { srcWidth: full.width, srcHeight: full.height });
      } catch {
        break;
      }
      const step = plan.steps.find((s) => s.type === 'denoise');
      if (step === undefined) break;
      if (step.type !== 'denoise') break; // narrows step for TS below; unreachable in practice
      const inEdge = working.edges.find((e) => e.target === step.nodeId);
      if (!inEdge) break; // a denoise node always has exactly one input once it reaches buildPlan's own validation
      const nodeId = step.nodeId;
      const strength = step.strength;
      const bypass = (doc: GraphDoc): GraphDoc => ({
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== nodeId),
        edges: doc.edges
          .filter((e) => e.target !== nodeId)
          .map((e) => (e.source === nodeId ? { ...e, source: inEdge.source } : e)),
      });
      try {
        // Always captured ENCODED (denoise has no linear mode, see
        // shared/ipc.ts's DenoiseRunRequest doc comment) — this SAME
        // captured buffer feeds inference below; its decoded-to-linear form
        // (`inputLinear`) is what the strength blend mixes against.
        const captured = await renderer.captureExternalInput(full, working, 1, true, inEdge.source, undefined);
        const pixelHash = await sha256Hex(captured.data.buffer as ArrayBuffer);
        const cacheKey = await sha256Hex(new TextEncoder().encode(`${pixelHash}|${DENOISE_MODEL_SHA256}|${nodeId}`).buffer);
        const result = await window.silverbox.runDenoise({
          cacheKey,
          width: captured.width,
          height: captured.height,
          data: captured.data.buffer as ArrayBuffer,
        });
        if (!result.ok) {
          const msg = result.needsConsent
            ? `denoise node bypassed — model not downloaded (grant consent in the Inspector, then export again)`
            : `denoise node failed during export, passing through: ${result.reason}`;
          console.warn(`${msg} (node ${nodeId})`);
          warnings.push(msg);
          working = bypass(working);
          continue;
        }
        const inputLinear = await renderer.decodeExternalResult(new Float32Array(captured.data), captured.width, captured.height, true);
        const denoisedLinear = await renderer.decodeExternalResult(new Float32Array(result.data), result.width, result.height, true);
        const t = Math.min(100, Math.max(0, strength)) / 100;
        const blended = new Float32Array(inputLinear.length);
        for (let i = 0; i < inputLinear.length; i += 4) {
          blended[i] = inputLinear[i]! + (denoisedLinear[i]! - inputLinear[i]!) * t;
          blended[i + 1] = inputLinear[i + 1]! + (denoisedLinear[i + 1]! - inputLinear[i + 1]!) * t;
          blended[i + 2] = inputLinear[i + 2]! + (denoisedLinear[i + 2]! - inputLinear[i + 2]!) * t;
          blended[i + 3] = 1;
        }
        const syntheticPath = `denoise:${nodeId}:${cacheKey}`;
        renderer.setImageNodeSource(syntheticPath, {
          data: blended,
          width: result.width,
          height: result.height,
          fullWidth: result.width,
          fullHeight: result.height,
          flip: 0,
          decodeMs: 0,
        });
        working = {
          ...working,
          nodes: working.nodes.map((n) =>
            n.id === nodeId ? { id: n.id, kind: IMAGE_KIND, position: n.position, image: { path: syntheticPath } } : n
          ),
        };
      } catch (err) {
        console.warn(`denoise node ${nodeId} failed during export, passing through:`, err);
        warnings.push(`denoise node failed during export, passing through: ${err instanceof Error ? err.message : String(err)}`);
        working = bypass(working);
      }
    }
    return { graph: working, warnings };
  };

  const exportOnePath = async (
    targetPath: string,
    outputId: string | undefined,
    opts?: ExportOverrides,
    allowExternal = true
  ): Promise<{ width: number; height: number; bytes: number; warnings?: string[] }> => {
    const { imagePath, fileName, graph, renderer } = get();
    if (!imagePath || !fileName || !renderer) throw new Error('no image open');
    // Resolve which output node this export actually targets — same
    // "matching id, else the doc's first output" rule buildPlan itself
    // applies (CompileContext.outputId's doc comment) — so the settings
    // resolved here always describe the SAME node the render targets.
    const outputs = graph.nodes.filter((n) => n.kind === 'output');
    const targetNode = (outputId && outputs.find((n) => n.id === outputId)) || outputs[0];
    const effective = resolveExportSettings(targetNode, opts ?? {});
    const bytes = await window.silverbox.readFile(imagePath);
    const kind = isRawFileName(fileName) ? 'raw' : 'jpg';
    const full = await loadImage(bytes, kind, Number.MAX_SAFE_INTEGER, get().settings.baselineExposureEV);
    const colorSpace = effective.colorSpace ?? 'srgb';
    // External-tool hook node (task #41): a headless CLI render WITHOUT
    // --allow-external never rewrites anything (allowExternal:false makes
    // renderToPixels' own buildPlan skip every 'external' node itself,
    // bit-exact — see graphDoc.ts's CompileContext.allowExternal) — just
    // detect it for a warning line. WITH the flag (or the interactive UI
    // export, which has its own per-node confirm gate already satisfied by
    // the time a doc reaches export) the doc gets rewritten so the tool's
    // result actually lands in the file.
    let warnings: string[] | undefined;
    let exportGraph = graph;
    if (!allowExternal) {
      try {
        const probe = buildPlan(graph, { outputId, srcWidth: full.width, srcHeight: full.height });
        if (probe.steps.some((s) => s.type === 'external')) {
          warnings = ['external node(s) bypassed — pass --allow-external to run them'];
        }
      } catch {
        // a broken graph surfaces via the render call below; nothing to warn about here
      }
    } else {
      exportGraph = await resolveExternalNodesForExport(graph, full);
    }
    // In-engine ML denoise (denoise v2, stage 1): unlike the external node,
    // no CLI opt-in gate — always attempted. A model that isn't downloaded
    // yet (no consent) or any other inference failure bypasses just that
    // node (pass-through) and adds a `warnings` entry, same shape as the
    // external node's own warning above (see resolveDenoiseNodesForExport's
    // doc comment).
    const denoiseResolved = await resolveDenoiseNodesForExport(exportGraph, full);
    exportGraph = denoiseResolved.graph;
    if (denoiseResolved.warnings.length > 0) {
      warnings = [...(warnings ?? []), ...denoiseResolved.warnings];
    }
    const { data, width, height } = await renderer.renderToPixels(full, exportGraph, 1, colorSpace, outputId, allowExternal);
    const cap = full.capture;
    const encodeResult = await window.silverbox.exportEncode({
      data: data.buffer,
      width,
      height,
      outPath: targetPath,
      quality: Math.min(100, Math.max(1, Math.round(effective.quality ?? 90))),
      maxDim: effective.maxDim ?? null,
      metadata: effective.metadata ?? 'all',
      colorSpace,
      meta: {
        ...(cap?.cameraMake ? { cameraMake: cap.cameraMake } : {}),
        ...(cap?.cameraModel ? { cameraModel: cap.cameraModel } : {}),
        ...(cap?.isoSpeed ? { isoSpeed: cap.isoSpeed } : {}),
        ...(cap?.shutter ? { shutter: cap.shutter } : {}),
        ...(cap?.aperture ? { aperture: cap.aperture } : {}),
        ...(cap?.focalLength ? { focalLength: cap.focalLength } : {}),
        ...(cap?.timestamp ? { timestampIso: new Date(cap.timestamp).toISOString() } : {}),
      },
    });
    return { ...encodeResult, ...(warnings ? { warnings } : {}) };
  };

  /**
   * Resolve `job.preset` (headless CLI, `--preset`) to its raw JSON text: a
   * PATH reads the file directly; a NAME looks it up by display name first,
   * then by slug (a user who already knows a preset's slug — e.g.
   * copy-pasted from another sidecar — shouldn't have to know its display
   * name too), against `presetsList()`/`presetRead()` — which, since the
   * visible library landed (docs/brief-bank/linked-looks-stage-e.md), are
   * themselves dual-location (library first, then the legacy
   * `<userData>/presets` dir) — this function gets that resolution for free,
   * no change needed here.
   */
  const readCliPresetText = async (ref: NonNullable<CliRenderJob['preset']>): Promise<string> => {
    if (ref.kind === 'path') {
      const buf = await window.silverbox.readFile(ref.value);
      return new TextDecoder().decode(buf);
    }
    const list = await window.silverbox.presetsList();
    const slug = list.find((p) => p.name === ref.value)?.slug ?? list.find((p) => p.slug === ref.value)?.slug;
    if (!slug) throw new Error(`preset not found: ${ref.value}`);
    const text = await window.silverbox.presetRead(slug);
    if (text === null) throw new Error(`preset not found: ${ref.value}`);
    return text;
  };

  /**
   * `--min-rating`/`--skip-rejected`'s cheap sidecar read (ratings pack;
   * generalized by the reject-flag pack, docs/brief-bank/reject-flag.md,
   * from the rating-only `readSidecarRatingCheap`): a bare JSON.parse of
   * just the wrapper's `rating`/`flag` keys, deliberately NOT the full
   * parseGraphDoc (which validates/migrates the whole graph and can throw)
   * — runCliRender/runCliCheck call this BEFORE openImageByPath's expensive
   * decode, so a batch over a folder full of below-threshold/rejected
   * images never pays for decoding any of them. No sidecar, unreadable
   * file, or malformed/missing keys all resolve to `{rating:0,flag:null}`
   * (unrated/unflagged), same fallback listImages'/projectPhotosStatus' own
   * cheap read uses (main/index.ts's extractWrapperMeta). A `.json` INPUT (a
   * look file — CLI tooling parity item 2) reads its OWN wrapper directly,
   * since `<lookfile>.json` + SIDECAR_SUFFIX would never resolve to
   * anything real.
   */
  const readSidecarWrapperMetaCheap = async (imagePath: string): Promise<{ rating: number; flag: PhotoFlag | null }> => {
    let text: string | null;
    try {
      text = imagePath.endsWith('.json')
        ? new TextDecoder().decode(await window.silverbox.readFile(imagePath))
        : await window.silverbox.readSidecar(imagePath + SIDECAR_SUFFIX);
    } catch {
      return { rating: 0, flag: null };
    }
    if (text === null) return { rating: 0, flag: null };
    try {
      const wrapper = JSON.parse(text) as { rating?: unknown; flag?: unknown };
      return { rating: sanitizeRating(wrapper.rating), flag: sanitizeFlag(wrapper.flag) ?? null };
    } catch {
      return { rating: 0, flag: null };
    }
  };

  // --- Project storage (stage 1, docs/brief-bank/project-storage.md) --------

  /**
   * Per-launch quick project (UX pack round 2, item A): this SESSION's own
   * dated subdir under `settings.quickProjectDir` (now a ROOT — see that
   * field's doc comment), resolved at most once per app session and cached
   * here so every later open/drop within the SAME session keeps accumulating
   * into it (catalog semantics preserved). `null` = not yet resolved this
   * session; `newProject()` resets it back to `null` so the NEXT quick-
   * project need mints a fresh dated subdir instead of reusing this one.
   * Irrelevant whenever `testFlags.projectDirOverride` is set (that lever
   * wins outright, no subdir — see ensureActiveProject below).
   */
  let quickSessionDir: string | null = null;

  /**
   * Resolve the ACTIVE project, activating the quick project on demand if
   * none is open yet: `SILVERBOX_TEST_PROJECT` (testFlags.projectDirOverride
   * — the verify-suite lever) wins over the `quickProjectDir` setting,
   * used EXACTLY as given (a pinned dir, no per-session subdir — keeps the
   * whole verify suite valid unchanged). Otherwise `quickProjectDir` is this
   * session's quick-projects ROOT: the first call resolves (via main's
   * resolveQuickSessionDir) and caches a fresh dated subdirectory
   * (`quickSessionDir` above); every subsequent call this session reuses it.
   * Reads/parses an existing manifest at the resolved directory if one
   * exists; starts a fresh empty one otherwise (nothing is written to disk
   * here — the FIRST playlist mutation is what schedules the debounced
   * project.silverbox write, see this file's bottom-of-file subscriber;
   * writeSidecar itself also mkdir's the looks/ dir just-in-time, so there is
   * no race between "photo added" and "look saved" even before that first
   * manifest write lands).
   */
  const ensureActiveProject = async (): Promise<ActiveProject> => {
    const existing = get().project;
    if (existing) return existing;
    const override = window.silverbox.testFlags.projectDirOverride;
    let dir: string;
    if (override !== null) {
      dir = override;
    } else {
      const root = get().settings.quickProjectDir;
      if (!root) throw new Error('quick project directory is not yet known (settings still loading)');
      if (quickSessionDir === null) {
        quickSessionDir = await window.silverbox.resolveQuickSessionDir(root);
        set({ quickSessionDir });
      }
      dir = quickSessionDir;
    }
    let manifest: ProjectManifest;
    try {
      const text = await window.silverbox.readProjectManifest(dir);
      manifest = text !== null ? parseProjectManifest(text) : defaultProjectManifest('Quick');
    } catch (err) {
      console.warn(`could not read/parse the quick project manifest at ${dir}, starting fresh:`, err);
      manifest = defaultProjectManifest('Quick');
    }
    const project: ActiveProject = { dir, name: manifest.name, photos: manifest.photos, unknown: manifest.unknown ?? null };
    set({ project, sharedLookTexts: {} }); // stage D: fresh per-project baseline cache, same reset openProjectByPath's own activation gets
    // Stage D semantic 1: arm the shared-looks watcher for THIS (quick or
    // resolved) project too — openProjectByPath isn't the only path that
    // activates a project; a folder/single-photo open with no existing
    // project.silverbox lands here instead (quick project).
    void window.silverbox.watchSharedLooks(dir);
    void get().refreshSharedLooks(); // linked-looks-stage-b.md: shared-looks/ is project-scoped, refresh on every project switch
    void get().refreshRepairSheets(); // linked-looks-stage-f.md: repair-sheets/ is project-scoped, same refresh
    // Semantic 5 (drift-at-open): a quick project can already have a
    // shared-looks/ dir from a PRIOR session at the same path (e.g. reusing
    // `<userData>/quick-projects/<date>` across launches) — same drift scan
    // openProjectByPath runs, fire-and-forget here since ensureActiveProject
    // itself must stay fast (it's on the hot path of every ordinary photo
    // open, not just project-level ones).
    void checkSharedLookDriftAtOpen();
    return project;
  };

  /**
   * Find `photoPath`'s existing playlist row, if any. Two arms, because
   * `path` can be stored in two different valid shapes (ProjectPhoto's own
   * doc comment): an EXACT match handles both a hand-authored/imported
   * absolute `path` (stored verbatim — resolveProjectPath would just return
   * it unchanged anyway) AND, defensively, a `photoPath` that isn't actually
   * absolute (a standalone verify script's bare `SILVERBOX_TEST_ARW`
   * fallback, e.g. `'test-assets/test.ARW'`, reused identically on every
   * open — real callers never do this, dialogs/drag-drop/filmstrip cells
   * always hand this an absolute path); a RESOLVED match handles the normal
   * case, a relative-to-project-dir `path` (relativizeProjectPath's usual
   * output for an absolute `photoPath`) resolving back to it.
   */
  const findPlaylistPhoto = (project: ActiveProject, photoPath: string): ProjectPhoto | undefined =>
    project.photos.find((p) => p.path === photoPath || resolveProjectPath(project.dir, p.path) === photoPath);

  /**
   * Ensure `photoPath` has a playlist row in the active project — creating/
   * activating that project first if none is active — and return its look
   * filename. A photo already on the playlist just returns its existing
   * look (never re-derives a name for it — see findPlaylistPhoto); a new
   * photo is appended with a freshly derived one (deriveLookName's
   * collision suffixing, keyed off every OTHER row resolved to absolute).
   */
  const ensureProjectAndAddPhoto = async (photoPath: string): Promise<{ project: ActiveProject; look: string }> => {
    const project = await ensureActiveProject();
    const existing = findPlaylistPhoto(project, photoPath);
    if (existing) return { project, look: existing.look };
    const byAbsPath = new Map(project.photos.map((p) => [resolveProjectPath(project.dir, p.path), p.look]));
    const look = deriveLookName(photoPath, byAbsPath);
    const photos: ProjectPhoto[] = [...project.photos, { path: relativizeProjectPath(project.dir, photoPath), look }];
    const updated: ActiveProject = { ...project, photos };
    set({ project: updated });
    return { project: updated, look };
  };

  /**
   * `--project <dir>` (CLI tooling parity, project-storage.md stage 2):
   * READ-ONLY playlist lookup for one photo — the CLI counterpart to
   * ensureProjectAndAddPhoto above, deliberately NOT sharing its
   * implementation because this one must never add a playlist row or write
   * anything (a headless batch over someone else's project must not
   * silently mutate it — see CliRenderJob.projectDir's doc comment). A photo
   * already on the playlist resolves to its recorded look; one that isn't
   * gets a `cliWarn` notice and falls back to the DEFAULT look, but still
   * needs a deterministic NAME for golden-render naming (CliCheckJob.
   * projectDir's doc comment) — computed with the same deriveLookName
   * algorithm ensureProjectAndAddPhoto uses, against a scratch map that is
   * never written back anywhere (zero mutation, unlike that function's own
   * use of it).
   */
  const resolveCliProjectLook = async (photoPath: string, dir: string): Promise<{ lookPath: string; project: ActiveProject }> => {
    const text = await window.silverbox.readProjectManifest(dir);
    if (text === null) throw new Error(`no project.silverbox found at ${dir}`);
    const manifest = parseProjectManifest(text);
    const project: ActiveProject = { dir, name: manifest.name, photos: manifest.photos, unknown: manifest.unknown ?? null };
    const row = findPlaylistPhoto(project, photoPath);
    if (row) return { lookPath: `${dir}/looks/${row.look}`, project };
    const byAbsPath = new Map(project.photos.map((p) => [resolveProjectPath(dir, p.path), p.look]));
    const lookName = deriveLookName(photoPath, byAbsPath);
    window.silverbox.cliWarn(`${photoPath}: not on the project playlist at ${dir} — rendering with the default look`);
    return { lookPath: `${dir}/looks/${lookName}`, project };
  };

  /**
   * The filmstrip's per-cell status for `project`'s WHOLE playlist (not
   * scoped to any one folder — "a playlist doesn't own photos", filmstrip-
   * curation.md) via one projectPhotosStatus IPC round trip: resolves every
   * row to absolute first (main stays project-path-agnostic).
   */
  const buildPlaylistEntries = async (project: ActiveProject): Promise<FolderImageEntry[]> => {
    const photos = project.photos.map((p) => ({ path: resolveProjectPath(project.dir, p.path), look: p.look }));
    return window.silverbox.projectPhotosStatus(project.dir, photos);
  };

  /**
   * Shared notice lifecycle (NG2 fix pack — "one shared mechanism, not four
   * copies"): every SET site for projectNotice/relinkMismatchNotice/
   * legacySidecarImportNotice should call this instead of a bare
   * `set({ field: value })`. For a `{ kind: 'success' }` projectNotice (a
   * clean completion — nothing needs the user's attention) it schedules an
   * ~8s auto-clear, guarded by reference identity so a NEWER notice that
   * superseded it before the timer fires is never clobbered — the exact
   * by-reference check connectNotice/spotsCapNotice each used to do inline,
   * generalized here rather than copied a third and fourth time. Anything
   * without `kind: 'success'` (an 'error' projectNotice, or
   * relinkMismatchNotice/legacySidecarImportNotice, neither of which carries
   * a `kind` at all) never auto-clears — `dismissNotice` (the Toolbar's ✕)
   * is the only way to close it early, besides whatever supersedes it.
   */
  const raiseNotice = <K extends 'projectNotice' | 'relinkMismatchNotice' | 'legacySidecarImportNotice'>(
    field: K,
    value: NonNullable<AppState[K]>
  ): void => {
    set({ [field]: value } as Pick<AppState, K>);
    if (!('kind' in value) || value.kind !== 'success') return;
    setTimeout(() => {
      if (get()[field] === value) set({ [field]: null } as Pick<AppState, K>);
    }, NOTICE_AUTO_EXPIRE_MS);
  };

  /**
   * Global-undo jump (docs/brief-bank/global-undo.md, decision 1): make
   * `target` the open photo, awaiting the SAME `openImageByPath` every other
   * open goes through (flush-on-switch, OpenSession epoch, sidecar read —
   * "session/epoch machinery as-is", per the brief's sequencing). A no-op
   * (returns `true` immediately, no reopen at all) when `target` is already
   * the open, ready photo — undoing/redoing an entry for the CURRENTLY open
   * photo must feel exactly like it always has, no flush/reset of anything.
   * Returns `false` when the jump didn't land (missing file, or a real open
   * racing it) — `undo`/`redo` treat that as BLOCKED: the entry stays on its
   * stack, untouched, and a notice explains why.
   */
  const ensurePhotoOpenForUndo = async (target: string): Promise<boolean> => {
    const before = get();
    if (before.imagePath === target && before.imageStatus === 'ready') return true;
    await before.openImageByPath(target, { keepFolderContext: true });
    const after = get();
    return after.imagePath === target && after.imageStatus === 'ready';
  };

  /** BLOCKED undo/redo notice (decision 1's missing-file carve-out) — reuses the same dismissable banner projectNotice already renders elsewhere. */
  const blockUndoRedo = (action: 'undo' | 'redo', label: string, target: string): void => {
    const name = target.split('/').pop() ?? target;
    raiseNotice('projectNotice', {
      kind: 'error',
      message: `could not ${action} "${label}" — ${name} could not be opened (missing file? relink it from the filmstrip, then try again)`,
    });
  };

  /**
   * Batch sync undo/redo (multi-select-sync.md, global-undo decision 1's
   * BATCH carve-out — "no single photo to show, revert all targets in
   * place"): write `graphs[photoPath]` back to each target's OWN look file,
   * preserving whatever else that file's wrapper metadata reads on disk
   * RIGHT NOW (rating/flag/photo/fingerprint/unknown/createdAt) — same
   * read-patch-write shape setFlag's "any other look" branch uses, just
   * looped over N targets. All-or-nothing: if ANY target's file can't be
   * read/parsed (missing, mid-relink, corrupted), NOTHING is written —
   * `undo`/`redo` treat that as BLOCKED (decision 1's "not silently
   * skipped, not applied blind"), the same spirit as a single-photo entry's
   * missing-file guard, just checked for every target before committing any
   * of them.
   */
  const applySyncEntryGraphs = async (
    targets: string[],
    graphs: Record<string, GraphDoc>
  ): Promise<{ ok: true } | { ok: false; failedTarget: string }> => {
    const project = get().project;
    if (!project) return { ok: false, failedTarget: targets[0] ?? '' };
    const writes: { lookPath: string; content: string; photoPath: string }[] = [];
    for (const photoPath of targets) {
      const row = findPlaylistPhoto(project, photoPath);
      const targetGraph = graphs[photoPath];
      if (!row || !targetGraph) return { ok: false, failedTarget: photoPath };
      const lookPath = `${project.dir}/looks/${row.look}`;
      let text: string | null;
      try {
        text = await window.silverbox.readSidecar(lookPath);
      } catch {
        return { ok: false, failedTarget: photoPath };
      }
      if (text === null) return { ok: false, failedTarget: photoPath };
      let parsed: SidecarDoc;
      try {
        parsed = parseGraphDoc(text);
      } catch {
        return { ok: false, failedTarget: photoPath };
      }
      const content = serializeGraphDoc(
        targetGraph,
        parsed.source ?? null,
        parsed.createdAt ?? null,
        parsed.unknown,
        parsed.rating,
        parsed.photo,
        parsed.fingerprint,
        parsed.flag
      );
      writes.push({ lookPath, content, photoPath });
    }
    for (const w of writes) await window.silverbox.writeSidecar(w.lookPath, w.content);
    // Develop-aware filmstrip thumbnails (semantic 3): undo/redo of a batch
    // sync entry rewrites every target's look file exactly like the batch
    // action that created the entry did — same trigger, same targets.
    get().bumpLookVersion(writes.map((w) => w.photoPath));
    // Self-write-suppression baseline (saveGraph/writeGraphSaveSnapshot's own
    // "record exactly what we just wrote" discipline — AppState.
    // lastSidecarText's doc comment): this is a DIRECT writeSidecar, not
    // saveGraph, so nothing else updates lastSidecarText. Harmless when the
    // currently open photo isn't among `targets` (a batch write whose
    // targets exclude the primary) — but
    // applyPresetToSelection's targets DO include the primary, and the
    // caller (undo()/redo()'s 'sync' case) reopens it right after this
    // returns ("the currently open photo happens to be one of the targets"
    // branch, both callers share). Without this, the fs-watch echo of the
    // write just above can race that reopen's own (slower — a real decode)
    // completion and misfire handleExternalSidecarChange as a genuine
    // EXTERNAL change, clobbering the just-pushed redo entry with a spurious
    // "Reload from disk" entry (caught by this feature's own verify script,
    // where the primary being a target is the COMMON case, not an edge one).
    const openPath = get().imagePath;
    const openWrite = writes.find((w) => w.photoPath === openPath);
    if (openWrite) set({ lastSidecarText: openWrite.content });
    return { ok: true };
  };

  // --- Shared-look hot-reload & drift (linked-looks-stage-d.md) ------------

  /**
   * ONE re-materialization path (the brief's "Key constraints") shared by
   * the watch handler (semantic 3), its deferred 'pending' reflect button
   * (semantic 4), AND drift-at-open (semantic 5) — the exact fan-out shape
   * publishToSharedLook uses (read every follower, rewrite `follows ∩
   * offered` from the NEW look body, bump `materializedFrom` on every
   * follower including an empty intersection), plus the value-drift-fork
   * check (semantic 6) run against `lookTextBefore` before any follower is
   * overwritten (skipped when `lookTextBefore === lookTextAfter` — nothing
   * to have drifted FROM, see checkSharedLookDriftAtOpen's own doc comment).
   * Pushes ONE PublishUndoEntry — kind reused VERBATIM (same shape, same
   * undo/redo cases already wired for 'publish'; only `label` distinguishes
   * an external/drift re-materialization from an actual publish gesture) —
   * whose `lookTextBefore`/`lookTextAfter` restore the shared-look FILE
   * itself on undo/redo, file-first, exactly like a real publish. No entry
   * is pushed when nothing follows this look (nothing to undo). Returns the
   * follower count, or `null` if `lookTextAfter` doesn't parse (a malformed
   * external edit — logged, left alone, never crashes) or there's no active
   * project.
   */
  const reMaterializeSharedLook = async (
    slug: string,
    lookTextBefore: string,
    lookTextAfter: string,
    label: string
  ): Promise<{ targetCount: number } | null> => {
    const project = get().project;
    if (!project) return null;
    let parsedAfter: ParsedPreset;
    try {
      parsedAfter = parsePresetFile(lookTextAfter);
    } catch (err) {
      console.warn(`shared look "${slug}": external content could not be parsed, skipping re-materialization:`, err);
      return null;
    }
    let referenceDevelop: DevelopParams | null = null;
    let referenceHash: string | null = null;
    if (lookTextBefore !== lookTextAfter) {
      try {
        referenceDevelop = lookDevelopOf(parsePresetFile(lookTextBefore));
        referenceHash = await sha256Hex(new TextEncoder().encode(lookTextBefore).buffer);
      } catch {
        // cached "before" text somehow doesn't parse — skip the value-drift-fork check, still re-materialize
      }
    }
    const offeredFamilies = (parsedAfter.includes ?? []).filter(isKnownFamilyId).filter(isDevelopFamily);
    const newLookDevelop = lookDevelopOf(parsedAfter);
    const materializedFrom = await sha256Hex(new TextEncoder().encode(lookTextAfter).buffer);

    /** Compute one follower node's re-materialized develop+link, running the value-drift-fork check first — shared by both the live-graph and on-disk branches below. */
    const materializeNode = (node: GraphNode): { develop: DevelopParams; link: DevelopLink } | null => {
      if (!node.link) return null;
      let working = node;
      if (referenceDevelop && referenceHash) {
        working = forkValueDriftedFamilies(node, referenceDevelop, referenceHash).node;
      }
      const intersect = working.link!.follows.filter((f) => offeredFamilies.includes(f));
      const newDevelop =
        intersect.length > 0
          ? pickDevelopFamilies(newLookDevelop, working.develop ?? defaultDevelopParams(), new Set(intersect))
          : (working.develop ?? defaultDevelopParams());
      return { develop: newDevelop, link: { ...working.link!, materializedFrom } };
    };

    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};

    for (const row of project.photos) {
      const photoPath = resolveProjectPath(project.dir, row.path);
      const isOpen = photoPath === get().imagePath && get().imageStatus === 'ready';

      if (isOpen) {
        const liveGraph = get().graph;
        const node = liveGraph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
        const materialized = node && materializeNode(node);
        if (!node || !materialized) continue;
        const nextGraph: GraphDoc = {
          ...liveGraph,
          nodes: liveGraph.nodes.map((n) => (n.id === node.id ? { ...n, ...materialized } : n)),
        };
        before[photoPath] = structuredClone(liveGraph);
        after[photoPath] = nextGraph;
        set({ graph: nextGraph, graphDirty: true });
        revalidateShaders(nextGraph);
        await get().saveGraph();
        continue;
      }

      const lookPath = `${project.dir}/looks/${row.look}`;
      let existingText: string | null;
      try {
        existingText = await window.silverbox.readSidecar(lookPath);
      } catch (err) {
        console.warn(`reMaterializeSharedLook: could not read ${lookPath}:`, err);
        continue;
      }
      if (existingText === null) continue; // never saved — nothing to re-materialize
      let parsedLook: SidecarDoc;
      try {
        parsedLook = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`reMaterializeSharedLook: ${lookPath} is unreadable by this build, skipping:`, err);
        continue;
      }
      const node = parsedLook.graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
      const materialized = node && materializeNode(node);
      if (!node || !materialized) continue; // not a follower of THIS look
      const nextGraph: GraphDoc = {
        ...parsedLook.graph,
        nodes: parsedLook.graph.nodes.map((n) => (n.id === node.id ? { ...n, ...materialized } : n)),
      };
      const content = serializeGraphDoc(
        nextGraph,
        parsedLook.source ?? null,
        parsedLook.createdAt ?? null,
        parsedLook.unknown,
        parsedLook.rating,
        parsedLook.photo,
        parsedLook.fingerprint,
        parsedLook.flag
      );
      try {
        await window.silverbox.writeSidecar(lookPath, content);
      } catch (err) {
        console.warn(`reMaterializeSharedLook: could not write ${lookPath}:`, err);
        continue;
      }
      before[photoPath] = structuredClone(parsedLook.graph);
      after[photoPath] = nextGraph;
    }

    const targets = Object.keys(after);
    if (targets.length > 0) {
      const entry: PublishUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'publish',
        label,
        projectDir: project.dir,
        slug,
        lookTextBefore,
        lookTextAfter,
        targets,
        before,
        after,
      };
      set((st) => ({
        undoStack: pushUndoEntry(st.undoStack, entry),
        sharedLookTexts: { ...st.sharedLookTexts, [slug]: lookTextAfter },
      }));
      // Develop-aware filmstrip thumbnails (semantic 3): this fan-out is the
      // SAME shape publishToSharedLook's own fan-out uses (external edit /
      // drift-at-open re-materialization) — every follower whose look file
      // just changed needs its cell to repaint too.
      get().bumpLookVersion(targets);
      await get().refreshPlaylistStatus();
    } else {
      // Nothing follows this look right now — still prime the cache (self-
      // write-suppression baseline), just nothing to undo.
      set((st) => ({ sharedLookTexts: { ...st.sharedLookTexts, [slug]: lookTextAfter } }));
    }
    await get().refreshSharedLooks();
    return { targetCount: targets.length };
  };

  /** reMaterializeSharedLook + the transient 'applied' notice (semantic 3) — shared by the watch handler, the drift checks, and the pending notice's reflect button. Silent (no notice, no undo entry) when nothing follows the look. */
  const runSharedLookReMaterialization = async (
    slug: string,
    lookName: string,
    lookTextBefore: string,
    lookTextAfter: string,
    label: string
  ): Promise<void> => {
    const result = await reMaterializeSharedLook(slug, lookTextBefore, lookTextAfter, label);
    if (!result || result.targetCount === 0) return;
    const notice = {
      kind: 'applied' as const,
      slug,
      message: `共通ルック「${lookName}」が変更されました — ${result.targetCount}枚に反映 (⌘Zで取り消し)`,
    };
    set({ sharedLookHotReloadNotice: notice });
    setTimeout(() => {
      if (get().sharedLookHotReloadNotice === notice) set({ sharedLookHotReloadNotice: null });
    }, 4000);
  };

  /**
   * Clean/dirty guard (semantic 4, parent §4.4): when the OPEN photo is
   * itself a follower of `slug` AND the session is dirty, the WHOLE fan-out
   * is deferred behind a persistent 'pending' notice with a reflect button
   * (autosave-ON makes this the rare path — dirty windows are transient); a
   * clean session (or a change to a look the open photo doesn't follow at
   * all) runs the re-materialization immediately, same as publish.
   */
  const maybeDeferOrReMaterialize = async (
    slug: string,
    lookName: string,
    lookTextBefore: string,
    lookTextAfter: string,
    label: string
  ): Promise<void> => {
    const s = get();
    const openIsFollower =
      s.imageStatus === 'ready' && s.graph.nodes.some((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
    if (openIsFollower && s.graphDirty) {
      set({
        sharedLookHotReloadNotice: {
          kind: 'pending',
          slug,
          message: `共通ルック「${lookName}」が変更されました — 未保存の編集があります (反映で適用)`,
          label,
          lookTextBefore,
          lookTextAfter,
        },
      });
      return;
    }
    await runSharedLookReMaterialization(slug, lookName, lookTextBefore, lookTextAfter, label);
  };

  /**
   * Drift-at-open (semantic 5, parent §4.5's git-pull story): for every
   * shared look in the project, compare its CURRENT on-disk hash against
   * every follower's `materializedFrom` (the live graph for the open photo,
   * each OTHER follower's own look file on disk). Any mismatch
   * re-materializes the WHOLE look uniformly via reMaterializeSharedLook —
   * not just the mismatched followers, same "bump every follower regardless"
   * contract publish/the watch handler both follow.
   *
   * No usable `lookTextBefore` exists for a look that drifted while the app
   * wasn't running (no session cache yet, by construction — a fresh
   * project open starts `sharedLookTexts` empty) — `lookTextBefore ===
   * lookTextAfter` is passed instead. This is deliberate, not a shortcut:
   * our own app never wrote the shared-look FILE in this scenario (an
   * external actor already did, before we ever saw it), so there is no
   * sound "before" text to restore on undo for the FILE side — the follower
   * graphs' before/after are the substantive, fully-recoverable undo
   * payload here (see reMaterializeSharedLook's own value-drift-fork
   * short-circuit on `lookTextBefore === lookTextAfter`, which correctly
   * never fires in this path either — there is nothing sound to compare a
   * drifted-from-when follower's OWN values against).
   *
   * Every slug's cache entry is primed with its current content regardless
   * of drift (avoids a false-positive fan-out from the FIRST watch event
   * that lands afterward). No-op without an active project.
   */
  const checkSharedLookDriftAtOpen = async (): Promise<void> => {
    const project = get().project;
    if (!project) return;
    for (const { slug, name } of get().sharedLooks) {
      let text: string | null;
      try {
        text = await window.silverbox.sharedLookRead(project.dir, slug);
      } catch (err) {
        console.warn(`checkSharedLookDriftAtOpen: could not read shared look "${slug}":`, err);
        continue;
      }
      if (text === null) continue; // missing — semantic 7 surfaces this per-photo at load, not here
      const hash = await sha256Hex(new TextEncoder().encode(text).buffer);
      let anyMismatch = false;
      for (const row of project.photos) {
        const photoPath = resolveProjectPath(project.dir, row.path);
        const isOpen = photoPath === get().imagePath && get().imageStatus === 'ready';
        let link: DevelopLink | undefined;
        if (isOpen) {
          link = get().graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug)?.link;
        } else {
          const lookPath = `${project.dir}/looks/${row.look}`;
          try {
            const t = await window.silverbox.readSidecar(lookPath);
            if (t) link = parseGraphDoc(t).graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug)?.link;
          } catch {
            // unreadable by this build — not this check's job, same posture publishToSharedLook/deleteSharedLook's own sweeps take
          }
        }
        if (link && link.materializedFrom !== hash) {
          anyMismatch = true;
          break;
        }
      }
      set((st) => ({ sharedLookTexts: { ...st.sharedLookTexts, [slug]: text! } }));
      if (!anyMismatch) continue;
      await runSharedLookReMaterialization(slug, name, text, text, `共通ルック「${name}」のドリフトを検出 (project open)`);
    }
  };

  /**
   * Per-photo link validation at open/hot-reload (semantics 5-belt/6/7): for
   * every Develop node carrying a `link`, read the shared look it names ONCE
   * (shared across every node naming the same slug, even across separate
   * chains of a multi-output doc) and:
   *  - semantic 7 (missing look): no backing file — metadata kept (stage
   *    B's quiet degradation already renders correctly with `link` simply
   *    ignored); returns a notice to surface, never strips anything.
   *  - semantic 6 (value-drift-implies-fork): the node's own marker matches
   *    the look's CURRENT hash but its own develop values for a followed
   *    family disagree — unlist that family (forkValueDriftedFamilies).
   *  - semantic 5 ("as a belt"): the node's marker does NOT match the
   *    look's current hash — a project-wide re-materialization for that
   *    slug hasn't caught this node up yet (this photo opened directly,
   *    bypassing/racing checkSharedLookDriftAtOpen's own project-open
   *    sweep) — trigger the SAME project-wide fan-out, fire-and-forget; the
   *    graph THIS function returns never carries re-materialized values
   *    itself (those land via that fan-out's own write, same timing as any
   *    other cross-photo update reaching the currently open photo).
   * Returns the graph with fork changes applied and at most one missing-look
   * notice (first one found — single-slot, same simplification
   * sharedLookHotReloadNotice makes generally).
   */
  const validatePhotoLinks = async (
    graph: GraphDoc,
    project: ActiveProject
  ): Promise<{ graph: GraphDoc; missingNotice: { slug: string; message: string } | null }> => {
    const linkedNodes = graph.nodes.filter((n) => n.kind === DEVELOP_KIND && n.link);
    if (linkedNodes.length === 0) return { graph, missingNotice: null };
    type LookInfo = { text: string; hash: string; develop: DevelopParams; name: string } | null;
    const cache = new Map<string, LookInfo>();
    let working = graph;
    let missingNotice: { slug: string; message: string } | null = null;
    for (const node of linkedNodes) {
      const slug = node.link!.look;
      if (!cache.has(slug)) {
        let text: string | null;
        try {
          text = await window.silverbox.sharedLookRead(project.dir, slug);
        } catch {
          text = null;
        }
        if (text === null) {
          cache.set(slug, null);
        } else {
          try {
            const parsed = parsePresetFile(text);
            const hash = await sha256Hex(new TextEncoder().encode(text).buffer);
            cache.set(slug, { text, hash, develop: lookDevelopOf(parsed), name: parsed.name });
          } catch {
            cache.set(slug, null); // unreadable — never crash the open, same posture as missing
          }
        }
      }
      const info = cache.get(slug) ?? null;
      if (!info) {
        if (!missingNotice) missingNotice = { slug, message: `共通ルック「${slug}」が見つかりません — リンクは保持されます` };
        continue;
      }
      const current = working.nodes.find((n) => n.id === node.id);
      if (!current || current.kind !== DEVELOP_KIND || !current.link) continue;
      const { node: forkedNode, forked } = forkValueDriftedFamilies(current, info.develop, info.hash);
      const effective = forked.length > 0 ? forkedNode : current;
      if (forked.length > 0) {
        working = { ...working, nodes: working.nodes.map((n) => (n.id === node.id ? forkedNode : n)) };
      }
      if (effective.link && effective.link.materializedFrom !== info.hash) {
        void runSharedLookReMaterialization(slug, info.name, info.text, info.text, `共通ルック「${info.name}」の変更を検出 (photo open)`);
      }
    }
    return { graph: working, missingNotice };
  };

  return {
  imageStatus: 'idle',
  image: null,
  fileName: null,
  imagePath: null,
  imageError: null,
  settingsReloading: false,
  project: null,
  quickSessionDir: null,
  projectNotice: null,
  currentLookPath: null,
  legacySidecarImportNotice: null,
  relinkMismatchNotice: null,
  folderDir: null,
  folderEntries: [],
  lookVersions: {},
  filmstripSelection: [],
  filmstripSelectionAnchor: null,
  currentPhotoMissingNotice: null,
  openingPreview: null,
  graph: defaultGraphDoc(),
  graphDirty: false,
  selectedNodeId: null,
  nodeThumbs: {},
  inspectNodeId: null,
  shaderErrors: {},
  renderer: null,
  viewportFitAnimated: null,
  exportStatus: 'idle',
  exportError: null,
  exportDialogOpen: false,
  settingsDialogOpen: false,
  exportBatchInfo: null,
  exportLutInfo: null,
  histogram: null,
  scopeMode: 'histogram',
  scopeSamples: null,
  undoStack: emptyUndoStackState(),
  sidecarNotice: null,
  sidecarUnreadable: false,
  sidecarCreatedAt: null,
  sidecarRating: 0,
  sidecarFlag: null,
  sidecarUnknownFields: null,
  sidecarFingerprint: null,
  sidecarPhotoAtOpen: null,
  lastSidecarText: null,
  sidecarHotReloadNotice: null,
  sidecarDiffDialog: null,
  exportInfo: null,
  wbModel: DEFAULT_WB_MODEL,
  showBefore: false,
  grayscaleView: false,
  compareMode: false,
  compareOutputId: null,
  compareDocOverride: null,
  cropMode: false,
  wbPicking: false,
  colorKeyPicking: false,
  developClipboard: null,
  settings: DEFAULT_SETTINGS,
  activeOutputId: null,
  maskOverlay: false,
  maskDrawMode: null,
  spotMode: false,
  selectedSpotIndex: null,
  spotBrushRadius: DEFAULT_SPOT_BRUSH_RADIUS,
  spotsCapNotice: null,
  gpuError: null,

  async openImageByPath(
    path: string,
    opts?: { skipSidecar?: boolean; keepFolderContext?: boolean; legacySidecarOnly?: boolean; cliProjectDir?: string }
  ) {
    // Newest-open-wins epoch guard + cleanup ledger (OpenSession extraction —
    // architecture-audit risk #1) — see openSession.ts's doc comment for the
    // race this guards (the filmstrip's arrow-key switching resolving
    // multi-second RAW decodes out of call order). Constructing `session`
    // claims the epoch AND runs the PREVIOUS session's disposers (its own
    // opening-preview blob URL, if it set one — see the `session.own(...)`
    // call below) — the scattered top-of-function `clearOpeningPreview`
    // call this used to be is now that ledger sweep instead.
    const session = new OpenSession(path, opts);
    // A pending autosave from whatever image was open belongs to THAT
    // image/path; never let it fire against the one we're about to open.
    // NOT part of the ledger above: the timer is scheduled by the
    // graph-mutation subscriber outside any particular session's lifetime
    // (openImageByPath never creates it), so there's no single owning
    // session to register it against — called unconditionally here instead,
    // exactly where the old epoch guard used to call it.
    // Flush it instead of just dropping it (conductor review finding, data
    // loss): `priorState` here still reads the OLD photo — nothing above
    // this line has mutated the store yet — so flushPendingAutosave's
    // capture is guaranteed pre-mutation. See its own doc comment for why
    // the actual write doesn't need to be awaited before the open proceeds.
    //
    // EXCEPT when `path` is the SAME one already open: that's a reopen, not
    // a switch (see flushPendingAutosave's CALLER CONTRACT doc comment for
    // the regression this guards — verify-basecurve's "reopening re-seeds"/
    // "deleted-curve sidecar" checks, which rely on an unsaved edit being
    // DISCARDED by reopening, same as they always were before this fix).
    // Flushing here would write straight into the file this reopen's own
    // upcoming readSidecar is about to read, racing it.
    const priorState = get();
    if (priorState.imagePath !== path) {
      void flushPendingAutosave(priorState);
    }
    cancelAutosaveTimer();
    // Folder filmstrip (ROADMAP "nice to have"): exit folder-browsing by
    // default — see this method's `keepFolderContext` doc comment.
    if (!opts?.keepFolderContext) set({ folderDir: null, folderEntries: [] });
    const fileName = path.split('/').pop() ?? path;
    const kind = isRawFileName(fileName) ? 'raw' : isJpegFileName(fileName) ? 'jpg' : null;
    if (!kind) {
      set({ imageStatus: 'error', imageError: `unsupported file type: ${fileName}` });
      return;
    }
    // A preset hover preview (round-7 UX pack G §4) belongs to whatever image
    // was open a moment ago — its merged geometry would be stale (and, in
    // the pathological case of the mouse holding still across a filmstrip
    // arrow-key switch, would ride along into the NEW image's render).
    // Clearing it here, synchronously and unconditionally, is simpler and
    // safer than trying to reason about every call site that could leave a
    // preview active.
    // settingsReloading is reset here too (defensive): a genuinely different
    // image opening must never inherit a stale "still decoding settings"
    // chip left behind by an in-flight reloadImageForSettings its own
    // `finally` hasn't run yet.
    set({
      imageStatus: 'loading',
      fileName,
      imagePath: path,
      imageError: null,
      previewLook: null,
      settingsReloading: false,
      // NG3 fix pack ("renaming an OPEN photo's file shows nothing"): a
      // fresh open — success or failure — always belongs to a DIFFERENT
      // photo than whatever refreshPlaylistStatus last flagged missing.
      currentPhotoMissingNotice: null,
    });
    try {
      const bytes = await session.guard(window.silverbox.readFile(path));
      // Embedded-preview-first opening: slice the camera JPEG OUT of `bytes`
      // (extractSonyEmbeddedPreview copies via ArrayBuffer.slice — never a
      // view into `bytes`) before loadImage transfers it to the decode
      // worker below (postMessage's transfer list detaches it synchronously
      // inside that call). JPEG opens skip this entirely — they decode fast
      // enough that a preview overlay would itself be the visible delay.
      if (kind === 'raw') {
        const preview = extractSonyEmbeddedPreview(bytes);
        if (preview) {
          // Revoke whatever preview URL is CURRENTLY live before installing
          // this one — guards a race the top-of-function clear can't: two
          // overlapping opens each await their own readFile, so a second
          // open's extraction can land while the first open's preview is
          // still showing (the first open's OWN `await loadImage(...)`
          // hasn't resolved yet to reach its ready/error clear). Without
          // this, that would silently overwrite (leak) the first URL
          // instead of revoking it.
          set(clearOpeningPreview(get()));
          const url = URL.createObjectURL(new Blob([preview.bytes], { type: 'image/jpeg' }));
          set({ openingPreview: { url, width: preview.width, height: preview.height, flip: preview.flip } });
          // Ledger registration: if THIS session gets superseded before
          // reaching ready/error, the NEXT session's constructor revokes
          // this URL for us — see the class doc comment.
          session.own(() => set(clearOpeningPreview(get())));
        }
      }
      const image = await session.guard(
        loadImage(bytes, kind, get().settings.previewLongEdge, get().settings.baselineExposureEV)
      );
      // The graph belongs to the image: restore its sidecar, or start fresh.
      // A malformed sidecar falls back to the default doc (and stays on disk
      // untouched until the user saves over it) with a toolbar notice.
      let graph = defaultGraphDoc();
      let sidecarNotice: string | null = null;
      let sidecarUnreadable = false;
      let sidecarCreatedAt: string | null = null;
      let sidecarRating = 0;
      let sidecarFlag: PhotoFlag | null = null;
      let sidecarUnknownFields: Record<string, unknown> | null = null;
      // Project-storage migration stage 3: the just-parsed look's own
      // `fingerprint`/`photo` fields, seeding sidecarFingerprint/
      // sidecarPhotoAtOpen (see their own doc comments) — null for a
      // pre-stage-3 look, a brand-new photo, or a legacy adjacent sidecar
      // (which never carries either field).
      let sidecarFingerprint: string | null = null;
      let sidecarPhotoAtOpen: string | null = null;
      let usedSidecar = false;
      // Raw disk text this session is about to account for (hot-reload's
      // self-write-suppression baseline — see AppState.lastSidecarText's doc
      // comment). Recorded even when the parse below fails: the malformed
      // text IS what's on disk, so a future external change compares against
      // it too, not against nothing.
      let sidecarRawText: string | null = null;
      // Project-storage migration (stage 1): every interactive open resolves
      // to a project (activating/creating the quick project on demand) and
      // reads/writes that project's own looks/ — see AppState.currentLookPath
      // and AppState.project's own doc comments. `legacySidecarOnly` (CLI
      // internal calls only) bypasses all of this, keeping today's exact
      // adjacent-sidecar behavior (stage 2 note — see openImageByPath's own
      // doc comment on that option).
      let projectPatch: ActiveProject | null = null;
      let watchPath = path + SIDECAR_SUFFIX;
      let legacySidecarImportNotice: AppState['legacySidecarImportNotice'] = null;
      try {
        // skipSidecar (headless CLI's --preset path): behave as if nothing
        // were on disk at all, even when a sidecar genuinely exists — see
        // AppState.openImageByPath's doc comment.
        let sidecar: string | null;
        if (opts?.skipSidecar) {
          sidecar = null;
        } else if (opts?.legacySidecarOnly) {
          sidecar = await session.guard(window.silverbox.readSidecar(watchPath));
        } else if (opts?.cliProjectDir) {
          // `--project <dir>` (CLI tooling parity, stage 2): READ-ONLY
          // playlist lookup — see resolveCliProjectLook's own doc comment.
          const resolved = await session.guard(resolveCliProjectLook(path, opts.cliProjectDir));
          projectPatch = resolved.project;
          watchPath = resolved.lookPath;
          sidecar = await session.guard(window.silverbox.readSidecar(watchPath));
        } else {
          const { project, look } = await session.guard(ensureProjectAndAddPhoto(path));
          projectPatch = project;
          watchPath = `${project.dir}/looks/${look}`;
          sidecar = await session.guard(window.silverbox.readSidecar(watchPath));
          if (sidecar === null) {
            // No look for this photo yet in the active project — offer the
            // adjacent legacy sidecar (if any) as a one-click import rather
            // than silently reading it as live state (one source of truth
            // per photo — coupling point 7, project-storage.md's migration
            // section).
            const legacy = await session.guard(window.silverbox.readSidecar(path + SIDECAR_SUFFIX));
            if (legacy !== null) {
              legacySidecarImportNotice = { imagePath: path, sidecarPath: path + SIDECAR_SUFFIX, lookPath: watchPath };
            }
          }
        }
        sidecarRawText = sidecar;
        if (sidecar !== null) {
          // the sidecar file EXISTS — a parse failure here (unlike readSidecar
          // itself throwing, an I/O-level issue) means this build genuinely
          // cannot understand the document on disk, so guard it from ⌘S
          try {
            // Pass the decoded dims so a pre-v4 sidecar's mask/spot coords can
            // be migrated from the old output frame into anchor space (see
            // parseGraphDoc / anchorSpace.ts); identity-geometry docs no-op.
            const parsed = parseGraphDoc(sidecar, { width: image.width, height: image.height });
            graph = parsed.graph;
            sidecarCreatedAt = parsed.createdAt ?? null;
            sidecarRating = parsed.rating;
            sidecarFlag = parsed.flag ?? null;
            sidecarUnknownFields = parsed.unknown ?? null;
            sidecarFingerprint = parsed.fingerprint ?? null;
            sidecarPhotoAtOpen = parsed.photo ?? null;
            usedSidecar = true;
          } catch (err) {
            sidecarNotice = `sidecar ignored: ${err instanceof Error ? err.message : String(err)}`;
            sidecarUnreadable = true;
            console.warn(`ignoring unreadable sidecar for ${fileName}:`, err);
          }
        }
      } catch (err) {
        // A newest-open-wins bail-out from session.guard() above must reach
        // the OUTER catch (which checks session.stale() and returns
        // silently), not get swallowed here as an ordinary "sidecar ignored"
        // notice — see OpenSession.guard's doc comment on this exact hazard.
        if (err instanceof StaleOpenError) throw err;
        // Pre-existing gap (flagged by the OpenSession extraction, closed
        // here): a GENUINE readSidecar rejection used to continue to the
        // final commit with staleness unchecked — the one path where a stale
        // open could still clobber a newer one's state. Re-check explicitly.
        if (session.stale()) throw new StaleOpenError();
        sidecarNotice = `sidecar ignored: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`ignoring invalid sidecar for ${fileName}:`, err);
      }
      // Fresh-open default-look seeding (WB Kelvin resolution, embedded lens
      // profile auto-on, base curve + default sharpen/color-NR) — pure
      // helper, see its doc comment for the per-piece gating.
      const seeded = seedDefaultLook(graph, image, { usedSidecar, kind, testFlags: window.silverbox.testFlags });
      graph = seeded.graph;
      const wbModel = seeded.wbModel;
      // Linked-look validation at open (linked-looks-stage-d.md semantics
      // 5-belt/6/7): only a genuinely loaded sidecar could carry a `link` at
      // all (a fresh default doc never does), and only meaningful with a
      // resolved project (shared looks live inside one) — skip the extra
      // round trip otherwise. session.guard: a slower validation read must
      // not land after a newer open has already superseded this one.
      let sharedLookMissingNotice: { slug: string; message: string } | null = null;
      if (usedSidecar && projectPatch) {
        const validated = await session.guard(validatePhotoLinks(graph, projectPatch));
        graph = validated.graph;
        sharedLookMissingNotice = validated.missingNotice;
      }
      // node ids of the previous doc must never alias into stale shaders
      clearCustomShaderArtifacts();
      mirrorShaderArtifactClear();
      shaderEpoch++;
      // Per-node thumbnails/inspect mode (per-node-preview pack) never
      // survive an image switch: defaultGraphDoc()/a loaded sidecar reuse the
      // SAME node ids across different images ('in'/'dev'/'out'…), so a
      // node-existence check alone couldn't tell "still the same node" apart
      // from "coincidentally the same id, totally different image" — clear
      // both explicitly, revoking every blob: URL before dropping the map.
      clearNodeThumbs(get().nodeThumbs);
      // Image node (composite/mask-by-another-file feature): the main-thread
      // decode cache is keyed by raw path strings that mean nothing outside
      // THIS doc's own sidecar directory — clear it on every image switch
      // (same "never let stale per-photo state survive" rule nodeThumbs/
      // shader artifacts already follow above), and let the render worker's
      // own per-path caches clear themselves inside the 'image' command they
      // are about to receive (see graphRenderer.ts's setImage doc comment).
      clearImageNodeSourceCache();
      set({
        // Item F (decode-completion flash fix): the FIELD is cleared here as
        // always, but the blob: URL itself is deliberately NOT revoked at
        // this commit any more (contrast the other 3 clearOpeningPreview
        // call sites in this file, which still revoke immediately — an
        // abandoned/failed open has nothing left to hand off to). CanvasView
        // freezes this value the moment it sees it and keeps showing it
        // through its own `pendingSwitch` gate — revoking here, in the SAME
        // synchronous commit that flips `imageStatus` to 'ready', would hand
        // it a URL that's already dead for that entire gap. CanvasView's own
        // releaseOpeningPreviewUrl call (once the real frame actually
        // presents, or on unmount) is now the ONLY place this specific URL
        // gets revoked — logged into the same revokedOpeningPreviewUrls
        // ledger either way, so openingPreviewRevocationLog()'s contract is
        // unchanged for callers that don't care which path did it.
        openingPreview: null,
        imageStatus: 'ready',
        image,
        graph,
        graphDirty: false,
        // Filmstrip-always-visible (UX pack round 2, item B): ANY successful
        // photo open that resolved a project (every interactive open except
        // the CLI-internal branches above) activates/re-affirms it, so the
        // strip must show it — including a lone single-file open, which used
        // to clear `folderDir` to null a moment ago (line above,
        // `!opts?.keepFolderContext`) and never set it back. Superseding
        // that here means "no project active" is the only remaining case the
        // strip stays hidden for (folderDir's own doc comment has the full
        // rule).
        ...(projectPatch ? { project: projectPatch, folderDir: projectPatch.dir } : {}),
        currentLookPath: watchPath,
        legacySidecarImportNotice,
        selectedNodeId: null,
        nodeThumbs: {},
        imageNodeMissing: {},
        // Round-11 fix pack item 4: node ids are reused across different
        // images (defaultGraphDoc()/a loaded sidecar both reuse 'in'/'dev'/
        // 'out'…), so a stale source-file thumbnail keyed by THIS image's
        // node ids must not survive into the next — same rule nodeThumbs
        // just above already follows. No URL to revoke (see the field's own
        // doc comment); the fresh doc's own image nodes get resynced by
        // CanvasView's effect once it re-runs against the new `graph`.
        imageNodeSourceThumbs: {},
        inspectNodeId: null,
        // Global undo (docs/brief-bank/global-undo.md): deliberately NOT
        // reset here — `undoStack` is the store's ONE global timeline, not
        // per-photo state; entries for whatever photo was open before this
        // switch (or a jump-undo's own target) must survive it. This is the
        // one field of this whole commit that this open must NEVER touch.
        shaderErrors: {},
        sidecarNotice,
        sidecarUnreadable,
        sidecarCreatedAt,
        sidecarRating,
        sidecarFlag,
        sidecarUnknownFields,
        sidecarFingerprint,
        sidecarPhotoAtOpen,
        lastSidecarText: sidecarRawText,
        sidecarHotReloadNotice: null,
        sidecarDiffDialog: null,
        // semantic 7: a missing linked look's notice, if validatePhotoLinks
        // found one above — null (cleared) otherwise, same "every open
        // resets this" rule sidecarHotReloadNotice already follows.
        sharedLookHotReloadNotice: sharedLookMissingNotice
          ? { kind: 'missing' as const, slug: sharedLookMissingNotice.slug, message: sharedLookMissingNotice.message }
          : null,
        exportInfo: null,
        wbModel,
        activeOutputId: null,
        maskOverlay: false,
        cropMode: false,
        wbPicking: false,
        colorKeyPicking: false,
        spotMode: false,
        selectedSpotIndex: null,
        compareMode: false,
        compareOutputId: null,
        compareDocOverride: null,
      });
      revalidateShaders(graph);
      // DCP camera-profile mode (docs/brief-bank/dcp-profile.md): if the
      // opened graph's Develop node is configured for a DCP file (saved
      // sidecar state, or a hand-authored look), load+bake it now — fire-
      // and-forget like watchSidecar below; a no-op (source !== 'dcp') is
      // the overwhelming common case and returns immediately.
      void get().refreshDcpProfile();
      // Arm (re-arm) the main-process sidecar watcher for THIS image's
      // resolved look/sidecar path — see shared/ipc.ts's watchSidecar doc
      // comment. Fire-and-forget: a failure here just means no hot-reload
      // push for this image, not a broken open.
      void window.silverbox.watchSidecar(watchPath);
      // Item B (cont.): a photo that's brand new to the playlist (just added
      // by ensureProjectAndAddPhoto above) needs its OWN cell to actually
      // show up — folderEntries is otherwise only rebuilt by folder/project-
      // level operations (openFolder/openMultiDrop/openProjectByPath), never
      // by an ordinary single-photo open. Fire-and-forget, same as
      // watchSidecar above: refreshPlaylistStatus's own staleness guard
      // (`get().project !== project`) keeps a slower round trip from
      // clobbering a newer switch's state.
      if (projectPatch) void get().refreshPlaylistStatus();
    } catch (err) {
      // A stale open's failure — including StaleOpenError from
      // session.guard(), which by construction only throws once
      // session.stale() is true — must not clobber the newer open's state:
      // the newer call owns the UI from the moment it claimed the epoch.
      if (session.stale()) return;
      set({
        ...clearOpeningPreview(get()),
        imageStatus: 'error',
        image: null,
        imageError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async openImageViaDialog() {
    if (get().imageStatus === 'loading') return;
    const result = await window.silverbox.openImageDialog();
    if (result.canceled) return;
    // openImageByPath's own success commit sets folderDir to the resolved
    // project's directory regardless (item B) — nothing extra to do here.
    await get().openImageByPath(result.path);
  },

  async refreshPlaylistStatus() {
    const project = get().project;
    if (!project) return;
    const entries = await buildPlaylistEntries(project);
    if (get().project !== project) return; // superseded by a project/folder switch meanwhile
    // folderEntries' own "empty when folderDir is null" invariant (see its
    // doc comment) — only repaint the strip while one is actually showing;
    // the missing-CURRENT-photo check below runs regardless.
    if (get().folderDir !== null) set({ folderEntries: entries });
    const imagePath = get().imagePath;
    const currentEntry = imagePath ? entries.find((e) => e.path === imagePath) : undefined;
    if (currentEntry?.missing) {
      set({ currentPhotoMissingNotice: 'photo file is missing — relink from the filmstrip' });
    } else if (get().currentPhotoMissingNotice) {
      set({ currentPhotoMissingNotice: null });
    }
  },

  bumpLookVersion(paths) {
    if (paths.length === 0) return;
    set((s) => {
      const next = { ...s.lookVersions };
      for (const p of paths) next[p] = (next[p] ?? 0) + 1;
      return { lookVersions: next };
    });
  },

  async openFolder(dir: string) {
    // Project-storage migration (stage 1): "open a folder" now means EXTEND
    // the active project's playlist with this folder's images (create/
    // activate the quick project first if none) — listImages stays pure
    // enumeration (see its own doc comment), never itself the filmstrip's
    // data source anymore.
    let listed: FolderImageEntry[];
    try {
      listed = await window.silverbox.listImages(dir);
    } catch (err) {
      // Not a (readable) directory — the drop handler's own fallback treats
      // this as "not actually a folder drop" and opens it as a single file
      // instead; any other caller (toolbar dialog, __openFolderByPath) just
      // sees nothing happen.
      console.warn(`openFolder: could not list ${dir}:`, err);
      return false;
    }
    const project = await ensureActiveProject();
    // Same identity rule as ensureProjectAndAddPhoto (see findPlaylistPhoto)
    // — never re-add/re-derive a photo already on the playlist.
    const byAbsPath = new Map(project.photos.map((p) => [resolveProjectPath(project.dir, p.path), p.look]));
    let photos = project.photos;
    for (const entry of listed) {
      if (findPlaylistPhoto({ ...project, photos }, entry.path)) continue;
      const look = deriveLookName(entry.path, byAbsPath);
      byAbsPath.set(resolveProjectPath(project.dir, entry.path), look);
      photos = [...photos, { path: relativizeProjectPath(project.dir, entry.path), look }];
    }
    if (photos !== project.photos) set({ project: { ...project, photos } });
    // The filmstrip renders the project's WHOLE playlist (photos "from
    // anywhere" — filmstrip-curation.md), not just this folder's subset.
    const current = get().project ?? project;
    const entries = await buildPlaylistEntries(current);
    // A slower buildPlaylistEntries resolving after the project changed
    // again (or a newer openFolder/openProjectByPath call) meanwhile must
    // not clobber it.
    if (get().project !== current) return true;
    set({ folderDir: dir, folderEntries: entries });
    if (listed.length > 0) await get().openImageByPath(listed[0]!.path, { keepFolderContext: true });
    return true;
  },

  async openMultiDrop(paths: string[]) {
    if (paths.length === 0) return;
    // Project-wins detection (see this action's own interface doc comment
    // above): tried against EVERY dropped path, same basename-strip
    // openPathSmart (App.tsx) uses for a single dropped project.silverbox
    // file — the realistic case is a dropped FOLDER that already contains
    // one, which readProjectManifest handles directly (ENOTDIR/ENOENT both
    // read as "no project here", never a thrown error — see main/index.ts's
    // own doc comment on that handler; `.catch` here is defensive only).
    const projectDirCandidates = paths.map((p) =>
      p.split('/').pop() === PROJECT_MANIFEST_NAME ? p.slice(0, -(PROJECT_MANIFEST_NAME.length + 1)) : p
    );
    const manifestTexts = await Promise.all(
      projectDirCandidates.map((dir) => window.silverbox.readProjectManifest(dir).catch(() => null))
    );
    const projectIndex = manifestTexts.findIndex((text) => text !== null);
    if (projectIndex !== -1) {
      const opened = await get().openProjectByPath(projectDirCandidates[projectIndex]!);
      // A failed open already raised its own persistent error notice inside
      // openProjectByPath — nothing more to do either way: a mixed drop
      // resolves to "the project" (full stop) or errors outright, never a
      // partial fallback onto the other dropped paths as images.
      if (opened) {
        const ignored = paths.length - 1;
        if (ignored > 0) {
          raiseNotice('projectNotice', {
            kind: 'success',
            message: `Dropped project.silverbox opened — ${ignored} other dropped file${ignored === 1 ? '' : 's'} ignored.`,
          });
        }
      }
      return;
    }
    // No project among the dropped paths — every one of them is a photo:
    // add each to the active project's playlist (creating/activating the
    // quick project first if none is active — same as openFolder's own
    // rule, reusing ensureProjectAndAddPhoto's identity/dedup logic instead
    // of re-deriving it here).
    for (const path of paths) {
      await ensureProjectAndAddPhoto(path);
    }
    const project = get().project;
    if (!project) return; // defensive only — the loop above always sets one for a non-empty paths list
    const entries = await buildPlaylistEntries(project);
    // A slower buildPlaylistEntries resolving after the project changed
    // again meanwhile must not clobber it (openFolder's own guard, same
    // reasoning).
    if (get().project !== project) return;
    // folderDir gates the strip's visibility (App.tsx) and is Filmstrip's
    // remount key; there is no single "this folder" for a multi-drop, so
    // the ACTIVE PROJECT's own directory stands in for it, same as
    // openProjectByPath's own folderDir assignment just below.
    set({ folderDir: project.dir, folderEntries: entries });
    await get().openImageByPath(paths[0]!, { keepFolderContext: true });
  },

  async openProjectByPath(dir: string) {
    set({ projectNotice: null }); // a fresh attempt (including a retry) starts clean
    let text: string | null;
    try {
      text = await window.silverbox.readProjectManifest(dir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`openProjectByPath: could not read a project manifest at ${dir}:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `could not open project at ${dir}: ${message}` });
      return false;
    }
    if (text === null) return false;
    let manifest: ProjectManifest;
    try {
      manifest = parseProjectManifest(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`openProjectByPath: ignoring a malformed project manifest at ${dir}:`, err);
      raiseNotice('projectNotice', {
        kind: 'error',
        message: `project.silverbox at ${dir} is corrupt, not opened: ${message}`,
      });
      return false;
    }
    // Same flush-before-drop as openImageByPath's own cancelAutosaveTimer
    // call (conductor review finding, data loss) — a project switch is
    // itself a photo switch a moment later (this function goes on to open
    // the project's first playlist entry below), so the currently open
    // photo's pending edit belongs here just as much. `get()` here still
    // reads whatever was open before this project switch — nothing above
    // this line touches imagePath/graph/currentLookPath.
    //
    // AWAITED — unlike openImageByPath's own fire-and-forget flush.
    // captureGraphSaveSnapshot reads `project` to relativize the photo's
    // `photo` field, and `project` is reassigned a few lines below; the
    // nested `openImageByPath(first.path, ...)` call further down does its
    // OWN flush attempt too (same photo, unless this one already cleared
    // graphDirty). If that inner attempt fired WHILE this one was still
    // in flight, it would capture the NEW project reference and tag the OLD
    // project's own look file with the wrong project's `photo` value.
    // Awaiting here guarantees graphDirty is settled (false, or a genuine
    // write failure left it true and dirty on purpose) before `project` is
    // ever reassigned — project switches are rare/heavy already, so the
    // extra wait is negligible. No same-path hazard to guard here (unlike
    // openImageByPath): `currentLookPath` is project-scoped, so switching
    // projects always changes the look file even when the underlying photo
    // path happens to repeat across projects.
    await flushPendingAutosave(get());
    cancelAutosaveTimer();
    const project: ActiveProject = { dir, name: manifest.name, photos: manifest.photos, unknown: manifest.unknown ?? null };
    // sharedLookTexts is project-scoped (stage D's per-slug baseline cache) —
    // a fresh empty cache for the new project, same reset shared_Looks itself
    // already gets below.
    set({ project, folderDir: dir, folderEntries: [], sharedLookTexts: {}, sharedLookHotReloadNotice: null });
    // Stage D semantic 1: (re-)arm the main-process shared-looks watcher for
    // THIS project's shared-looks/ directory — fire-and-forget, same posture
    // as openImageByPath's own watchSidecar call.
    void window.silverbox.watchSharedLooks(dir);
    await get().refreshSharedLooks(); // linked-looks-stage-b.md: shared-looks/ is project-scoped
    void get().refreshRepairSheets(); // linked-looks-stage-f.md: repair-sheets/ is project-scoped, same refresh
    if (get().project !== project) return true; // superseded by a newer project/folder open meanwhile
    // Stage D semantic 5: drift-at-open — compare every known shared look's
    // current hash against every follower's materializedFrom BEFORE the
    // first photo opens, so that open sees already-caught-up looks (the
    // per-photo "belt" check in openImageByPath/validatePhotoLinks is the
    // redundant backstop for a photo opened directly, not the primary path).
    await checkSharedLookDriftAtOpen();
    if (get().project !== project) return true; // superseded while the drift scan was in flight
    // Captured BEFORE opening the first photo — openImageByPath's own commit
    // unconditionally resets sharedLookHotReloadNotice (same "cleared on
    // every image switch" rule sidecarHotReloadNotice already follows), which
    // would otherwise wipe out whatever checkSharedLookDriftAtOpen just
    // raised before it's ever paintable.
    const driftNotice = get().sharedLookHotReloadNotice;
    const entries = await buildPlaylistEntries(project);
    if (get().project !== project) return true; // superseded by a newer project/folder open meanwhile
    set({ folderEntries: entries });
    const first = entries.find((e) => !e.missing);
    if (first) await get().openImageByPath(first.path, { keepFolderContext: true });
    // Restore the drift notice UNLESS the just-opened photo raised its own
    // (a missing-look notice for THIS specific photo is more actionable than
    // an already-completed drift fan-out's transient confirmation).
    if (driftNotice && !get().sharedLookHotReloadNotice) set({ sharedLookHotReloadNotice: driftNotice });
    return true;
  },

  async newProject() {
    // Same flush-before-close as openProjectByPath's own AWAITED flush
    // (data-loss precedent) — closing the current project is itself a photo
    // switch a moment later (down to the empty state), so whatever's
    // pending belongs here just as much.
    await flushPendingAutosave(get());
    cancelAutosaveTimer();
    // Reset the per-session quick-project cache (ensureActiveProject's own
    // module-scope variable) — the NEXT photo open/drop that needs a quick
    // project mints a FRESH dated subdirectory instead of resuming this one.
    quickSessionDir = null;
    // Stage D: no project, nothing to watch (armSharedLooksWatch(null) just tears down).
    void window.silverbox.watchSharedLooks(null);
    set({
      ...emptyPhotoFields(),
      project: null,
      quickSessionDir: null,
      projectNotice: null,
      relinkMismatchNotice: null,
      legacySidecarImportNotice: null,
      folderDir: null,
      folderEntries: [],
      filmstripSelection: [],
      filmstripSelectionAnchor: null,
      sharedLooks: [], // linked-looks-stage-b.md: shared-looks/ is project-scoped, gone with the project
      sharedLookTexts: {}, // linked-looks-stage-d.md: same reset, per-slug baseline cache
      repairSheets: [], // linked-looks-stage-f.md: repair-sheets/ is project-scoped, gone with the project
    });
  },

  stepFilmstrip(delta) {
    const { folderDir, folderEntries, imagePath, imageStatus } = get();
    if (!folderDir || folderEntries.length === 0 || imageStatus === 'loading') return;
    const idx = folderEntries.findIndex((e) => e.path === imagePath);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= folderEntries.length) return;
    // The ⌘/⇧ multi-select is anchored to the CURRENT primary's context: a
    // plain cell click clears it before opening (Filmstrip.tsx), and an
    // arrow switch changes the primary the same way, so it must clear too —
    // leaving it alive across arrow switches would let ⌫ remove photos whose
    // selection highlight was no longer on screen.
    set({ filmstripSelection: [], filmstripSelectionAnchor: folderEntries[next]!.path });
    void get().openImageByPath(folderEntries[next]!.path, { keepFolderContext: true });
  },

  selectNode(id) {
    set({ selectedNodeId: id });
  },

  setNodeThumbs(thumbs) {
    set({ nodeThumbs: thumbs });
  },

  setInspectNode(id) {
    set((s) => (s.inspectNodeId === id ? {} : { inspectNodeId: id, ...(id !== null ? { compareMode: false } : {}) }));
  },

  // `key` is a flat param key for op nodes, or a dot path into the Develop
  // sections (e.g. 'basic.ev') for Develop nodes.
  updateNodeParam(nodeId, key, value) {
    set((s) => ({
      ...pushHistory(s, `param:${nodeId}:${key}`, { label: `Adjust ${key.split('.').pop()}` }),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          if (n.kind === DEVELOP_KIND) {
            const develop = structuredClone(n.develop ?? defaultDevelopParams());
            const parts = key.split('.');
            let obj = develop as unknown as Record<string, unknown>;
            for (const part of parts.slice(0, -1)) obj = obj[part] as Record<string, unknown>;
            obj[parts[parts.length - 1]!] = value;
            return forkLinkedFamilies({ ...n, develop }, [key]);
          }
          return { ...n, params: { ...n.params, [key]: value } };
        }),
      },
      graphDirty: true,
    }));
  },

  setDevelopBwEnabled(nodeId, enabled) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== DEVELOP_KIND) return {};
      const develop = structuredClone(node.develop ?? defaultDevelopParams());
      develop.bw.enabled = enabled;
      return {
        ...pushHistory(s, `param:${nodeId}:bw.enabled`, { label: 'Toggle black & white' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? forkLinkedFamilies({ ...n, develop }, ['bw.enabled']) : n)),
        },
        graphDirty: true,
      };
    });
  },

  toggleNodeDisabled(nodeId) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || !isBypassableNodeKind(node.kind)) return {};
      return {
        ...pushHistory(s, null, { label: 'Toggle bypass' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, disabled: n.disabled ? undefined : true } : n)),
        },
        graphDirty: true,
      };
    });
  },

  moveNode(nodeId, position) {
    set((s) => ({
      ...pushHistory(s, `move:${nodeId}`, { label: 'Move node' }),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      },
      graphDirty: true,
    }));
  },

  arrangeNodes(positions) {
    let moved = false;
    set((s) => {
      const target = s.imagePath;
      if (!target) return {};
      // 1px tolerance (brief): dagre's float output re-run on the SAME
      // structure is deterministic (nodeAutoLayout.test.ts), so a second
      // click after Arrange already ran only sees noise-level deltas, if any.
      const MOVE_EPS = 1;
      const before: Record<string, { x: number; y: number }> = {};
      const after: Record<string, { x: number; y: number }> = {};
      const nodes = s.graph.nodes.map((n) => {
        const next = positions[n.id];
        if (!next) return n;
        if (Math.abs(next.x - n.position.x) < MOVE_EPS && Math.abs(next.y - n.position.y) < MOVE_EPS) return n;
        before[n.id] = n.position;
        after[n.id] = next;
        return { ...n, position: next };
      });
      if (Object.keys(before).length === 0) return {}; // idempotent re-click — nothing moved, `moved` stays false
      moved = true;
      // Unlike a photo-edit entry (whose `after` is only knowable once the
      // mutation has actually landed, captured lazily on first undo — see
      // pushHistory's doc comment), Arrange's `after` is exactly `positions`
      // filtered to the moved subset: known synchronously right here, same
      // as a sync entry's before/after (undoStack.ts's SyncUndoEntry doc).
      const entry: ArrangeUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'arrange',
        label: 'Arrange nodes',
        target,
        before,
        after,
      };
      return { graph: { ...s.graph, nodes }, graphDirty: true, undoStack: pushUndoEntry(s.undoStack, entry) };
    });
    return moved;
  },

  // Insert before the ACTIVE output node; the new node takes the output's
  // spot and the output shifts right so the chain stays readable. A blend
  // node gets both inputs from the previous source (a self-blend is an
  // identity) — rewiring 'b' onto another branch is what makes it useful.
  // kind 'output' is special: multiple output nodes are legal (named
  // outputs, spec §6), so adding one never rewires anything — it lands
  // disconnected, ready to be wired up freely (see connectEdge).
  addOpNode(kind) {
    set((s) => {
      const g = s.graph;
      const outputs = g.nodes.filter((n) => n.kind === 'output');
      const out = (s.activeOutputId && outputs.find((n) => n.id === s.activeOutputId)) || outputs[0];
      if (!out) return {};

      if (kind === 'output') {
        const id = nextId(g, 'output');
        const node: GraphNode = { id, kind: 'output', position: { x: out.position.x, y: out.position.y + 140 } };
        return {
          ...pushHistory(s, null, { label: 'Add output node' }),
          graph: { ...g, nodes: [...g.nodes, node] },
          graphDirty: true,
          selectedNodeId: id,
        };
      }

      if (kind === IMAGE_KIND) {
        // Zero-input SOURCE (like 'input') — splicing it into the existing
        // input→output chain the way every other kind below does would
        // REPLACE the real photo with the referenced file, which is never
        // the point (the use case is compositing/masking WITH it, via a
        // blend's 'b'/'mask' port). Lands disconnected instead, same "wire
        // it up freely afterwards" treatment 'output' gets above.
        const id = nextId(g, 'image');
        const node: GraphNode = {
          id,
          kind: IMAGE_KIND,
          position: { x: out.position.x, y: out.position.y + 200 },
          image: defaultImageParams(),
        };
        return {
          ...pushHistory(s, null, { label: 'Add image node' }),
          graph: { ...g, nodes: [...g.nodes, node] },
          graphDirty: true,
          selectedNodeId: id,
        };
      }

      const inEdge = g.edges.find((e) => e.target === out.id);
      if (!inEdge) return {};
      const id = nextId(g, kind);
      // Fresh custom nodes are seeded with the engine-authored identity
      // artifact — known valid, no async validation round-trip needed.
      if (kind === CUSTOM_KIND) mirrorShaderArtifactSet(id, seedDefaultCustomShaderArtifact(id));
      let node: GraphNode;
      if (kind === CUSTOM_KIND) {
        node = { id, kind, position: { ...out.position }, shader: createDefaultCustomShaderParams() };
      } else if (kind === MASK_KIND) {
        node = { id, kind, position: { ...out.position }, mask: defaultMaskParams() };
      } else if (kind === SPOTS_KIND) {
        node = { id, kind, position: { ...out.position }, spots: defaultSpotsParams() };
      } else if (kind === EXTERNAL_KIND) {
        // Spliced into the chain like every other 1-in-1-out kind above (NOT
        // the disconnected-source treatment IMAGE_KIND gets) — an empty
        // command is identity (bit-exact pass-through), so adding one never
        // changes the render until the user actually types a command.
        node = { id, kind, position: { ...out.position }, external: defaultExternalParams() };
      } else if (kind === DENOISE_KIND) {
        // Spliced into the chain like every other 1-in-1-out kind (NOT the
        // disconnected-source treatment IMAGE_KIND gets) — strength 0 is
        // identity (bit-exact pass-through), so adding one never changes the
        // render until the user raises the strength slider.
        node = { id, kind, position: { ...out.position }, denoise: defaultDenoiseParams() };
      } else {
        // fresh WB atomics start at the image's as-shot values (= identity)
        const params =
          kind === 'whitebalance' ? { temp: s.wbModel.asShot.temp, tint: s.wbModel.asShot.tint } : defaultParams(kind);
        node = { id, kind, position: { ...out.position }, params };
      }
      const nodes = g.nodes
        .map((n) => (n.id === out.id ? { ...n, position: { x: n.position.x + 180, y: n.position.y } } : n))
        .concat(node);
      let scratch: GraphDoc = { ...g, nodes, edges: g.edges.filter((e) => e !== inEdge) };
      const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
        const edge = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
        scratch = { ...scratch, edges: [...scratch.edges, edge] };
      };
      if (kind === BLEND_KIND) {
        addEdge(inEdge.source, id, 'a');
        addEdge(inEdge.source, id, 'b');
      } else {
        addEdge(inEdge.source, id);
      }
      addEdge(id, out.id);
      return {
        ...pushHistory(s, null, { label: `Add ${kind} node` }),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: id,
      };
    });
  },

  removeOpNode(nodeId) {
    set((s) => {
      const g = s.graph;
      const node = g.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind === 'input') return {};
      if (node.kind === 'output') {
        // Named outputs (spec §6): deleting an output is legal while at least
        // one output REMAINS — a doc whose last output is gone couldn't
        // render or export anything. Outputs have no outgoing edges, so
        // there's nothing to bypass: drop the node and its feeding edge(s).
        const outputs = g.nodes.filter((n) => n.kind === 'output');
        if (outputs.length < 2) return {};
        return {
          ...pushHistory(s, null, { label: 'Remove output node' }),
          graph: {
            ...g,
            nodes: g.nodes.filter((n) => n.id !== nodeId),
            edges: g.edges.filter((e) => e.target !== nodeId),
          },
          graphDirty: true,
          selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
          // null falls back to the doc's first output everywhere activeOutputId is consumed
          activeOutputId: s.activeOutputId === nodeId ? null : s.activeOutputId,
          // null falls back to Mode A (before) — the compare strip's dropdown
          // just loses this option, same "graceful fallback" as activeOutputId
          compareOutputId: s.compareOutputId === nodeId ? null : s.compareOutputId,
          // Per-node-preview pack: prune this node's own thumbnail (revoking
          // its blob: URL) immediately rather than waiting for the next
          // debounced refresh, and exit inspect mode if it was targeting
          // exactly this node.
          nodeThumbs: pruneNodeThumb(s.nodeThumbs, nodeId),
          inspectNodeId: s.inspectNodeId === nodeId ? null : s.inspectNodeId,
        };
      }
      // bypass: route the node's input (blend: its 'a' input) to every target
      // it fed, preserving handles — EXCEPT a target's 'mask' port (masks
      // milestone): rewiring raw color into a blend's mask input would silently
      // reinterpret arbitrary color as a mask value, which is never what the
      // user wants. Deleting the node that fed a mask port instead just DROPS
      // that edge, so the blend falls back to its uniform factor (same as an
      // unmasked blend) — see graphDoc.ts's buildPlan blend branch.
      const incoming = g.edges.filter((e) => e.target === nodeId);
      const outgoing = g.edges.filter((e) => e.source === nodeId);
      const bypass =
        node.kind === BLEND_KIND ? incoming.find((e) => e.targetHandle === 'a')?.source : incoming[0]?.source;
      let scratch: GraphDoc = {
        ...g,
        nodes: g.nodes.filter((n) => n.id !== nodeId),
        edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      };
      if (bypass) {
        for (const e of outgoing) {
          if (e.targetHandle === 'mask') continue; // drop, don't rewire
          const edge = {
            id: nextId(scratch, 'e'),
            source: bypass,
            target: e.target,
            ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
          };
          scratch = { ...scratch, edges: [...scratch.edges, edge] };
        }
      }
      // Prune this node's own missing-file badge state (image node feature)
      // the same immediate way nodeThumbs is pruned above it, rather than
      // waiting for the next syncImageNodeSources pass to notice it's gone.
      const { [nodeId]: _pruned, ...imageNodeMissing } = s.imageNodeMissing;
      // Round-11 fix pack item 4: same immediate prune for the source-file
      // thumbnail fallback, in case a removed node was kind 'image'.
      const { [nodeId]: _prunedThumb, ...imageNodeSourceThumbs } = s.imageNodeSourceThumbs;
      return {
        ...pushHistory(s, null, { label: `Remove ${node.kind} node` }),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
        nodeThumbs: pruneNodeThumb(s.nodeThumbs, nodeId),
        imageNodeMissing,
        imageNodeSourceThumbs,
        inspectNodeId: s.inspectNodeId === nodeId ? null : s.inspectNodeId,
      };
    });
  },

  duplicateOutput() {
    set((s) => {
      const g = s.graph;
      const out = activeOutputNode(g, s.activeOutputId);
      if (!out) return {};
      const inputNode = g.nodes.find((n) => n.kind === 'input');

      // Everything upstream of the active output EXCEPT the doc's single
      // shared input node — every output's chain shares the one input/
      // geometry (setGeometry/setLens/computeOutputDims all assume exactly
      // one 'input' kind node), so it's never cloned; the clone reconnects
      // to the SAME input node below instead.
      const reach = reachableToOutput(g, out.id);
      const cloneIds = new Set(reach);
      cloneIds.delete(out.id);
      if (inputNode) cloneIds.delete(inputNode.id);
      if (cloneIds.size === 0) return {}; // nothing upstream to clone — shouldn't happen for any output with a real chain

      let scratch: GraphDoc = g;
      const idMap = new Map<string, string>();
      for (const n of g.nodes) {
        if (!cloneIds.has(n.id)) continue;
        // Same fresh-id scheme buildLocalAdjustmentPatch already uses for
        // its own dev/mask/blend triple (nextId keyed by the node's own
        // kind, 'dev' for Develop).
        const prefix = n.kind === DEVELOP_KIND ? 'dev' : n.kind;
        const freshId = nextId(scratch, prefix);
        idMap.set(n.id, freshId);
        const clone: GraphNode = {
          ...structuredClone(n),
          id: freshId,
          position: { x: n.position.x + 40, y: n.position.y + 220 },
        };
        scratch = { ...scratch, nodes: [...scratch.nodes, clone] };
      }

      const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
        const edge = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
        scratch = { ...scratch, edges: [...scratch.edges, edge] };
      };
      // Clone every edge strictly AMONG the cloned set 1:1; an edge feeding
      // the clone's root from OUTSIDE it (the shared input, or whatever else
      // the active chain actually starts from) reconnects to that SAME,
      // untouched source rather than a clone of it.
      for (const e of g.edges) {
        const tgtCloned = idMap.get(e.target);
        if (!tgtCloned) continue;
        const srcCloned = idMap.get(e.source);
        addEdge(srcCloned ?? e.source, tgtCloned, e.targetHandle);
      }

      const tailEdge = g.edges.find((e) => e.target === out.id);
      const tailId = tailEdge ? idMap.get(tailEdge.source) : undefined;
      if (!tailId) return {};

      // Name dedupe: same sanitize-and-suffix convention suffixExportPath/
      // slugifyPresetName already use (sanitizeToken) — here just a plain
      // "already taken" bump since output names aren't filesystem tokens.
      const baseName = `${outputName(out)} copy`;
      const existingNames = new Set(g.nodes.filter((n) => n.kind === 'output').map((n) => outputName(n)));
      let name = baseName;
      for (let i = 2; existingNames.has(name); i++) name = `${baseName} ${i}`;

      // Same outX + offset layout convention addOpNode's 'output' branch uses.
      const newOutId = nextId(scratch, 'output');
      const newOutNode: GraphNode = {
        id: newOutId,
        kind: 'output',
        position: { x: out.position.x, y: out.position.y + 140 },
        name,
      };
      scratch = { ...scratch, nodes: [...scratch.nodes, newOutNode] };
      addEdge(tailId, newOutId);

      return {
        ...pushHistory(s, null, { label: 'Duplicate output' }),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: newOutId,
        activeOutputId: newOutId,
      };
    });
  },

  connectNotice: null,
  graphBroken: false,

  connectEdge(source, target, targetHandle) {
    let rejected: string | null = null;
    set((s) => {
      const g = s.graph;
      const edges = g.edges.filter(
        (e) => !(e.target === target && (e.targetHandle ?? null) === (targetHandle ?? null))
      );
      const edge = {
        id: nextId({ ...g, edges }, 'e'),
        source,
        target,
        ...(targetHandle ? { targetHandle } : {}),
      };
      const graph = { ...g, edges: [...edges, edge] };
      try {
        buildPlan(graph); // reject cycles / invalid wiring outright
      } catch (err) {
        rejected = err instanceof Error ? err.message : String(err);
        return {};
      }
      return { ...pushHistory(s, null, { label: 'Connect nodes' }), graph, graphDirty: true, connectNotice: null };
    });
    if (rejected) {
      set({ connectNotice: rejected });
      setTimeout(() => {
        if (get().connectNotice === rejected) set({ connectNotice: null });
      }, 4000);
    }
  },

  removeEdge(edgeId) {
    set((s) => {
      if (!s.graph.edges.some((e) => e.id === edgeId)) return {};
      return {
        ...pushHistory(s, null, { label: 'Disconnect nodes' }),
        graph: { ...s.graph, edges: s.graph.edges.filter((e) => e.id !== edgeId) },
        graphDirty: true,
      };
    });
  },

  setGraphBroken(broken) {
    if (get().graphBroken !== broken) set({ graphBroken: broken });
  },

  setActiveOutputId(id) {
    set({ activeOutputId: id });
  },

  renameOutput(nodeId, name, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== 'output') return {};
      return {
        ...pushHistory(s, coalesceKey, { label: 'Rename output' }),
        graph: { ...s.graph, nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)) },
        graphDirty: true,
      };
    });
  },

  setExportOverrides(nodeId, overrides, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== 'output') return {};
      // sanitizeExportOverrides both validates and clamps (quality 1-100,
      // maxDim > 0 or null) — the same normalization a sidecar load applies,
      // so a value typed here round-trips identically through save/reload.
      const sanitized = sanitizeExportOverrides(overrides, nodeId);
      const nextExport = Object.keys(sanitized).length > 0 ? sanitized : undefined;
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit export settings' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, export: nextExport } : n)),
        },
        graphDirty: true,
      };
    });
  },

  setMaskShape(nodeId, shape, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== MASK_KIND) return {};
      const mask = node.mask ?? defaultMaskParams();
      const clamped = clampMaskShape(shape);
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit mask shape' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === nodeId ? { ...n, mask: { shapes: [clamped, ...mask.shapes.slice(1)] } } : n
          ),
        },
        graphDirty: true,
      };
    });
  },

  toggleMaskOverlay() {
    set((s) => ({ maskOverlay: !s.maskOverlay }));
  },

  setGpuError(message) {
    set((s) => (s.gpuError === message ? {} : { gpuError: message }));
  },

  // See the AppState doc comment: one undo entry builds Develop D (defaults)
  // + Mask M (default centered radial) + Blend B (a = the node currently
  // feeding the active output, b = D, mask = M), rewires the output to B,
  // and selects M.
  addLocalAdjustment() {
    set((s) => buildLocalAdjustmentPatch(s));
  },

  addLocalAdjustmentWithShape(shape) {
    set((s) => buildLocalAdjustmentPatch(s, shape));
  },

  setMaskDrawMode(mode) {
    set(mode !== null ? { maskDrawMode: mode, ...deactivateOtherTools('maskDraw') } : { maskDrawMode: null });
  },

  setSpotMode(active) {
    set((s) =>
      s.spotMode === active
        ? {}
        : active
          ? { spotMode: true, ...deactivateOtherTools('spot') }
          : { spotMode: false, selectedSpotIndex: null }
    );
  },

  setSelectedSpotIndex(index) {
    set({ selectedSpotIndex: index });
  },

  setSpotBrushRadius(radius) {
    set({ spotBrushRadius: Math.min(0.5, Math.max(0.002, radius)) });
  },

  commitSpot(dst, src, radius) {
    let capped = false;
    const spot = clampSpot({ dx: dst.x, dy: dst.y, sx: src.x, sy: src.y, radius, feather: 0.3 });
    set((s) => {
      const result = resolveSpotInsertion(s.graph, s.activeOutputId, spot);
      if (result === 'capped') {
        capped = true;
        return {};
      }
      if (result === null) return {};
      return {
        ...pushHistory(s, null, { label: 'Add spot' }),
        graph: result.graph,
        graphDirty: true,
        selectedNodeId: result.nodeId,
        selectedSpotIndex: result.spotIndex,
      };
    });
    if (capped) {
      const message = `spot cap reached (${SPOTS_CAP} max) — this spot was not added`;
      set({ spotsCapNotice: message });
      setTimeout(() => {
        if (get().spotsCapNotice === message) set({ spotsCapNotice: null });
      }, 4000);
    }
  },

  updateSpot(nodeId, index, patch, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== SPOTS_KIND) return {};
      const list = node.spots?.spots ?? [];
      const current = list[index];
      if (!current) return {};
      const next = clampSpot({ ...current, ...patch });
      return {
        ...pushHistory(s, coalesceKey, { label: 'Move spot' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === nodeId ? { ...n, spots: { spots: list.map((sp, i) => (i === index ? next : sp)) } } : n
          ),
        },
        graphDirty: true,
      };
    });
  },

  removeSpot(nodeId, index) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== SPOTS_KIND) return {};
      const list = node.spots?.spots ?? [];
      if (index < 0 || index >= list.length) return {};
      return {
        ...pushHistory(s, null, { label: 'Remove spot' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === nodeId ? { ...n, spots: { spots: list.filter((_, i) => i !== index) } } : n
          ),
        },
        graphDirty: true,
        selectedSpotIndex: null,
      };
    });
  },

  setSpots(nodeId, spots, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== SPOTS_KIND) return {};
      const clamped = spots.slice(0, SPOTS_CAP).map(clampSpot);
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit spots' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, spots: { spots: clamped } } : n)),
        },
        graphDirty: true,
      };
    });
  },

  shaderRev: 0,

  async applyShaderSource(nodeId, src) {
    await validateShaderSource(nodeId, src, { history: true });
  },

  setImagePath(nodeId, path, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== IMAGE_KIND) return {};
      return {
        ...pushHistory(s, coalesceKey, { label: 'Set image source' }),
        graph: { ...s.graph, nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, image: { path } } : n)) },
        graphDirty: true,
        // A path edit invalidates whatever "missing" verdict the OLD path
        // earned — imageNodeSource.ts's next syncImageNodeSources call (the
        // render effect the graph change itself triggers) re-settles it.
        imageNodeMissing: { ...s.imageNodeMissing, [nodeId]: false },
      };
    });
  },

  imageNodeMissing: {},
  setImageNodeMissing(nodeId, missing) {
    set((s) => (s.imageNodeMissing[nodeId] === missing ? {} : { imageNodeMissing: { ...s.imageNodeMissing, [nodeId]: missing } }));
  },

  imageNodeRev: 0,
  bumpImageNodeRev() {
    set((s) => ({ imageNodeRev: s.imageNodeRev + 1 }));
  },

  imageNodeSourceThumbs: {},
  setImageNodeSourceThumb(nodeId, url) {
    set((s) => (s.imageNodeSourceThumbs[nodeId] === url ? {} : { imageNodeSourceThumbs: { ...s.imageNodeSourceThumbs, [nodeId]: url } }));
  },
  clearImageNodeSourceThumb(nodeId) {
    set((s) => {
      if (!(nodeId in s.imageNodeSourceThumbs)) return {};
      const { [nodeId]: _dropped, ...rest } = s.imageNodeSourceThumbs;
      return { imageNodeSourceThumbs: rest };
    });
  },

  setExternalCommand(nodeId, command, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== EXTERNAL_KIND) return {};
      const prevEncoded = node.external?.encoded ?? defaultExternalParams().encoded;
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit external command' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, external: { command, encoded: prevEncoded } } : n)),
        },
        graphDirty: true,
        // A command edit is a NEW command — any stale "needs confirm"/error
        // state for the OLD one no longer applies (the render effect's next
        // pass will re-derive whatever the new command actually needs).
        externalNodeNeedsConfirm: { ...s.externalNodeNeedsConfirm, [nodeId]: undefined as unknown as string },
        externalNodeErrors: { ...s.externalNodeErrors, [nodeId]: undefined as unknown as string },
      };
    });
  },

  setExternalEncoded(nodeId, encoded) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== EXTERNAL_KIND) return {};
      const prevCommand = node.external?.command ?? '';
      return {
        ...pushHistory(s, null, { label: 'Edit external command' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, external: { command: prevCommand, encoded } } : n)),
        },
        graphDirty: true,
      };
    });
  },

  externalNodeNeedsConfirm: {},
  setExternalNodeNeedsConfirm(nodeId, command) {
    set((s) =>
      command === (s.externalNodeNeedsConfirm[nodeId] ?? null)
        ? {}
        : { externalNodeNeedsConfirm: { ...s.externalNodeNeedsConfirm, [nodeId]: command ?? (undefined as unknown as string) } }
    );
  },

  confirmExternalNode(nodeId) {
    const { imagePath, renderer, externalNodeNeedsConfirm } = get();
    const command = externalNodeNeedsConfirm[nodeId] ?? pendingExternalRequest(nodeId)?.command;
    if (!renderer || !command) return;
    const docKey = imagePath ?? 'unsaved';
    set((s) => ({ externalNodeNeedsConfirm: { ...s.externalNodeNeedsConfirm, [nodeId]: undefined as unknown as string } }));
    confirmAndRetry(
      nodeId,
      docKey,
      command,
      renderer,
      (startedNodeId) => {
        // A confirm-triggered retry is a fresh run — drop any stale error
        // badge from a PRIOR failed attempt so the spinner isn't fighting a
        // leftover ⚠ for priority (see NodeEditorPanel's badge ordering).
        get().setExternalNodeError(startedNodeId, null);
        get().setExternalNodeRunning(startedNodeId, true);
      },
      (settledNodeId, ok, error) => {
        get().setExternalNodeRunning(settledNodeId, false);
        get().setExternalNodeError(settledNodeId, ok ? null : (error ?? 'unknown error'));
        get().bumpExternalNodeRev();
      }
    );
  },

  externalNodeErrors: {},
  setExternalNodeError(nodeId, error) {
    set((s) =>
      error === (s.externalNodeErrors[nodeId] ?? null)
        ? {}
        : { externalNodeErrors: { ...s.externalNodeErrors, [nodeId]: error ?? (undefined as unknown as string) } }
    );
  },

  externalNodeRunning: {},
  setExternalNodeRunning(nodeId, running) {
    set((s) =>
      running === (s.externalNodeRunning[nodeId] ?? false)
        ? {}
        : { externalNodeRunning: { ...s.externalNodeRunning, [nodeId]: running || (undefined as unknown as boolean) } }
    );
  },

  externalNodeRev: 0,
  bumpExternalNodeRev() {
    set((s) => ({ externalNodeRev: s.externalNodeRev + 1 }));
  },

  // --- In-engine ML denoise (denoise v2, stage 1) ----------------------------
  setDenoiseStrength(nodeId, strength, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== DENOISE_KIND) return {};
      return {
        ...pushHistory(s, coalesceKey, { label: 'Adjust denoise strength' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, denoise: { strength } } : n)),
        },
        graphDirty: true,
      };
    });
  },

  denoiseNodeNeedsConsent: {},
  setDenoiseNodeNeedsConsent(nodeId, needsConsent) {
    set((s) =>
      needsConsent === (s.denoiseNodeNeedsConsent[nodeId] ?? false)
        ? {}
        : { denoiseNodeNeedsConsent: { ...s.denoiseNodeNeedsConsent, [nodeId]: needsConsent || (undefined as unknown as boolean) } }
    );
  },

  async consentDenoiseModel(nodeId) {
    const { renderer } = get();
    if (!renderer) return;
    // Persisted, install-wide consent (Settings.denoiseModelConsent's doc
    // comment) — main (denoiseModel.ts) is the actual security gate and
    // re-reads this itself; this just unblocks the retry below.
    await get().updateSettings({ denoiseModelConsent: true });
    set((s) => ({ denoiseNodeNeedsConsent: { ...s.denoiseNodeNeedsConsent, [nodeId]: undefined as unknown as boolean } }));
    retryPendingDenoise(
      nodeId,
      renderer,
      (startedNodeId) => {
        get().setDenoiseNodeError(startedNodeId, null);
        get().setDenoiseNodeRunning(startedNodeId, true);
      },
      (settledNodeId, ok, error) => {
        get().setDenoiseNodeRunning(settledNodeId, false);
        get().setDenoiseNodeError(settledNodeId, ok ? null : (error ?? 'unknown error'));
        get().bumpDenoiseNodeRev();
      }
    );
  },

  denoiseNodeErrors: {},
  setDenoiseNodeError(nodeId, error) {
    set((s) =>
      error === (s.denoiseNodeErrors[nodeId] ?? null)
        ? {}
        : { denoiseNodeErrors: { ...s.denoiseNodeErrors, [nodeId]: error ?? (undefined as unknown as string) } }
    );
  },

  denoiseNodeRunning: {},
  setDenoiseNodeRunning(nodeId, running) {
    set((s) =>
      running === (s.denoiseNodeRunning[nodeId] ?? false)
        ? {}
        : { denoiseNodeRunning: { ...s.denoiseNodeRunning, [nodeId]: running || (undefined as unknown as boolean) } }
    );
  },

  denoiseNodeRev: 0,
  bumpDenoiseNodeRev() {
    set((s) => ({ denoiseNodeRev: s.denoiseNodeRev + 1 }));
  },

  // --- DCP camera-profile mode (docs/brief-bank/dcp-profile.md, stage 1) -----
  dcpProfileStatus: 'idle',
  dcpProfileError: null,
  dcpProfileRev: 0,
  async refreshDcpProfile() {
    const { graph, wbModel } = get();
    const devNode = graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.develop);
    const profile = devNode?.develop?.profile;
    if (!profile || profileSource(profile) !== 'dcp' || !profile.dcpPath) {
      mirrorDcpLattice(null);
      set((s) => ({ dcpProfileStatus: 'idle', dcpProfileError: null, dcpProfileRev: s.dcpProfileRev + 1 }));
      return;
    }
    const nodeId = devNode!.id; // devNode is defined here (the guard above returns when it isn't)
    set({ dcpProfileStatus: 'loading', dcpProfileError: null });
    try {
      const buf = await window.silverbox.readFile(profile.dcpPath);
      const parsed = parseDcp(buf, profile.dcpPath);
      // camXyz/rgbCam are the SAME matrices whiteBalance.ts carries for its own
      // WB math (see WbModel.camXyz / WbModel.rgbCam's doc comments) — cast
      // past the two modules' independently-typed (but shape-identical) 3×3
      // matrix aliases. cameraFromWorkingMatrix picks the exact rgb_cam route
      // when the decoder exposed one, else the camXyz approximation.
      const cameraFromWorking = cameraFromWorkingMatrix(
        wbModel.rgbCam as unknown as DcpMat3 | null,
        wbModel.camXyz as unknown as DcpMat3
      );
      const lattice = bakeDcpLattice(parsed, cameraFromWorking, wbModel.asShot.temp, PROFILE_LATTICE_N);
      mirrorDcpLattice(lattice);
      set((s) => ({ dcpProfileStatus: 'ready', dcpProfileError: null, dcpProfileRev: s.dcpProfileRev + 1 }));
      // DCP double-tone fix (docs/brief-bank/dcp-double-tone-fix.md, option a').
      // bakeDcpLattice above bakes the DCP's OWN ProfileToneCurve INTO the
      // lattice, so the fresh-open base curve seeded into toneCurve.rgb
      // (seedDefaultLook) would apply tone a SECOND time. When the active DCP
      // carries a tone curve AND toneCurve.rgb is still EXACTLY the untouched
      // seed for this photo's camera, flatten the master curve to identity so
      // the DCP's tone is the only tone (one undoable step + a notice). Three
      // guards, each load-bearing:
      //   1. hasToneCurve — a tone-LESS DCP provides COLOR only; its base
      //      curve is the sole tone and MUST stay (flattening it renders flat).
      //   2. equals-the-seed — never clobber a curve the user edited themselves.
      //   3. only toneCurve.rgb (the master) — r/g/b channel curves are untouched.
      // Switching back to builtin leaves the curve flat (documented posture —
      // we deliberately keep no "was-this-our-flatten?" state to re-seed from).
      // Reached by BOTH trigger paths (setDevelopProfileSource on a photo with
      // a dcpPath already set, and setDevelopProfileDcpPath followed by the
      // source→dcp switch): they both route through this refreshDcpProfile bake.
      if (parsed.toneCurve != null) {
        const cameraModel = get().image?.capture?.cameraModel ?? null;
        const seed = baseCurveForModel(cameraModel);
        const node = get().graph.nodes.find((n) => n.id === nodeId);
        const isUntouchedSeed =
          node?.kind === DEVELOP_KIND && node.develop != null && curvePointsEqual(node.develop.toneCurve.rgb, seed);
        if (isUntouchedSeed) {
          set((s) => ({
            ...pushHistory(s, null, { label: 'Flatten tone curve for DCP profile' }),
            graph: {
              ...s.graph,
              nodes: s.graph.nodes.map((n) => {
                if (n.id !== nodeId || n.kind !== DEVELOP_KIND || !n.develop) return n;
                const develop = { ...n.develop, toneCurve: { ...n.develop.toneCurve, rgb: identityCurvePoints() } };
                return forkLinkedFamilies({ ...n, develop }, ['toneCurve.rgb']);
              }),
            },
            graphDirty: true,
          }));
          raiseNotice('projectNotice', {
            kind: 'success',
            message: 'DCPプロファイルのトーンカーブを使用中 — 写真側のトーンカーブはフラットにしました（元に戻すには ⌘Z）',
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mirrorDcpLattice(null);
      set((s) => ({ dcpProfileStatus: 'error', dcpProfileError: message, dcpProfileRev: s.dcpProfileRev + 1 }));
    }
  },
  setDevelopProfileSource(nodeId, source) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== DEVELOP_KIND) return {};
      const develop = structuredClone(node.develop ?? defaultDevelopParams());
      develop.profile.source = source;
      return {
        ...pushHistory(s, `param:${nodeId}:profile.source`, { label: 'Switch profile source' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? forkLinkedFamilies({ ...n, develop }, ['profile.source']) : n)),
        },
        graphDirty: true,
      };
    });
    void get().refreshDcpProfile();
  },
  setDevelopProfileDcpPath(nodeId, dcpPath) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== DEVELOP_KIND) return {};
      const develop = structuredClone(node.develop ?? defaultDevelopParams());
      develop.profile.dcpPath = dcpPath;
      return {
        ...pushHistory(s, `param:${nodeId}:profile.dcpPath`, { label: 'Choose DCP file' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === nodeId ? forkLinkedFamilies({ ...n, develop }, ['profile.dcpPath']) : n)),
        },
        graphDirty: true,
      };
    });
    void get().refreshDcpProfile();
  },

  updateNodeParamsBatch(nodeId, entries, coalesceKey) {
    set((s) => ({
      ...pushHistory(s, coalesceKey, { label: 'Adjust develop' }),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => {
          if (n.id !== nodeId || n.kind !== DEVELOP_KIND) return n;
          const develop = structuredClone(n.develop ?? defaultDevelopParams());
          for (const [key, value] of entries) {
            const parts = key.split('.');
            let obj = develop as unknown as Record<string, unknown>;
            for (const part of parts.slice(0, -1)) obj = obj[part] as Record<string, unknown>;
            obj[parts[parts.length - 1]!] = value;
          }
          return forkLinkedFamilies({ ...n, develop }, entries.map(([key]) => key));
        }),
      },
      graphDirty: true,
    }));
  },

  setToneCurvePoints(nodeId, channel, points, session) {
    const sanitized = sanitizeCurvePoints(points);
    if (!sanitized) return;
    set((s) => ({
      ...pushHistory(s, `curve:${nodeId}:${channel}:${session}`, { label: `Edit tone curve (${channel})` }),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => {
          if (n.id !== nodeId || n.kind !== DEVELOP_KIND) return n;
          const develop = n.develop ?? defaultDevelopParams();
          return forkLinkedFamilies(
            { ...n, develop: { ...develop, toneCurve: { ...develop.toneCurve, [channel]: sanitized } } },
            [`toneCurve.${channel}`]
          );
        }),
      },
      graphDirty: true,
    }));
  },

  addShaderParam(nodeId, def) {
    const shader = getShader(get().graph, nodeId);
    if (!shader) return 'no such shader node';
    if (!WGSL_IDENT_RE.test(def.name)) return `"${def.name}" is not a valid WGSL identifier`;
    if (shader.params.some((p) => p.name === def.name)) return `param "${def.name}" already exists`;
    if (![def.min, def.max, def.default].every(Number.isFinite) || def.min > def.max) return 'invalid range';
    set((s) => ({
      ...pushHistory(s, null, { label: 'Add shader parameter' }),
      graph: withShader(s.graph, nodeId, (p) => ({
        ...p,
        params: [...p.params, { ...def, value: def.default }],
      })),
      graphDirty: true,
    }));
    // the uniform struct changed — recompile the current editing source
    const code = getShader(get().graph, nodeId)?.code;
    if (code) void validateShaderSource(nodeId, code.src, { history: false });
    return null;
  },

  removeShaderParam(nodeId, name) {
    if (!getShader(get().graph, nodeId)) return;
    set((s) => ({
      ...pushHistory(s, null, { label: 'Remove shader parameter' }),
      graph: withShader(s.graph, nodeId, (p) => ({ ...p, params: p.params.filter((x) => x.name !== name) })),
      graphDirty: true,
    }));
    const code = getShader(get().graph, nodeId)?.code;
    if (code) void validateShaderSource(nodeId, code.src, { history: false });
  },

  updateShaderParam(nodeId, name, value) {
    set((s) => ({
      ...pushHistory(s, `shaderparam:${nodeId}:${name}`, { label: `Adjust shader parameter "${name}"` }),
      graph: withShader(s.graph, nodeId, (p) => ({
        ...p,
        params: p.params.map((x) => (x.name === name ? { ...x, value } : x)),
      })),
      graphDirty: true,
    }));
  },

  async undo() {
    const entry = peekUndo(get().undoStack);
    if (!entry) return;
    switch (entry.kind) {
      case 'photo-edit':
      case 'preset-apply':
      case 'develop-reset':
      case 'reset-all': {
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('undo', entry.label, entry.target);
          return;
        }
        // Current graph == this entry's `after` (LIFO invariant — see
        // undoStack.ts's file doc comment): nothing else could have touched
        // this same photo without ITSELF being a later, still-undone entry.
        const after = get().graph;
        set((s) => ({
          graph: entry.before,
          graphDirty: true,
          selectedNodeId: entry.before.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
          // a jump (or just a different graph) can change/shorten any spots
          // node's list — a stale index would point at the wrong spot or past the end
          selectedSpotIndex: null,
          undoStack: moveTopToRedo(s.undoStack, { ...entry, after }),
        }));
        // a jump may restore shader sources whose artifacts are stale
        shaderEpoch++;
        revalidateShaders(get().graph);
        return;
      }
      case 'rating': {
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('undo', entry.label, entry.target);
          return;
        }
        const after = get().sidecarRating;
        set((s) => ({ sidecarRating: entry.before, graphDirty: true, undoStack: moveTopToRedo(s.undoStack, { ...entry, after }) }));
        return;
      }
      case 'flag': {
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('undo', entry.label, entry.target);
          return;
        }
        const after = get().sidecarFlag;
        set((s) => ({ sidecarFlag: entry.before, graphDirty: true, undoStack: moveTopToRedo(s.undoStack, { ...entry, after }) }));
        return;
      }
      case 'sync': {
        const result = await applySyncEntryGraphs(entry.targets, entry.before);
        if (!result.ok) {
          blockUndoRedo('undo', entry.label, result.failedTarget);
          return;
        }
        set((s) => ({ undoStack: moveTopToRedo(s.undoStack, entry) }));
        // Not a JUMP (decision 1's BATCH carve-out: no single photo to show)
        // — but if the CURRENTLY open photo happens to be one of the
        // targets (e.g. the user opened it via the filmstrip sometime after
        // the sync ran), its in-memory graph would otherwise silently
        // diverge from the look file just reverted on disk. Re-opening the
        // SAME path (no navigation, nothing new becomes visible) keeps
        // memory and disk consistent for that one edge case.
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        return;
      }
      case 'arrange': {
        // "Jump semantics don't apply — arrange is always on the OPEN
        // photo's doc" (node-editor-ux.md): still runs through the same
        // ensurePhotoOpenForUndo/blockUndoRedo machinery as every other
        // single-photo entry for the (rare) case a LATER entry for a
        // DIFFERENT photo was undone first and this Arrange entry's photo
        // is consequently not the one currently open — it's a no-op whenever
        // that photo already is.
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('undo', entry.label, entry.target);
          return;
        }
        set((s) => ({
          graph: {
            ...s.graph,
            nodes: s.graph.nodes.map((n) => (entry.before[n.id] ? { ...n, position: entry.before[n.id]! } : n)),
          },
          graphDirty: true,
          undoStack: moveTopToRedo(s.undoStack, entry),
        }));
        return;
      }
      case 'remove-photos': {
        // Batch, no single photo to jump to (SyncUndoEntry's own shape) — the
        // project itself has to still be the SAME one this removal happened
        // against, or there is nothing coherent to splice the rows back into.
        const project = get().project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not undo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        let photos = [...project.photos];
        for (const { index, photo } of [...entry.removed].sort((a, b) => a.index - b.index)) {
          const at = Math.min(index, photos.length);
          photos = [...photos.slice(0, at), photo, ...photos.slice(at)];
        }
        set((s) => ({
          project: { ...project, photos },
          undoStack: moveTopToRedo(s.undoStack, entry),
        }));
        await get().refreshPlaylistStatus();
        return;
      }
      case 'delete-shared-look': {
        // Same "project must still be the SAME one" guard as remove-photos
        // above. The FILE is restored FIRST (conductor review finding —
        // DeleteSharedLookUndoEntry's own doc comment): a follower's `link`
        // must never end up pointing at a missing file, even transiently.
        const project = get().project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not undo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        await window.silverbox.sharedLookWrite(entry.projectDir, entry.slug, entry.lookText);
        // Stage D echo suppression (linked-looks-stage-d.md semantic 2): this
        // write, like any app-side shared-look write, will echo back through
        // the shared-looks watch — prime the baseline now so that echo
        // compares equal and is ignored, not misread as a genuine external
        // change.
        set((s) => ({ sharedLookTexts: { ...s.sharedLookTexts, [entry.slug]: entry.lookText } }));
        if (entry.targets.length > 0) {
          const result = await applySyncEntryGraphs(entry.targets, entry.before);
          if (!result.ok) {
            blockUndoRedo('undo', entry.label, result.failedTarget);
            return;
          }
        }
        await get().refreshSharedLooks();
        set((s) => ({ undoStack: moveTopToRedo(s.undoStack, entry) }));
        // Same "currently open follower" resync as the 'sync' case above.
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        if (entry.targets.length > 0) await get().refreshPlaylistStatus();
        return;
      }
      case 'publish': {
        // Same "project must still be the SAME one" guard, and the SAME
        // "file first" order as delete-shared-look's own undo, exactly per
        // the brief (PublishUndoEntry's own doc comment): the shared-look
        // FILE is restored to `lookTextBefore` FIRST, then every follower's
        // `before` graph.
        const project = get().project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not undo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        await window.silverbox.sharedLookWrite(entry.projectDir, entry.slug, entry.lookTextBefore);
        // Stage D echo suppression — same reasoning as delete-shared-look's own undo above.
        set((s) => ({ sharedLookTexts: { ...s.sharedLookTexts, [entry.slug]: entry.lookTextBefore } }));
        const result = await applySyncEntryGraphs(entry.targets, entry.before);
        if (!result.ok) {
          blockUndoRedo('undo', entry.label, result.failedTarget);
          return;
        }
        await get().refreshSharedLooks();
        set((s) => ({ undoStack: moveTopToRedo(s.undoStack, entry) }));
        // Same "currently open follower" resync as the 'sync'/
        // 'delete-shared-look' cases above.
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        await get().refreshPlaylistStatus();
        return;
      }
    }
  },

  async redo() {
    const entry = peekRedo(get().undoStack);
    if (!entry) return;
    switch (entry.kind) {
      case 'photo-edit':
      case 'preset-apply':
      case 'develop-reset':
      case 'reset-all': {
        if (entry.after === undefined) return; // defensive: undo() always populates `after` before an entry reaches the redo stack
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('redo', entry.label, entry.target);
          return;
        }
        const after = entry.after;
        set((s) => ({
          graph: after,
          graphDirty: true,
          selectedNodeId: after.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
          selectedSpotIndex: null,
          undoStack: moveTopToUndo(s.undoStack, entry),
        }));
        shaderEpoch++;
        revalidateShaders(get().graph);
        return;
      }
      case 'rating': {
        if (entry.after === undefined) return;
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('redo', entry.label, entry.target);
          return;
        }
        set((s) => ({ sidecarRating: entry.after!, graphDirty: true, undoStack: moveTopToUndo(s.undoStack, entry) }));
        return;
      }
      case 'flag': {
        if (entry.after === undefined) return;
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('redo', entry.label, entry.target);
          return;
        }
        set((s) => ({ sidecarFlag: entry.after ?? null, graphDirty: true, undoStack: moveTopToUndo(s.undoStack, entry) }));
        return;
      }
      case 'sync': {
        if (entry.after === undefined) return; // defensive: every 'sync'-kind writer populates `after` eagerly (unlike photo-edit entries, both sides are known synchronously at push time)
        const result = await applySyncEntryGraphs(entry.targets, entry.after);
        if (!result.ok) {
          blockUndoRedo('redo', entry.label, result.failedTarget);
          return;
        }
        set((s) => ({ undoStack: moveTopToUndo(s.undoStack, entry) }));
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        return;
      }
      case 'arrange': {
        if (entry.after === undefined) return; // defensive: arrangeNodes always populates `after` eagerly (both sides known synchronously at push time, like a sync entry)
        if (!(await ensurePhotoOpenForUndo(entry.target))) {
          blockUndoRedo('redo', entry.label, entry.target);
          return;
        }
        const after = entry.after;
        set((s) => ({
          graph: {
            ...s.graph,
            nodes: s.graph.nodes.map((n) => (after[n.id] ? { ...n, position: after[n.id]! } : n)),
          },
          graphDirty: true,
          undoStack: moveTopToUndo(s.undoStack, entry),
        }));
        return;
      }
      case 'remove-photos': {
        const before = get();
        const project = before.project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not redo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        const removedLooks = new Set(entry.removed.map((r) => r.photo.look));
        const removedPaths = new Set(entry.removed.map((r) => resolveProjectPath(project.dir, r.photo.path)));
        const photos = project.photos.filter((p) => !removedLooks.has(p.look));
        const priorFolderEntries = before.folderEntries;
        set((s) => ({
          project: { ...project, photos },
          undoStack: moveTopToUndo(s.undoStack, entry),
        }));
        // Same "reopened one of these since the removal, redo must move the
        // canvas off it" handling removeFromProject itself does — the user
        // may have undone this exact removal and reopened one of the
        // restored photos before pressing redo.
        if (before.imagePath && removedPaths.has(before.imagePath)) {
          const idx = priorFolderEntries.findIndex((e) => e.path === before.imagePath);
          let neighbor: string | null = null;
          for (let d = 1; idx !== -1 && d < priorFolderEntries.length && neighbor === null; d++) {
            const after = priorFolderEntries[idx + d];
            if (after && !removedPaths.has(after.path)) {
              neighbor = after.path;
              break;
            }
            const beforeEntry = priorFolderEntries[idx - d];
            if (beforeEntry && !removedPaths.has(beforeEntry.path)) {
              neighbor = beforeEntry.path;
              break;
            }
          }
          if (neighbor) {
            await get().openImageByPath(neighbor, { keepFolderContext: true });
          } else {
            await flushPendingAutosave(get());
            cancelAutosaveTimer();
            set(emptyPhotoFields());
          }
        }
        await get().refreshPlaylistStatus();
        return;
      }
      case 'delete-shared-look': {
        if (entry.after === undefined) return; // defensive: deleteSharedLook always populates `after` eagerly (both sides known synchronously at push time, like a sync entry)
        const project = get().project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not redo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        if (entry.targets.length > 0) {
          const result = await applySyncEntryGraphs(entry.targets, entry.after);
          if (!result.ok) {
            blockUndoRedo('redo', entry.label, result.failedTarget);
            return;
          }
        }
        // Strip the followers' links FIRST, then delete the file — the
        // mirror order of undo's own "restore file first" (no window where
        // a follower's link points at a file the delete hasn't reached yet
        // in either direction).
        await window.silverbox.sharedLookDelete(entry.projectDir, entry.slug);
        // Stage D: nothing left on disk — drop the baseline cache entry (same as deleteSharedLook's own action-side handling).
        set((s) => {
          const { [entry.slug]: _dropped, ...rest } = s.sharedLookTexts;
          return { sharedLookTexts: rest };
        });
        await get().refreshSharedLooks();
        set((s) => ({ undoStack: moveTopToUndo(s.undoStack, entry) }));
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        if (entry.targets.length > 0) await get().refreshPlaylistStatus();
        return;
      }
      case 'publish': {
        if (entry.after === undefined) return; // defensive: publishToSharedLook always populates `after` eagerly (both sides known synchronously at push time, like a sync entry)
        const project = get().project;
        if (!project || project.dir !== entry.projectDir) {
          raiseNotice('projectNotice', {
            kind: 'error',
            message: `could not redo "${entry.label}" — the active project has changed since`,
          });
          return;
        }
        const result = await applySyncEntryGraphs(entry.targets, entry.after);
        if (!result.ok) {
          blockUndoRedo('redo', entry.label, result.failedTarget);
          return;
        }
        // Mirror order of undo's own "file first" (PublishUndoEntry's own
        // doc comment): every follower's `after` graph FIRST, then the
        // shared-look file's own `lookTextAfter` — the delete-shared-look
        // precedent's exact mirror-order shape.
        await window.silverbox.sharedLookWrite(entry.projectDir, entry.slug, entry.lookTextAfter);
        // Stage D echo suppression — same reasoning as the undo side above.
        set((s) => ({ sharedLookTexts: { ...s.sharedLookTexts, [entry.slug]: entry.lookTextAfter } }));
        await get().refreshSharedLooks();
        set((s) => ({ undoStack: moveTopToUndo(s.undoStack, entry) }));
        const openPath = get().imagePath;
        if (openPath && entry.targets.includes(openPath)) {
          await get().openImageByPath(openPath, { keepFolderContext: true });
        }
        await get().refreshPlaylistStatus();
        return;
      }
    }
  },

  setRenderer(renderer) {
    set({ renderer });
  },

  setViewportFitAnimated(fn) {
    set({ viewportFitAnimated: fn });
  },

  toggleBefore() {
    set((s) => ({ showBefore: !s.showBefore }));
  },

  toggleGrayscaleView() {
    set((s) => ({ grayscaleView: !s.grayscaleView }));
  },

  setCompareMode(active) {
    set((s) =>
      s.compareMode === active
        ? {}
        : active
          // Entering compare exits inspect mode (per-node-preview pack) — both
          // answer "what should the canvas show", and letting them stack would
          // mean two different "which node's result am I looking at" pickers
          // fighting over the one canvas.
          ? { compareMode: true, inspectNodeId: null, ...deactivateOtherTools('compare') }
          // Leaving compare mode (however it happened — the toolbar toggle,
          // 'C', or Escape) always drops any sidecar-diff compareDocOverride
          // too: it is only ever meaningful WHILE compare is on, and leaving
          // it set would silently resurrect the diff's pane B the next time
          // compare gets turned on for an unrelated reason.
          : { compareMode: false, compareDocOverride: null }
    );
  },

  setCompareOutputId(id) {
    set({ compareOutputId: id });
  },

  setCompareDocOverride(doc) {
    set({ compareDocOverride: doc });
  },

  toggleCropMode() {
    set((s) => (s.cropMode ? { cropMode: false } : { cropMode: true, ...deactivateOtherTools('crop') }));
  },

  setWbPicking(picking) {
    set(picking ? { wbPicking: true, ...deactivateOtherTools('wbPick') } : { wbPicking: false });
  },

  setColorKeyPicking(picking) {
    set(picking ? { colorKeyPicking: true, ...deactivateOtherTools('colorKeyPick') } : { colorKeyPicking: false });
  },

  copyDevelopSettings() {
    const { graph } = get();
    set({ developClipboard: structuredClone(captureLook(graph)) });
  },

  pasteDevelopSettings() {
    let nextGraph: GraphDoc | null = null;
    set((s) => {
      const clip = s.developClipboard;
      if (!clip) return {};
      const patch = applyLook(s, clip);
      nextGraph = patch.graph;
      return patch;
    });
    // node ids referenced by the pasted custom nodes need fresh compiled
    // artifacts in THIS session's cache (same as opening a doc with shaders)
    if (nextGraph) revalidateShaders(nextGraph);
  },

  resetAllEdits() {
    const s = get();
    if (s.imageStatus !== 'ready' || !s.image) return;
    const kind = isRawFileName(s.fileName ?? '') ? 'raw' : 'jpg';
    // The exact same two calls openImageByPath makes for a sidecar-less open
    // of this image: defaultGraphDoc() (its own `!sidecar` branch) through
    // seedDefaultLook with `usedSidecar: false` (its default-look gate) and
    // the real testFlags — see openImageByPath's own call for the precedent
    // this mirrors.
    const { graph } = seedDefaultLook(defaultGraphDoc(), s.image, {
      usedSidecar: false,
      kind,
      testFlags: window.silverbox.testFlags,
    });
    set((s2) => ({
      ...pushHistory(s2, null, { kind: 'reset-all', label: 'Reset all edits' }),
      graph,
      graphDirty: true,
      // Selection + modal tools, same fields deactivateOtherTools groups as
      // "one canvas tool at a time" — all off, none excepted.
      selectedNodeId: null,
      selectedSpotIndex: null,
      cropMode: false,
      spotMode: false,
      maskDrawMode: null,
      wbPicking: false,
      colorKeyPicking: false,
      compareMode: false,
      // rating (sidecarRating) is metadata about the PHOTO, not the look —
      // deliberately untouched, same as setRating's own contract.
    }));
    revalidateShaders(graph);
  },

  resetDevelopNode(nodeId) {
    const s = get();
    if (s.imageStatus !== 'ready' || !s.image) return;
    const target = s.graph.nodes.find((n) => n.id === nodeId);
    if (!target || target.kind !== DEVELOP_KIND) return;
    const kind = isRawFileName(s.fileName ?? '') ? 'raw' : 'jpg';
    // Same seeded-defaults source as resetAllEdits above (a fresh
    // defaultGraphDoc() through seedDefaultLook with usedSidecar:false, real
    // testFlags) — but only THIS node's develop params get lifted out of the
    // seeded graph and written onto the CURRENT graph's matching node; the
    // rest of the seeded graph (its own single 'dev'/'in'/'out' skeleton) is
    // discarded. If the doc has a second develop node, the seeded graph's
    // (only) develop node is still the right reset target — "fresh-open
    // defaults for a develop stage" doesn't depend on which node holds it.
    const { graph: seededGraph } = seedDefaultLook(defaultGraphDoc(), s.image, {
      usedSidecar: false,
      kind,
      testFlags: window.silverbox.testFlags,
    });
    const seededDevelop = seededGraph.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop;
    if (!seededDevelop) return;
    set((s2) => ({
      ...pushHistory(s2, null, { kind: 'develop-reset', label: 'Reset develop' }),
      graph: {
        ...s2.graph,
        nodes: s2.graph.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const reset = { ...n, develop: structuredClone(seededDevelop) };
          // A whole-node reset touches EVERY develop family at once —
          // fork-on-touch (semantic 4), scaled up: every currently-followed
          // family forks, same "metadata-only, same undo entry" rule.
          return n.link ? { ...reset, link: { ...n.link, follows: [] } } : reset;
        }),
      },
      graphDirty: true,
    }));
  },

  presets: [],

  async refreshPresets() {
    set({ presets: await window.silverbox.presetsList() });
  },

  async vendorPresetIntoProject(slug) {
    const project = get().project;
    if (!project) return;
    const text = await window.silverbox.presetRead(slug);
    if (text === null) {
      raiseNotice('projectNotice', { kind: 'error', message: `"${slug}" could not be read from the library` });
      return;
    }
    const sourceName = get().presets.find((p) => p.slug === slug)?.name ?? slug;
    const existing = await window.silverbox.sharedLooksList(project.dir);
    const taken = new Set(existing.map((p) => p.slug));
    let destSlug = slug;
    for (let n = 2; taken.has(destSlug); n++) destSlug = `${slug}-${n}`;
    await window.silverbox.sharedLookWrite(project.dir, destSlug, text);
    // Stage D echo suppression — same reasoning as createSharedLook's own priming.
    set((st) => ({ sharedLookTexts: { ...st.sharedLookTexts, [destSlug]: text } }));
    // shared-looks/ may not have existed yet for this project — the write
    // above is what just created it (own mkdir-before-write); harmless
    // no-op re-arm otherwise, same posture as createSharedLook's own re-arm.
    void window.silverbox.watchSharedLooks(project.dir);
    await get().refreshSharedLooks();
    raiseNotice('projectNotice', {
      kind: 'success',
      message:
        destSlug === slug
          ? `vendored "${sourceName}" into this project`
          : `vendored "${sourceName}" into this project as "${destSlug}" (name already used here)`,
    });
  },

  async publishSharedLookToLibrary(slug) {
    const project = get().project;
    if (!project) return;
    const text = await window.silverbox.sharedLookRead(project.dir, slug);
    if (text === null) {
      raiseNotice('projectNotice', { kind: 'error', message: `"${slug}" could not be read from this project's shared looks` });
      return;
    }
    const name = get().sharedLooks.find((p) => p.slug === slug)?.name ?? slug;
    await window.silverbox.presetWrite(slug, text);
    await get().refreshPresets();
    raiseNotice('projectNotice', { kind: 'success', message: `published "${name}" to the library` });
  },

  async importPresetFile() {
    const result = await window.silverbox.openLibraryImportDialog();
    if (result.canceled) return;
    const bytes = await window.silverbox.readFile(result.path);
    const text = new TextDecoder().decode(bytes);
    let name: string;
    try {
      name = parsePresetFile(text).name;
    } catch (err) {
      console.warn(`importPresetFile: "${result.fileName}" could not be parsed as a preset/look file:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `"${result.fileName}" is not a valid preset/look file — nothing imported` });
      return;
    }
    const baseSlug = slugifyPresetName(result.fileName.replace(/\.json$/i, ''));
    const existing = await window.silverbox.presetsList();
    const taken = new Set(existing.map((p) => p.slug));
    let slug = baseSlug;
    for (let n = 2; taken.has(slug); n++) slug = `${baseSlug}-${n}`;
    await window.silverbox.presetWrite(slug, text);
    await get().refreshPresets();
    raiseNotice('projectNotice', { kind: 'success', message: `imported "${name}" into the library` });
  },

  sharedLooks: [],

  async refreshSharedLooks() {
    const project = get().project;
    if (!project) {
      set({ sharedLooks: [] });
      return;
    }
    set({ sharedLooks: await window.silverbox.sharedLooksList(project.dir) });
  },

  repairSheets: [],

  async refreshRepairSheets() {
    const project = get().project;
    if (!project) {
      set({ repairSheets: [] });
      return;
    }
    set({ repairSheets: await window.silverbox.repairSheetsList(project.dir) });
  },

  async saveRepairSheet(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;

    // Semantic 4: a sheet needs a RAW frame with a readout window (the
    // sensor↔anchor transform's origin) — a JPEG or a RAW libraw exposed no
    // crop for has none, so there's no sensor frame to anchor dust in.
    const image = s.image;
    if (!image || !image.readoutOrigin) {
      raiseNotice('projectNotice', {
        kind: 'error',
        message: 'ゴミ取りセットは読み出し枠を持つ RAW 写真からのみ保存できます',
      });
      return;
    }

    // ALL of the open photo's spots, from the active chain's spots node.
    const spotsNodeId = findActiveSpotsNodeId(s.graph, s.activeOutputId);
    const anchorSpots = spotsNodeId ? (s.graph.nodes.find((n) => n.id === spotsNodeId)?.spots?.spots ?? []) : [];
    if (anchorSpots.length === 0) {
      raiseNotice('projectNotice', { kind: 'error', message: 'この写真にはスポットがありません（先にゴミを取ってください）' });
      return;
    }

    const window_: ReadoutWindow = {
      originX: image.readoutOrigin.x,
      originY: image.readoutOrigin.y,
      orientedWidth: image.fullWidth,
      orientedHeight: image.fullHeight,
      flip: image.flip,
    };
    const sensorSpots = anchorSpots.map((sp) => anchorSpotToSensor(sp, window_));

    const baseSlug = slugifyPresetName(trimmed);
    const list = await window.silverbox.repairSheetsList(project.dir);
    const sameName = list.find((p) => p.name === trimmed);
    let slug = sameName?.slug ?? baseSlug;
    if (!sameName) {
      const taken = new Set(list.map((p) => p.slug));
      for (let n = 2; taken.has(slug); n++) slug = `${baseSlug}-${n}`;
    }
    const doc: RepairSheetDoc = {
      name: trimmed,
      createdAt: new Date().toISOString(),
      ...(image.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
      spots: sensorSpots,
    };
    await window.silverbox.repairSheetWrite(project.dir, slug, serializeRepairSheet(doc));
    await get().refreshRepairSheets();
    raiseNotice('projectNotice', {
      kind: 'success',
      message: `ゴミ取りセット「${trimmed}」を保存しました（${sensorSpots.length} 点）`,
    });
  },

  async applyRepairSheet(slug) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;

    const text = await window.silverbox.repairSheetRead(project.dir, slug);
    if (!text) return;
    let sheet: RepairSheetDoc;
    try {
      sheet = parseRepairSheet(text);
    } catch (err) {
      console.warn(`repair sheet "${slug}" could not be parsed:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `ゴミ取りセット「${slug}」を読み込めませんでした` });
      return;
    }

    // Filmstrip selection = primary + every secondary (stage A's batch shape).
    const secondaryTargets = s.filmstripSelection.filter((p) => p !== primaryPath);
    const allTargets = [primaryPath, ...secondaryTargets];

    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};
    // Per-target skip lines (semantic 5/6), each naming the photo loudly.
    const skips: string[] = [];
    let errorCount = 0;
    // Cache decode-derived readout windows per apply run (semantic 7).
    const windowCache = new Map<string, ReadoutWindow | null>();

    /** Decode (or reuse the open image for the primary) to get a target's readout window; null when it has none (non-RAW / no crop). */
    const readoutWindowFor = async (photoPath: string): Promise<ReadoutWindow | null> => {
      if (windowCache.has(photoPath)) return windowCache.get(photoPath)!;
      let win: ReadoutWindow | null = null;
      const img =
        photoPath === primaryPath && s.image
          ? s.image
          : await (async () => {
              const bytes = await window.silverbox.readFile(photoPath);
              const kind: 'raw' | 'jpg' = isRawFileName(photoPath) ? 'raw' : 'jpg';
              return loadImage(bytes, kind, undefined, s.settings.baselineExposureEV);
            })();
      if (img.readoutOrigin) {
        win = {
          originX: img.readoutOrigin.x,
          originY: img.readoutOrigin.y,
          orientedWidth: img.fullWidth,
          orientedHeight: img.fullHeight,
          flip: img.flip,
        };
      }
      windowCache.set(photoPath, win);
      return win;
    };

    // Live-graph merge for the primary (open photo), file merge for secondaries
    // — the exact primary/secondary split applyPresetToSelection uses.
    let primaryAfter: GraphDoc | null = null;

    for (const photoPath of allTargets) {
      const shortName = photoPath.split('/').pop() ?? photoPath;
      let win: ReadoutWindow | null;
      try {
        win = await readoutWindowFor(photoPath);
      } catch (err) {
        console.warn(`applyRepairSheet: could not decode ${photoPath}:`, err);
        errorCount++;
        continue;
      }
      if (!win) {
        // Semantic 5: non-RAW / no readout window — skipped loudly, never written.
        skips.push(`${shortName}（RAW/読み出し枠なしのためスキップ）`);
        continue;
      }

      // Map sensor → this target's anchor space; drop out-of-frame spots.
      const mapped: Spot[] = [];
      for (const sensorSpot of sheet.spots) {
        const anchorSpot = sensorSpotToAnchor(sensorSpot, win);
        if (anchorSpot) mapped.push(anchorSpot);
      }
      if (mapped.length === 0) {
        skips.push(`${shortName}（枠内に入るスポットなし）`);
        continue;
      }

      if (photoPath === primaryPath) {
        // Primary: merge onto the LIVE graph (its own activeOutputId).
        const existingId = findActiveSpotsNodeId(s.graph, s.activeOutputId);
        const existingCount = existingId ? (s.graph.nodes.find((n) => n.id === existingId)?.spots?.spots.length ?? 0) : 0;
        if (existingCount + mapped.length > SPOTS_CAP) {
          // Semantic 6: REFUSE, never truncate.
          skips.push(`${shortName}（既存 ${existingCount} + ${mapped.length} が上限 ${SPOTS_CAP} 超過のため拒否）`);
          continue;
        }
        const inserted = insertSpotsIntoChain(s.graph, s.activeOutputId, mapped);
        if (inserted === 'no-target' || inserted === 'capped') {
          skips.push(`${shortName}（スポットノードに追加できませんでした）`);
          continue;
        }
        before[photoPath] = structuredClone(s.graph);
        after[photoPath] = inserted.graph;
        primaryAfter = inserted.graph;
        continue;
      }

      // Secondary: read/seed its look file, merge, write.
      const row = findPlaylistPhoto(project, photoPath);
      if (!row) {
        errorCount++;
        continue;
      }
      const lookPath = `${project.dir}/looks/${row.look}`;
      let existingText: string | null = null;
      try {
        existingText = await window.silverbox.readSidecar(lookPath);
      } catch (err) {
        console.warn(`applyRepairSheet: could not read ${lookPath}:`, err);
        errorCount++;
        continue;
      }

      let baseGraph: GraphDoc;
      let meta: {
        source: SidecarSource | null;
        createdAt: string | null;
        unknown: Record<string, unknown> | undefined;
        rating: number;
        photo: string | undefined;
        fingerprint: string | undefined;
        flag: PhotoFlag | undefined;
      };
      if (existingText !== null) {
        let parsedLook: SidecarDoc;
        try {
          parsedLook = parseGraphDoc(existingText);
        } catch (err) {
          console.warn(`applyRepairSheet: ${lookPath} is unreadable by this build, skipping:`, err);
          errorCount++;
          continue;
        }
        baseGraph = parsedLook.graph;
        meta = {
          source: parsedLook.source ?? null,
          createdAt: parsedLook.createdAt ?? null,
          unknown: parsedLook.unknown,
          rating: parsedLook.rating,
          photo: parsedLook.photo,
          fingerprint: parsedLook.fingerprint,
          flag: parsedLook.flag,
        };
      } else {
        // No look yet — seed it exactly like a fresh open would (same as
        // applyPresetToSelection), then merge the sheet's spots onto it.
        try {
          const bytes = await window.silverbox.readFile(photoPath);
          const kind: 'raw' | 'jpg' = isRawFileName(photoPath) ? 'raw' : 'jpg';
          const image = await loadImage(bytes, kind, undefined, s.settings.baselineExposureEV);
          baseGraph = seedDefaultLook(defaultGraphDoc(), image, {
            usedSidecar: false,
            kind,
            testFlags: window.silverbox.testFlags,
          }).graph;
          const fingerprint = (await computeFingerprintCached(photoPath)) ?? undefined;
          meta = {
            source: {
              fileName: shortName,
              ...(image.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
              kind,
            },
            createdAt: new Date().toISOString(),
            unknown: undefined,
            rating: 0,
            photo: relativizeProjectPath(project.dir, photoPath),
            fingerprint,
            flag: undefined,
          };
        } catch (err) {
          console.warn(`applyRepairSheet: could not decode ${photoPath} to seed a fresh look:`, err);
          errorCount++;
          continue;
        }
      }

      // Cap check BEFORE writing (semantic 6): existing + mapped > SPOTS_CAP ⇒
      // REFUSE, never let sanitizeSpotsParams's slice(0,32) be what trims it.
      const existingId = findActiveSpotsNodeId(baseGraph, null);
      const existingCount = existingId ? (baseGraph.nodes.find((n) => n.id === existingId)?.spots?.spots.length ?? 0) : 0;
      if (existingCount + mapped.length > SPOTS_CAP) {
        skips.push(`${shortName}（既存 ${existingCount} + ${mapped.length} が上限 ${SPOTS_CAP} 超過のため拒否）`);
        continue;
      }
      const inserted = insertSpotsIntoChain(baseGraph, null, mapped);
      if (inserted === 'no-target' || inserted === 'capped') {
        skips.push(`${shortName}（スポットノードに追加できませんでした）`);
        continue;
      }
      const content = serializeGraphDoc(
        inserted.graph,
        meta.source,
        meta.createdAt,
        meta.unknown,
        meta.rating,
        meta.photo,
        meta.fingerprint,
        meta.flag
      );
      try {
        await window.silverbox.writeSidecar(lookPath, content);
      } catch (err) {
        console.warn(`applyRepairSheet: could not write ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      before[photoPath] = structuredClone(baseGraph);
      after[photoPath] = inserted.graph;
    }

    // Persist the open photo's live graph now (flush discipline — same as
    // applyPresetToSelection: the sheet applies TO the primary too).
    if (primaryAfter) {
      set({ graph: primaryAfter, graphDirty: true });
      revalidateShaders(primaryAfter);
      await get().saveGraph();
    }

    const writtenTargets = Object.keys(after);
    if (writtenTargets.length > 0) {
      const entry: SyncUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'sync',
        label: `Apply repair sheet "${sheet.name}" to ${writtenTargets.length} photo${writtenTargets.length === 1 ? '' : 's'}`,
        targets: writtenTargets,
        before,
        after,
      };
      set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
      // Develop-aware filmstrip thumbnails (semantic 3's repair-sheet-apply
      // trigger) — every target's cell (primary AND every closed secondary)
      // recomputes off its already-cached preview, no RAW decode.
      get().bumpLookVersion(writtenTargets);
      await get().refreshPlaylistStatus();
    }

    const skipSuffix = skips.length > 0 ? `; スキップ: ${skips.join(', ')}` : '';
    const errorSuffix = errorCount > 0 ? `（${errorCount} 件エラー）` : '';
    raiseNotice('projectNotice', {
      kind: errorCount > 0 || skips.length > 0 ? 'error' : 'success',
      message: `ゴミ取りセット「${sheet.name}」を ${writtenTargets.length} 枚に適用しました${skipSuffix}${errorSuffix}`,
    });
  },

  async deleteRepairSheet(slug) {
    const project = get().project;
    if (!project) return;
    await window.silverbox.repairSheetDelete(project.dir, slug);
    await get().refreshRepairSheets();
    raiseNotice('projectNotice', { kind: 'success', message: `ゴミ取りセットを削除しました` });
  },

  async savePreset(name, families) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { graph, activeOutputId } = get();
    // Multi-output scoping fix (virtual-copy.md): a preset always represents
    // ONE develop chain — on a 2+-output doc it must capture only the ACTIVE
    // output's own chain, never an amalgam of independent copies. No-op on a
    // single-output doc (chainScope covers the whole graph there).
    const scope = chainScope(graph, activeOutputId);
    const baseSlug = slugifyPresetName(trimmed);
    const list = await window.silverbox.presetsList();
    // Same DISPLAY NAME as an existing preset = the update path (reuse its
    // slug, its createdAt, and its on-disk unknown wrapper keys); a
    // different name that happens to SANITIZE to the same slug disambiguates
    // instead of colliding.
    const sameName = list.find((p) => p.name === trimmed);
    let slug = sameName?.slug ?? baseSlug;
    if (!sameName) {
      const taken = new Set(list.map((p) => p.slug));
      for (let n = 2; taken.has(slug); n++) slug = `${baseSlug}-${n}`;
    }
    let unknownFields: Record<string, unknown> | undefined;
    let createdAt = new Date().toISOString();
    let existingIncludes: string[] | undefined;
    const existingText = await window.silverbox.presetRead(slug);
    if (existingText) {
      try {
        const parsed = parsePresetFile(existingText);
        unknownFields = parsed.unknown;
        createdAt = parsed.createdAt;
        existingIncludes = parsed.includes;
      } catch (err) {
        // this slug's file on disk is unreadable — overwrite it cleanly
        // rather than fail the save (promise-9 leaves the OLD file alone
        // only until we deliberately replace it here)
        console.warn(`overwriting unreadable preset file for slug "${slug}":`, err);
      }
    }
    // Preset scoping: `families` (the Save-dialog's checked ids) wins when
    // given; otherwise this is the "Update with current look" flow, which
    // deliberately does not re-prompt — reuse whatever family scope the
    // file already had (verbatim, known ids AND any preserved-unknown ones
    // alike — this is also what makes an unknown future family id survive a
    // reload/re-save round trip, per the brief's forward-compat rule).
    // `families === undefined` with no existing file at all is the
    // historical whole-look shape (no `includes` key at all) — the
    // back-compat path for any caller that predates this feature.
    let look: GraphDoc;
    let includesOut: string[] | undefined;
    if (families !== undefined) {
      look = buildScopedLook(families.includes('geometry') ? graph : captureLook(graph), new Set(families), scope);
      const priorUnknown = existingIncludes?.filter((id) => !isKnownFamilyId(id)) ?? [];
      includesOut = [...families, ...priorUnknown];
    } else if (existingIncludes !== undefined) {
      const priorKnown = existingIncludes.filter(isKnownFamilyId);
      look = buildScopedLook(priorKnown.includes('geometry') ? graph : captureLook(graph), new Set(priorKnown), scope);
      includesOut = existingIncludes;
    } else {
      // Legacy whole-look save (no family dialog at all, predates preset
      // scoping) — still narrowed to the active chain on a 2+-output doc,
      // same reasoning as the two scoped branches above (a no-op on a
      // single-output doc).
      look = restrictToChain(captureLook(graph), scope);
      includesOut = undefined;
    }
    const content = serializePreset(trimmed, look, createdAt, unknownFields, includesOut);
    await window.silverbox.presetWrite(slug, content);
    set({ presets: await window.silverbox.presetsList() });
  },

  async applyPreset(slug) {
    if (get().imageStatus !== 'ready') return;
    const text = await window.silverbox.presetRead(slug);
    if (!text) return;
    let parsed: ParsedPreset;
    try {
      parsed = parsePresetFile(text);
    } catch (err) {
      console.warn(`preset "${slug}" could not be parsed:`, err);
      return;
    }
    let nextGraph: GraphDoc | null = null;
    set((s) => {
      const patch = applyParsedPreset(s, parsed);
      nextGraph = patch.graph;
      return patch;
    });
    if (nextGraph) revalidateShaders(nextGraph);
  },

  async deletePreset(slug) {
    await window.silverbox.presetDelete(slug);
    set({ presets: await window.silverbox.presetsList() });
  },

  async createSharedLook(name, families) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;

    // develop families only — refuse/ignore structural at create time (semantic 1).
    const developFamilies = families.filter(isDevelopFamily);
    if (developFamilies.length === 0) {
      raiseNotice('projectNotice', { kind: 'error', message: 'a shared look needs at least one develop family checked' });
      return;
    }

    // geometry can never be among developFamilies (it's structural), so
    // captureLook's geometry-stripping is always the right capture here —
    // same conditional savePreset's own scoped branch reduces to in that case.
    const scope = chainScope(s.graph, s.activeOutputId);
    const look = buildScopedLook(captureLook(s.graph), new Set(developFamilies), scope);

    const baseSlug = slugifyPresetName(trimmed);
    const list = await window.silverbox.sharedLooksList(project.dir);
    const sameName = list.find((p) => p.name === trimmed);
    let slug = sameName?.slug ?? baseSlug;
    if (!sameName) {
      const taken = new Set(list.map((p) => p.slug));
      for (let n = 2; taken.has(slug); n++) slug = `${baseSlug}-${n}`;
    }
    const content = serializePreset(trimmed, look, new Date().toISOString(), undefined, developFamilies);
    await window.silverbox.sharedLookWrite(project.dir, slug, content);
    // Stage D echo suppression — same reasoning as publishToSharedLook's own priming.
    set((st) => ({ sharedLookTexts: { ...st.sharedLookTexts, [slug]: content } }));
    // Re-arm the shared-looks watch: `shared-looks/` may not have existed
    // yet the first time a project activated (armSharedLooksWatch fails
    // silently on a missing directory, same posture as armSidecarWatch on a
    // missing one) — the write above is what just created it (its own
    // mkdir-before-write), so THIS is the first point a watch is guaranteed
    // to succeed for a project that never had a shared look before. A
    // harmless no-op re-arm for every subsequent creation.
    void window.silverbox.watchSharedLooks(project.dir);
    await get().refreshSharedLooks();

    // "creating a look you don't follow yourself is meaningless" (semantic
    // 1) — link the creator DIRECTLY, rather than through
    // linkPhotosToLook's "does this family differ from fresh-seed
    // defaults?" comparison: that comparison is for photos being ATTACHED
    // to an EXISTING look (semantic 2). The creator's checked-family values
    // ARE, by construction, exactly what was just captured INTO the look —
    // there is nothing to compare against a fresh-open baseline for, and
    // running that comparison here would be a category error (a
    // deliberately-edited creator photo would almost always look
    // "already edited" relative to ITS OWN fresh-open defaults, forking
    // every family it just used to build the look). Constraint 3 (at most
    // one linked Develop) still applies.
    const primaryScope = chainScope(s.graph, s.activeOutputId);
    const devNode = s.graph.nodes.find((n) => n.kind === DEVELOP_KIND && primaryScope.has(n.id));
    if (!devNode) return;
    if (devNode.link) {
      raiseNotice('projectNotice', { kind: 'error', message: 'this photo is already linked to a shared look — unlink it first' });
      return;
    }
    const materializedFrom = await sha256Hex(new TextEncoder().encode(content).buffer);
    const newLink: DevelopLink = { look: slug, follows: [...developFamilies], materializedFrom };
    const before = structuredClone(s.graph);
    const after: GraphDoc = {
      ...s.graph,
      nodes: s.graph.nodes.map((n) => (n.id === devNode.id ? { ...n, link: newLink } : n)),
    };
    set({ graph: after, graphDirty: true });
    revalidateShaders(after);
    await get().saveGraph();
    const entry: SyncUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'sync',
      label: `Create shared look "${trimmed}"`,
      targets: [primaryPath],
      before: { [primaryPath]: before },
      after: { [primaryPath]: after },
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    await get().refreshPlaylistStatus();
    raiseNotice('projectNotice', { kind: 'success', message: `created shared look "${trimmed}" and linked this photo to it` });
  },

  async linkPhotosToLook(targets, slug) {
    const s = get();
    const project = s.project;
    if (!project || targets.length === 0) return;

    const lookText = await window.silverbox.sharedLookRead(project.dir, slug);
    if (!lookText) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" could not be read` });
      return;
    }
    let parsed: ParsedPreset;
    try {
      parsed = parsePresetFile(lookText);
    } catch (err) {
      console.warn(`shared look "${slug}" could not be parsed:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" is corrupt and could not be linked` });
      return;
    }
    const offeredFamilies = (parsed.includes ?? []).filter(isKnownFamilyId).filter(isDevelopFamily);
    if (offeredFamilies.length === 0) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" offers no develop families to follow` });
      return;
    }
    const lookDevelop = parsed.look.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
    const materializedFrom = await sha256Hex(new TextEncoder().encode(lookText).buffer);

    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};
    let totalFollowed = 0;
    let totalIndividual = 0;
    let alreadyLinkedCount = 0;
    let errorCount = 0;

    for (const photoPath of targets) {
      const row = findPlaylistPhoto(project, photoPath);
      if (!row) {
        errorCount++;
        continue;
      }
      const lookPath = `${project.dir}/looks/${row.look}`;
      const isPrimary = photoPath === s.imagePath && s.imageStatus === 'ready' && !!s.image;

      let baseGraph: GraphDoc;
      let freshDevelop: DevelopParams;
      let meta:
        | {
            source: SidecarSource | null;
            createdAt: string | null;
            unknown: Record<string, unknown> | undefined;
            rating: number;
            photo: string | undefined;
            fingerprint: string | undefined;
            flag: PhotoFlag | undefined;
          }
        | null = null;

      if (isPrimary) {
        // Live in-memory graph + already-decoded image — no I/O needed.
        baseGraph = s.graph;
        const kind: 'raw' | 'jpg' = isRawFileName(s.fileName ?? '') ? 'raw' : 'jpg';
        freshDevelop =
          seedDefaultLook(defaultGraphDoc(), s.image!, { usedSidecar: false, kind, testFlags: window.silverbox.testFlags }).graph.nodes.find(
            (n) => n.kind === DEVELOP_KIND
          )?.develop ?? defaultDevelopParams();
      } else {
        let existingText: string | null = null;
        try {
          existingText = await window.silverbox.readSidecar(lookPath);
        } catch (err) {
          console.warn(`linkPhotosToLook: could not read ${lookPath}:`, err);
          errorCount++;
          continue;
        }
        let image: PreparedImage;
        const kind: 'raw' | 'jpg' = isRawFileName(photoPath) ? 'raw' : 'jpg';
        try {
          const bytes = await window.silverbox.readFile(photoPath);
          image = await loadImage(bytes, kind, undefined, s.settings.baselineExposureEV);
        } catch (err) {
          console.warn(`linkPhotosToLook: could not decode ${photoPath}:`, err);
          errorCount++;
          continue;
        }
        const seeded = seedDefaultLook(defaultGraphDoc(), image, { usedSidecar: false, kind, testFlags: window.silverbox.testFlags });
        freshDevelop = seeded.graph.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
        if (existingText !== null) {
          let parsedLook: SidecarDoc;
          try {
            parsedLook = parseGraphDoc(existingText);
          } catch (err) {
            console.warn(`linkPhotosToLook: ${lookPath} is unreadable by this build, skipping:`, err);
            errorCount++;
            continue;
          }
          baseGraph = parsedLook.graph;
          meta = {
            source: parsedLook.source ?? null,
            createdAt: parsedLook.createdAt ?? null,
            unknown: parsedLook.unknown,
            rating: parsedLook.rating,
            photo: parsedLook.photo,
            fingerprint: parsedLook.fingerprint,
            flag: parsedLook.flag,
          };
        } else {
          // No look yet — same fresh-seed baseline IS the current graph, no
          // separate decode (mirrors applyPresetToSelection's own "seed it
          // exactly like a fresh open would" branch).
          baseGraph = seeded.graph;
          const fingerprint = (await computeFingerprintCached(photoPath)) ?? undefined;
          meta = {
            source: {
              fileName: photoPath.split('/').pop() ?? photoPath,
              ...(image.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
              kind,
            },
            createdAt: new Date().toISOString(),
            unknown: undefined,
            rating: 0,
            photo: relativizeProjectPath(project.dir, photoPath),
            fingerprint,
            flag: undefined,
          };
        }
      }

      const targetScope = isPrimary ? chainScope(s.graph, s.activeOutputId) : chainScope(baseGraph, null);
      const devNode = baseGraph.nodes.find((n) => n.kind === DEVELOP_KIND && targetScope.has(n.id));
      if (!devNode) {
        errorCount++;
        continue;
      }
      // Constraint 3 (structurally enforced at link time): at most one
      // linked Develop, never silently double-link — skip and report rather
      // than abort the whole batch (same "skip, don't corrupt" posture as
      // mergeFamiliesWithSkipDetection's structural skip).
      if (devNode.link) {
        alreadyLinkedCount++;
        continue;
      }

      const currentDevelop = devNode.develop ?? defaultDevelopParams();
      const follows: PresetFamilyId[] = [];
      const individual: PresetFamilyId[] = [];
      for (const fam of offeredFamilies) {
        if (developFamilyUntouched(currentDevelop, freshDevelop, fam)) follows.push(fam);
        else individual.push(fam);
      }
      const newDevelop = pickDevelopFamilies(lookDevelop, currentDevelop, new Set(follows));
      const newLink: DevelopLink = { look: slug, follows, materializedFrom };
      const newGraph: GraphDoc = {
        ...baseGraph,
        nodes: baseGraph.nodes.map((n) => (n.id === devNode.id ? { ...n, develop: newDevelop, link: newLink } : n)),
      };

      if (!isPrimary) {
        const m = meta!;
        const content = serializeGraphDoc(newGraph, m.source, m.createdAt, m.unknown, m.rating, m.photo, m.fingerprint, m.flag);
        try {
          await window.silverbox.writeSidecar(lookPath, content);
        } catch (err) {
          console.warn(`linkPhotosToLook: could not write ${lookPath}:`, err);
          errorCount++;
          continue;
        }
      }
      before[photoPath] = structuredClone(baseGraph);
      after[photoPath] = newGraph;
      totalFollowed += follows.length;
      totalIndividual += individual.length;
    }

    // Primary flush discipline (applyPresetToSelection precedent): apply to
    // the live graph + persist right away, rather than the ordinary 1000ms
    // autosave debounce.
    const primaryAfter = s.imagePath ? after[s.imagePath] : undefined;
    if (primaryAfter) {
      set({ graph: primaryAfter, graphDirty: true });
      revalidateShaders(primaryAfter);
      await get().saveGraph();
    }

    const writtenTargets = Object.keys(after);
    if (writtenTargets.length > 0) {
      const entry: SyncUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'sync',
        label: `Link ${writtenTargets.length} photo${writtenTargets.length === 1 ? '' : 's'} to "${parsed.name}"`,
        targets: writtenTargets,
        before,
        after,
      };
      set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
      // Develop-aware filmstrip thumbnails (semantic 3's link trigger).
      get().bumpLookVersion(writtenTargets);
      await get().refreshPlaylistStatus();
    }

    const skipSuffix = alreadyLinkedCount > 0 ? `; ${alreadyLinkedCount} already linked, skipped` : '';
    const errorSuffix = errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? '' : 's'})` : '';
    raiseNotice('projectNotice', {
      kind: errorCount > 0 ? 'error' : 'success',
      message: `linked ${writtenTargets.length} photo${writtenTargets.length === 1 ? '' : 's'} to "${parsed.name}" — ${totalFollowed} group${totalFollowed === 1 ? '' : 's'} followed, ${totalIndividual} individual${skipSuffix}${errorSuffix}`,
    });
  },

  async revertFamilyToLook(nodeId, family) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;
    const node = s.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== DEVELOP_KIND || !node.link) return;
    const slug = node.link.look;
    const lookText = await window.silverbox.sharedLookRead(project.dir, slug);
    if (!lookText) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" could not be read` });
      return;
    }
    let parsed: ParsedPreset;
    try {
      parsed = parsePresetFile(lookText);
    } catch (err) {
      console.warn(`shared look "${slug}" could not be parsed:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" is corrupt` });
      return;
    }
    const offeredFamilies = (parsed.includes ?? []).filter(isKnownFamilyId).filter(isDevelopFamily);
    if (!offeredFamilies.includes(family)) {
      // Orphaned override (parent spec §4.2): the look body dropped this
      // family — the fork survives as local, nothing to revert to.
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" no longer offers ${family}` });
      return;
    }
    const lookDevelop = parsed.look.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
    const materializedFrom = await sha256Hex(new TextEncoder().encode(lookText).buffer);
    const currentDevelop = node.develop ?? defaultDevelopParams();
    const newDevelop = pickDevelopFamilies(lookDevelop, currentDevelop, new Set([family]));
    const nextFollows = node.link.follows.includes(family) ? node.link.follows : [...node.link.follows, family];
    const newLink: DevelopLink = { look: slug, follows: nextFollows, materializedFrom };
    const before = structuredClone(s.graph);
    const after: GraphDoc = {
      ...s.graph,
      nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, develop: newDevelop, link: newLink } : n)),
    };
    set({ graph: after, graphDirty: true });
    revalidateShaders(after);
    await get().saveGraph();
    const entry: SyncUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'sync',
      label: `Revert ${family} to shared look`,
      targets: [primaryPath],
      before: { [primaryPath]: before },
      after: { [primaryPath]: after },
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    await get().refreshPlaylistStatus();
  },

  async resetAllFamiliesToLook(nodeId) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;
    const node = s.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== DEVELOP_KIND || !node.link) return;
    const slug = node.link.look;
    const lookText = await window.silverbox.sharedLookRead(project.dir, slug);
    if (!lookText) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" could not be read` });
      return;
    }
    let parsed: ParsedPreset;
    try {
      parsed = parsePresetFile(lookText);
    } catch (err) {
      console.warn(`shared look "${slug}" could not be parsed:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" is corrupt` });
      return;
    }
    const offeredFamilies = (parsed.includes ?? []).filter(isKnownFamilyId).filter(isDevelopFamily);
    if (offeredFamilies.length === 0) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" offers no develop families` });
      return;
    }
    const lookDevelop = parsed.look.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
    const materializedFrom = await sha256Hex(new TextEncoder().encode(lookText).buffer);
    const currentDevelop = node.develop ?? defaultDevelopParams();
    const newDevelop = pickDevelopFamilies(lookDevelop, currentDevelop, new Set(offeredFamilies));
    const newLink: DevelopLink = { look: slug, follows: [...offeredFamilies], materializedFrom };
    const before = structuredClone(s.graph);
    const after: GraphDoc = {
      ...s.graph,
      nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, develop: newDevelop, link: newLink } : n)),
    };
    set({ graph: after, graphDirty: true });
    revalidateShaders(after);
    await get().saveGraph();
    const entry: SyncUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'sync',
      label: 'Reset all families to shared look',
      targets: [primaryPath],
      before: { [primaryPath]: before },
      after: { [primaryPath]: after },
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    await get().refreshPlaylistStatus();
  },

  async unlinkLook(nodeId) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const node = s.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== DEVELOP_KIND || !node.link) return;
    const before = structuredClone(s.graph);
    const after = stripDevelopLink(s.graph, nodeId);
    set({ graph: after, graphDirty: true });
    revalidateShaders(after);
    await get().saveGraph();
    const entry: SyncUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'sync',
      label: 'Unlink from shared look',
      targets: [primaryPath],
      before: { [primaryPath]: before },
      after: { [primaryPath]: after },
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    await get().refreshPlaylistStatus();
  },

  async deleteSharedLook(slug) {
    const s = get();
    const project = s.project;
    if (!project) return;

    // Capture the file's own bytes BEFORE deleting it (conductor review
    // finding): a follower's `link` REFERENCES the shared look — unlike a
    // preset, which nothing references — so undo of a delete must
    // resurrect the FILE too, or a restored `link` points at nothing (a
    // user-reachable inconsistent state one ⌘Z away). See
    // DeleteSharedLookUndoEntry's own doc comment.
    const lookText = await window.silverbox.sharedLookRead(project.dir, slug);
    if (lookText === null) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" could not be read — nothing deleted` });
      return;
    }

    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};
    let errorCount = 0;
    const openPath = s.imagePath;

    for (const row of project.photos) {
      const photoPath = resolveProjectPath(project.dir, row.path);
      const isOpen = photoPath === openPath && s.imageStatus === 'ready';

      if (isOpen) {
        const node = s.graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
        if (!node) continue;
        const stripped = stripDevelopLink(s.graph, node.id);
        before[photoPath] = structuredClone(s.graph);
        after[photoPath] = stripped;
        set({ graph: stripped, graphDirty: true });
        revalidateShaders(stripped);
        await get().saveGraph();
        continue;
      }

      const lookPath = `${project.dir}/looks/${row.look}`;
      let existingText: string | null;
      try {
        existingText = await window.silverbox.readSidecar(lookPath);
      } catch (err) {
        console.warn(`deleteSharedLook: could not read ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      if (existingText === null) continue; // never saved — nothing to strip
      let parsedLook: SidecarDoc;
      try {
        parsedLook = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`deleteSharedLook: ${lookPath} is unreadable by this build, skipping:`, err);
        errorCount++;
        continue;
      }
      const node = parsedLook.graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
      if (!node) continue; // not a follower of THIS look
      const stripped = stripDevelopLink(parsedLook.graph, node.id);
      const content = serializeGraphDoc(
        stripped,
        parsedLook.source ?? null,
        parsedLook.createdAt ?? null,
        parsedLook.unknown,
        parsedLook.rating,
        parsedLook.photo,
        parsedLook.fingerprint,
        parsedLook.flag
      );
      try {
        await window.silverbox.writeSidecar(lookPath, content);
      } catch (err) {
        console.warn(`deleteSharedLook: could not write ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      before[photoPath] = structuredClone(parsedLook.graph);
      after[photoPath] = stripped;
    }

    // The file deletion IS covered by undo now (DeleteSharedLookUndoEntry) —
    // unlike deletePreset, which nothing references, a follower's `link`
    // would otherwise point at a file that's simply gone once undo restores
    // it. Pushed unconditionally (even with zero followers): the delete
    // itself, not merely a follower change, is what this entry restores.
    await window.silverbox.sharedLookDelete(project.dir, slug);
    // Stage D: drop the baseline cache entry too — nothing left on disk to compare a future watch echo against.
    set((st) => {
      const { [slug]: _dropped, ...rest } = st.sharedLookTexts;
      return { sharedLookTexts: rest };
    });
    await get().refreshSharedLooks();

    const writtenTargets = Object.keys(after);
    const entry: DeleteSharedLookUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'delete-shared-look',
      label: `Delete shared look (${writtenTargets.length} follower${writtenTargets.length === 1 ? '' : 's'} unlinked)`,
      projectDir: project.dir,
      slug,
      lookText,
      targets: writtenTargets,
      before,
      after,
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    if (writtenTargets.length > 0) {
      // Develop-aware filmstrip thumbnails (semantic 3's unlink trigger —
      // every follower this delete just unlinked had its look file rewritten).
      get().bumpLookVersion(writtenTargets);
      await get().refreshPlaylistStatus();
    }

    const errorSuffix = errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? '' : 's'})` : '';
    raiseNotice('projectNotice', {
      kind: errorCount > 0 ? 'error' : 'success',
      message: `deleted shared look — ${writtenTargets.length} follower${writtenTargets.length === 1 ? '' : 's'} unlinked${errorSuffix}`,
    });
  },

  activeLinkedDevelopNode() {
    const s = get();
    if (!s.imagePath || s.imageStatus !== 'ready') return null;
    const scope = chainScope(s.graph, s.activeOutputId);
    const devNode = s.graph.nodes.find((n) => n.kind === DEVELOP_KIND && scope.has(n.id) && !!n.link);
    return devNode ?? null;
  },

  async publishToSharedLook(families) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return; // UI gates the button on this — silent, same posture as every sibling shared-look action
    const project = s.project;
    if (!project) {
      raiseNotice('projectNotice', { kind: 'error', message: 'no active project — nothing to publish' });
      return;
    }

    // Semantic 2: read ONLY the linked Develop node of the active chain —
    // NEVER a tweak-layer Develop node sharing the same chain.
    const scope = chainScope(s.graph, s.activeOutputId);
    const devNode = s.graph.nodes.find((n) => n.kind === DEVELOP_KIND && scope.has(n.id) && !!n.link);
    if (!devNode || !devNode.link) {
      raiseNotice('projectNotice', { kind: 'error', message: 'no linked look on this photo — nothing to publish' });
      return;
    }
    const slug = devNode.link.look;

    // develop families only — same create-time guard createSharedLook uses.
    const developFamilies = families.filter(isDevelopFamily);
    if (developFamilies.length === 0) {
      raiseNotice('projectNotice', { kind: 'error', message: 'publish needs at least one develop family checked' });
      return;
    }

    const lookTextBefore = await window.silverbox.sharedLookRead(project.dir, slug);
    if (lookTextBefore === null) {
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" could not be read — nothing published` });
      return;
    }
    let parsedBefore: ParsedPreset;
    try {
      parsedBefore = parsePresetFile(lookTextBefore);
    } catch (err) {
      console.warn(`publishToSharedLook: shared look "${slug}" could not be parsed:`, err);
      raiseNotice('projectNotice', { kind: 'error', message: `shared look "${slug}" is corrupt — nothing published` });
      return;
    }

    // Semantic 3: flush the open photo's own pending autosave state FIRST —
    // writeGraphSaveSnapshot/flushPendingAutosave's own discipline, run
    // inline here since publish never navigates the primary away.
    if (s.graphDirty) await get().saveGraph();

    // Build the new look body: `developFamilies` picked FROM the photo's
    // current develop values, onto the EXISTING look body as base — mirrors
    // buildScopedLook's SAVE direction (pickDevelopFamilies's own doc
    // comment), so an unchecked-but-already-offered family's look value is
    // left exactly as it was (never removed from the look, per semantic 1).
    const currentDevelop = devNode.develop ?? defaultDevelopParams();
    const lookDevelopBefore = parsedBefore.look.nodes.find((n) => n.kind === DEVELOP_KIND)?.develop ?? defaultDevelopParams();
    const existingIncludes = (parsedBefore.includes ?? []).filter(isKnownFamilyId).filter(isDevelopFamily);
    const newIncludes = [...new Set([...existingIncludes, ...developFamilies])]; // semantic 1: checking a new family EXTENDS includes
    const newLookDevelop = pickDevelopFamilies(currentDevelop, lookDevelopBefore, new Set(developFamilies));
    const newLookGraph: GraphDoc = {
      ...parsedBefore.look,
      nodes: parsedBefore.look.nodes.map((n) => (n.kind === DEVELOP_KIND ? { ...n, develop: newLookDevelop } : n)),
    };
    const lookTextAfter = serializePreset(parsedBefore.name, newLookGraph, parsedBefore.createdAt, parsedBefore.unknown, newIncludes);
    const materializedFrom = await sha256Hex(new TextEncoder().encode(lookTextAfter).buffer);

    await window.silverbox.sharedLookWrite(project.dir, slug, lookTextAfter);
    // Stage D echo suppression (linked-looks-stage-d.md semantic 2): prime
    // the per-slug baseline BEFORE the shared-looks watch's own debounced
    // echo of this exact write can arrive — otherwise handleSharedLooksChanged
    // would see "different from cache" and fan out a SECOND time from our
    // own publish.
    set((st) => ({ sharedLookTexts: { ...st.sharedLookTexts, [slug]: lookTextAfter } }));

    // Fan-out re-materialization (semantic 4) — same playlist-scan shape as
    // deleteSharedLook, but every row whose Develop node follows THIS slug
    // gets its (follows ∩ developFamilies) values rewritten AND its
    // materializedFrom bumped unconditionally (even an empty intersection —
    // CRITICAL DETAIL, stage D's drift detection depends on it). The
    // publisher (currently open photo) is handled inline via the live graph;
    // every other follower is read/patched/written on disk, same shape
    // linkPhotosToLook/deleteSharedLook already use.
    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};
    let errorCount = 0;

    for (const row of project.photos) {
      const photoPath = resolveProjectPath(project.dir, row.path);
      const isOpen = photoPath === primaryPath;

      if (isOpen) {
        // Semantic 5: the publisher re-follows every published family — its
        // checked-family values already equal the look's own by
        // construction (this pickDevelopFamilies call is an identity write
        // for `developFamilies`), but running it uniformly keeps this
        // branch's shape identical to every other follower's own
        // materialization below. Families NOT published keep whatever
        // follow/fork state they already had.
        const newFollows = [...new Set([...devNode.link.follows, ...developFamilies])];
        const newDevelop = pickDevelopFamilies(newLookDevelop, devNode.develop ?? defaultDevelopParams(), new Set(developFamilies));
        const newLink: DevelopLink = { look: slug, follows: newFollows, materializedFrom };
        const nextGraph: GraphDoc = {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === devNode.id ? { ...n, develop: newDevelop, link: newLink } : n)),
        };
        before[photoPath] = structuredClone(s.graph);
        after[photoPath] = nextGraph;
        set({ graph: nextGraph, graphDirty: true });
        revalidateShaders(nextGraph);
        await get().saveGraph();
        continue;
      }

      const lookPath = `${project.dir}/looks/${row.look}`;
      let existingText: string | null;
      try {
        existingText = await window.silverbox.readSidecar(lookPath);
      } catch (err) {
        console.warn(`publishToSharedLook: could not read ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      if (existingText === null) continue; // never saved — nothing to re-materialize
      let parsedLook: SidecarDoc;
      try {
        parsedLook = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`publishToSharedLook: ${lookPath} is unreadable by this build, skipping:`, err);
        errorCount++;
        continue;
      }
      const node = parsedLook.graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.link?.look === slug);
      if (!node?.link) continue; // not a follower of THIS look

      // Semantic 4: rewrite ONLY (follows ∩ published families)'s values;
      // `follows` itself is untouched here (only the publisher re-follows,
      // semantic 5) — but materializedFrom bumps regardless of whether the
      // intersection is empty.
      const intersect = node.link.follows.filter((f) => developFamilies.includes(f));
      const newDevelop =
        intersect.length > 0
          ? pickDevelopFamilies(newLookDevelop, node.develop ?? defaultDevelopParams(), new Set(intersect))
          : (node.develop ?? defaultDevelopParams());
      const newLink: DevelopLink = { ...node.link, materializedFrom };
      const nextGraph: GraphDoc = {
        ...parsedLook.graph,
        nodes: parsedLook.graph.nodes.map((n) => (n.id === node.id ? { ...n, develop: newDevelop, link: newLink } : n)),
      };
      const content = serializeGraphDoc(
        nextGraph,
        parsedLook.source ?? null,
        parsedLook.createdAt ?? null,
        parsedLook.unknown,
        parsedLook.rating,
        parsedLook.photo,
        parsedLook.fingerprint,
        parsedLook.flag
      );
      try {
        await window.silverbox.writeSidecar(lookPath, content);
      } catch (err) {
        console.warn(`publishToSharedLook: could not write ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      before[photoPath] = structuredClone(parsedLook.graph);
      after[photoPath] = nextGraph;
    }

    const targets = Object.keys(after);
    const entry: PublishUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'publish',
      label: `Publish "${parsedBefore.name}" → ${targets.length} photo${targets.length === 1 ? '' : 's'}`,
      projectDir: project.dir,
      slug,
      lookTextBefore,
      lookTextAfter,
      targets,
      before,
      after,
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    // Develop-aware filmstrip thumbnails (semantic 3's publish-fan-out
    // trigger — the brief's own headline case: N closed followers repaint
    // off their already-cached previews, zero RAW decodes).
    get().bumpLookVersion(targets);
    await get().refreshSharedLooks();
    await get().refreshPlaylistStatus();

    const errorSuffix = errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? '' : 's'})` : '';
    raiseNotice('projectNotice', {
      kind: errorCount > 0 ? 'error' : 'success',
      message: `published "${parsedBefore.name}" — applied to ${targets.length} photo${targets.length === 1 ? '' : 's'}${errorSuffix}`,
    });
  },

  sharedLookTexts: {},
  sharedLookHotReloadNotice: null,

  async handleSharedLooksChanged() {
    const project = get().project;
    if (!project) return;
    await get().refreshSharedLooks();
    for (const { slug, name } of get().sharedLooks) {
      const cached = get().sharedLookTexts[slug];
      let text: string | null;
      try {
        text = await window.silverbox.sharedLookRead(project.dir, slug);
      } catch (err) {
        console.warn(`handleSharedLooksChanged: could not read shared look "${slug}":`, err);
        continue;
      }
      // Deleted externally: out of stage D's explicit scope (semantic 7's
      // missing-look posture is a per-photo LOAD-time concern) — the next
      // photo that loads this link surfaces the notice on its own.
      if (text === null) continue;
      if (cached === undefined) {
        // First sighting this session — establish the baseline silently,
        // nothing to fan out FROM (sharedLookTexts's own doc comment).
        set((s) => ({ sharedLookTexts: { ...s.sharedLookTexts, [slug]: text! } }));
        continue;
      }
      if (text === cached) continue; // our own write's echo, or truly unchanged
      await maybeDeferOrReMaterialize(slug, name, cached, text, `共通ルック「${name}」の外部編集`);
    }
  },

  async reflectPendingSharedLook() {
    const pending = get().sharedLookHotReloadNotice;
    if (!pending || pending.kind !== 'pending') return;
    set({ sharedLookHotReloadNotice: null });
    const lookName = get().sharedLooks.find((l) => l.slug === pending.slug)?.name ?? pending.slug;
    await runSharedLookReMaterialization(pending.slug, lookName, pending.lookTextBefore, pending.lookTextAfter, pending.label);
  },

  previewLook: null,

  setPreviewLook(look) {
    set((s) => {
      if (!look) return { previewLook: null };
      // Same applyLook fork (virtual-copy.md): a 2+-output doc previews
      // exactly what an actual paste/apply would produce (this getter's own
      // doc-comment contract) — the old unconditional wholesale-replace
      // would have previewed every OTHER output vanishing too.
      const outputs = s.graph.nodes.filter((n) => n.kind === 'output');
      const preview =
        outputs.length <= 1
          ? mergeLookWithCurrentGeometry(s.graph, look)
          : replaceActiveChainWithLook(s.graph, look, s.activeOutputId);
      return { previewLook: preview };
    });
  },

  previewParsedPreset(parsed) {
    set((s) => {
      if (!parsed.includes) {
        // Whole-look preview: the exact fork applyLook/setPreviewLook use.
        const outputs = s.graph.nodes.filter((n) => n.kind === 'output');
        const preview =
          outputs.length <= 1
            ? mergeLookWithCurrentGeometry(s.graph, parsed.look)
            : replaceActiveChainWithLook(s.graph, parsed.look, s.activeOutputId);
        return { previewLook: preview };
      }
      const scope = chainScope(s.graph, s.activeOutputId);
      const merged = mergeScopedLook(s.graph, parsed.look, new Set(parsed.includes.filter(isKnownFamilyId)), scope);
      return { previewLook: mergeLookWithCurrentGeometry(s.graph, merged) };
    });
  },

  setGeometry(geo, coalesceKey) {
    set((s) => {
      const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
      if (!inputNode) return {};
      const geometry = clampGeometry(geo);
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit crop / straighten' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === inputNode.id ? { ...n, geometry } : n)),
        },
        graphDirty: true,
      };
    });
  },

  setLens(lensParams, coalesceKey) {
    set((s) => {
      const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
      if (!inputNode) return {};
      const lens = clampLens(lensParams);
      return {
        ...pushHistory(s, coalesceKey, { label: 'Edit lens correction' }),
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === inputNode.id ? { ...n, lens } : n)),
        },
        graphDirty: true,
      };
    });
  },

  setHistogram(histogram) {
    set({ histogram });
  },

  setScopeMode(mode) {
    set({ scopeMode: mode });
  },

  setScopeSamples(samples) {
    set({ scopeSamples: samples });
  },

  async exportImage(path, opts) {
    const { imagePath, fileName, renderer, imageStatus, exportStatus, activeOutputId } = get();
    if (!imagePath || !fileName || !renderer || imageStatus !== 'ready' || exportStatus === 'working') return;
    let target = path ?? null;
    if (!target) {
      const result = await window.silverbox.exportImageDialog(imagePath.replace(/\.[^.]+$/, '') + '.jpg');
      if (result.canceled) return;
      target = result.path;
    }
    set({ exportStatus: 'working', exportError: null, exportInfo: null });
    try {
      // Export honors the currently SELECTED output (named outputs, spec §6)
      // unless the caller overrides it — undefined = the doc's first, same
      // default buildPlan itself applies.
      const result = await exportOnePath(target, opts?.outputId ?? activeOutputId ?? undefined, opts);
      set({
        exportStatus: 'idle',
        exportInfo: { width: result.width, height: result.height, bytes: result.bytes },
      });
    } catch (err) {
      set({ exportStatus: 'error', exportError: err instanceof Error ? err.message : String(err) });
    }
  },

  setSettingsDialogOpen(open) {
    set({ settingsDialogOpen: open });
  },
  setExportDialogOpen(open) {
    set({ exportDialogOpen: open });
  },

  async exportSelectedOutputs(target, path, opts) {
    const { imagePath, fileName, graph, renderer, imageStatus, exportStatus, activeOutputId } = get();
    if (!imagePath || !fileName || !renderer || imageStatus !== 'ready' || exportStatus === 'working') return;
    const outputs = graph.nodes.filter((n) => n.kind === 'output');
    const targets =
      target === 'all'
        ? outputs
        : target === 'active'
          ? (() => {
              const active = (activeOutputId && outputs.find((n) => n.id === activeOutputId)) || outputs[0];
              return active ? [active] : [];
            })()
          : outputs.filter((n) => n.id === target);
    if (targets.length === 0) return;

    let basePath = path ?? null;
    if (!basePath) {
      const result = await window.silverbox.exportImageDialog(imagePath.replace(/\.[^.]+$/, '') + '.jpg');
      if (result.canceled) return;
      basePath = result.path;
    }

    set({ exportStatus: 'working', exportError: null, exportInfo: null, exportBatchInfo: null });
    try {
      const paths: string[] = [];
      const used = new Set<string>();
      let last: { width: number; height: number; bytes: number } | null = null;
      for (const node of targets) {
        // single output = no suffix (current behavior); 2+ (an explicit "all
        // outputs" export) suffix each file with its output name so nothing
        // silently overwrites the previous one. Names can COLLIDE — two
        // unnamed outputs both fall back to 'main' (outputName), and nothing
        // stops the user naming two outputs identically — so repeats get a
        // numeric disambiguator (-2, -3, …): every target must land in its
        // own file, which is the entire point of "All outputs".
        let outPath = targets.length > 1 ? suffixExportPath(basePath, outputName(node)) : basePath;
        for (let n = 2; used.has(outPath); n++) outPath = suffixExportPath(basePath, `${outputName(node)}-${n}`);
        used.add(outPath);
        last = await exportOnePath(outPath, node.id, opts);
        paths.push(outPath);
      }
      set({
        exportStatus: 'idle',
        exportInfo: last,
        exportBatchInfo: { count: paths.length, paths },
      });
    } catch (err) {
      set({ exportStatus: 'error', exportError: err instanceof Error ? err.message : String(err) });
    }
  },

  async runCliRender(job, onResult) {
    for (const input of job.images) {
      const startedAt = Date.now();
      try {
        // --min-rating / --skip-rejected (ratings pack / reject-flag pack):
        // one cheap sidecar read BEFORE the expensive decode/render below —
        // an image with no rating (or a rating below the threshold), or one
        // flagged reject, is reported as a skip, never rendered. Read once,
        // check both (only when at least one filter is actually active).
        if (job.minRating !== null || job.skipRejected) {
          const meta = await readSidecarWrapperMetaCheap(input);
          if (job.minRating !== null && meta.rating < job.minRating) {
            onResult({ input, status: 'skipped-rating' });
            continue;
          }
          if (job.skipRejected && meta.flag === 'reject') {
            onResult({ input, status: 'skipped-rejected' });
            continue;
          }
        }

        // Render directly from a look file (CLI tooling parity item 2): a
        // `.json` argument is a per-photo DOCUMENT, not an image — parsed
        // here, before opening anything, so a missing `photo` field is a
        // clean per-file error rather than openImageByPath's own "unsupported
        // file type" (which only knows RAW/JPEG kinds). `openTarget` is what
        // actually gets decoded/rendered; `input` stays the argument the user
        // typed for every reported result below.
        let openTarget = input;
        let lookGraphText: string | null = null;
        if (input.endsWith('.json')) {
          const text = new TextDecoder().decode(await window.silverbox.readFile(input));
          let photoField: unknown;
          try {
            photoField = (JSON.parse(text) as { photo?: unknown }).photo;
          } catch (err) {
            throw new Error(`could not parse look file ${input}: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (typeof photoField !== 'string' || photoField.trim() === '') {
            throw new Error(
              `${input} has no \`photo\` field — pass the IMAGE directly instead (a look file only renders directly when it carries \`photo\`, e.g. a project's looks/*.json; a legacy adjacent sidecar has none)`
            );
          }
          // Resolved relative to the look's OWN project dir (parent of
          // looks/) — same rule regardless of whether --project pointed us
          // at this file or it was given as a bare standalone path.
          openTarget = resolveProjectPath(dirnameOf(dirnameOf(input)), photoField);
          lookGraphText = text;
        }

        // job.preset REPLACES the sidecar entirely (see openImageByPath's
        // skipSidecar doc comment): open as a truly fresh doc with identity
        // geometry, which is all applyLook below actually preserves — the
        // fresh-open defaults (lens profile, base curve) it also seeds get
        // superseded a moment later when applyLook replaces the nodes/edges
        // wholesale with the preset's own, so only the identity geometry
        // survives into the final render. A look-file argument ALSO skips
        // the sidecar (lookGraphText replaces it below, geometry included —
        // unlike --preset, this IS the photo's own document, not a foreign
        // look to merge onto identity). Whichever of legacySidecarOnly/
        // cliProjectDir accompanies skipSidecar:true is moot either way
        // (openImageByPath consults skipSidecar first), so this one
        // expression covers plain images and look-file arguments alike.
        await get().openImageByPath(openTarget, {
          skipSidecar: job.preset !== null || lookGraphText !== null,
          legacySidecarOnly: job.projectDir === null,
          ...(job.projectDir !== null ? { cliProjectDir: job.projectDir } : {}),
        });
        if (get().imageStatus !== 'ready') {
          throw new Error(get().imageError ?? `failed to open ${openTarget}`);
        }

        if (lookGraphText !== null) {
          // Full graph replace (geometry included) — the same "this text IS
          // the photo's own document" shape hot-reload's readAndParseSidecar
          // uses, NOT applyLook's preset-style merge (which deliberately
          // discards geometry — wrong here, this look already has its own).
          const { width, height } = get().image!;
          const parsed = parseGraphDoc(lookGraphText, { width, height });
          set({ graph: parsed.graph, graphDirty: false });
          revalidateShaders(parsed.graph);
        }

        if (job.preset !== null) {
          const text = await readCliPresetText(job.preset);
          const { look } = parsePresetFile(text);
          let nextGraph: GraphDoc | null = null;
          set((s) => {
            const patch = applyLook(s, look);
            nextGraph = patch.graph;
            return patch;
          });
          if (nextGraph) revalidateShaders(nextGraph);
        }

        // DCP camera-profile mode (docs/brief-bank/dcp-profile.md): the
        // headless CLI must not race the (async, file-IO-bound) DCP bake —
        // unlike the interactive app's fire-and-forget refresh inside
        // openImageByPath (a live preview just re-renders once the bake
        // lands), a CLI render is a ONE-SHOT action with no second chance.
        // Awaited HERE (after openImageByPath, the lookGraphText full-graph
        // replace, and any --preset apply above — whichever of those actually
        // set the FINAL develop.profile.dcpPath this render should use).
        await get().refreshDcpProfile();

        const outputs = get().graph.nodes.filter((n) => n.kind === 'output');
        const targets =
          job.output === 'all'
            ? outputs
            : job.output !== null
              ? outputs.filter((n) => outputName(n) === job.output)
              : outputs.slice(0, 1); // no --output: the doc's first, per the CLI contract
        if (targets.length === 0) {
          throw new Error(
            job.output !== null && job.output !== 'all' ? `no output named "${job.output}"` : 'document has no output nodes'
          );
        }

        // The PHOTO's own basename (openTarget), not the look-file argument's
        // — a look-file render must produce the exact same output filename
        // an equivalent --project image render of the same photo would.
        const basePath = cliOutputPath(openTarget, job.outDir);
        const used = new Set<string>();
        for (const node of targets) {
          // same disambiguation as exportSelectedOutputs: single target keeps
          // the base path as-is, 2+ (an explicit 'all') get suffixed, with a
          // numeric tiebreaker for colliding output names.
          let outPath = targets.length > 1 ? suffixExportPath(basePath, outputName(node)) : basePath;
          for (let n = 2; used.has(outPath); n++) outPath = suffixExportPath(basePath, `${outputName(node)}-${n}`);
          used.add(outPath);
          const result = await exportOnePath(
            outPath,
            node.id,
            {
              quality: job.quality,
              maxDim: job.maxDim,
              metadata: job.metadata,
              colorSpace: job.colorSpace,
            },
            job.allowExternal
          );
          onResult({
            input,
            output: outPath,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            ms: Date.now() - startedAt,
            ...(result.warnings ? { warnings: result.warnings } : {}),
          });
        }
      } catch (err) {
        onResult({ input, error: err instanceof Error ? err.message : String(err) });
      }
    }
  },

  async runCliCheck(job, onResult) {
    for (const input of job.images) {
      try {
        // --skip-rejected (reject-flag pack): unlike --min-rating (rejected
        // outright with --check, see parseCliArgs), this ALSO applies to
        // golden checks — same cheap pre-decode read runCliRender uses,
        // BEFORE opening/rendering/comparing anything.
        if (job.skipRejected && (await readSidecarWrapperMetaCheap(input)).flag === 'reject') {
          onResult({ input, status: 'skipped-rejected' });
          continue;
        }

        // No `skipSidecar`/preset here (unlike runCliRender) — a golden
        // always represents the image's own sidecar-or-default look, the
        // same defaults rule `--render` uses without `--preset`. `--project`
        // resolves that look from the project's playlist instead of the
        // legacy adjacent sidecar (see CliCheckJob.projectDir's doc comment).
        await get().openImageByPath(input, {
          legacySidecarOnly: job.projectDir === null,
          ...(job.projectDir !== null ? { cliProjectDir: job.projectDir } : {}),
        });
        if (get().imageStatus !== 'ready') {
          throw new Error(get().imageError ?? `failed to open ${input}`);
        }
        const { imagePath, fileName, graph, renderer, project, currentLookPath } = get();
        if (!imagePath || !fileName || !renderer) throw new Error('no image open');
        const bytes = await window.silverbox.readFile(imagePath);
        const kind = isRawFileName(fileName) ? 'raw' : 'jpg';
        const full = await loadImage(bytes, kind, Number.MAX_SAFE_INTEGER, get().settings.baselineExposureEV);
        const outputs = graph.nodes.filter((n) => n.kind === 'output');
        if (outputs.length === 0) throw new Error('document has no output nodes');
        // No --output support in check mode (see CliCheckJob's doc comment)
        // — always the doc's first, same as --render's no-`--output` default.
        const outputId = outputs[0]!.id;
        const { data, width, height } = await renderer.renderToPixels(full, graph, 1, 'srgb', outputId);
        // --project's golden relocation (CliCheckJob.projectDir's doc
        // comment): `<project>/golden/<look-name>.png`, look-name = the
        // resolved look's own filename with `.json` dropped — derived from
        // `currentLookPath` (already resolved by openImageByPath's
        // `cliProjectDir` branch above), never written to the manifest.
        const goldenPath =
          job.projectDir !== null && project && currentLookPath
            ? `${project.dir}/golden/${(currentLookPath.split('/').pop() ?? currentLookPath).replace(/\.json$/, '')}.png`
            : undefined;
        const outcome = await window.silverbox.checkGoldenImage({
          input,
          data: data.buffer,
          width,
          height,
          update: job.update,
          threshold: job.threshold,
          ...(goldenPath ? { goldenPath } : {}),
        });
        onResult(outcome);
      } catch (err) {
        onResult({ input, error: err instanceof Error ? err.message : String(err) });
      }
    }
  },

  async runCliDiff(job, onResult) {
    // Resolved once known — used both for the actual render/compare AND as
    // the reported `input`; falls back to a sidecarA/B pairing string if
    // resolution itself fails, so a bad pair is still traceable in the
    // output (CliDiffResult always needs SOME `input` to report against).
    let image = job.image;
    try {
      const readText = async (path: string): Promise<string> => new TextDecoder().decode(await window.silverbox.readFile(path));
      const [textA, textB] = await Promise.all([readText(job.sidecarA), readText(job.sidecarB)]);

      if (image === null) {
        // `--image` omitted (CLI tooling parity item 4): derive it from both
        // sidecars' `photo` field — a cheap top-level JSON.parse (NOT the
        // full parseGraphDoc, which needs image dims we don't have yet),
        // each resolved relative to ITS OWN project dir (parent of looks/),
        // the same rule runCliRender's look-file handling uses.
        const photoOf = (text: string, sidecarPath: string): string | null => {
          try {
            const photo = (JSON.parse(text) as { photo?: unknown }).photo;
            return typeof photo === 'string' && photo.trim() !== ''
              ? resolveProjectPath(dirnameOf(dirnameOf(sidecarPath)), photo)
              : null;
          } catch {
            return null;
          }
        };
        const photoA = photoOf(textA, job.sidecarA);
        const photoB = photoOf(textB, job.sidecarB);
        if (photoA !== null && photoA === photoB) {
          image = photoA;
        } else {
          throw new Error(
            '--diff needs --image <path>: could not derive it — both sidecars must carry a matching `photo` field (pass --image explicitly otherwise)'
          );
        }
      }

      // openImageByPath's job here is ONLY to get an image decoded and the
      // render-worker client mounted (CanvasView's client only exists once
      // `image` is set — see its own doc comment) — its OWN sidecar-or-
      // default `graph` result is discarded entirely below; sidecarA/
      // sidecarB are parsed and rendered as two INDEPENDENT docs, same
      // "supply my own graph, ignore whatever's open" shape exportOnePath
      // already uses for ordinary exports.
      await get().openImageByPath(image, { legacySidecarOnly: true });
      if (get().imageStatus !== 'ready') {
        throw new Error(get().imageError ?? `failed to open ${image}`);
      }
      const { renderer } = get();
      if (!renderer) throw new Error('no image open');

      const kind = isRawFileName(image) ? 'raw' : 'jpg';
      const baselineExposureEV = get().settings.baselineExposureEV;
      // loadImage ALSO transfers (detaches) its own `bytes` ArrayBuffer to
      // the decode worker — on top of renderToPixels transferring the
      // resulting PreparedImage's data (see this function's own comment
      // below) — so every decode needs its own FRESH readFile, not a shared
      // `bytes` reused across the two loadImage calls.
      const fullA = await loadImage(await window.silverbox.readFile(image), kind, Number.MAX_SAFE_INTEGER, baselineExposureEV);
      const dims = { width: fullA.width, height: fullA.height };
      const parsedA = parseGraphDoc(textA, dims);
      const parsedB = parseGraphDoc(textB, dims);
      const lines = diffLook(parsedA, parsedB);

      // renderToPixels TRANSFERS its PreparedImage's data buffer (see
      // exportOnePath's own doc comment) — a fresh decode per render, not a
      // shared `full` reused across both docs.
      const renderA = await renderer.renderToPixels(fullA, parsedA.graph, 1, 'srgb');
      const fullB = await loadImage(await window.silverbox.readFile(image), kind, Number.MAX_SAFE_INTEGER, baselineExposureEV);
      const renderB = await renderer.renderToPixels(fullB, parsedB.graph, 1, 'srgb');

      if (renderA.width !== renderB.width || renderA.height !== renderB.height) {
        // A geometry difference (e.g. a crop) that changed the rendered
        // dimensions — reported, not resampled to force a comparison (same
        // policy as --check's own dims-changed). The param lines above are
        // unaffected — they need no successful pixel comparison at all.
        onResult({ input: image, lines, status: 'dims-changed' });
        return;
      }
      const { deltaE } = await window.silverbox.diffRenderImages({
        dataA: renderA.data.buffer,
        dataB: renderB.data.buffer,
        width: renderA.width,
        height: renderA.height,
      });
      onResult({ input: image, lines, deltaE });
    } catch (err) {
      onResult({ input: image ?? `${job.sidecarA} vs ${job.sidecarB}`, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async runCliExtractLook(job, onResult) {
    try {
      if (job.families !== null) {
        const invalidIds = job.families.filter((id) => !isValidDevelopFamilyId(id));
        if (invalidIds.length > 0) {
          throw new Error(`--families has unknown or structural id(s): ${invalidIds.join(', ')} (structural families — geometry/spots/masks/custom-nodes — are never part of a look)`);
        }
      }
      const families = job.families?.filter(isValidDevelopFamilyId);

      const developsList = await Promise.all(
        job.looks.map(async (path) => {
          const text = new TextDecoder().decode(await window.silverbox.readFile(path));
          let parsed: SidecarDoc;
          try {
            // No srcDims: this mode only ever reads a Develop node's own
            // params (never masks/spots/geometry — see this function's own
            // doc comment), so there is nothing an anchor-space migration
            // would need dims for.
            parsed = parseGraphDoc(text);
          } catch (err) {
            throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
          }
          const devNode = parsed.graph.nodes.find((n) => n.kind === DEVELOP_KIND && n.develop);
          if (!devNode?.develop) throw new Error(`${path}: no Develop node found — nothing to extract a look from`);
          return devNode.develop;
        })
      );

      const consensus = computeLookConsensus(developsList, {
        families,
        minAgreement: job.minAgreement ?? undefined,
      });
      const graph = defaultGraphDoc();
      const devNode = graph.nodes.find((n) => n.kind === DEVELOP_KIND)!;
      devNode.develop = consensus.params;
      const name = job.outPath.split(/[\\/]/).pop()?.replace(/\.json$/i, '') || 'Extracted look';
      const content = serializePreset(name, graph, new Date().toISOString(), undefined, consensus.includes);
      await window.silverbox.writeExtractedPreset(job.outPath, content);

      const excluded = consensus.reports.filter((r) => !r.included).map((r) => r.family);
      const report = formatConsensusReport(consensus.reports);
      onResult({ input: job.outPath, outputPath: job.outPath, includes: consensus.includes, excluded, report });
    } catch (err) {
      onResult({ input: job.outPath, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async runCliExtractReferences(job, onResult) {
    try {
      // Decode each reference at the interactive preview resolution — a look
      // signature is a percentile DISTRIBUTION, statistically identical at
      // preview vs full res (imageLumaPercentiles strides to a sample cap
      // regardless), and preview res bounds memory across a set. RAW gets the
      // same baseline-exposure decode gain the app's normal open (and the base
      // curve the tone solve reuses) uses; ignored for JPEG.
      const { previewLongEdge, baselineExposureEV } = get().settings;
      const images = [];
      for (const path of job.references) {
        const bytes = await window.silverbox.readFile(path);
        const kind = isRawFileName(path) ? 'raw' : 'jpg';
        let prepared;
        try {
          prepared = await loadImage(bytes, kind, previewLongEdge, baselineExposureEV);
        } catch (err) {
          throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        images.push({ data: prepared.data, width: prepared.width, height: prepared.height });
      }

      // Freeze stage 1 (luma tone) ONLY — solve the tone curve that maps the
      // PLACEHOLDER neutral baseline (stage-2 TODO: bundled corpus) toward the
      // reference set's luma signature; the color/grain stages are deferred.
      const signature = aggregateSignature(images);
      const { curve, report } = solveToneCurve(PLACEHOLDER_BASELINE_SIGNATURE, signature);

      const develop = defaultDevelopParams();
      develop.toneCurve = { ...develop.toneCurve, rgb: curve };
      const graph = defaultGraphDoc();
      const devNode = graph.nodes.find((n) => n.kind === DEVELOP_KIND)!;
      devNode.develop = develop;
      const name = job.outPath.split(/[\\/]/).pop()?.replace(/\.json$/i, '') || 'Extracted look';
      // A curves-only preset: only the tone curve was solved this stage, so
      // that's the one family `includes` gates on apply (same scoping mode 1
      // uses — everything else stays at identity/default).
      const content = serializePreset(name, graph, new Date().toISOString(), undefined, ['curves']);
      await window.silverbox.writeExtractedPreset(job.outPath, content);

      onResult({
        input: job.outPath,
        outputPath: job.outPath,
        solved: report.solved,
        deferred: report.deferred,
        imageCount: signature.imageCount,
        report: formatToneSolveReport(report, signature.imageCount),
      });
    } catch (err) {
      onResult({ input: job.outPath, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async exportLut(path) {
    const { imagePath, fileName, graph, wbModel, imageStatus, exportStatus, activeOutputId } = get();
    if (!imagePath || !fileName || imageStatus !== 'ready' || exportStatus === 'working') return;
    let basePath = path ?? null;
    if (!basePath) {
      const result = await window.silverbox.exportLutDialog(imagePath.replace(/\.[^.]+$/, '') + '-lut.cube');
      if (result.canceled) return;
      basePath = result.path.replace(/\.cube$/i, '');
    }
    set({ exportStatus: 'working', exportError: null, exportLutInfo: null });
    try {
      const name = basePath.split(/[\\/]/).pop() || 'silverbox-lut';
      const { cubeText, unityRgba, ueRgba, webglText, skipped } = buildLutExport(
        graph,
        wbModel,
        activeOutputId ?? undefined,
        name
      );
      const result = await window.silverbox.exportLut({
        basePath,
        name,
        cubeText,
        unityRgba: unityRgba.buffer as ArrayBuffer,
        ueRgba: ueRgba.buffer as ArrayBuffer,
        webglText,
      });
      set({ exportStatus: 'idle', exportLutInfo: { count: result.paths.length, paths: result.paths, skipped } });
    } catch (err) {
      set({ exportStatus: 'error', exportError: err instanceof Error ? err.message : String(err) });
    }
  },

  async setRating(rating, lookPath) {
    const s = get();
    const next = sanitizeRating(rating);
    if (lookPath === undefined || lookPath === s.currentLookPath) {
      // The CANVAS photo: update the live in-memory state and let the
      // ordinary autosave/⌘S pipeline persist it.
      if (!s.imagePath) return; // no image open: nothing to rate, and no sidecar to eventually write it to
      if (next === s.sidecarRating) return; // e.g. pressing the same star twice — nothing changed, nothing to save
      // Global-undo (docs/brief-bank/global-undo.md, decision 2): rating IS
      // in the undoable scope now — pushes a 'rating' entry onto the SAME
      // global stack every graph edit uses (see AppState.sidecarRating's
      // doc comment; this supersedes the old "ratings never undo"
      // contract). graphDirty:true still marks the doc dirty so autosave
      // persists it (the bottom-of-file autosave subscribe watches
      // sidecarRating in addition to `graph` for exactly this reason — a
      // rating-only change never touches `graph` itself).
      const entry: RatingUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'rating',
        label: `Set rating to ${next}`,
        target: s.imagePath,
        before: s.sidecarRating,
      };
      set((st) => ({ sidecarRating: next, graphDirty: true, undoStack: pushUndoEntry(st.undoStack, entry) }));
      return;
    }
    // Any OTHER look file — the explicit-look-path seam multi-select's key
    // fan-out uses, same shape as setFlag's own OTHER-look branch (see its
    // doc comment for the owner-photo-path resolution this mirrors exactly).
    const project = s.project;
    const ownerRow = project?.photos.find((p) => `${project.dir}/looks/${p.look}` === lookPath);
    const ownerPhotoPath = project && ownerRow ? resolveProjectPath(project.dir, ownerRow.path) : null;

    let existingText: string | null = null;
    try {
      existingText = await window.silverbox.readSidecar(lookPath);
    } catch (err) {
      console.warn(`setRating: could not read ${lookPath}:`, err);
      return;
    }
    let before: number;
    let content: string;
    if (existingText === null) {
      before = 0;
      if (next === 0) return; // nothing to clear, nothing to save — don't create a bare look file for a no-op
      content = serializeGraphDoc(defaultGraphDoc(), null, null, undefined, next);
    } else {
      let parsed: SidecarDoc;
      try {
        parsed = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`setRating: ${lookPath} is unreadable by this build, leaving it untouched:`, err);
        return;
      }
      before = parsed.rating;
      if (before === next) return; // no-op, nothing to save
      content = serializeGraphDoc(
        parsed.graph,
        parsed.source ?? null,
        parsed.createdAt ?? null,
        parsed.unknown,
        next,
        parsed.photo,
        parsed.fingerprint,
        parsed.flag
      );
    }
    await window.silverbox.writeSidecar(lookPath, content);
    if (ownerPhotoPath) {
      const entry: RatingUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'rating',
        label: `Set rating to ${next}`,
        target: ownerPhotoPath,
        before,
        after: next,
      };
      set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    }
  },

  async setFlag(lookPath, flag) {
    const next = sanitizeFlag(flag ?? undefined) ?? null;
    // The CANVAS photo (today's only caller — App.tsx's p/x/u keys): update
    // the live in-memory state and let the ordinary autosave/⌘S pipeline
    // persist it. Global-undo (decision 2): pushes a 'flag' entry onto the
    // SAME global stack rating does (see AppState.sidecarFlag's own doc
    // comment for why this branches on the EXPLICIT `lookPath` argument
    // matching `currentLookPath` rather than assuming "the current photo"
    // implicitly).
    if (lookPath === get().currentLookPath) {
      const s = get();
      if (next === s.sidecarFlag) return; // no-op, nothing to save
      if (!s.imagePath) {
        // Defensive only: currentLookPath implies an open photo in every real
        // caller, but without one there's no `target` to tag the entry with.
        set({ sidecarFlag: next, graphDirty: true });
        return;
      }
      const entry: FlagUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'flag',
        label: next === 'pick' ? 'Pick' : next === 'reject' ? 'Reject' : 'Unflag',
        target: s.imagePath,
        before: s.sidecarFlag,
      };
      set((st) => ({ sidecarFlag: next, graphDirty: true, undoStack: pushUndoEntry(st.undoStack, entry) }));
      return;
    }
    // Any OTHER look file — the explicit-look-path seam multi-select's
    // rating/flag key fan-out uses (docs/brief-bank/multi-select-sync.md): a
    // direct read-patch-write against ITS OWN file, independent of whatever
    // graph happens to be in memory right now (mirrors relinkPhoto's own
    // read-patch-write shape above), since that photo isn't necessarily
    // open/decoded at all. Resolves the OWNING photo path (for the undo
    // entry's `target`, which ⌘Z jumps to) via the active project's
    // playlist row whose `look` filename matches `lookPath` — every real
    // caller only ever passes a path drawn from that same playlist, so this
    // always resolves; the write still happens even without a project/match
    // (defensive), just without an undo entry (nothing sane to jump to).
    const project = get().project;
    const ownerRow = project?.photos.find((p) => `${project.dir}/looks/${p.look}` === lookPath);
    const ownerPhotoPath = project && ownerRow ? resolveProjectPath(project.dir, ownerRow.path) : null;

    let existingText: string | null = null;
    try {
      existingText = await window.silverbox.readSidecar(lookPath);
    } catch (err) {
      console.warn(`setFlag: could not read ${lookPath}:`, err);
      return;
    }
    let before: PhotoFlag | null;
    let content: string;
    if (existingText === null) {
      before = null;
      if (next === null) return; // nothing to clear, nothing to save — don't create a bare look file for a no-op
      // No look yet for this photo — write a fresh minimal one carrying
      // just the flag (same shape presetDoc.ts's captureLook round-trip
      // already produces for a document with no per-photo metadata yet).
      content = serializeGraphDoc(defaultGraphDoc(), null, null, undefined, 0, undefined, undefined, next);
    } else {
      let parsed: SidecarDoc;
      try {
        parsed = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`setFlag: ${lookPath} is unreadable by this build, leaving it untouched:`, err);
        return;
      }
      before = parsed.flag ?? null;
      if (before === next) return; // no-op, nothing to save
      content = serializeGraphDoc(
        parsed.graph,
        parsed.source ?? null,
        parsed.createdAt ?? null,
        parsed.unknown,
        parsed.rating,
        parsed.photo,
        parsed.fingerprint,
        next ?? undefined
      );
    }
    await window.silverbox.writeSidecar(lookPath, content);
    if (ownerPhotoPath) {
      const entry: FlagUndoEntry = {
        seq: nextUndoSeq(),
        at: Date.now(),
        kind: 'flag',
        label: next === 'pick' ? 'Pick' : next === 'reject' ? 'Reject' : 'Unflag',
        target: ownerPhotoPath,
        before,
        after: next,
      };
      set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    }
  },

  setFilmstripSelection(paths) {
    set((s) => ({ filmstripSelection: Array.from(new Set(paths.filter((p) => p !== s.imagePath))) }));
  },

  toggleFilmstripSelection(path) {
    set((s) => {
      if (path === s.imagePath) return {}; // the primary can't be toggled out — see this field's own doc comment
      const has = s.filmstripSelection.includes(path);
      return { filmstripSelection: has ? s.filmstripSelection.filter((p) => p !== path) : [...s.filmstripSelection, path] };
    });
  },

  setFilmstripSelectionAnchor(path) {
    set({ filmstripSelectionAnchor: path });
  },

  rangeSelectFilmstrip(path, order) {
    set((s) => {
      const anchor = s.filmstripSelectionAnchor ?? s.imagePath;
      const anchorIndex = anchor ? order.indexOf(anchor) : -1;
      const clickedIndex = order.indexOf(path);
      if (anchorIndex === -1 || clickedIndex === -1) {
        return { filmstripSelection: path === s.imagePath ? [] : [path] };
      }
      const [lo, hi] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
      return { filmstripSelection: order.slice(lo, hi + 1).filter((p) => p !== s.imagePath) };
    });
  },

  lookPathForPhoto(photoPath) {
    const project = get().project;
    if (!project) return null;
    const row = findPlaylistPhoto(project, photoPath);
    return row ? `${project.dir}/looks/${row.look}` : null;
  },

  async applyPresetToSelection(slug) {
    const s = get();
    const primaryPath = s.imagePath;
    if (!primaryPath || s.imageStatus !== 'ready') return;
    const project = s.project;
    if (!project) return;
    // Primary excluded, everything else in filmstripSelection is a
    // secondary target.
    const secondaryTargets = s.filmstripSelection.filter((p) => p !== primaryPath);
    if (secondaryTargets.length === 0) {
      // No secondary selection: brief's explicit "no behavior change for the
      // 1-photo case" — defer to the existing single-photo apply verbatim
      // (its own 'preset-apply' undo entry, no SyncUndoEntry batch).
      await get().applyPreset(slug);
      return;
    }

    const text = await window.silverbox.presetRead(slug);
    if (!text) return;
    let parsed: ParsedPreset;
    try {
      parsed = parsePresetFile(text);
    } catch (err) {
      console.warn(`preset "${slug}" could not be parsed:`, err);
      return;
    }

    // Scope law (brief): the preset's OWN saved `includes` governs — no
    // apply-time dialog. Absent `includes` (a pre-scoping whole-look file,
    // predating preset-scoping-and-export-overrides.md) is treated as every
    // family except geometry, mirroring applyLook's own single-photo
    // "whole look, geometry excluded" shape — the one case the brief itself
    // doesn't pin down (every preset saved through today's UI carries
    // `includes`; see this action's own doc comment).
    const families = new Set<PresetFamilyId>(
      parsed.includes ? parsed.includes.filter(isKnownFamilyId) : ALL_FAMILY_IDS.filter((id) => id !== 'geometry')
    );

    const before: Record<string, GraphDoc> = {};
    const after: Record<string, GraphDoc> = {};
    const skippedByFamily: Record<string, number> = {};
    let errorCount = 0;

    // --- Primary (the open photo): merge onto its LIVE graph, the same
    // scoped-merge path applyPreset's own scoped branch (applyParsedPreset)
    // uses — chainScope'd to the active-output chain exactly like that
    // branch, via the SAME shared helper the secondaries' loop below uses.
    const primaryScope = chainScope(s.graph, s.activeOutputId);
    const { merged: primaryAfter, skipped: primarySkipped } = mergeFamiliesWithSkipDetection(
      s.graph,
      parsed.look,
      families,
      primaryScope
    );
    for (const fam of primarySkipped) skippedByFamily[fam] = (skippedByFamily[fam] ?? 0) + 1;
    before[primaryPath] = structuredClone(s.graph);
    after[primaryPath] = primaryAfter;

    // --- Secondaries: the shared read-existing/seed-if-absent/merge/write
    // loop this file's batch writers all follow, with the preset's OWN
    // `look` playing the role a captured primary look plays elsewhere.
    for (const photoPath of secondaryTargets) {
      const row = findPlaylistPhoto(project, photoPath);
      if (!row) {
        errorCount++;
        continue;
      }
      const lookPath = `${project.dir}/looks/${row.look}`;
      let existingText: string | null = null;
      try {
        existingText = await window.silverbox.readSidecar(lookPath);
      } catch (err) {
        console.warn(`applyPresetToSelection: could not read ${lookPath}:`, err);
        errorCount++;
        continue;
      }

      let baseGraph: GraphDoc;
      let meta: {
        source: SidecarSource | null;
        createdAt: string | null;
        unknown: Record<string, unknown> | undefined;
        rating: number;
        photo: string | undefined;
        fingerprint: string | undefined;
        flag: PhotoFlag | undefined;
      };
      if (existingText !== null) {
        let parsedLook: SidecarDoc;
        try {
          parsedLook = parseGraphDoc(existingText);
        } catch (err) {
          console.warn(`applyPresetToSelection: ${lookPath} is unreadable by this build, skipping:`, err);
          errorCount++;
          continue;
        }
        baseGraph = parsedLook.graph;
        meta = {
          source: parsedLook.source ?? null,
          createdAt: parsedLook.createdAt ?? null,
          unknown: parsedLook.unknown,
          rating: parsedLook.rating,
          photo: parsedLook.photo,
          fingerprint: parsedLook.fingerprint,
          flag: parsedLook.flag,
        };
      } else {
        // No look yet — seed it exactly like a fresh open would, THEN merge
        // the preset's families onto it, so the file this creates is never
        // a bare default doc.
        try {
          const bytes = await window.silverbox.readFile(photoPath);
          const kind: 'raw' | 'jpg' = isRawFileName(photoPath) ? 'raw' : 'jpg';
          const image = await loadImage(bytes, kind, undefined, s.settings.baselineExposureEV);
          baseGraph = seedDefaultLook(defaultGraphDoc(), image, {
            usedSidecar: false,
            kind,
            testFlags: window.silverbox.testFlags,
          }).graph;
          const fingerprint = (await computeFingerprintCached(photoPath)) ?? undefined;
          meta = {
            source: {
              fileName: photoPath.split('/').pop() ?? photoPath,
              ...(image.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
              kind,
            },
            createdAt: new Date().toISOString(),
            unknown: undefined,
            rating: 0,
            photo: relativizeProjectPath(project.dir, photoPath),
            fingerprint,
            flag: undefined,
          };
        } catch (err) {
          console.warn(`applyPresetToSelection: could not decode ${photoPath} to seed a fresh look:`, err);
          errorCount++;
          continue;
        }
      }

      // Target-side scoping fix (virtual-copy.md): "activeOutputId ??
      // first" fallback rule (chainScope with `null` — this target photo
      // isn't open, so there's no live activeOutputId for it).
      const targetScope = chainScope(baseGraph, null);
      const { merged: mergedGraph, skipped } = mergeFamiliesWithSkipDetection(baseGraph, parsed.look, families, targetScope);
      for (const fam of skipped) skippedByFamily[fam] = (skippedByFamily[fam] ?? 0) + 1;
      const content = serializeGraphDoc(
        mergedGraph,
        meta.source,
        meta.createdAt,
        meta.unknown,
        meta.rating,
        meta.photo,
        meta.fingerprint,
        meta.flag
      );
      try {
        await window.silverbox.writeSidecar(lookPath, content);
      } catch (err) {
        console.warn(`applyPresetToSelection: could not write ${lookPath}:`, err);
        errorCount++;
        continue;
      }
      before[photoPath] = structuredClone(baseGraph);
      after[photoPath] = mergedGraph;
    }

    // --- Apply to the live graph + persist the open photo right away
    // (flush discipline — see this action's own doc comment): the preset
    // applies TO the primary too, so its look file must land on disk now,
    // not 1000ms later on the ordinary autosave debounce.
    set({ graph: primaryAfter, graphDirty: true });
    revalidateShaders(primaryAfter);
    await get().saveGraph();

    const writtenTargets = Object.keys(after);
    const entry: SyncUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'sync',
      label: `Apply "${parsed.name}" to ${writtenTargets.length} look${writtenTargets.length === 1 ? '' : 's'}`,
      targets: writtenTargets,
      before,
      after,
    };
    set((st) => ({ undoStack: pushUndoEntry(st.undoStack, entry) }));
    // Develop-aware filmstrip thumbnails (semantic 3's apply-preset-to-
    // selection trigger).
    get().bumpLookVersion(writtenTargets);
    await get().refreshPlaylistStatus();

    const skipParts = Object.entries(skippedByFamily).map(([fam, n]) => `${fam} on ${n} (incompatible chain)`);
    const skipSuffix = skipParts.length > 0 ? `; skipped ${skipParts.join(', ')}` : '';
    const errorSuffix = errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? '' : 's'})` : '';
    raiseNotice('projectNotice', {
      kind: errorCount > 0 ? 'error' : 'success',
      message: `applied "${parsed.name}" to ${writtenTargets.length} photo${writtenTargets.length === 1 ? '' : 's'}${skipSuffix}${errorSuffix}`,
    });
  },

  async removeFromProject(paths) {
    const s = get();
    const project = s.project;
    if (!project || paths.length === 0) return;
    const pathSet = new Set(paths);
    const removed: { index: number; photo: ProjectPhoto }[] = [];
    const remaining: ProjectPhoto[] = [];
    project.photos.forEach((p, index) => {
      if (pathSet.has(resolveProjectPath(project.dir, p.path))) removed.push({ index, photo: p });
      else remaining.push(p);
    });
    if (removed.length === 0) return;
    const updatedProject: ActiveProject = { ...project, photos: remaining };
    const entry: RemovePhotosUndoEntry = {
      seq: nextUndoSeq(),
      at: Date.now(),
      kind: 'remove-photos',
      label: `Remove ${removed.length} photo${removed.length === 1 ? '' : 's'} from project`,
      projectDir: project.dir,
      removed,
    };
    // Snapshot the PRE-removal strip order for the neighbor search below —
    // folderEntries is about to go stale the instant `project` changes.
    const priorFolderEntries = s.folderEntries;
    set((st) => ({
      project: updatedProject,
      filmstripSelection: st.filmstripSelection.filter((p) => !pathSet.has(p)),
      undoStack: pushUndoEntry(st.undoStack, entry),
    }));
    if (s.imagePath && pathSet.has(s.imagePath)) {
      // The currently open photo was removed — step to the nearest
      // remaining neighbor by the strip's own (pre-removal) sort order,
      // walking outward on both sides so a removal in the middle of a
      // contiguous multi-select still lands on the closest survivor.
      const idx = priorFolderEntries.findIndex((e) => e.path === s.imagePath);
      let neighbor: string | null = null;
      for (let d = 1; idx !== -1 && d < priorFolderEntries.length && neighbor === null; d++) {
        const after = priorFolderEntries[idx + d];
        if (after && !pathSet.has(after.path)) {
          neighbor = after.path;
          break;
        }
        const before = priorFolderEntries[idx - d];
        if (before && !pathSet.has(before.path)) {
          neighbor = before.path;
          break;
        }
      }
      if (neighbor) {
        await get().openImageByPath(neighbor, { keepFolderContext: true });
      } else {
        // Nothing left on the playlist — fall to the empty state (the
        // project stays active, just with nothing open; openImageByPath's
        // own flush-on-switch precedent doesn't apply here since we're not
        // opening anything, so flush explicitly first).
        await flushPendingAutosave(get());
        cancelAutosaveTimer();
        set(emptyPhotoFields());
      }
    }
    await get().refreshPlaylistStatus();
  },

  async saveGraph() {
    // an explicit save (⌘S, or autosave's own timer firing) always cancels
    // any still-pending autosave — nothing left to race it afterward
    cancelAutosaveTimer();
    // capture-then-write (shared with flushPendingAutosave — see its own
    // doc comment): captured synchronously here, so the write below can take
    // as long as it needs without reading `get()` again.
    const snapshot = captureGraphSaveSnapshot(get());
    if (!snapshot) return;
    // Epoch token, same reasoning as flushPendingAutosave's own: `imagePath`
    // equality alone can't tell "still this save" apart from "a LATER
    // reopen of the same path" (e.g. ⌘S, then immediately reopening the
    // SAME photo before this write resolves — imagePath reads the same
    // either way).
    const epochAtCapture = OpenSession.currentEpoch();
    const result = await writeGraphSaveSnapshot(snapshot);
    // A photo switch racing this exact await (⌘S, then immediately clicking
    // another filmstrip photo before the write resolves) must not stomp the
    // NEW photo's state with THIS photo's bookkeeping — same guard
    // flushPendingAutosave uses. The disk write already happened either way.
    if (OpenSession.currentEpoch() !== epochAtCapture) return;
    if (get().imagePath !== snapshot.imagePath) return;
    // Record exactly what we just wrote (hot-reload's self-write-suppression
    // baseline) and clear any hot-reload notice: our edits just overwrote
    // disk, resolving whatever pending/malformed conflict was showing (see
    // AppState.sidecarHotReloadNotice's doc comment). The fs-watch echo of
    // THIS write will read back identical text and be ignored silently.
    set({
      graphDirty: false,
      sidecarCreatedAt: result.createdAt,
      sidecarFingerprint: result.fingerprint,
      sidecarPhotoAtOpen: result.photo,
      lastSidecarText: result.content,
      sidecarHotReloadNotice: null,
    });
  },

  async importLegacySidecar() {
    const { legacySidecarImportNotice, imagePath, image, project } = get();
    if (!legacySidecarImportNotice || !imagePath || !image || !project) return;
    if (legacySidecarImportNotice.imagePath !== imagePath) return; // stale offer — a different image is open now
    let text: string | null;
    try {
      text = await window.silverbox.readSidecar(legacySidecarImportNotice.sidecarPath);
    } catch (err) {
      set({ sidecarNotice: `could not import legacy sidecar: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (text === null) {
      // vanished since the offer was made — nothing to import anymore
      set({ legacySidecarImportNotice: null });
      return;
    }
    try {
      const content = await buildImportedLookContent(project, imagePath, text, { width: image.width, height: image.height });
      await window.silverbox.writeSidecar(legacySidecarImportNotice.lookPath, content);
      set({ legacySidecarImportNotice: null });
      // Re-open exactly like any other open: the just-written look is now
      // there to be found, so this reuses the normal read path (and its
      // usedSidecar/seedDefaultLook semantics) instead of duplicating it.
      await get().openImageByPath(imagePath, { keepFolderContext: true });
    } catch (err) {
      set({ sidecarNotice: `legacy sidecar is unreadable, nothing imported: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  async importSidecarsFromFolder(dir) {
    const project = await ensureActiveProject();
    let sidecarPaths: string[];
    try {
      sidecarPaths = await window.silverbox.listSidecarFiles(dir);
    } catch (err) {
      raiseNotice('projectNotice', {
        kind: 'error',
        message: `could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { imported: 0, skippedExisting: 0, skippedUnreadable: 0 };
    }
    let photos = project.photos;
    const byAbsPath = new Map(photos.map((p) => [resolveProjectPath(project.dir, p.path), p.look]));
    let imported = 0;
    let skippedExisting = 0;
    let skippedUnreadable = 0;
    for (const sidecarPath of sidecarPaths) {
      const imagePath = sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
      // Same identity rule as ensureProjectAndAddPhoto/openFolder — never
      // re-import a photo already on the playlist (report it, don't skip
      // silently — the completion notice's own "M skipped" count).
      if (findPlaylistPhoto({ ...project, photos }, imagePath)) {
        skippedExisting++;
        continue;
      }
      let text: string | null;
      try {
        text = await window.silverbox.readSidecar(sidecarPath);
      } catch {
        text = null;
      }
      if (text === null) {
        skippedUnreadable++;
        continue;
      }
      let content: string;
      try {
        // No decoded dims for a folder photo we haven't opened — see
        // buildImportedLookContent's own doc comment on the dimensionless-
        // caller tradeoff this accepts.
        content = await buildImportedLookContent(project, imagePath, text);
      } catch (err) {
        console.warn(`importSidecarsFromFolder: skipping unreadable sidecar ${sidecarPath}:`, err);
        skippedUnreadable++;
        continue;
      }
      const look = deriveLookName(imagePath, byAbsPath);
      await window.silverbox.writeSidecar(`${project.dir}/looks/${look}`, content);
      byAbsPath.set(imagePath, look);
      photos = [...photos, { path: relativizeProjectPath(project.dir, imagePath), look }];
      imported++;
    }
    if (photos !== project.photos) set({ project: { ...project, photos } });
    // 'error' (persistent) when anything came back unreadable — that's
    // worth the user's attention, not a clean completion; 'success' (~8s
    // auto-clear) otherwise. NG2 fix pack: this is the notice that used to
    // stay on screen forever.
    raiseNotice('projectNotice', {
      kind: skippedUnreadable > 0 ? 'error' : 'success',
      message: `imported ${imported} look${imported === 1 ? '' : 's'} (${skippedExisting} skipped: already in project, ${skippedUnreadable} unreadable)`,
    });
    // NG3 fix pack: one shared refresh (folderEntries repaint + the
    // CURRENT photo's own missing check), not another one-off
    // buildPlaylistEntries call.
    await get().refreshPlaylistStatus();
    return { imported, skippedExisting, skippedUnreadable };
  },

  async relinkPhoto(playlistIndex, newPath, force = false) {
    const project = get().project;
    const row = project?.photos[playlistIndex];
    if (!project || !row) return 'error';
    const newFingerprint = await computeFingerprintCached(newPath);
    if (newFingerprint === null) return 'error'; // the candidate file itself is unreadable
    const lookPath = `${project.dir}/looks/${row.look}`;
    let existingText: string | null = null;
    try {
      existingText = await window.silverbox.readSidecar(lookPath);
    } catch (err) {
      console.warn(`relinkPhoto: could not read ${lookPath}:`, err);
    }
    let existing: SidecarDoc | null = null;
    if (existingText !== null) {
      try {
        existing = parseGraphDoc(existingText);
      } catch (err) {
        console.warn(`relinkPhoto: ${lookPath} is unreadable by this build, relinking the playlist row anyway:`, err);
      }
    }
    if (existing?.fingerprint && existing.fingerprint !== newFingerprint && !force) {
      raiseNotice('relinkMismatchNotice', {
        playlistIndex,
        newPath,
        message: `${newPath.split('/').pop() ?? newPath}: fingerprint differs — relink anyway?`,
      });
      return 'mismatch';
    }
    const newRel = relativizeProjectPath(project.dir, newPath);
    const photos = project.photos.map((p, i) => (i === playlistIndex ? { ...p, path: newRel } : p));
    set({ project: { ...project, photos }, relinkMismatchNotice: null });
    if (existing) {
      // Keep `photo`/`fingerprint` in lockstep with the row's new path — a
      // LATER relink of this same row must verify against the RIGHT file,
      // not whatever this row pointed at before.
      const content = serializeGraphDoc(
        existing.graph,
        existing.source ?? null,
        existing.createdAt ?? null,
        existing.unknown,
        existing.rating,
        newRel,
        newFingerprint,
        existing.flag
      );
      await window.silverbox.writeSidecar(lookPath, content);
    }
    // NG3 fix pack: shared refresh, see refreshPlaylistStatus's doc comment.
    await get().refreshPlaylistStatus();
    return 'relinked';
  },

  dismissNotice(field) {
    set({ [field]: null } as Pick<AppState, typeof field>);
  },

  async scanFolderForRelink(playlistIndex, dir) {
    const project = get().project;
    const row = project?.photos[playlistIndex];
    if (!project || !row) return 'error';
    const lookPath = `${project.dir}/looks/${row.look}`;
    let expectedFingerprint: string | null = null;
    try {
      const text = await window.silverbox.readSidecar(lookPath);
      if (text !== null) expectedFingerprint = parseGraphDoc(text).fingerprint ?? null;
    } catch (err) {
      console.warn(`scanFolderForRelink: could not read ${lookPath}:`, err);
    }
    // The photo's own last-known basename (NOT the look's filename — a
    // collision-suffixed look like `dup.ARW-2.json` must still hint at
    // `dup.ARW`, the actual photo basename main is scanning the folder for).
    const basenameHint = row.path.split('/').pop() ?? row.path;
    const candidate = await window.silverbox.scanFolderForRelink(dir, basenameHint, expectedFingerprint);
    if (candidate === null) {
      raiseNotice('projectNotice', { kind: 'error', message: `no matching photo found in ${dir}` });
      return 'no-match';
    }
    // main already did whatever verification is possible this round trip —
    // nothing left for relinkPhoto's own mismatch gate to add.
    const result = await get().relinkPhoto(playlistIndex, candidate, true);
    return result === 'error' ? 'error' : 'relinked';
  },

  async saveQuickProjectAs(destDir) {
    const project = get().project;
    // Per-launch quick project (item A): `settings.quickProjectDir` is now a
    // ROOT, never equal to any real project's own `dir` (including the
    // active quick SESSION's own dated subdir) — `quickSessionDir` (this
    // session's resolved subdir, mirrored in state by ensureActiveProject)
    // is the identity check now, same as `testFlags.projectDirOverride`'s
    // exact-pin case.
    const quickDir = window.silverbox.testFlags.projectDirOverride ?? get().quickSessionDir;
    if (!project || !quickDir || project.dir !== quickDir) {
      return { ok: false, message: 'only the Quick project can be saved as a new project' };
    }
    const normalize = (p: string) => p.replace(/\/+$/, '');
    if (normalize(destDir) === normalize(quickDir) || normalize(destDir).startsWith(`${normalize(quickDir)}/`)) {
      return { ok: false, message: 'destination cannot be inside the Quick project' };
    }
    const lookNames = project.photos.map((p) => p.look);
    let moveResult: MoveProjectFilesResult;
    try {
      moveResult = await window.silverbox.moveProjectFiles(project.dir, destDir, lookNames);
    } catch (err) {
      // A per-FILE problem no longer throws here (main/index.ts's
      // moveProjectFiles now tolerates a missing/unreadable look — see its
      // own doc comment) — this catch is left for something batch-level
      // (destDir itself unwritable, an IPC-layer failure, …), which really
      // does mean nothing moved and nothing should be touched here.
      return { ok: false, message: `could not move project files: ${err instanceof Error ? err.message : String(err)}` };
    }
    // NG fix pack (CRITICAL — "Save as project… fails and fails SILENTLY"):
    // a row whose look had NO file to move (`missingLook`, an opened-but-
    // never-edited photo) still migrates — there's nothing left behind in
    // srcDir either way. Only a row whose look genuinely FAILED to move
    // (`failed`) stays put in the Quick project, so neither manifest ever
    // ends up pointing at a file that isn't where it says.
    const failedNames = new Set(moveResult.failed.map((f) => f.name));
    const migratedPhotos = project.photos.filter((p) => !failedNames.has(p.look));
    const stayBehindPhotos = project.photos.filter((p) => failedNames.has(p.look));
    const newPhotos: ProjectPhoto[] = migratedPhotos.map((p) => ({
      path: relativizeProjectPath(destDir, resolveProjectPath(project.dir, p.path)),
      look: p.look,
    }));
    const name = destDir.split('/').filter((s) => s.length > 0).pop() || 'Project';
    // NOT a flush site: the currently open PHOTO never changes here (only
    // which project/directory owns it, already moved on disk by
    // moveProjectFiles above) — a dirty in-memory edit stays graphDirty:true
    // and gets picked up by the next real save (⌘S, or the next edit
    // re-arming the debounce) against the repointed currentLookPath below.
    // Canceling here only prevents the OLD timer from firing against the
    // now-moved (soon target of a stale write) path in the gap before
    // currentLookPath is repointed a few lines down.
    cancelAutosaveTimer();
    const newProject: ActiveProject = { dir: destDir, name, photos: newPhotos, unknown: null };
    set({ project: newProject, folderDir: destDir });
    // Quick's OWN manifest is no longer covered by the debounced playlist-
    // save subscriber (bottom of this file) once `project` points elsewhere
    // — written here, immediately, rather than left stale on disk. Rows that
    // failed to move STAY on Quick's playlist (their look is still there) —
    // this is no longer always an empty manifest, see stayBehindPhotos above.
    const remainingQuick: ProjectManifest = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: project.name,
      photos: stayBehindPhotos,
      ...(project.unknown ? { unknown: project.unknown } : {}),
    };
    await window.silverbox.writeProjectManifest(quickDir, serializeProjectManifest(remainingQuick));
    // NG3 fix pack: shared refresh, see refreshPlaylistStatus's doc comment.
    await get().refreshPlaylistStatus();
    // The currently open photo's look lived at `<quickDir>/looks/<name>` —
    // repoint currentLookPath/the hot-reload watch at its NEW home (same
    // filename, new project dir) so the open session isn't left watching a
    // path that no longer exists. Skipped when THIS row is one that failed
    // to move — its look is still sitting at the OLD path, which is exactly
    // where currentLookPath already points, so leaving it alone is correct.
    const lookPrefix = `${project.dir}/looks/`;
    const curLookPath = get().currentLookPath;
    if (curLookPath && curLookPath.startsWith(lookPrefix)) {
      const curLookName = curLookPath.slice(lookPrefix.length);
      if (!failedNames.has(curLookName)) {
        const newLookPath = `${destDir}/looks/${curLookName}`;
        set({ currentLookPath: newLookPath });
        void window.silverbox.watchSidecar(newLookPath);
      }
    }
    // Completion notice (NG2 fix pack lifecycle — see raiseNotice): a clean
    // move (nothing missing, nothing failed) is 'success' and auto-clears;
    // anything the user should look at (a failed row) is 'error' and stays
    // until dismissed. Reuses `projectNotice`, same banner every other
    // project-op completion already surfaces through (no new modal
    // framework) — this is also the fix for "surfaces nothing on failure".
    const parts = [`moved ${moveResult.moved}`];
    if (moveResult.missingLook > 0) parts.push(`${moveResult.missingLook} no look yet`);
    if (moveResult.failed.length > 0) parts.push(`${moveResult.failed.length} failed`);
    raiseNotice('projectNotice', {
      kind: moveResult.failed.length > 0 ? 'error' : 'success',
      message: `saved as project "${name}": ${parts.join(', ')}`,
    });
    return { ok: true };
  },

  // Sidecar hot-reload (the AI-editing loop): handleExternalSidecarChange is
  // the automatic entry point, called once from preload's onSidecarChanged
  // subscription at module scope below; reloadSidecarNow is the dirty
  // session's "Reload" button. Both share readAndParseSidecar/
  // applyExternalGraph above.

  async handleExternalSidecarChange() {
    const { imagePath, image, currentLookPath } = get();
    if (!imagePath || !image || !currentLookPath) return;
    const result = await readAndParseSidecar(currentLookPath, image);
    // a slow read can resolve after a DIFFERENT image was opened meanwhile
    if (get().imagePath !== imagePath) return;
    if (!result.ok) {
      set({ sidecarHotReloadNotice: { kind: 'malformed', message: result.notice } });
      return;
    }
    if (result.text === get().lastSidecarText) return; // our own write's echo, or truly no change — ignore silently
    if (get().graphDirty) {
      // Dirty session: never auto-clobber unsaved edits (the AI-loop safety
      // valve) — persistent notice with an inline Reload action instead.
      set({
        sidecarHotReloadNotice: {
          kind: 'pending',
          message: 'sidecar changed on disk — Reload (discards your unsaved edits)',
        },
      });
      return;
    }
    // Clean session: safe to auto-reload — one undo entry, transient notice.
    let nextGraph: GraphDoc | null = null;
    set((s) => {
      const patch = applyExternalGraph(s, result.parsed, result.text);
      nextGraph = patch.graph;
      return patch;
    });
    if (nextGraph) revalidateShaders(nextGraph);
    const notice = { kind: 'reloaded' as const, message: 'sidecar reloaded from disk' };
    set({ sidecarHotReloadNotice: notice });
    setTimeout(() => {
      if (get().sidecarHotReloadNotice === notice) set({ sidecarHotReloadNotice: null });
    }, 4000);
  },

  async reloadSidecarNow() {
    const { imagePath, image, currentLookPath } = get();
    if (!imagePath || !image || !currentLookPath) return;
    const result = await readAndParseSidecar(currentLookPath, image);
    if (get().imagePath !== imagePath) return;
    if (!result.ok) {
      set({ sidecarHotReloadNotice: { kind: 'malformed', message: result.notice } });
      return;
    }
    let nextGraph: GraphDoc | null = null;
    set((s) => {
      const patch = applyExternalGraph(s, result.parsed, result.text);
      nextGraph = patch.graph;
      return patch;
    });
    if (nextGraph) revalidateShaders(nextGraph);
  },

  async showSidecarDiff() {
    const { imagePath, image, graph, sidecarRating, sidecarFlag, currentLookPath } = get();
    if (!imagePath || !image || !currentLookPath) return;
    const result = await readAndParseSidecar(currentLookPath, image);
    // a slow read can resolve after a DIFFERENT image was opened meanwhile,
    // or after the user already moved on (undo, another edit) — either way
    // `imagePath` no longer names what this read was about.
    if (get().imagePath !== imagePath) return;
    if (!result.ok) return; // readAndParseSidecar's own callers already keep sidecarHotReloadNotice honest about this
    // The CURRENT side of the comparison is built fresh from live state, not
    // from `lastSidecarText` — a dirty session's unsaved edits are exactly
    // what "Show diff" exists to let the user review BEFORE they get
    // clobbered by Reload, so the diff must reflect them.
    const currentDoc: SidecarDoc = { graph, rating: sidecarRating, ...(sidecarFlag ? { flag: sidecarFlag } : {}) };
    const lines = diffLook(currentDoc, result.parsed);
    set({ sidecarDiffDialog: { lines, externalGraph: result.parsed.graph } });
  },

  closeSidecarDiff() {
    set({ sidecarDiffDialog: null, compareDocOverride: null });
  },

  async updateSettings(partial) {
    const before = get().settings;
    const settings = await window.silverbox.settingsUpdate(partial);
    set({ settings });
    // turning autosave off must not leave a stale timer to fire once more.
    // NOT a flush site: the photo stays open (no switch), so the dirty edit
    // stays in memory and reaches disk via the next ⌘S — flushing here would
    // override the user's own "stop autosaving" choice. This falls out of
    // flushPendingAutosave's guard for free anyway: `settings` above is
    // already the NEW (autosaveSidecar: false) value by the time anything
    // downstream could call it.
    if (!settings.autosaveSidecar) cancelAutosaveTimer();
    // Round-10 fix pack item 3: baselineExposureEV is the only setting an
    // open image's DECODE depends on (previewLongEdge only affects the
    // opening preview — see reloadImageForSettings' interface doc comment —
    // and autosaveSidecar already applies live via the check above). Only
    // re-decode when the value genuinely moved, so redundant updateSettings
    // calls (e.g. the same number re-typed) don't churn the GPU texture.
    // Round-13 fix pack item 2: the re-decode itself is debounced (see
    // scheduleSettingsReload above) so a burst of changes costs one decode.
    if (partial.baselineExposureEV !== undefined && partial.baselineExposureEV !== before.baselineExposureEV) {
      await scheduleSettingsReload();
    }
  },

  async reloadImageForSettings() {
    const { imagePath, imageStatus, fileName } = get();
    if (!imagePath || !fileName || imageStatus !== 'ready') return;
    // Same epoch guard openImageByPath uses: a real open (or another reload)
    // racing this one supersedes it cleanly — see openSession.ts's doc
    // comment. No opts to pass; this session never sets an opening-preview
    // URL, so its disposer ledger stays empty (nothing for a superseding
    // session to tear down).
    const session = new OpenSession(imagePath);
    set({ settingsReloading: true });
    try {
      const bytes = await session.guard(window.silverbox.readFile(imagePath));
      const kind = isRawFileName(fileName) ? 'raw' : 'jpg';
      const image = await session.guard(
        loadImage(bytes, kind, get().settings.previewLongEdge, get().settings.baselineExposureEV)
      );
      // Deliberately narrow: graph/history/dirty/sidecar/crop-mode/etc. are
      // ALL left exactly as they are — this is a pixel refresh, not a
      // re-open. CanvasView's own effect (watching `image` by reference)
      // pushes the new texture to the render worker and re-renders.
      set({ image });
    } catch (err) {
      if (err instanceof StaleOpenError || session.stale()) return;
      console.warn(`reloadImageForSettings failed for ${imagePath}:`, err);
    } finally {
      // Unconditional: success, genuine failure, AND superseded-by-a-newer-
      // session all clear it (this method's interface doc comment).
      set({ settingsReloading: false });
    }
  },
  };
});

// Boot: load persisted settings into the store once `window.silverbox` (the
// preload bridge) exists — always true in the real app; guarded for safety
// under any non-Electron test harness that imports this module directly.
if (typeof window !== 'undefined' && window.silverbox) {
  void window.silverbox.settingsGet().then((settings) => {
    useAppStore.setState({ settings });
  });
  void window.silverbox.presetsList().then((presets) => {
    useAppStore.setState({ presets });
  });
  // Sidecar hot-reload (the AI-editing loop): one subscription for the whole
  // app lifetime — main re-arms its OWN watcher per image (see
  // openImageByPath's watchSidecar call), so this listener never needs to be
  // re-registered per open/close, it just always routes to whatever image is
  // current when the push arrives.
  window.silverbox.onSidecarChanged(() => {
    void useAppStore.getState().handleExternalSidecarChange();
  });
  // Shared-look hot-reload (linked-looks-stage-d.md, semantic 1): same
  // "one subscription for the whole app lifetime" shape as onSidecarChanged
  // above — main re-arms its OWN watcher per project (openProjectByPath's
  // watchSharedLooks call), this listener just always routes to whatever
  // project is current when the push arrives.
  window.silverbox.onSharedLooksChanged(() => {
    void useAppStore.getState().handleSharedLooksChanged();
  });
  // Library hot-reload (linked-looks-stage-e.md semantic 6): same one-
  // subscription-for-the-app-lifetime shape as the two watchers above, but
  // the library is a single GLOBAL folder (armed once at main's boot, not
  // per project) — "putting a file in the folder IS the import" needs no
  // per-slug diffing the way sidecar/shared-look hot-reload do, a plain
  // list refresh is the whole reaction.
  window.silverbox.onLibraryChanged(() => {
    void useAppStore.getState().refreshPresets();
  });
}

// Project manifest autosave (project-storage migration, stage 1): any
// PLAYLIST change (`project.photos` replaced by reference — ensureActiveProject/
// ensureProjectAndAddPhoto/openFolder are the only writers) reschedules a
// 300ms debounce that writes project.silverbox once edits settle — the SAME
// debounce shape as sidecar autosave below, but keyed on the project's own
// dirty surface (the playlist), not `graphDirty`/`graph`: an ordinary
// per-photo LOOK autosave never touches `project.photos` at all, so it can
// never accidentally trigger a manifest rewrite (see docs/brief-bank/
// project-storage.md's "don't rewrite it on every look autosave").
let projectSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedPhotos: ProjectPhoto[] | null = null;
useAppStore.subscribe((state) => {
  const project = state.project;
  if (!project || project.photos === lastSavedPhotos) return;
  lastSavedPhotos = project.photos;
  if (projectSaveTimer !== null) clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => {
    projectSaveTimer = null;
    // Read fresh state at fire time (not a closed-over `project`) — same
    // "no stale reference" discipline saveGraph's own autosave timer below
    // follows via useAppStore.getState().
    const p = useAppStore.getState().project;
    if (!p) return;
    // NG fix pack (path policy migration): every manifest rewrite is a free
    // chance to bring an older row's `path` in line with the current policy
    // (relative only when it's actually inside `p.dir`, absolute otherwise —
    // see relativizeProjectPath's doc comment) — resolve-then-relativize is a
    // no-op for a row already in the current shape, and turns a pre-migration
    // `../../…` row absolute the next time this project is touched at all
    // (doc-is-truth, harmless either way).
    const photos = p.photos.map((row) => ({
      ...row,
      path: relativizeProjectPath(p.dir, resolveProjectPath(p.dir, row.path)),
    }));
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      name: p.name,
      photos,
      ...(p.unknown ? { unknown: p.unknown } : {}),
    };
    void window.silverbox.writeProjectManifest(p.dir, serializeProjectManifest(manifest));
  }, 300);
});

// Title bar (project-storage migration): keeps document.title in sync with
// the active project's name + the current photo — "Silverbox — <Project> —
// <photo.ARW>" (subsets gracefully when either half is absent) — so the
// active project is always visible, never "behind the user's back" (see
// docs/brief-bank/project-storage.md's quick-project rationale). Guarded for
// the vitest unit tier (environment: 'node' — no DOM, see vitest.config.ts).
let lastTitleProject: string | null = null;
let lastTitleFileName: string | null = null;
useAppStore.subscribe((state) => {
  const projectName = state.project?.name ?? null;
  const fileName = state.fileName;
  if (projectName === lastTitleProject && fileName === lastTitleFileName) return;
  lastTitleProject = projectName;
  lastTitleFileName = fileName;
  if (typeof document === 'undefined') return;
  document.title = ['Silverbox', ...(projectName ? [projectName] : []), ...(fileName ? [fileName] : [])].join(' — ');
});

// Sidecar autosave (settings.autosaveSidecar, default ON): any graph mutation
// (graph replaced by reference + graphDirty:true) reschedules a 1000ms
// debounce that saves once edits settle. Subscribing here, after the store
// exists, is the only point that can see "the graph object changed" without
// threading a scheduling call through every one of the many graph-mutating
// actions above. `sidecarRating` is watched the same way (by VALUE, not
// reference — it's a plain number) because setRating deliberately never
// replaces `graph` (ratings pack: a rating is not a graph edit — see
// AppState.sidecarRating's doc comment) — without this, a rating-only
// change would mark graphDirty but never actually get autosaved.
// `sidecarFlag` (reject-flag pack) rides the exact same by-value watch, same
// reasoning: setFlag's in-memory branch (canvas photo) never replaces
// `graph` either — a flag is metadata, not a graph edit.
let lastAutosaveGraph: GraphDoc | null = null;
let lastAutosaveRating: number | null = null;
let lastAutosaveFlag: PhotoFlag | null = null;
useAppStore.subscribe((state) => {
  const graphChanged = state.graph !== lastAutosaveGraph;
  const ratingChanged = state.sidecarRating !== lastAutosaveRating;
  const flagChanged = state.sidecarFlag !== lastAutosaveFlag;
  if (!graphChanged && !ratingChanged && !flagChanged) return;
  lastAutosaveGraph = state.graph;
  lastAutosaveRating = state.sidecarRating;
  lastAutosaveFlag = state.sidecarFlag;
  if (!state.graphDirty || !state.settings.autosaveSidecar) return;
  if (!state.imagePath || !state.fileName || state.sidecarUnreadable) return;
  cancelAutosaveTimer();
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void useAppStore.getState().saveGraph();
  }, 1000);
});

// Mask overlay auto-clear (round-7 hand-test fix, "0キーでのオーバーレイは切り替わらないかも？
// 赤のまま"): the LR-style red overlay only makes sense while a MASK node is
// selected — the repro was enabling it, then clicking any other node (or the
// canvas, which clears selection), which left the overlay stuck ON with no
// way to reach it (the 'O' handler in App.tsx used to require a mask
// selection even to turn it OFF). There are many selection writers
// (selectNode, addOpNode, removeOpNode, commitSpot, undo/redo, sidecar
// reload…) — rather than thread a "clear the overlay" side effect through
// every one of them, this single subscribe watches `selectedNodeId` (keyed
// off its own last-seen value, same pattern as lastAutosaveGraph above) and
// clears the overlay the moment selection moves off a mask node while it's
// on. 'O' itself (App.tsx) separately always turns an ON overlay OFF
// regardless of selection — the two mechanisms together mean the overlay can
// never survive past the mask node it was showing.
let lastMaskOverlaySelection: string | null = null;
useAppStore.subscribe((state) => {
  if (state.selectedNodeId === lastMaskOverlaySelection) return;
  lastMaskOverlaySelection = state.selectedNodeId;
  if (!state.maskOverlay) return;
  const node = state.graph.nodes.find((n) => n.id === state.selectedNodeId);
  if (node?.kind !== MASK_KIND) useAppStore.setState({ maskOverlay: false });
});

// Per-node-preview pack: belt-and-braces prune, alongside removeOpNode's own
// immediate one — undo/redo and sidecar reload replace `graph` wholesale
// without going through removeOpNode at all, so a node this map/inspection
// still names could otherwise survive a graph replacement that dropped it.
// Keyed off `graph` itself (lastAutosaveGraph's own pattern above): image
// switches ALSO replace `graph`, but openImageByPath already clears both
// fields explicitly and synchronously in the SAME `set` — by the time this
// subscribe observes the new graph, inspectNodeId/nodeThumbs are already
// whatever that call left them, so this only ever has real work to do for
// an in-session graph edit (undo/redo, sidecar reload) that dropped a node.
let lastNodePreviewGraph: GraphDoc | null = null;
useAppStore.subscribe((state) => {
  if (state.graph === lastNodePreviewGraph) return;
  lastNodePreviewGraph = state.graph;
  const ids = new Set(state.graph.nodes.map((n) => n.id));
  const patch: Partial<AppState> = {};
  if (state.inspectNodeId !== null && !ids.has(state.inspectNodeId)) patch.inspectNodeId = null;
  const staleThumbIds = Object.keys(state.nodeThumbs).filter((id) => !ids.has(id));
  if (staleThumbIds.length > 0) {
    let thumbs = state.nodeThumbs;
    for (const id of staleThumbIds) thumbs = pruneNodeThumb(thumbs, id);
    patch.nodeThumbs = thumbs;
  }
  if (Object.keys(patch).length > 0) useAppStore.setState(patch);
});
