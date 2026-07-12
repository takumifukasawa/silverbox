import { create } from 'zustand';
import { OpenSession, StaleOpenError } from './openSession';
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
  nextId,
  outputName,
  parseGraphDoc,
  resolveExportSettings,
  sanitizeExportOverrides,
  sanitizeRating,
  serializeGraphDoc,
  type AddableKind,
  type ExportOverrides,
  type GeometryParams,
  type GraphDoc,
  type GraphNode,
  type LensParams,
  type SidecarDoc,
} from '../engine/graph/graphDoc';
import { defaultDevelopParams } from '../engine/graph/developNode';
import { clampMaskShape, defaultMaskParams, MASK_KIND, type MaskShape } from '../engine/graph/maskNode';
import { clampSpot, defaultSpotsParams, SPOTS_CAP, SPOTS_KIND, type Spot } from '../engine/graph/spotsNode';
import { defaultImageParams, IMAGE_KIND } from '../engine/graph/imageNode';
import { clearImageNodeSourceCache } from '../engine/graph/imageNodeSource';
import { defaultExternalParams, EXTERNAL_KIND } from '../engine/graph/externalNode';
import { confirmAndRetry, pendingExternalRequest } from '../engine/graph/externalNodeRunner';
import { sha256Hex, type HistogramData, type ScopeSamples } from '../engine/gpu/graphRenderer';
import { RenderWorkerClient, mirrorShaderArtifactClear, mirrorShaderArtifactSet } from '../engine/gpu/renderClient';
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
import { parsePresetFile, serializePreset } from '../engine/graph/presetDoc';
import {
  DEFAULT_SETTINGS,
  SIDECAR_SUFFIX,
  type CliCheckJob,
  type CliCheckResult,
  type CliRenderJob,
  type CliRenderResult,
  type FolderImageEntry,
  type PresetSummary,
  type Settings,
} from '../../../shared/ipc';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface GraphHistory {
  past: GraphDoc[];
  future: GraphDoc[];
  /**
   * Coalescing tag of the edit that produced the newest `past` entry —
   * consecutive edits with the same tag (one slider drag) share one entry.
   */
  lastCoalesceKey: string | null;
}

const HISTORY_LIMIT = 100;

const emptyHistory = (): GraphHistory => ({ past: [], future: [], lastCoalesceKey: null });

interface AppState {
  imageStatus: ImageStatus;
  image: PreparedImage | null;
  fileName: string | null;
  imagePath: string | null;
  imageError: string | null;
  /**
   * Folder filmstrip (ROADMAP "nice to have" — browse a folder, NOT a
   * catalog): non-null while the open image came from an explicit folder
   * open (a folder drop or the toolbar's "Open Folder…"), holding that
   * folder's sorted image listing. null for a standalone single-file open
   * (Open… dialog, or dropping one file) — the filmstrip renders nothing at
   * all while this is null, so a single-file open keeps today's exact
   * experience (see openImageViaDialog / App.tsx's drop handler, which both
   * clear this before opening).
   */
  folderDir: string | null;
  /** The current folder's sorted image listing (see shared/ipc.ts's FolderImageEntry); empty when folderDir is null. */
  folderEntries: FolderImageEntry[];
  /**
   * Open every image in `dir` (no recursion — see main's listImages) and
   * show the filmstrip, opening the FIRST (sorted) entry. The drop handler
   * (App.tsx), the toolbar's "Open Folder…" dialog action, and the verify
   * harness's `__openFolderByPath` debug hook (dialogs are untestable) all
   * funnel through this one action. Returns false (and touches nothing) if
   * `dir` can't be listed as a directory — callers that need to distinguish
   * "this wasn't actually a folder" (the drop handler's file-vs-folder
   * ambiguity) branch on that; a real folder with zero images still returns
   * true (the strip just renders empty).
   */
  openFolder(dir: string): Promise<boolean>;
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
   */
  openingPreview: { url: string; width: number; height: number } | null;
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
  history: GraphHistory;
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
   * PHOTO, not the look — lives next to sidecarCreatedAt, not in `graph`, so
   * rating a photo never pushes a develop-history entry (setRating below is
   * the only writer, and it deliberately skips pushHistory — a documented
   * divergence from every other graph mutation in this store, all of which
   * DO push history). 0 = unrated; reset to 0 on every image open before a
   * sidecar (if any) restores it, same as sidecarCreatedAt.
   */
  sidecarRating: number;
  /**
   * Set (1-5) or clear (0) the current image's rating — the toolbar's star
   * display and App.tsx's 1-5/0 key handler both call this. Marks the doc
   * dirty (autosave's own subscribe watches sidecarRating in addition to
   * `graph` — see the bottom of this file) but is NOT a history entry: see
   * this field's own doc comment for why ratings deliberately don't undo
   * like every other graph edit. No-op without an open image.
   */
  setRating(rating: number): void;
  /** Unrecognized wrapper-level sidecar keys (DESIGN §9 passthrough) — round-tripped verbatim on save. */
  sidecarUnknownFields: Record<string, unknown> | null;
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
  /** `<userData>/presets/*.json` summaries (task #37); refreshed after save/delete and once at boot. */
  presets: PresetSummary[];
  /**
   * Save the CURRENT graph as a whole-look preset file named `name`
   * (captureLook — the exact copyDevelopSettings geometry-stripping
   * contract). Same display name as an existing preset overwrites it (its
   * slug/createdAt/unknown wrapper keys are reused — DESIGN §9 passthrough);
   * a different name that sanitizes to the same slug disambiguates (-2, -3…).
   */
  savePreset(name: string): Promise<void>;
  /** Apply a saved preset by slug — exactly the pasteDevelopSettings code path (applyLook), one undo entry. No-op without an open image. */
  applyPreset(slug: string): Promise<void>;
  /** Delete a saved preset's file; refreshes the list. No confirm dialog (see PresetsMenu's low-friction-but-not-accidental design). */
  deletePreset(slug: string): Promise<void>;
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
   * `opts.keepFolderContext` (folder filmstrip, ROADMAP "nice to have"):
   * by default, EVERY call to this function exits folder-browsing (clears
   * folderDir/folderEntries, hiding the strip) — that's what makes a
   * standalone single-file open (Open… dialog, a single-file drop, the
   * `__openImageByPath` verify hook) behave exactly like it always has, with
   * no strip. The 3 call sites that must NOT do that — a filmstrip cell
   * click, ←/→ (stepFilmstrip), and openFolder's own "open the first entry"
   * — pass `true` here.
   */
  openImageByPath(path: string, opts?: { skipSidecar?: boolean; keepFolderContext?: boolean }): Promise<void>;
  openImageViaDialog(): Promise<void>;
  selectNode(id: string | null): void;
  updateNodeParam(nodeId: string, key: string, value: number): void;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
  addOpNode(kind: AddableKind): void;
  removeOpNode(nodeId: string): void;
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
  /** Bumped whenever an external-tool round trip settles (success or failure) or a cached result becomes ready with no run needed — mirrors imageNodeRev's role in re-running CanvasView's render effect. */
  externalNodeRev: number;
  bumpExternalNodeRev(): void;
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
  undo(): void;
  redo(): void;
  /** `<userData>/settings.json`, loaded at boot; DEFAULT_SETTINGS until that IPC round-trip resolves. */
  settings: Settings;
  /** Merge `partial` into the persisted settings via IPC; updates local state with the sanitized result. */
  updateSettings(partial: Partial<Settings>): Promise<void>;
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

// --- Embedded-preview-first opening (AppState.openingPreview) --------------
//
// Revoke the overlay's blob: URL and drop it — call sites: a new open
// starting (openImageByPath's top), the real image reaching 'ready', or the
// open failing. Never leaves a blob: URL live past whichever of those three
// happens first, so two rapid opens never leak the first one's URL.
//
// Verify-only: every URL actually revoked here, in order — lets
// verify-preview.mjs prove a rapid second open revoked the FIRST open's URL
// specifically (not just that openingPreview is now null, which a leaked
// URL sitting unreferenced would also show).
const revokedOpeningPreviewUrls: string[] = [];
export function openingPreviewRevocationLog(): readonly string[] {
  return revokedOpeningPreviewUrls;
}

function clearOpeningPreview(state: Pick<AppState, 'openingPreview'>): { openingPreview: null } {
  if (state.openingPreview) {
    URL.revokeObjectURL(state.openingPreview.url);
    revokedOpeningPreviewUrls.push(state.openingPreview.url);
  }
  return { openingPreview: null };
}

/** History advance for a graph mutation; `key` coalesces slider-drag runs. */
function pushHistory(s: AppState, key: string | null): { history: GraphHistory } {
  const coalesce = key !== null && key === s.history.lastCoalesceKey;
  return {
    history: {
      past: coalesce ? s.history.past : [...s.history.past.slice(-(HISTORY_LIMIT - 1)), s.graph],
      future: [],
      lastCoalesceKey: key,
    },
  };
}

export function isJpegFileName(name: string): boolean {
  return /\.(jpg|jpeg)$/i.test(name);
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
  const wbModel = createWbModel({ camMul: image.color?.camMul, camXyz: image.color?.camXyz });
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

  return { ...pushHistory(s, null), graph: scratch, graphDirty: true, selectedNodeId: maskId };
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
 * Apply a captured look to `s`'s CURRENT graph (mergeLookWithCurrentGeometry
 * above), as one undo entry (pushHistory's `null` = its own discrete entry,
 * coalescing nothing). This is the entire body of pasteDevelopSettings;
 * applyPreset (the preset "Apply" action) shares it unchanged, so paste and
 * preset-apply are one implementation with one merge semantics.
 */
function applyLook(s: AppState, look: GraphDoc): Partial<AppState> & { graph: GraphDoc } {
  const graph = mergeLookWithCurrentGeometry(s.graph, look);
  return { ...pushHistory(s, null), graph, graphDirty: true };
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
 * parseGraphDoc call.
 */
async function readAndParseSidecar(
  imagePath: string,
  image: { width: number; height: number }
): Promise<{ ok: true; text: string; parsed: SidecarDoc } | { ok: false; notice: string }> {
  const unreadable = (detail: string): { ok: false; notice: string } => ({
    ok: false,
    notice: `sidecar on disk is unreadable — keeping the in-app state (${detail})`,
  });
  let text: string | null;
  try {
    text = await window.silverbox.readSidecar(imagePath + SIDECAR_SUFFIX);
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
    ...pushHistory(s, null),
    graph,
    graphDirty: false,
    selectedNodeId: graph.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
    selectedSpotIndex: null,
    sidecarCreatedAt: parsed.createdAt ?? null,
    sidecarRating: parsed.rating,
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
          ...(opts.history ? pushHistory(s, null) : {}),
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
   * PATH reads the file directly; a NAME looks it up against
   * `<userData>/presets` by display name first, then by slug (a user who
   * already knows a preset's slug — e.g. copy-pasted from another sidecar —
   * shouldn't have to know its display name too).
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
   * `--min-rating`'s cheap sidecar read (ratings pack): a bare JSON.parse of
   * just the wrapper's `rating` key, deliberately NOT the full parseGraphDoc
   * (which validates/migrates the whole graph and can throw) — runCliRender
   * calls this BEFORE openImageByPath's expensive decode, so a batch over a
   * folder full of below-threshold images never pays for decoding any of
   * them. No sidecar, unreadable file, or malformed/missing `rating` key all
   * resolve to 0 (unrated), same fallback listImages' own cheap read uses
   * (main/index.ts's extractSidecarRating).
   */
  const readSidecarRatingCheap = async (imagePath: string): Promise<number> => {
    let text: string | null;
    try {
      text = await window.silverbox.readSidecar(imagePath + SIDECAR_SUFFIX);
    } catch {
      return 0;
    }
    if (text === null) return 0;
    try {
      const wrapper = JSON.parse(text) as { rating?: unknown };
      return sanitizeRating(wrapper.rating);
    } catch {
      return 0;
    }
  };

  return {
  imageStatus: 'idle',
  image: null,
  fileName: null,
  imagePath: null,
  imageError: null,
  folderDir: null,
  folderEntries: [],
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
  history: emptyHistory(),
  sidecarNotice: null,
  sidecarUnreadable: false,
  sidecarCreatedAt: null,
  sidecarRating: 0,
  sidecarUnknownFields: null,
  lastSidecarText: null,
  sidecarHotReloadNotice: null,
  exportInfo: null,
  wbModel: DEFAULT_WB_MODEL,
  showBefore: false,
  grayscaleView: false,
  compareMode: false,
  compareOutputId: null,
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

  async openImageByPath(path: string, opts?: { skipSidecar?: boolean; keepFolderContext?: boolean }) {
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
    set({ imageStatus: 'loading', fileName, imagePath: path, imageError: null, previewLook: null });
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
          set({ openingPreview: { url, width: preview.width, height: preview.height } });
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
      let sidecarUnknownFields: Record<string, unknown> | null = null;
      let usedSidecar = false;
      // Raw disk text this session is about to account for (hot-reload's
      // self-write-suppression baseline — see AppState.lastSidecarText's doc
      // comment). Recorded even when the parse below fails: the malformed
      // text IS what's on disk, so a future external change compares against
      // it too, not against nothing.
      let sidecarRawText: string | null = null;
      try {
        // skipSidecar (headless CLI's --preset path): behave as if nothing
        // were on disk at all, even when a sidecar genuinely exists — see
        // AppState.openImageByPath's doc comment.
        const sidecar = opts?.skipSidecar
          ? null
          : await session.guard(window.silverbox.readSidecar(path + SIDECAR_SUFFIX));
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
            sidecarUnknownFields = parsed.unknown ?? null;
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
        sidecarNotice = `sidecar ignored: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`ignoring invalid sidecar for ${fileName}:`, err);
      }
      // Fresh-open default-look seeding (WB Kelvin resolution, embedded lens
      // profile auto-on, base curve + default sharpen/color-NR) — pure
      // helper, see its doc comment for the per-piece gating.
      const seeded = seedDefaultLook(graph, image, { usedSidecar, kind, testFlags: window.silverbox.testFlags });
      graph = seeded.graph;
      const wbModel = seeded.wbModel;
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
        ...clearOpeningPreview(get()),
        imageStatus: 'ready',
        image,
        graph,
        graphDirty: false,
        selectedNodeId: null,
        nodeThumbs: {},
        imageNodeMissing: {},
        inspectNodeId: null,
        history: emptyHistory(),
        shaderErrors: {},
        sidecarNotice,
        sidecarUnreadable,
        sidecarCreatedAt,
        sidecarRating,
        sidecarUnknownFields,
        lastSidecarText: sidecarRawText,
        sidecarHotReloadNotice: null,
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
      });
      revalidateShaders(graph);
      // Arm (re-arm) the main-process sidecar watcher for THIS image — see
      // shared/ipc.ts's watchSidecar doc comment. Fire-and-forget: a failure
      // here just means no hot-reload push for this image, not a broken open.
      void window.silverbox.watchSidecar(path + SIDECAR_SUFFIX);
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
    // openImageByPath itself exits folder-browsing by default (see its
    // `keepFolderContext` doc comment) — nothing extra to do here.
    await get().openImageByPath(result.path);
  },

  async openFolder(dir: string) {
    let entries: FolderImageEntry[];
    try {
      entries = await window.silverbox.listImages(dir);
    } catch (err) {
      // Not a (readable) directory — the drop handler's own fallback treats
      // this as "not actually a folder drop" and opens it as a single file
      // instead; any other caller (toolbar dialog, __openFolderByPath) just
      // sees nothing happen.
      console.warn(`openFolder: could not list ${dir}:`, err);
      return false;
    }
    set({ folderDir: dir, folderEntries: entries });
    if (entries.length > 0) await get().openImageByPath(entries[0]!.path, { keepFolderContext: true });
    return true;
  },

  stepFilmstrip(delta) {
    const { folderDir, folderEntries, imagePath, imageStatus } = get();
    if (!folderDir || folderEntries.length === 0 || imageStatus === 'loading') return;
    const idx = folderEntries.findIndex((e) => e.path === imagePath);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= folderEntries.length) return;
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
      ...pushHistory(s, `param:${nodeId}:${key}`),
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
            return { ...n, develop };
          }
          return { ...n, params: { ...n.params, [key]: value } };
        }),
      },
      graphDirty: true,
    }));
  },

  moveNode(nodeId, position) {
    set((s) => ({
      ...pushHistory(s, `move:${nodeId}`),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      },
      graphDirty: true,
    }));
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
          ...pushHistory(s, null),
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
          ...pushHistory(s, null),
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
      return { ...pushHistory(s, null), graph: scratch, graphDirty: true, selectedNodeId: id };
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
          ...pushHistory(s, null),
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
      return {
        ...pushHistory(s, null),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
        nodeThumbs: pruneNodeThumb(s.nodeThumbs, nodeId),
        imageNodeMissing,
        inspectNodeId: s.inspectNodeId === nodeId ? null : s.inspectNodeId,
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
      return { ...pushHistory(s, null), graph, graphDirty: true, connectNotice: null };
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
        ...pushHistory(s, null),
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
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, coalesceKey),
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
      const existingId = findActiveSpotsNodeId(s.graph, s.activeOutputId);
      if (existingId) {
        const node = s.graph.nodes.find((n) => n.id === existingId)!;
        const list = node.spots?.spots ?? [];
        if (list.length >= SPOTS_CAP) {
          capped = true;
          return {};
        }
        return {
          ...pushHistory(s, null),
          graph: {
            ...s.graph,
            nodes: s.graph.nodes.map((n) => (n.id === existingId ? { ...n, spots: { spots: [...list, spot] } } : n)),
          },
          graphDirty: true,
          selectedNodeId: existingId,
          selectedSpotIndex: list.length,
        };
      }
      // No spots node anywhere in the active chain yet: auto-insert one
      // RIGHT AFTER the input node (retouch before color — see spotsNode.ts's
      // file doc comment), rewiring input→X to input→spots→X, combined with
      // this first spot into ONE undo entry (buildLocalAdjustmentPatch's
      // same one-entry-per-gesture rule).
      const out = activeOutputNode(s.graph, s.activeOutputId);
      const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
      if (!out || !inputNode) return {};
      const reach = reachableToOutput(s.graph, out.id);
      const edge = s.graph.edges.find((e) => e.source === inputNode.id && reach.has(e.target));
      if (!edge) return {};
      const spotsId = nextId(s.graph, 'spots');
      const spotsNode: GraphNode = {
        id: spotsId,
        kind: SPOTS_KIND,
        position: { x: inputNode.position.x + 110, y: inputNode.position.y + 90 },
        spots: { spots: [spot] },
      };
      let scratch: GraphDoc = {
        ...s.graph,
        nodes: [...s.graph.nodes, spotsNode],
        edges: s.graph.edges.filter((e) => e.id !== edge.id),
      };
      const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b' | 'mask') => {
        const e = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
        scratch = { ...scratch, edges: [...scratch.edges, e] };
      };
      addEdge(inputNode.id, spotsId);
      addEdge(spotsId, edge.target, edge.targetHandle);
      return {
        ...pushHistory(s, null),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: spotsId,
        selectedSpotIndex: 0,
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
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, null),
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
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, coalesceKey),
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

  setExternalCommand(nodeId, command, coalesceKey) {
    set((s) => {
      const node = s.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind !== EXTERNAL_KIND) return {};
      const prevEncoded = node.external?.encoded ?? defaultExternalParams().encoded;
      return {
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, null),
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
    confirmAndRetry(nodeId, docKey, command, renderer, (settledNodeId, ok, error) => {
      get().setExternalNodeError(settledNodeId, ok ? null : (error ?? 'unknown error'));
      get().bumpExternalNodeRev();
    });
  },

  externalNodeErrors: {},
  setExternalNodeError(nodeId, error) {
    set((s) =>
      error === (s.externalNodeErrors[nodeId] ?? null)
        ? {}
        : { externalNodeErrors: { ...s.externalNodeErrors, [nodeId]: error ?? (undefined as unknown as string) } }
    );
  },

  externalNodeRev: 0,
  bumpExternalNodeRev() {
    set((s) => ({ externalNodeRev: s.externalNodeRev + 1 }));
  },

  updateNodeParamsBatch(nodeId, entries, coalesceKey) {
    set((s) => ({
      ...pushHistory(s, coalesceKey),
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
          return { ...n, develop };
        }),
      },
      graphDirty: true,
    }));
  },

  setToneCurvePoints(nodeId, channel, points, session) {
    const sanitized = sanitizeCurvePoints(points);
    if (!sanitized) return;
    set((s) => ({
      ...pushHistory(s, `curve:${nodeId}:${channel}:${session}`),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => {
          if (n.id !== nodeId || n.kind !== DEVELOP_KIND) return n;
          const develop = n.develop ?? defaultDevelopParams();
          return { ...n, develop: { ...develop, toneCurve: { ...develop.toneCurve, [channel]: sanitized } } };
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
      ...pushHistory(s, null),
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
      ...pushHistory(s, null),
      graph: withShader(s.graph, nodeId, (p) => ({ ...p, params: p.params.filter((x) => x.name !== name) })),
      graphDirty: true,
    }));
    const code = getShader(get().graph, nodeId)?.code;
    if (code) void validateShaderSource(nodeId, code.src, { history: false });
  },

  updateShaderParam(nodeId, name, value) {
    set((s) => ({
      ...pushHistory(s, `shaderparam:${nodeId}:${name}`),
      graph: withShader(s.graph, nodeId, (p) => ({
        ...p,
        params: p.params.map((x) => (x.name === name ? { ...x, value } : x)),
      })),
      graphDirty: true,
    }));
  },

  undo() {
    set((s) => {
      const prev = s.history.past.at(-1);
      if (!prev) return {};
      return {
        graph: prev,
        history: {
          past: s.history.past.slice(0, -1),
          future: [s.graph, ...s.history.future],
          lastCoalesceKey: null,
        },
        graphDirty: true,
        selectedNodeId: prev.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
        // a jump can change (or shorten) any spots node's list — a stale
        // index would either point at the wrong spot or past the end
        selectedSpotIndex: null,
      };
    });
    // a jump may restore shader sources whose artifacts are stale
    shaderEpoch++;
    revalidateShaders(get().graph);
  },

  redo() {
    set((s) => {
      const next = s.history.future[0];
      if (!next) return {};
      return {
        graph: next,
        history: {
          past: [...s.history.past, s.graph],
          future: s.history.future.slice(1),
          lastCoalesceKey: null,
        },
        graphDirty: true,
        selectedNodeId: next.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
        selectedSpotIndex: null,
      };
    });
    shaderEpoch++;
    revalidateShaders(get().graph);
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
          : { compareMode: false }
    );
  },

  setCompareOutputId(id) {
    set({ compareOutputId: id });
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

  presets: [],

  async savePreset(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { graph } = get();
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
    const existingText = await window.silverbox.presetRead(slug);
    if (existingText) {
      try {
        const parsed = parsePresetFile(existingText);
        unknownFields = parsed.unknown;
        createdAt = parsed.createdAt;
      } catch (err) {
        // this slug's file on disk is unreadable — overwrite it cleanly
        // rather than fail the save (promise-9 leaves the OLD file alone
        // only until we deliberately replace it here)
        console.warn(`overwriting unreadable preset file for slug "${slug}":`, err);
      }
    }
    const content = serializePreset(trimmed, captureLook(graph), createdAt, unknownFields);
    await window.silverbox.presetWrite(slug, content);
    set({ presets: await window.silverbox.presetsList() });
  },

  async applyPreset(slug) {
    if (get().imageStatus !== 'ready') return;
    const text = await window.silverbox.presetRead(slug);
    if (!text) return;
    let look: GraphDoc;
    try {
      ({ look } = parsePresetFile(text));
    } catch (err) {
      console.warn(`preset "${slug}" could not be parsed:`, err);
      return;
    }
    let nextGraph: GraphDoc | null = null;
    set((s) => {
      const patch = applyLook(s, look);
      nextGraph = patch.graph;
      return patch;
    });
    if (nextGraph) revalidateShaders(nextGraph);
  },

  async deletePreset(slug) {
    await window.silverbox.presetDelete(slug);
    set({ presets: await window.silverbox.presetsList() });
  },

  previewLook: null,

  setPreviewLook(look) {
    set((s) => ({ previewLook: look ? mergeLookWithCurrentGeometry(s.graph, look) : null }));
  },

  setGeometry(geo, coalesceKey) {
    set((s) => {
      const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
      if (!inputNode) return {};
      const geometry = clampGeometry(geo);
      return {
        ...pushHistory(s, coalesceKey),
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
        ...pushHistory(s, coalesceKey),
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
        // --min-rating (ratings pack): a cheap sidecar read BEFORE the
        // expensive decode/render below — an image with no rating (or a
        // rating below the threshold) is reported as a skip, never rendered.
        if (job.minRating !== null && (await readSidecarRatingCheap(input)) < job.minRating) {
          onResult({ input, status: 'skipped-rating' });
          continue;
        }
        // job.preset REPLACES the sidecar entirely (see openImageByPath's
        // skipSidecar doc comment): open as a truly fresh doc with identity
        // geometry, which is all applyLook below actually preserves — the
        // fresh-open defaults (lens profile, base curve) it also seeds get
        // superseded a moment later when applyLook replaces the nodes/edges
        // wholesale with the preset's own, so only the identity geometry
        // survives into the final render.
        await get().openImageByPath(input, { skipSidecar: job.preset !== null });
        if (get().imageStatus !== 'ready') {
          throw new Error(get().imageError ?? `failed to open ${input}`);
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

        const basePath = cliOutputPath(input, job.outDir);
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
        // No `skipSidecar`/preset here (unlike runCliRender) — a golden
        // always represents the image's own sidecar-or-default look, the
        // same defaults rule `--render` uses without `--preset`.
        await get().openImageByPath(input);
        if (get().imageStatus !== 'ready') {
          throw new Error(get().imageError ?? `failed to open ${input}`);
        }
        const { imagePath, fileName, graph, renderer } = get();
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
        const outcome = await window.silverbox.checkGoldenImage({
          input,
          data: data.buffer,
          width,
          height,
          update: job.update,
          threshold: job.threshold,
        });
        onResult(outcome);
      } catch (err) {
        onResult({ input, error: err instanceof Error ? err.message : String(err) });
      }
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

  setRating(rating) {
    // no image open: nothing to rate, and no sidecar to eventually write it to
    if (!get().imagePath) return;
    const next = sanitizeRating(rating);
    if (next === get().sidecarRating) return; // e.g. pressing the same star twice — nothing changed, nothing to save
    // Deliberately NOT pushHistory: a rating is per-photo metadata, not an
    // undoable look edit (see AppState.sidecarRating's doc comment) — this
    // is the one graph-adjacent mutation in this store that skips it.
    // graphDirty:true still marks the doc dirty so autosave persists it (the
    // bottom-of-file autosave subscribe watches sidecarRating in addition to
    // `graph` for exactly this reason — a rating-only change never touches
    // `graph` itself).
    set({ sidecarRating: next, graphDirty: true });
  },

  async saveGraph() {
    // an explicit save (⌘S, or autosave's own timer firing) always cancels
    // any still-pending autosave — nothing left to race it afterward
    cancelAutosaveTimer();
    const { imagePath, fileName, image, graph, sidecarCreatedAt, sidecarRating, sidecarUnreadable, sidecarUnknownFields } =
      get();
    if (!imagePath || !fileName || sidecarUnreadable) return;
    const source = {
      fileName,
      ...(image?.capture?.cameraModel ? { cameraModel: image.capture.cameraModel } : {}),
      kind: (isRawFileName(fileName) ? 'raw' : 'jpg') as 'raw' | 'jpg',
    };
    const createdAt = sidecarCreatedAt ?? new Date().toISOString();
    const content = serializeGraphDoc(graph, source, createdAt, sidecarUnknownFields ?? undefined, sidecarRating);
    await window.silverbox.writeSidecar(imagePath + SIDECAR_SUFFIX, content);
    // Record exactly what we just wrote (hot-reload's self-write-suppression
    // baseline) and clear any hot-reload notice: our edits just overwrote
    // disk, resolving whatever pending/malformed conflict was showing (see
    // AppState.sidecarHotReloadNotice's doc comment). The fs-watch echo of
    // THIS write will read back identical text and be ignored silently.
    set({ graphDirty: false, sidecarCreatedAt: createdAt, lastSidecarText: content, sidecarHotReloadNotice: null });
  },

  // Sidecar hot-reload (the AI-editing loop): handleExternalSidecarChange is
  // the automatic entry point, called once from preload's onSidecarChanged
  // subscription at module scope below; reloadSidecarNow is the dirty
  // session's "Reload" button. Both share readAndParseSidecar/
  // applyExternalGraph above.

  async handleExternalSidecarChange() {
    const { imagePath, image } = get();
    if (!imagePath || !image) return;
    const result = await readAndParseSidecar(imagePath, image);
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
    const { imagePath, image } = get();
    if (!imagePath || !image) return;
    const result = await readAndParseSidecar(imagePath, image);
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

  async updateSettings(partial) {
    const settings = await window.silverbox.settingsUpdate(partial);
    set({ settings });
    // turning autosave off must not leave a stale timer to fire once more
    if (!settings.autosaveSidecar) cancelAutosaveTimer();
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
}

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
let lastAutosaveGraph: GraphDoc | null = null;
let lastAutosaveRating: number | null = null;
useAppStore.subscribe((state) => {
  const graphChanged = state.graph !== lastAutosaveGraph;
  const ratingChanged = state.sidecarRating !== lastAutosaveRating;
  if (!graphChanged && !ratingChanged) return;
  lastAutosaveGraph = state.graph;
  lastAutosaveRating = state.sidecarRating;
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
