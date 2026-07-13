import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { findActiveSpotsNodeId, openingPreviewRevocationLog, useAppStore } from '../store/appStore';
import { thumbnailRevocationLog } from '../engine/thumbnail/thumbnailCache';
import { nodeThumbRevocationLog, updateNodeThumbs } from '../engine/thumbnail/nodeThumbCache';
import { srgbDecode, srgbEncode } from '../engine/color/srgb';
import { SRGB_TO_WORK, WORK_TO_SRGB, WORKING_LUMA, WORKING_SPACE_ID } from '../engine/color/workingSpace';
import { loadImage } from '../engine/decoder/imageLoader';
import { solveNeutralWb } from '../engine/color/whiteBalance';
import { DECODE_OUTPUT_COLOR, isRawFileName } from '../engine/decoder/librawDecoder';
import { RenderWorkerClient } from '../engine/gpu/renderClient';
import {
  buildPlan,
  computeOutputDims,
  cpuEvalPlan,
  defaultGeometryOrientation,
  defaultGeometryParams,
  defaultLensParams,
  DEVELOP_KIND,
  isIdentityGeometry,
  nodeLabel,
  orientedDims,
  outputName,
  planHasCpuReference,
  type ExportOverrides,
  type GeometryParams,
  type GraphDoc,
  type LensParams,
} from '../engine/graph/graphDoc';
import {
  anchorRadiusToOutput,
  maskShapeOutputToAnchor,
  outputRadiusToAnchor,
  outputToAnchor,
} from '../engine/graph/anchorSpace';
import { useCanvasViewport, type ViewportState } from './useCanvasViewport';
import { HistogramPanel } from './HistogramPanel';
import { CropOverlay } from './CropOverlay';
import { MaskOverlay } from './MaskOverlay';
import { MaskDrawOverlay } from './MaskDrawOverlay';
import {
  clampMaskShape,
  defaultLinearMaskShape,
  defaultMaskParams,
  defaultRadialMaskShape,
  MASK_KIND,
  type MaskParams,
  type MaskShape,
} from '../engine/graph/maskNode';
import { defaultSpotsParams, SPOTS_KIND, type Spot, type SpotsParams } from '../engine/graph/spotsNode';
import { dirnameOf, IMAGE_KIND } from '../engine/graph/imageNode';
import { imageNodeDecodeCount, syncImageNodeSources } from '../engine/graph/imageNodeSource';
import { EXTERNAL_KIND } from '../engine/graph/externalNode';
import { handleExternalRunRequest } from '../engine/graph/externalNodeRunner';
import { SpotOverlay } from './SpotOverlay';
import { SpotDrawOverlay } from './SpotDrawOverlay';
import { cpuRgb2hsl } from '../engine/graph/developOps';
import { isTextEntry } from './textEntry';
import type { ExportColorSpace, ExportMetadataPolicy, Settings } from '../../../shared/ipc';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number; flip?: number };
      /** Embedded-preview-first opening (Lightroom trick): the overlay's current state, or null once cleared. `flip` is RawDecoder's rotation code space (round-8 fix — see appStore.ts's openingPreview doc comment). */
      openingPreviewState(): { url: string; width: number; height: number; flip: number } | null;
      /** Verify-only: every blob: URL clearOpeningPreview has revoked so far, in order (proves a rapid second open doesn't leak the first's URL). */
      openingPreviewRevocations(): string[];
      /** Folder filmstrip (ROADMAP "nice to have") state: the open folder (if any) + its sorted listing + which path is current. */
      folderState(): {
        dir: string | null;
        entries: { name: string; path: string; hasSidecar: boolean; mtimeMs: number; rating: number }[];
        currentPath: string | null;
      };
      /** Verify-only: every thumbnail blob: URL revokeAllThumbnails has revoked so far, in order (proves a folder switch doesn't leak the previous folder's URLs). */
      thumbnailRevocations(): string[];
      /** Per-node-preview pack, tier 1: nodeId → blob: URL, exactly what the node editor's thumbnails read. */
      nodeThumbsState(): Record<string, string>;
      /** Verify-only: every node-thumbnail blob: URL updateNodeThumbs has revoked so far, in order. */
      nodeThumbRevocations(): string[];
      /** Per-node-preview pack, tier 2: the currently-inspected node id, or null. */
      inspectState(): string | null;
      rendererKind(): 'webgpu';
      outputSize(): { width: number; height: number } | null;
      readbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      /** Verify-only (external-tool hook node, task #41): see graphRenderer.ts's readbackLinearMean doc comment. */
      readbackLinearMean(): Promise<{ r: number; g: number; b: number } | null>;
      readbackSharpness(): Promise<{ luma: number; chroma: number } | null>;
      /** Compare pane (compare pack) readback — null before an image/compare pane exists (mirrors readbackMean's own guard). */
      compareReadbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      /** Compare view toggle + Mode B's picked second output id (compare pack). */
      compareState(): { mode: boolean; outputId: string | null };
      /** Verify-only convenience: flips compareMode without driving the toolbar button/'C' shortcut. */
      setCompareMode(active: boolean): void;
      /** Verify-only convenience: sets Mode B's picked second output id without driving the compare strip's dropdown. */
      setCompareOutputId(id: string | null): void;
      cpuReferenceMean(): { r: number; g: number; b: number } | null;
      graphState(): GraphDoc;
      graphDirty(): boolean;
      /** `rating` is the ratings pack's star rating (0..5) — see appStore.ts's sidecarRating. */
      sidecarState(): { notice: string | null; unreadable: boolean; rating: number };
      /** Sidecar hot-reload notice state (AI-editing loop) — see appStore.ts's sidecarHotReloadNotice. */
      hotReloadState(): { kind: 'reloaded' | 'pending' | 'malformed'; message: string } | null;
      /** Sidecar visual diff dialog state (git-native completion brief §1) — see appStore.ts's sidecarDiffDialog. */
      sidecarDiffState(): { lines: string[] } | null;
      shaderErrors(): Record<string, string>;
      /** In-page access to the decoded linear pixels for reference math. */
      imageForVerify(): { data: Float32Array; width: number; height: number } | null;
      /**
       * Fit-profile tooling (scripts/fit-profile.mjs): the CURRENT graph's
       * DEVELOPED output in working-space linear Rec.2020, at a long edge of
       * ≤ maxDim. Renders through the real GPU export path (renderToPixels →
       * display-encoded sRGB) — so orientation/geometry are applied and the
       * frame comes out upright, matching an LR export — then INVERTS the exit
       * transform (sRGB decode → SRGB_TO_WORK) back to working-linear, exactly
       * the design's "invert our exit transform on our render". Null when no
       * image/renderer. Async (a one-shot render).
       */
      developedForFit(maxDim: number): Promise<{ rgb: number[]; width: number; height: number } | null>;
      /** Capture make/model of the current image (fit-base-curve + base-curve verify); null for a JPEG or non-Sony RAW. */
      captureInfo(): { cameraMake: string | null; cameraModel: string | null } | null;
      /** Working-space identity + the decode's libraw output color (verify:cst). */
      workingSpaceInfo(): { id: string; outputColor: number };
      /** Fraction of decoded pixels whose WORK_TO_SRGB has any channel < −0.001 (out-of-gamut probe). */
      outOfGamutFraction(): number | null;
      updateNodeParam(nodeId: string, key: string, value: number): void;
      applyShaderSource(nodeId: string, src: string): Promise<void>;
      addShaderParam(nodeId: string, def: { name: string; min: number; max: number; default: number }): string | null;
      updateShaderParam(nodeId: string, name: string, value: number): void;
      removeShaderParam(nodeId: string, name: string): void;
      exportImageTo(
        path: string,
        opts?: { quality?: number; maxDim?: number | null; metadata?: ExportMetadataPolicy; colorSpace?: ExportColorSpace }
      ): void;
      /** Verify-only: exercises the export dialog's "output" selector (exportSelectedOutputs) without a native save dialog. */
      exportOutputsTo(
        target: 'active' | 'all' | string,
        path: string,
        opts?: { quality?: number; maxDim?: number | null; metadata?: ExportMetadataPolicy; colorSpace?: ExportColorSpace }
      ): void;
      exportState(): { status: string; error: string | null };
      /** Verify-only: exercises the export dialog's "Export LUT…" action without a native save dialog (mirrors exportOutputsTo's pattern). */
      exportLutTo(basePath: string): void;
      /** Set once an exportLut call completes — file count, their paths, and any color ops it couldn't capture. */
      exportLutState(): { count: number; paths: string[]; skipped: string[] } | null;
      /** Verify-only: deterministic store-level wiring for test setup (the drag-to-wire UI itself is ms13's coverage). */
      connectEdge(source: string, target: string, targetHandle?: 'a' | 'b' | 'mask'): void;
      /**
       * Verify-only: select a node by id (or null to deselect) without
       * clicking its React Flow DOM element — NodeEditorPanel's `fitView`
       * only runs once at mount, so a node added later in a long verify
       * script can sit outside the panel's current pan/zoom, making a real
       * click flaky/hanging (round-7's overlay-auto-clear repro needs to
       * select an ARBITRARY node deterministically).
       */
      selectNode(id: string | null): void;
      /** Node bypass toggle (Resolve's Ctrl+D-equivalent) — verify-only convenience, drives the exact same store action as ⌘D/the node body's bypass button. */
      toggleNodeDisabled(nodeId: string): void;
      /** Set once a exportSelectedOutputs batch completes — file count + the paths written. */
      exportBatchState(): { count: number; paths: string[] } | null;
      /** Current `<userData>/settings.json` state (loaded at boot / after any settingsUpdate). */
      settingsState(): Settings;
      /** Merge `partial` into settings via IPC (mirrors the store action). */
      updateSettings(partial: Partial<Settings>): Promise<void>;
      canvasView(): ViewportState & { dpr: number };
      wbState(): { asShot: { temp: number; tint: number }; mccamyCct: number };
      setToneCurvePoints(nodeId: string, channel: 'rgb' | 'r' | 'g' | 'b', points: [number, number][]): void;
      histogramState(): import('../engine/gpu/graphRenderer').HistogramData | null;
      historyState(): { past: number; future: number };
      setGeometry(geo: GeometryParams): void;
      geometryState(): GeometryParams;
      setLens(lens: LensParams): void;
      lensState(): LensParams;
      /** Sony embedded lens-profile (task #34): the parsed splines on the current image + the doc's enabled flag. */
      lensProfileState(): {
        hasProfile: boolean;
        enabled: boolean;
        distortion: number[] | null;
        caRed: number[] | null;
        caBlue: number[] | null;
        vignette: number[] | null;
      };
      outputDims(): { width: number; height: number } | null;
      /** WB eyedropper solver unit check: solves + applies gains to `rgb`, using the live per-image wbModel. */
      wbSolveCheck(rgb: [number, number, number]): {
        temp: number;
        tint: number;
        result: [number, number, number];
        resultEncoded: [number, number, number];
      };
      scopeState(): {
        mode: string;
        samples: { cols: number; rows: number; length: number; meanLuma: number } | null;
      };
      setScopeMode(mode: 'histogram' | 'waveform' | 'parade' | 'vectorscope'): void;
      /** Live GPU-resource counters + cache sizes from the GraphRenderer (perf-probe diagnostics; bridged to the render worker). */
      rendererStats(): Promise<import('../engine/gpu/graphRenderer').RendererStats | null>;
      /** Heap + renderer snapshot in one call, for scripts/perf-probe.mjs's per-batch sampling. */
      perfProbe(): Promise<{
        heapUsed: number | null;
        rendererStats: import('../engine/gpu/graphRenderer').RendererStats | null;
      }>;
      /** Verify-only: GPU histogram compute restricted to a crop rect (scripts/verify-ms10-histogram.mjs). */
      statsCrop(
        x0: number,
        y0: number,
        w: number,
        h: number
      ): Promise<import('../engine/gpu/graphRenderer').HistogramData | null>;
      /** Verify-only: raw encoded RGBA bytes of a crop rect, for cross-checking statsCrop() in JS. */
      encodedCropForVerify(x0: number, y0: number, w: number, h: number): Promise<number[] | null>;
      /** Mask node params (masks milestone); `nodeId` defaults to the currently selected node. Null when that node isn't kind 'mask'. */
      maskState(nodeId?: string): MaskParams | null;
      /** Replace shapes[0] of a mask node — one undo entry (verify-only convenience; the UI drag handles use the store action directly). */
      setMaskShape(nodeId: string, shape: MaskShape): void;
      /** Per-output export setting overrides (per-output export settings design note) — one undo entry (verify-only convenience; mirrors setMaskShape's pattern). `{}` clears every override back to "inherit". */
      setExportOverrides(nodeId: string, overrides: ExportOverrides): void;
      /** Spots node params (spot removal, task #50); `nodeId` defaults to the currently selected node. Null when that node isn't kind 'spots'. */
      spotsState(nodeId?: string): SpotsParams | null;
      /** Wholesale-replace a spots node's list — one undo entry (verify-only convenience; mirrors setMaskShape's pattern). */
      setSpots(nodeId: string, spots: Spot[]): void;
      /** The active chain's spots node id (see appStore.ts's findActiveSpotsNodeId), or null when none exists yet. */
      activeSpotsNodeId(): string | null;
      /** Spot-mode UI state: tool toggle, current brush radius, selected index, and any cap notice. */
      spotState(): { mode: boolean; brushRadius: number; selectedIndex: number | null; capNotice: string | null };
      /** Verify-only convenience: set the brush radius directly (bypasses the slider's UI range so scripts can dial in a "generous" radius). */
      setSpotBrushRadius(radius: number): void;
      /** Image node (composite/mask-by-another-file feature): `nodeId` defaults to the currently selected node. Null when that node isn't kind 'image'. */
      imageNodeState(nodeId?: string): { path: string; missing: boolean } | null;
      /** Verify-only: set an image node's referenced-file path — one undo entry (bypasses the Inspector's native "Choose…" dialog). */
      setImagePath(nodeId: string, path: string): void;
      /** Verify-only render-worker-cache check: how many times imageNodeSource.ts has actually decoded (cache misses only) — see its own doc comment. */
      imageNodeDecodeCount(): number;
      /** External-tool hook node (task #41): `nodeId` defaults to the currently selected node. Null when that node isn't kind 'external'. */
      externalNodeState(
        nodeId?: string
      ): { command: string; encoded: boolean; needsConfirm: string | null; error: string | null } | null;
      /** Verify-only: set an external node's command template — one undo entry (bypasses the Inspector's text input). */
      setExternalCommand(nodeId: string, command: string): void;
      /** Verify-only: toggle an external node's encoded/linear color-boundary mode. */
      setExternalEncoded(nodeId: string, encoded: boolean): void;
      /** Verify-only: click-equivalent of the Inspector's "Run external tool" confirm button. */
      confirmExternalNode(nodeId: string): void;
      /** Verify-only: real subprocess spawn count this session (main process — see externalTool.ts). */
      externalToolSpawnCount(): Promise<number>;
      /** Verify-only: cumulative count of render() calls posted to the render worker — used to prove a node drag doesn't re-post per mouse-move (#pointer-drag-lag). */
      renderPostCount(): number;
      /** Develop presets (task #37): `<userData>/presets/*.json` summaries currently in the store. */
      presetsState(): import('../../../shared/ipc').PresetSummary[];
      /** Save the current graph as a whole-look preset named `name` (mirrors PresetsMenu's "Save"). */
      savePreset(name: string): Promise<void>;
      /** Apply a saved preset by slug (mirrors PresetsMenu's "Apply") — one undo entry. */
      applyPreset(slug: string): Promise<void>;
      /** Delete a saved preset by slug (mirrors PresetsMenu's "Delete"). */
      deletePreset(slug: string): Promise<void>;
    };
  }
}

/**
 * The exit color transform, mirroring the ENCODE_SHADER matrix exactly (same
 * row order, so GPU f32 and CPU f64 agree well within the 1/255 parity bound):
 * linear Rec.2020 working color → linear sRGB. srgbEncode then clamps to
 * [0,1] — the gamut clip lives at the exit.
 */
/**
 * Referentially-stable projection of a GraphDoc onto the fields buildPlan (and
 * the GPU pass) actually consume. Node `position` is layout-only (graphDoc.ts
 * — buildPlan never reads it) and used only by NodeEditorPanel/serialization,
 * so a position-only edit (dragging a node, or the one commit at drag end —
 * see NodeEditorPanel.tsx's local drag state) must not change the object this
 * hook returns. That keeps it safe to key the render effect below on this
 * value instead of the raw store `graph`: a drag no longer re-posts the same
 * plan to the render worker on every move, or even once at drop.
 */
function usePlanDoc(doc: GraphDoc): GraphDoc {
  const stableRef = useRef(doc);
  const keyRef = useRef<string>('');
  const key = JSON.stringify(doc.nodes.map(({ position: _position, ...rest }) => rest)) + '|' + JSON.stringify(doc.edges);
  if (key !== keyRef.current) {
    keyRef.current = key;
    stableRef.current = doc;
  }
  return stableRef.current;
}

/**
 * Compare view (compare pack): backing-store resolution of the compare pane
 * relative to outputDims. 1 = full-res double render (same cost as the main
 * pane); 0.5 halves the compare pane's pixel count when a full-res double
 * render measurably lags slider drags (see this file's compare-render effect
 * and the report's perf finding — CSS size still matches outputDims exactly,
 * so the browser just upsamples a softer image; the fit/pan/zoom MATH is
 * untouched either way).
 */
const COMPARE_PANE_SCALE = 1;

/** Long-edge target (px) for every node-graph thumbnail (per-node-preview pack, tier 1) — a UE-material-editor-style ~64px preview, cheap at this size (see graphRenderer.ts's THUMBNAIL_SHADER). */
const NODE_THUMBNAIL_LONG_EDGE = 64;
/** Debounce (ms) after the LAST render before thumbnails refresh — never per-slider-tick (see this file's thumbnail-timer effect below). */
const NODE_THUMBNAIL_DEBOUNCE_MS = 300;

function workToSrgb(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  return [
    WORK_TO_SRGB[0][0] * r + WORK_TO_SRGB[0][1] * g + WORK_TO_SRGB[0][2] * b,
    WORK_TO_SRGB[1][0] * r + WORK_TO_SRGB[1][1] * g + WORK_TO_SRGB[1][2] * b,
    WORK_TO_SRGB[2][0] * r + WORK_TO_SRGB[2][1] * g + WORK_TO_SRGB[2][2] * b,
  ];
}

/**
 * Preview area. Milestone 4: the GraphDoc op chain runs as WebGPU passes over
 * the linear preview, ending in the exit encode (Rec.2020→sRGB + sRGB curve).
 * The verify harness compares the GPU readback against cpuReferenceMean(),
 * which executes the same chain on the CPU via the op registry's reference
 * implementations and the same exit transform.
 */
export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RenderWorkerClient | null>(null);
  // Compare view (compare pack): the SECOND pane's canvas — see renderWorker.ts
  // for why it's a second GraphRenderer in the SAME worker, not a second
  // Worker. Its container is deliberately NOT wired to useCanvasViewport: the
  // brief's "events bind once" — pan/zoom listeners stay on `containerRef`
  // only, and `view` (below) is applied to BOTH canvases' transforms.
  const compareCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastImageRef = useRef<unknown>(null);
  // Async GPU failures (device loss etc.) live in the store (see task
  // #45/worker-error-surfacing) so the render worker's out-of-band 'error'
  // message reaches the UI the same way a pre-worker GraphRenderer rejection
  // used to — this component just reads it, same as any other store field.
  const gpuError = useAppStore((s) => s.gpuError);
  const setGpuError = useAppStore((s) => s.setGpuError);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const openingPreview = useAppStore((s) => s.openingPreview);
  const imageError = useAppStore((s) => s.imageError);
  const graph = useAppStore((s) => s.graph);
  const fileName = useAppStore((s) => s.fileName);
  // Inspect mode (per-node-preview pack, tier 2) — see appStore.ts's
  // inspectNodeId doc comment for the compareMode exclusivity rule.
  const inspectNodeId = useAppStore((s) => s.inspectNodeId);
  const setInspectNode = useAppStore((s) => s.setInspectNode);
  // LR-style preset hover preview (round-7 UX pack G §4): a transient look
  // that overrides the RENDER only — everything else in this component
  // (selection, mask/spot overlays, the node editor's own reads of `graph`)
  // stays bound to the real `graph` below; only graphForBuild substitutes
  // this in, and only at the top of its derivation (before cropMode's own
  // override) — see graphForBuild's assignment.
  const previewLook = useAppStore((s) => s.previewLook);
  const shaderRev = useAppStore((s) => s.shaderRev);
  // Image node (composite/mask-by-another-file feature): imagePath is the
  // main image's own path, used only to derive the SIDECAR directory a
  // relative image-node path resolves against (see imageNode.ts's
  // resolveImagePath) — imageNodeRev is the shaderRev-style "an async
  // decode settled, re-render" bump (see appStore.ts's doc comment).
  const imagePath = useAppStore((s) => s.imagePath);
  const imageNodeRev = useAppStore((s) => s.imageNodeRev);
  const bumpImageNodeRev = useAppStore((s) => s.bumpImageNodeRev);
  // External-tool hook node (task #41): bumped when a round trip settles or a
  // cached result becomes ready with no run needed — same "re-run this
  // effect so client.render() reposts and the fresh texture shows up" role
  // as imageNodeRev above.
  const externalNodeRev = useAppStore((s) => s.externalNodeRev);
  const setImageNodeMissing = useAppStore((s) => s.setImageNodeMissing);
  const wbModel = useAppStore((s) => s.wbModel);
  const showBefore = useAppStore((s) => s.showBefore);
  const grayscaleView = useAppStore((s) => s.grayscaleView);
  const toggleBefore = useAppStore((s) => s.toggleBefore);
  const toggleGrayscaleView = useAppStore((s) => s.toggleGrayscaleView);
  const compareMode = useAppStore((s) => s.compareMode);
  const compareOutputId = useAppStore((s) => s.compareOutputId);
  // Sidecar visual diff's "Compare visually" (git-native completion brief
  // §1): a transient whole-graph override for pane B — see appStore.ts's
  // compareDocOverride doc comment. Takes priority over the ordinary
  // compareOutputId-based Mode B selection below whenever set.
  const compareDocOverride = useAppStore((s) => s.compareDocOverride);
  const cropMode = useAppStore((s) => s.cropMode);
  const wbPicking = useAppStore((s) => s.wbPicking);
  const setWbPicking = useAppStore((s) => s.setWbPicking);
  const colorKeyPicking = useAppStore((s) => s.colorKeyPicking);
  const setColorKeyPicking = useAppStore((s) => s.setColorKeyPicking);
  const maskDrawMode = useAppStore((s) => s.maskDrawMode);
  const setMaskDrawMode = useAppStore((s) => s.setMaskDrawMode);
  const spotMode = useAppStore((s) => s.spotMode);
  const setSpotMode = useAppStore((s) => s.setSpotMode);
  const spotBrushRadius = useAppStore((s) => s.spotBrushRadius);
  const commitSpot = useAppStore((s) => s.commitSpot);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const activeOutputId = useAppStore((s) => s.activeOutputId);
  const maskOverlay = useAppStore((s) => s.maskOverlay);
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
  const selectedMaskNode = selectedNode?.kind === MASK_KIND ? selectedNode : undefined;
  // Inspect mode (per-node-preview pack, tier 2) badge label — nodeLabel is
  // the SAME helper NodeEditorPanel's node bodies use, so the two never say
  // different things about the same node.
  const inspectedNode = inspectNodeId ? graph.nodes.find((n) => n.id === inspectNodeId) : undefined;
  // The active chain's spots node (appStore.ts's findActiveSpotsNodeId) —
  // NOT simply selectedNode: spot mode edits/shows that chain's spots
  // regardless of whatever else happens to be selected in the node editor.
  const activeSpotsNodeId = spotMode ? findActiveSpotsNodeId(graph, activeOutputId) : null;
  const activeSpotsNode = graph.nodes.find((n) => n.id === activeSpotsNodeId);
  // Mask/spot coords live in ANCHOR space (anchorSpace.ts): the committed
  // (real) input-node geometry + the decoded image's ORIENTED dims are what
  // the overlays and canvas gestures convert against. Overlays/gestures only
  // ever run OUTSIDE crop mode (the modal tools are mutually exclusive), so
  // this uses the true geometry — not cropMode's crop-suppressed graphForBuild.
  const inputGeometry = graph.nodes.find((n) => n.kind === 'input')?.geometry ?? defaultGeometryParams();
  const anchorDims = image
    ? orientedDims(image.width, image.height, inputGeometry.orientation ?? defaultGeometryOrientation())
    : null;
  // Preset hover preview (UX pack G §4) substitutes in at the TOP of this
  // derivation — before cropMode's own override below — so a preview during
  // crop mode (edge case; the two tools aren't normally used together) still
  // gets the crop-suppressed full-frame treatment same as the real graph
  // would. previewLook already carries the CURRENT geometry (setPreviewLook
  // merges it in — see appStore.ts), so this substitution alone never changes
  // outputDims.
  const previewBase = previewLook ?? graph;
  // Crop mode previews the FULL (uncropped) straightened frame — the overlay
  // lets you re-adjust the crop rect against the whole image — so force crop
  // back to identity for RENDERING only; the true crop committed in the graph
  // is untouched and takes over once cropMode exits (Done). Angle AND
  // orientation stay live so straighten/rotate/flip are visible while cropping.
  const graphForBuild =
    cropMode && image
      ? {
          ...previewBase,
          nodes: previewBase.nodes.map((n) =>
            n.kind === 'input'
              ? {
                  ...n,
                  geometry: {
                    crop: { x: 0, y: 0, w: 1, h: 1 },
                    angle: n.geometry?.angle ?? 0,
                    orientation: n.geometry?.orientation ?? defaultGeometryOrientation(),
                  },
                }
              : n
          ),
        }
      : previewBase;
  // Output dims (post-crop) computed SYNCHRONOUSLY from store state — the
  // canvas/viewport must not wait on the GPU renderer's async setGraph()
  // round-trip to know its own size, or fit-to-view would race it (see ms9).
  // A ref-memoized value keeps the object referentially stable across
  // unrelated re-renders, so fit-to-view only re-runs when the size actually
  // changes.
  const outputDimsRef = useRef<{ width: number; height: number } | null>(null);
  const rawOutputDims = image ? computeOutputDims(image.width, image.height, graphForBuild) : null;
  if (!rawOutputDims) {
    outputDimsRef.current = null;
  } else if (
    !outputDimsRef.current ||
    outputDimsRef.current.width !== rawOutputDims.width ||
    outputDimsRef.current.height !== rawOutputDims.height
  ) {
    outputDimsRef.current = rawOutputDims;
  }
  const outputDims = outputDimsRef.current;
  // Position-only edits (node drags) must never cause a re-render-and-post to
  // the worker — buildPlan ignores position entirely, so reposting the exact
  // same plan is wasted GPU work (and was the root cause of the drag-lag bug:
  // see NodeEditorPanel.tsx). planDoc keeps the SAME reference across such
  // edits; it — not graphForBuild directly — drives the render effect below.
  const planDoc = usePlanDoc(graphForBuild);
  const { view, fit, fitAnimated, oneToOne, setViewFree } = useCanvasViewport(
    containerRef,
    outputDims,
    wbPicking || colorKeyPicking || maskDrawMode !== null || spotMode,
    spotMode // spot mode repurposes the wheel to adjust brush radius (see the dedicated wheel listener below)
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const statsTimerRef = useRef<number | undefined>(undefined);
  /** Per-node-preview pack (tier 1): the 300ms post-render debounce timer — see the thumbnail-refresh block in the render effect below. */
  const thumbTimerRef = useRef<number | undefined>(undefined);
  const scopeMode = useAppStore((s) => s.scopeMode);

  // Space's animated fit (UX pack G §2): register this mount's fitAnimated
  // with the store so App.tsx's window-level Space handler can reach it —
  // same "component-local imperative thing, store-reachable" pattern as
  // setRenderer below. Cleared on unmount so a stale closure never lingers
  // after the canvas goes away.
  useEffect(() => {
    useAppStore.getState().setViewportFitAnimated(fitAnimated);
    return () => useAppStore.getState().setViewportFitAnimated(null);
  }, [fitAnimated]);

  // Spot mode (task #50; round-10 fix pack item 7 adds the `[`/`]` alias +
  // the transient readout below): the plain wheel gesture adjusts the brush
  // radius instead of zooming (useCanvasViewport's own onWheel opts out via
  // suppressWheelZoom above — both listeners sit on the SAME container
  // element, so no propagation trickery is needed, just checking spotMode
  // fresh from the store on every event so this effect never needs to
  // re-register when the mode flips).
  //
  // Round-5 finding: mirrors SpotOverlay's slider rule — with a spot
  // SELECTED, the wheel resizes THAT spot (LR behavior) instead of the
  // next-spot brush radius. `adjustSpotRadius` (below) is the ONE
  // implementation of that branch, shared with the `[`/`]` keys — both are
  // "the same kind of edit" at different input granularities, so they also
  // share ONE undo-coalescing session (`spotRadiusSessionRef`/
  // `spotRadiusTimerRef`): a burst that mixes wheel scrolls and bracket
  // presses still lands as a single undo entry, same idle-timeout shape the
  // wheel-only version already had (500ms of silence resets it).
  const spotRadiusSessionRef = useRef<number | null>(null);
  const spotRadiusTimerRef = useRef<number | undefined>(undefined);
  // Last pointer position seen over the canvas WHILE in spot mode (client
  // coords) — purely so the `[`/`]` keys (no coordinates of their own, unlike
  // a WheelEvent) can still show the transient readout near the cursor.
  // Ref, not state: updated on every pointermove, and a re-render on every
  // mouse move in spot mode would be wasteful.
  const spotCursorRef = useRef<{ x: number; y: number } | null>(null);
  // Transient "radius changed" readout (round-10 item 7): shown near the
  // cursor for ~900ms after a wheel/bracket change, then auto-hidden — same
  // idle-timeout shape as the undo-session coalescing above, just for the UI
  // instead of history. Reuses SpotOverlay's own `(radius*100).toFixed(1)%`
  // formatting (the existing readout pattern next to the brush-radius
  // slider) rather than inventing a new unit.
  const [spotRadiusReadout, setSpotRadiusReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const spotRadiusReadoutTimerRef = useRef<number | undefined>(undefined);
  // useCallback([]) — not just an inline closure — because BOTH consumers
  // below (the wheel effect and the `[`/`]` keydown effect) register with
  // empty deps arrays themselves (so they never re-subscribe as spot state
  // changes, matching the pre-existing wheel effect's own convention); a
  // stable identity here means there's no stale-closure surprise even though
  // it's never actually re-invoked with a different closure in practice
  // (everything inside reads fresh via useAppStore.getState() or a ref).
  const showSpotRadiusReadout = useCallback((x: number, y: number, outputRadius: number) => {
    setSpotRadiusReadout({ x, y, text: `${(outputRadius * 100).toFixed(1)}%` });
    clearTimeout(spotRadiusReadoutTimerRef.current);
    spotRadiusReadoutTimerRef.current = window.setTimeout(() => setSpotRadiusReadout(null), 900);
  }, []);

  const adjustSpotRadius = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      const s = useAppStore.getState();
      if (s.selectedSpotIndex !== null) {
        const spotsNodeId = findActiveSpotsNodeId(s.graph, s.activeOutputId);
        const spotsNode = spotsNodeId ? s.graph.nodes.find((n) => n.id === spotsNodeId) : undefined;
        const spot = spotsNode?.spots?.spots?.[s.selectedSpotIndex];
        if (spotsNode && spot && s.image) {
          const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
          const geom = inputNode?.geometry ?? defaultGeometryParams();
          const dims = orientedDims(s.image.width, s.image.height, geom.orientation ?? defaultGeometryOrientation());
          const outRadius = anchorRadiusToOutput(spot.radius, geom, dims.width, dims.height);
          const nextOutRadius = Math.max(0.005, outRadius * factor);
          const nextRadius = outputRadiusToAnchor(nextOutRadius, geom, dims.width, dims.height);
          spotRadiusSessionRef.current ??= Date.now();
          clearTimeout(spotRadiusTimerRef.current);
          spotRadiusTimerRef.current = window.setTimeout(() => {
            spotRadiusSessionRef.current = null;
          }, 500);
          s.updateSpot(
            spotsNode.id,
            s.selectedSpotIndex,
            { radius: nextRadius },
            `spot-radius-wheel:${spotsNode.id}:${s.selectedSpotIndex}:${spotRadiusSessionRef.current}`
          );
          showSpotRadiusReadout(clientX, clientY, nextOutRadius);
          return;
        }
      }
      const next = Math.min(0.5, Math.max(0.002, s.spotBrushRadius * factor));
      s.setSpotBrushRadius(next);
      showSpotRadiusReadout(clientX, clientY, next);
    },
    [showSpotRadiusReadout]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (ev: WheelEvent) => {
      const s = useAppStore.getState();
      if (!s.spotMode) return;
      // Trackpad pinch (ctrlKey wheel, round-6): let it fall through to
      // useCanvasViewport's own listener on the SAME container instead —
      // don't preventDefault here (that listener already does), and don't
      // touch the brush radius, or pinch would stop zooming the moment spot
      // mode repurposes the plain wheel.
      if (ev.ctrlKey) return;
      ev.preventDefault();
      adjustSpotRadius(Math.exp(-ev.deltaY * 0.0015), ev.clientX, ev.clientY);
    };
    // Cheap continuous tracker (no state, no re-render) purely so the `[`/`]`
    // keydown handler below has a recent cursor position to anchor its own
    // readout on.
    const onPointerMove = (ev: PointerEvent) => {
      if (!useAppStore.getState().spotMode) return;
      spotCursorRef.current = { x: ev.clientX, y: ev.clientY };
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('pointermove', onPointerMove);
    return () => {
      clearTimeout(spotRadiusTimerRef.current);
      clearTimeout(spotRadiusReadoutTimerRef.current);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointermove', onPointerMove);
    };
  }, [adjustSpotRadius]);

  // `[`/`]` brush-radius aliases (round-10 fix pack item 7, LR convention) —
  // window-scoped (not the container) so they fire regardless of which
  // element inside the canvas currently has focus, same reach as App.tsx's
  // own shortcut chain; lives here rather than in App.tsx because it needs
  // the same image/geometry context adjustSpotRadius above already has in
  // scope. isTextEntry-guarded like every other plain-key shortcut.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== '[' && ev.key !== ']') return;
      if (!useAppStore.getState().spotMode) return;
      if (isTextEntry(ev.target)) return;
      ev.preventDefault();
      const factor = ev.key === ']' ? 1.1 : 1 / 1.1;
      const cursor = spotCursorRef.current;
      const container = containerRef.current;
      const fallback = container?.getBoundingClientRect();
      const x = cursor?.x ?? (fallback ? fallback.left + fallback.width / 2 : 0);
      const y = cursor?.y ?? (fallback ? fallback.top + fallback.height / 2 : 0);
      adjustSpotRadius(factor, x, y);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [adjustSpotRadius]);

  // Keep the canvas element's own LAYOUT size in sync with outputDims
  // SYNCHRONOUSLY (before paint) — decoupled from the GPU renderer's async
  // render pipeline, which only needs to catch up on PIXEL CONTENT.
  //
  // This sets CSS pixel size, not the width/height IDL attributes: once the
  // canvas's control has been transferred to the render worker's
  // OffscreenCanvas (RenderWorkerClient's constructor — see the effect
  // below), setting those attributes on the placeholder THROWS ("Cannot
  // resize canvas after call to transferControlToOffscreen()"). The
  // OffscreenCanvas's own backing-store size is instead kept in sync by an
  // explicit 'resize' message (client.resize() in the effect below) — CSS
  // size here and backing-store size there are set from the same
  // `outputDims` value, so the 1:1 pixel-grid invariant handleWbPick relies
  // on still holds.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !outputDims) return;
    canvas.style.width = `${outputDims.width}px`;
    canvas.style.height = `${outputDims.height}px`;
  }, [outputDims]);

  // Compare pane's CSS size ALWAYS matches the main canvas's exactly (same
  // outputDims) regardless of COMPARE_PANE_SCALE — the backing-store
  // resolution (set via client.compareResize below) is the only thing that
  // may differ, so the shared `view` transform's fit/pan/zoom math applies
  // identically to both canvases (the browser just up/downsamples the
  // compare pane's pixel content to fill the same CSS box).
  useLayoutEffect(() => {
    const canvas = compareCanvasRef.current;
    if (!canvas || !outputDims) return;
    canvas.style.width = `${outputDims.width}px`;
    canvas.style.height = `${outputDims.height}px`;
  }, [outputDims]);

  // switching into a non-histogram mode fetches fresh samples immediately:
  // edits made while the histogram was showing don't update scopeSamples, so
  // an existing value may be stale — always refetch, never just reuse it
  useEffect(() => {
    if (scopeMode === 'histogram') return;
    const client = useAppStore.getState().renderer;
    if (!client || !client.hasImage) return;
    void client.scopeSamples().then((samples) => {
      useAppStore.getState().setScopeSamples(samples);
    });
  }, [scopeMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    try {
      // transferControlToOffscreen() may only run once per canvas element —
      // this ref persists across re-renders the same way the old GraphRenderer
      // promise did. Creation itself is synchronous (the GPUDevice/pipelines
      // come up async INSIDE the worker); GPU-init failure surfaces later via
      // handleInitError → setGpuError, mirroring GraphRenderer.create()
      // rejecting on the old single-thread path.
      if (!clientRef.current) {
        const client = new RenderWorkerClient(canvas);
        client.setErrorHandler((message) => setGpuError(message));
        // External-tool hook node (task #41): the worker only knows WHAT to
        // run (readback + hash + debounce — see GraphRenderer.checkExternalNodes);
        // externalNodeRunner.ts owns the confirm gate + the actual IPC call.
        // docKey (imagePath — falls back to 'unsaved' for a never-saved doc)
        // is read FRESH from the store at request time, not closed over here,
        // since this handler is registered once per canvas mount.
        client.setExternalRunRequestHandler((req) => {
          const s = useAppStore.getState();
          void handleExternalRunRequest(
            req,
            s.imagePath ?? 'unsaved',
            client,
            (nodeId, command) => useAppStore.getState().setExternalNodeNeedsConfirm(nodeId, command),
            (nodeId, ok, error) => {
              useAppStore.getState().setExternalNodeError(nodeId, ok ? null : (error ?? 'unknown error'));
              useAppStore.getState().bumpExternalNodeRev();
            }
          );
        });
        client.setExternalNodeReadyHandler(() => useAppStore.getState().bumpExternalNodeRev());
        clientRef.current = client;
        useAppStore.getState().setRenderer(client);
      }
      const client = clientRef.current;
      if (lastImageRef.current !== image) {
        client.setImage(image);
        lastImageRef.current = image;
      }
      // Image node (composite/mask-by-another-file feature): decode any
      // referenced file THIS doc needs, lazily, cached per path — see
      // imageNodeSource.ts. Fire-and-forget from this effect's own point of
      // view: `image` (captured now) is the staleness guard (dropped if the
      // main image has switched by the time a decode resolves), and
      // bumpImageNodeRev (imageNodeRev is a dependency below) is what makes
      // THIS SAME effect re-run and post a fresh render once a referenced
      // file's texture actually lands worker-side.
      syncImageNodeSources(
        planDoc,
        imagePath ? dirnameOf(imagePath) : null,
        client,
        () => useAppStore.getState().image !== image,
        setImageNodeMissing,
        bumpImageNodeRev
      );
      const renderScale = Math.max(image.width, image.height) / Math.max(image.fullWidth, image.fullHeight);
      // a broken input→output path renders as pass-through with a banner in
      // the node editor instead of killing the preview. buildPlan is pure and
      // side-effect-free (graphDoc.ts), so re-running it here — main-side,
      // redundant to the worker's own copy over the SAME doc — costs nothing
      // and needs no round trip just to learn whether it throws. This is
      // ALSO the FULL, never-inspect-truncated plan the thumbnail refresh
      // below reuses (its nodeSteps) — inspect mode must never change what
      // thumbnails show, only what the main canvas shows (see client.render's
      // own inspectNodeId, further down).
      let nodeSteps: Record<string, number> = {};
      try {
        const localPlan = buildPlan(planDoc, {
          wb: wbModel,
          renderScale,
          outputId: activeOutputId ?? undefined,
          srcWidth: image.width,
          srcHeight: image.height,
        });
        nodeSteps = localPlan.nodeSteps;
        useAppStore.getState().setGraphBroken(false);
      } catch {
        useAppStore.getState().setGraphBroken(true);
      }
      // the canvas element's pixel dims are kept in sync with outputDims by
      // the useLayoutEffect above (synchronous, no GPU round-trip needed);
      // the OFFSCREEN canvas the worker actually renders into needs its own
      // explicit resize message (setting the placeholder's width/height does
      // not reach across the transfer).
      if (outputDims) client.resize(outputDims.width, outputDims.height);
      client.viewMode = grayscaleView ? 'grayscale' : 'color';
      // Before/After: show the unedited decode (readbacks follow, so the
      // histogram describes what is on screen — LR behavior); the worker
      // applies this same override after building its own plan. outputId
      // selects among named outputs (spec §6, undefined = the doc's first);
      // overlayMaskNodeId (masks milestone) shows the selected mask node's
      // value as a canvas-only red overlay (present-time only — see
      // graphRenderer.ts's render()), gated on BOTH the 'O' toggle and the
      // selection actually being a mask node.
      client.render({
        doc: planDoc,
        renderScale,
        showBefore,
        outputId: activeOutputId ?? undefined,
        overlayMaskNodeId: maskOverlay && selectedMaskNode ? selectedMaskNode.id : null,
        inspectNodeId,
      });
      setGpuError(null);
      // Compare view (compare pack): mirrors the render() call above onto the
      // SECOND canvas/GraphRenderer (renderWorker.ts's initCompare/compareRender)
      // — Mode A (no valid compareOutputId) shows the before state, exactly
      // like the A/B toggle's showBefore above; Mode B shows a second output
      // picked from the compare strip's dropdown (Toolbar.tsx's CompareStrip).
      // initCompare/compareResize run every effect pass regardless of
      // compareMode — both are cheap/idempotent — so the pane is already
      // sized and has a renderer waiting the INSTANT compare mode toggles on,
      // with no first-toggle GPU-setup lag; only the render() call itself is
      // gated on compareMode, so no GPU work happens while the pane is
      // hidden.
      const compareCanvas = compareCanvasRef.current;
      if (compareCanvas) {
        client.initCompare(compareCanvas);
        if (outputDims) {
          client.compareResize(
            Math.max(1, Math.round(outputDims.width * COMPARE_PANE_SCALE)),
            Math.max(1, Math.round(outputDims.height * COMPARE_PANE_SCALE))
          );
        }
        if (compareMode) {
          if (compareDocOverride) {
            // Sidecar visual diff's "Compare visually": pane B renders a
            // WHOLE FOREIGN DOC (the parsed disk sidecar), its own first
            // output — same "hand compareRender a different doc" trick Mode
            // B's own second-output selection below already relies on
            // (compareRender independently builds its own plan from `doc`,
            // see renderWorker.ts's 'compareRender' handler).
            client.compareRender({ doc: compareDocOverride, renderScale, showBefore: false, outputId: undefined });
          } else {
            const outputs = planDoc.nodes.filter((n) => n.kind === 'output');
            const resolvedActiveId =
              (activeOutputId && outputs.some((n) => n.id === activeOutputId) && activeOutputId) || outputs[0]?.id;
            // Mode B only while the picked id still names a DIFFERENT, existing
            // output — an output deleted out from under the selection (or a
            // stale pick equal to the now-active output) falls back to Mode A.
            const modeBOutputId =
              compareOutputId && compareOutputId !== resolvedActiveId && outputs.some((n) => n.id === compareOutputId)
                ? compareOutputId
                : null;
            client.compareRender({
              doc: planDoc,
              renderScale,
              showBefore: modeBOutputId === null,
              outputId: modeBOutputId ?? undefined,
            });
          }
        }
      }
      // refresh the histogram once edits settle (slider drags fire rapidly);
      // `gen` pins this debounce cycle so a slow response that resolves after
      // a NEWER edit's response never clobbers the store with stale data.
      clearTimeout(statsTimerRef.current);
      const gen = client.currentGen();
      statsTimerRef.current = window.setTimeout(() => {
        void client.stats().then((stats) => {
          if (stats && client.currentGen() === gen) useAppStore.getState().setHistogram(stats);
        });
        // scope samples are an extra readback — skip them in the default
        // histogram mode, where nothing consumes them
        if (useAppStore.getState().scopeMode !== 'histogram') {
          void client.scopeSamples().then((samples) => {
            if (client.currentGen() === gen) useAppStore.getState().setScopeSamples(samples);
          });
        }
      }, 120);

      // Node thumbnails (per-node-preview pack, tier 1): refreshed on a
      // SEPARATE, longer (300ms) post-render debounce — never per-slider-tick
      // — and skipped ENTIRELY while a modal canvas gesture (crop/spot/
      // mask-draw) is active, so a thumbnail readback never contends with a
      // drag's own frame budget (this file's fragile-spot guard). Clearing
      // the pending timer without rescheduling one is enough: the NEXT time
      // this effect runs with the gesture flag back off (the tool's own
      // deactivation flips cropMode/spotMode/maskDrawMode, which is itself a
      // dependency below) a fresh 300ms timer starts, so thumbnails still
      // settle shortly after the session ends.
      clearTimeout(thumbTimerRef.current);
      const gestureActive = cropMode || spotMode || maskDrawMode !== null;
      if (!gestureActive && Object.keys(nodeSteps).length > 0) {
        const thumbGen = client.currentGen();
        thumbTimerRef.current = window.setTimeout(() => {
          void client.thumbnails(nodeSteps, NODE_THUMBNAIL_LONG_EDGE).then(async (batch) => {
            // Stale-response guard, same reasoning as the stats/scope debounce
            // above: a newer edit (or image switch) may have moved on while
            // the GPU readback + PNG encode were in flight.
            if (!batch || client.currentGen() !== thumbGen) return;
            const merged = await updateNodeThumbs(useAppStore.getState().nodeThumbs, batch);
            useAppStore.getState().setNodeThumbs(merged);
          });
        }, NODE_THUMBNAIL_DEBOUNCE_MS);
      }
    } catch (err) {
      setGpuError(err instanceof Error ? err.message : String(err));
    }
  }, [
    image,
    planDoc,
    shaderRev,
    wbModel,
    showBefore,
    grayscaleView,
    cropMode,
    spotMode,
    maskDrawMode,
    activeOutputId,
    maskOverlay,
    selectedMaskNode?.id,
    compareMode,
    compareOutputId,
    compareDocOverride,
    inspectNodeId,
    imagePath,
    imageNodeRev,
    externalNodeRev,
  ]);

  useEffect(() => {
    window.__debug = {
      imageState() {
        const s = useAppStore.getState();
        return {
          status: s.imageStatus,
          width: s.image?.width,
          height: s.image?.height,
          fullWidth: s.image?.fullWidth,
          fullHeight: s.image?.fullHeight,
          flip: s.image?.flip,
        };
      },
      openingPreviewState() {
        return useAppStore.getState().openingPreview;
      },
      openingPreviewRevocations() {
        return [...openingPreviewRevocationLog()];
      },
      folderState() {
        const s = useAppStore.getState();
        return {
          dir: s.folderDir,
          entries: s.folderEntries.map((e) => ({ name: e.name, path: e.path, hasSidecar: e.hasSidecar, mtimeMs: e.mtimeMs, rating: e.rating })),
          currentPath: s.imagePath,
        };
      },
      thumbnailRevocations() {
        return [...thumbnailRevocationLog()];
      },
      /** Per-node-preview pack, tier 1: nodeId → blob: URL, exactly what the node editor's thumbnails read. */
      nodeThumbsState() {
        return useAppStore.getState().nodeThumbs;
      },
      /** Verify-only: every node-thumbnail blob: URL updateNodeThumbs has revoked so far, in order (revocation audit, mirrors thumbnailRevocations()). */
      nodeThumbRevocations() {
        return [...nodeThumbRevocationLog()];
      },
      /** Per-node-preview pack, tier 2: the currently-inspected node id, or null — see appStore.ts's inspectNodeId. */
      inspectState() {
        return useAppStore.getState().inspectNodeId;
      },
      rendererKind() {
        return 'webgpu';
      },
      outputSize() {
        // outputDimsRef is the single synchronous source of truth for the
        // canvas's pixel dims (see its computation above) — the DOM canvas
        // element's own width/height ATTRIBUTES are frozen at whatever they
        // were before transferControlToOffscreen() (setting them afterward
        // throws); its backing store is resized via an explicit message to
        // the render worker instead (RenderWorkerClient.resize()).
        return outputDimsRef.current;
      },
      async readbackMean() {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        return client.readbackMean();
      },
      async readbackLinearMean() {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        return client.readbackLinearMean();
      },
      /** Compare pane (compare pack) readback — see compareReadbackMean's client-side doc comment. */
      async compareReadbackMean() {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        return client.compareReadbackMean();
      },
      /** Compare view toggle + Mode B's picked second output id — see appStore.ts's compareMode/compareOutputId. */
      compareState() {
        const s = useAppStore.getState();
        return { mode: s.compareMode, outputId: s.compareOutputId };
      },
      setCompareMode(active) {
        useAppStore.getState().setCompareMode(active);
      },
      setCompareOutputId(id) {
        useAppStore.getState().setCompareOutputId(id);
      },
      async readbackSharpness() {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        return client.readbackSharpness();
      },
      cpuReferenceMean() {
        const s = useAppStore.getState();
        if (!s.image) return null;
        const { data, width, height } = s.image;
        const plan = buildPlan(s.graph, {
          wb: s.wbModel,
          renderScale: Math.max(width, height) / Math.max(s.image.fullWidth, s.image.fullHeight),
          srcWidth: width,
          srcHeight: height,
          cameraModel: s.image.capture?.cameraModel ?? null,
        });
        // custom WGSL (and not-yet-mirrored Develop sections) have no CPU reference
        if (!planHasCpuReference(plan)) return null;
        const n = width * height;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          const x = i % width;
          const y = Math.floor(i / width);
          const px = cpuEvalPlan(plan, [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!], x, y, width, height);
          const s = workToSrgb(px);
          r += srgbEncode(s[0]);
          g += srgbEncode(s[1]);
          b += srgbEncode(s[2]);
        }
        return { r: r / n, g: g / n, b: b / n };
      },
      graphState() {
        return useAppStore.getState().graph;
      },
      graphDirty() {
        return useAppStore.getState().graphDirty;
      },
      sidecarState() {
        const s = useAppStore.getState();
        return { notice: s.sidecarNotice, unreadable: s.sidecarUnreadable, rating: s.sidecarRating };
      },
      /** Sidecar hot-reload notice state (AI-editing loop) — see appStore.ts's sidecarHotReloadNotice. */
      hotReloadState() {
        return useAppStore.getState().sidecarHotReloadNotice;
      },
      /** Sidecar visual diff dialog state (git-native completion brief §1) — structured line list, robust for verify against DOM text scraping. */
      sidecarDiffState() {
        const dialog = useAppStore.getState().sidecarDiffDialog;
        return dialog ? { lines: dialog.lines } : null;
      },
      shaderErrors() {
        return useAppStore.getState().shaderErrors;
      },
      imageForVerify() {
        const image = useAppStore.getState().image;
        return image ? { data: image.data, width: image.width, height: image.height } : null;
      },
      async developedForFit(maxDim) {
        const s = useAppStore.getState();
        if (!s.imagePath || !s.fileName || !s.renderer) return null;
        const bytes = await window.silverbox.readFile(s.imagePath);
        const kind = isRawFileName(s.fileName) ? 'raw' : 'jpg';
        const full = await loadImage(bytes, kind, Math.max(1, maxDim), s.settings.baselineExposureEV);
        const { data, width, height } = await s.renderer.renderToPixels(full, s.graph, 1, 'srgb', undefined, false);
        // invert the exit transform: sRGB decode → SRGB_TO_WORK → working-linear
        const M = SRGB_TO_WORK;
        const n = width * height;
        const out = new Array(n * 3);
        for (let i = 0; i < n; i++) {
          const sr = srgbDecode(data[i * 4]! / 255);
          const sg = srgbDecode(data[i * 4 + 1]! / 255);
          const sb = srgbDecode(data[i * 4 + 2]! / 255);
          const o = i * 3;
          out[o] = M[0][0] * sr + M[0][1] * sg + M[0][2] * sb;
          out[o + 1] = M[1][0] * sr + M[1][1] * sg + M[1][2] * sb;
          out[o + 2] = M[2][0] * sr + M[2][1] * sg + M[2][2] * sb;
        }
        return { rgb: out, width, height };
      },
      captureInfo() {
        const image = useAppStore.getState().image;
        if (!image) return null;
        return { cameraMake: image.capture?.cameraMake ?? null, cameraModel: image.capture?.cameraModel ?? null };
      },
      workingSpaceInfo() {
        return { id: WORKING_SPACE_ID, outputColor: DECODE_OUTPUT_COLOR };
      },
      outOfGamutFraction() {
        const image = useAppStore.getState().image;
        if (!image) return null;
        const { data } = image;
        const n = data.length / 4;
        let oog = 0;
        for (let i = 0; i < n; i++) {
          const s = workToSrgb([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]);
          if (s[0] < -0.001 || s[1] < -0.001 || s[2] < -0.001) oog++;
        }
        return n > 0 ? oog / n : 0;
      },
      updateNodeParam(nodeId, key, value) {
        useAppStore.getState().updateNodeParam(nodeId, key, value);
      },
      applyShaderSource(nodeId, src) {
        return useAppStore.getState().applyShaderSource(nodeId, src);
      },
      addShaderParam(nodeId, def) {
        return useAppStore.getState().addShaderParam(nodeId, def);
      },
      updateShaderParam(nodeId, name, value) {
        useAppStore.getState().updateShaderParam(nodeId, name, value);
      },
      removeShaderParam(nodeId, name) {
        useAppStore.getState().removeShaderParam(nodeId, name);
      },
      exportImageTo(path, opts) {
        void useAppStore.getState().exportImage(path, opts);
      },
      exportOutputsTo(target, path, opts) {
        void useAppStore.getState().exportSelectedOutputs(target, path, opts);
      },
      connectEdge(source, target, targetHandle) {
        useAppStore.getState().connectEdge(source, target, targetHandle);
      },
      selectNode(id) {
        useAppStore.getState().selectNode(id);
      },
      toggleNodeDisabled(nodeId) {
        useAppStore.getState().toggleNodeDisabled(nodeId);
      },
      exportState() {
        const s = useAppStore.getState();
        return { status: s.exportStatus, error: s.exportError };
      },
      exportLutTo(basePath) {
        void useAppStore.getState().exportLut(basePath);
      },
      exportLutState() {
        return useAppStore.getState().exportLutInfo;
      },
      exportBatchState() {
        return useAppStore.getState().exportBatchInfo;
      },
      settingsState() {
        return useAppStore.getState().settings;
      },
      updateSettings(partial) {
        return useAppStore.getState().updateSettings(partial);
      },
      canvasView() {
        return { ...viewRef.current, dpr: devicePixelRatio };
      },
      wbState() {
        const { wbModel: model } = useAppStore.getState();
        return { asShot: model.asShot, mccamyCct: model.mccamyCct };
      },
      setToneCurvePoints(nodeId, channel, points) {
        useAppStore.getState().setToneCurvePoints(nodeId, channel, points, Date.now());
      },
      histogramState() {
        return useAppStore.getState().histogram;
      },
      historyState() {
        const h = useAppStore.getState().history;
        return { past: h.past.length, future: h.future.length };
      },
      scopeState() {
        const s = useAppStore.getState();
        const samples = s.scopeSamples;
        let meanLuma = 0;
        if (samples) {
          const n = samples.cols * samples.rows;
          let sum = 0;
          for (let i = 0; i < n; i++) {
            const r = samples.data[i * 3]!;
            const g = samples.data[i * 3 + 1]!;
            const b = samples.data[i * 3 + 2]!;
            sum += (WORKING_LUMA[0] * r + WORKING_LUMA[1] * g + WORKING_LUMA[2] * b) / 255;
          }
          meanLuma = n > 0 ? sum / n : 0;
        }
        return {
          mode: s.scopeMode,
          samples: samples ? { cols: samples.cols, rows: samples.rows, length: samples.data.length, meanLuma } : null,
        };
      },
      setScopeMode(mode) {
        useAppStore.getState().setScopeMode(mode);
      },
      async rendererStats() {
        const client = useAppStore.getState().renderer;
        return client ? await client.rendererStats() : null;
      },
      async perfProbe() {
        const client = useAppStore.getState().renderer;
        return {
          heapUsed: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
          rendererStats: client ? await client.rendererStats() : null,
        };
      },
      async statsCrop(x0, y0, w, h) {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        return client.statsCrop(x0, y0, w, h);
      },
      async encodedCropForVerify(x0, y0, w, h) {
        const client = clientRef.current;
        if (!client || !client.hasImage) return null;
        const px = await client.encodedCropForVerify(x0, y0, w, h);
        return px ? Array.from(px) : null;
      },
      setGeometry(geo) {
        useAppStore.getState().setGeometry(geo, null);
      },
      geometryState() {
        const s = useAppStore.getState();
        const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
        return inputNode?.geometry ?? defaultGeometryParams();
      },
      setLens(lens) {
        useAppStore.getState().setLens(lens, null);
      },
      lensState() {
        const s = useAppStore.getState();
        const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
        return inputNode?.lens ?? defaultLensParams();
      },
      lensProfileState() {
        const s = useAppStore.getState();
        const profile = s.image?.profile ?? null;
        const inputNode = s.graph.nodes.find((n) => n.kind === 'input');
        return {
          hasProfile: !!profile,
          enabled: inputNode?.lens?.profile?.enabled ?? false,
          distortion: profile?.distortion ?? null,
          caRed: profile?.caRed ?? null,
          caBlue: profile?.caBlue ?? null,
          vignette: profile?.vignette ?? null,
        };
      },
      outputDims() {
        return outputDimsRef.current;
      },
      wbSolveCheck(rgb) {
        const { wbModel: model } = useAppStore.getState();
        const { temp, tint } = solveNeutralWb(rgb, model);
        const g = model.gains(temp, tint);
        const result: [number, number, number] = [rgb[0] * g[0], rgb[1] * g[1], rgb[2] * g[2]];
        const resultEncoded: [number, number, number] = [
          srgbEncode(result[0]),
          srgbEncode(result[1]),
          srgbEncode(result[2]),
        ];
        return { temp, tint, result, resultEncoded };
      },
      maskState(nodeId) {
        const s = useAppStore.getState();
        const id = nodeId ?? s.selectedNodeId;
        const node = s.graph.nodes.find((n) => n.id === id);
        return node?.kind === MASK_KIND ? (node.mask ?? defaultMaskParams()) : null;
      },
      setMaskShape(nodeId, shape) {
        useAppStore.getState().setMaskShape(nodeId, shape, null);
      },
      setExportOverrides(nodeId, overrides) {
        useAppStore.getState().setExportOverrides(nodeId, overrides, null);
      },
      spotsState(nodeId) {
        const s = useAppStore.getState();
        const id = nodeId ?? s.selectedNodeId;
        const node = s.graph.nodes.find((n) => n.id === id);
        return node?.kind === SPOTS_KIND ? (node.spots ?? defaultSpotsParams()) : null;
      },
      setSpots(nodeId, spots) {
        useAppStore.getState().setSpots(nodeId, spots, null);
      },
      activeSpotsNodeId() {
        const s = useAppStore.getState();
        return findActiveSpotsNodeId(s.graph, s.activeOutputId);
      },
      spotState() {
        const s = useAppStore.getState();
        return {
          mode: s.spotMode,
          brushRadius: s.spotBrushRadius,
          selectedIndex: s.selectedSpotIndex,
          capNotice: s.spotsCapNotice,
        };
      },
      setSpotBrushRadius(radius) {
        useAppStore.getState().setSpotBrushRadius(radius);
      },
      /** Image node (composite/mask-by-another-file feature): path + missing-badge state for `nodeId` (defaults to the current selection); null when it isn't an image node. */
      imageNodeState(nodeId) {
        const s = useAppStore.getState();
        const id = nodeId ?? s.selectedNodeId;
        const node = s.graph.nodes.find((n) => n.id === id);
        if (node?.kind !== IMAGE_KIND) return null;
        return { path: node.image?.path ?? '', missing: s.imageNodeMissing[node.id] === true };
      },
      /** Verify-only: set an image node's referenced-file path without driving the Inspector's "Choose…" native dialog. */
      setImagePath(nodeId, path) {
        useAppStore.getState().setImagePath(nodeId, path, null);
      },
      /** Verify-only render-worker-cache check: bumped once per REAL decode (cache miss) — see imageNodeSource.ts. */
      imageNodeDecodeCount() {
        return imageNodeDecodeCount();
      },
      /** External-tool hook node (task #41): command/encoded + needs-confirm/error badge state for `nodeId` (defaults to the current selection); null when it isn't an external node. */
      externalNodeState(nodeId) {
        const s = useAppStore.getState();
        const id = nodeId ?? s.selectedNodeId;
        const node = s.graph.nodes.find((n) => n.id === id);
        if (node?.kind !== EXTERNAL_KIND) return null;
        return {
          command: node.external?.command ?? '',
          encoded: node.external?.encoded ?? true,
          needsConfirm: s.externalNodeNeedsConfirm[id!] ?? null,
          error: s.externalNodeErrors[id!] ?? null,
        };
      },
      setExternalCommand(nodeId, command) {
        useAppStore.getState().setExternalCommand(nodeId, command, null);
      },
      setExternalEncoded(nodeId, encoded) {
        useAppStore.getState().setExternalEncoded(nodeId, encoded);
      },
      confirmExternalNode(nodeId) {
        useAppStore.getState().confirmExternalNode(nodeId);
      },
      externalToolSpawnCount() {
        return window.silverbox.externalToolSpawnCount();
      },
      renderPostCount() {
        return clientRef.current?.renderPostCount ?? 0;
      },
      presetsState() {
        return useAppStore.getState().presets;
      },
      savePreset(name) {
        return useAppStore.getState().savePreset(name);
      },
      applyPreset(slug) {
        return useAppStore.getState().applyPreset(slug);
      },
      deletePreset(slug) {
        return useAppStore.getState().deletePreset(slug);
      },
    };
    return () => {
      delete window.__debug;
    };
  }, []);

  /**
   * WB eyedropper: samples the DECODED image pixel (store's `image.data`,
   * linear working space) at the clicked point, then solves (temp, tint) so
   * that pixel becomes neutral under the per-image WB model.
   *
   * Coordinate mapping: the canvas's own untransformed pixel grid equals
   * `image` 1:1 (only the CSS `transform: translate(tx,ty) scale(scale)` pans
   * /zooms it — see useCanvasViewport's contract), so a screen point maps to
   * an image pixel via `(client - containerOrigin - (tx,ty)) / scale`.
   *
   * Geometry (crop/straighten/orientation/lens) resamples the image through a
   * GPU-only inverse map with no CPU mirror (same as crop/lens elsewhere in
   * this file — see planHasCpuReference). Reimplementing that inverse here
   * just to support picking through it isn't worth the duplication, so the
   * simplest-correct choice (spec-approved): picking is a no-op while the
   * input node's geometry is non-identity. Straighten/rotate first if you
   * need to WB-pick a cropped/rotated image.
   */
  const handleWbPick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container || !image) return;
    const inputNode = graph.nodes.find((n) => n.kind === 'input');
    const geometry = inputNode?.geometry ?? defaultGeometryParams();
    if (!isIdentityGeometry(geometry)) return;
    const rect = container.getBoundingClientRect();
    const ix = Math.floor((ev.clientX - rect.left - view.tx) / view.scale);
    const iy = Math.floor((ev.clientY - rect.top - view.ty) / view.scale);
    if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return;
    const idx = (iy * image.width + ix) * 4;
    const rgb: [number, number, number] = [image.data[idx]!, image.data[idx + 1]!, image.data[idx + 2]!];
    const devNode = graph.nodes.find((n) => n.kind === DEVELOP_KIND);
    if (!devNode) return;
    const { temp, tint } = solveNeutralWb(rgb, wbModel);
    useAppStore
      .getState()
      .updateNodeParamsBatch(
        devNode.id,
        [
          ['basic.temp', temp],
          ['basic.tint', tint],
        ],
        `wbpick:${Date.now()}`
      );
    setWbPicking(false);
  };

  /**
   * ColorKey mask eyedropper: same coordinate mapping and geometry caveat as
   * handleWbPick (samples the DECODED image pixel, main-side, at the clicked
   * point), but seeds the SELECTED mask node's shapes[0] hue/sat/lum instead
   * of solving white balance. The pixel is converted through the exact same
   * encoded-working-space HSL helpers the colorKey mask math itself uses
   * (cpuRgb2hsl — see maskNode.ts's doc comment), so the picked point becomes
   * the shape's new key center. Ranges/softness/invert are left untouched;
   * one undo entry (coalesceKey null, same as setMaskShape's discrete edits).
   */
  const handleColorKeyPick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container || !image) return;
    const inputNode = graph.nodes.find((n) => n.kind === 'input');
    const geometry = inputNode?.geometry ?? defaultGeometryParams();
    if (!isIdentityGeometry(geometry)) return;
    const rect = container.getBoundingClientRect();
    const ix = Math.floor((ev.clientX - rect.left - view.tx) / view.scale);
    const iy = Math.floor((ev.clientY - rect.top - view.ty) / view.scale);
    setColorKeyPicking(false);
    if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return;
    const idx = (iy * image.width + ix) * 4;
    const rgb: [number, number, number] = [image.data[idx]!, image.data[idx + 1]!, image.data[idx + 2]!];
    const maskNode = graph.nodes.find((n) => n.id === selectedNodeId && n.kind === MASK_KIND);
    const shape = maskNode?.mask?.shapes[0];
    if (!maskNode || !shape || shape.type !== 'colorKey') return;
    const enc: [number, number, number] = [
      srgbEncode(Math.min(Math.max(rgb[0], 0), 1)),
      srgbEncode(Math.min(Math.max(rgb[1], 0), 1)),
      srgbEncode(Math.min(Math.max(rgb[2], 0), 1)),
    ];
    const [hue, sat, lum] = cpuRgb2hsl(enc);
    useAppStore.getState().setMaskShape(maskNode.id, { ...shape, hue, sat, lum }, null);
  };

  // --- Draw-to-create masks (UX pack B §1) -------------------------------
  //
  // Mousedown sets the shape's anchor (radial center / linear p0), dragging
  // shows a live outline (MaskDrawOverlay), mouseup commits ONE
  // addLocalAdjustmentWithShape call (one undo entry, same as the
  // no-argument addLocalAdjustment). Coordinate mapping mirrors
  // handleWbPick's container-rect + view.tx/scale math (the same absolute
  // client→image-px conversion), normalized to 0..1 against outputDims to
  // match maskNode.ts's shape convention. Clicking without dragging (< 2px
  // moved) still creates something sane: a default-radius radial at the
  // click point, or the default linear gradient, per the brief.
  const [drawGesture, setDrawGesture] = useState<{
    mode: 'radial' | 'linear';
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const drawCleanupRef = useRef<(() => void) | null>(null);

  // Escape (App.tsx) flips maskDrawMode to null directly — tear down any
  // in-flight drag's window listeners and drop the preview WITHOUT
  // committing, so cancel is always clean regardless of when it happens.
  useEffect(() => {
    if (maskDrawMode === null) {
      drawCleanupRef.current?.();
      drawCleanupRef.current = null;
      setDrawGesture(null);
    }
  }, [maskDrawMode]);

  const imagePointFromClient = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const container = containerRef.current;
    if (!container || !outputDims) return null;
    const rect = container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.tx) / view.scale / outputDims.width,
      y: (clientY - rect.top - view.ty) / view.scale / outputDims.height,
    };
  };

  const handleMaskDrawPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (maskDrawMode === null || !outputDims) return;
    ev.preventDefault();
    const start = imagePointFromClient(ev.clientX, ev.clientY);
    if (!start) return;
    const mode = maskDrawMode;
    setDrawGesture({ mode, start, current: start });

    const onMove = (e: PointerEvent) => {
      const pt = imagePointFromClient(e.clientX, e.clientY);
      if (pt) setDrawGesture({ mode, start, current: pt });
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      drawCleanupRef.current = null;
      setDrawGesture(null);

      const end = imagePointFromClient(e.clientX, e.clientY) ?? start;
      const dxPx = (end.x - start.x) * outputDims.width;
      const dyPx = (end.y - start.y) * outputDims.height;
      const draggedPx = Math.hypot(dxPx, dyPx);
      const clickOnly = draggedPx < 2; // no meaningful drag — a plain click

      let shape: MaskShape;
      if (mode === 'radial') {
        shape = clickOnly
          ? { ...defaultRadialMaskShape(), cx: start.x, cy: start.y }
          : {
              type: 'radial',
              mode: 'add',
              cx: start.x,
              cy: start.y,
              radius: draggedPx / Math.max(outputDims.width, outputDims.height),
              feather: 0.5,
              invert: false,
            };
      } else {
        shape = clickOnly
          ? defaultLinearMaskShape()
          : { type: 'linear', mode: 'add', x0: start.x, y0: start.y, x1: end.x, y1: end.y, feather: 0.3, invert: false };
      }
      // Gesture coords are in the OUTPUT frame (imagePointFromClient); the
      // store holds ANCHOR-space coords, so convert before writing (no-op when
      // geometry is identity — see anchorSpace.ts).
      const anchorShape = anchorDims
        ? maskShapeOutputToAnchor(clampMaskShape(shape), inputGeometry, anchorDims.width, anchorDims.height)
        : clampMaskShape(shape);
      useAppStore.getState().addLocalAdjustmentWithShape(clampMaskShape(anchorShape));
      setMaskDrawMode(null);
    };
    drawCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // --- Spot removal (task #50): create-by-drag on the canvas -------------
  //
  // Mousedown on empty canvas fixes the dst (blemish) center; dragging moves
  // a live src (source) preview (SpotDrawOverlay) — unlike mask draw, the
  // RADIUS never comes from the drag distance, it's always the current brush
  // radius (slider / wheel — see spotBrushRadius). Mouseup commits ONE
  // commitSpot call (one undo entry, possibly combined with the spots node's
  // auto-insert — see appStore.ts). A click with no meaningful drag (<2px)
  // still commits something sane: src = dst nudged sideways by ~1.5x the
  // brush radius (close enough that the clone is barely perceptible until
  // the user deliberately drags the src elsewhere — the brief's "visibly
  // does nothing" fallback), rather than reusing dst exactly (which some
  // future feature might special-case as "no spot").
  const [spotDraft, setSpotDraft] = useState<{ dst: { x: number; y: number }; src: { x: number; y: number } } | null>(
    null
  );
  const spotDraftCleanupRef = useRef<(() => void) | null>(null);

  // Escape (App.tsx) flips spotMode to false directly — tear down any
  // in-flight drag the same way the mask-draw gesture does above. Also drops
  // the round-10 brush-radius readout (item 7) — it has its own 900ms
  // auto-hide timer, but leaving spot mode should clear it immediately
  // rather than let it linger over whatever tool comes next.
  useEffect(() => {
    if (!spotMode) {
      spotDraftCleanupRef.current?.();
      spotDraftCleanupRef.current = null;
      setSpotDraft(null);
      clearTimeout(spotRadiusReadoutTimerRef.current);
      setSpotRadiusReadout(null);
    }
  }, [spotMode]);

  const handleSpotPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spotMode || !outputDims) return;
    ev.preventDefault();
    const dst = imagePointFromClient(ev.clientX, ev.clientY);
    if (!dst) return;
    setSpotDraft({ dst, src: dst });

    const onMove = (e: PointerEvent) => {
      const pt = imagePointFromClient(e.clientX, e.clientY);
      if (pt) setSpotDraft({ dst, src: pt });
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      spotDraftCleanupRef.current = null;
      setSpotDraft(null);

      const end = imagePointFromClient(e.clientX, e.clientY) ?? dst;
      const dxPx = (end.x - dst.x) * outputDims.width;
      const dyPx = (end.y - dst.y) * outputDims.height;
      const draggedPx = Math.hypot(dxPx, dyPx);
      const clickOnly = draggedPx < 2;
      const radius = useAppStore.getState().spotBrushRadius;

      let src: { x: number; y: number };
      if (clickOnly) {
        const offsetPx = Math.max(8, radius * Math.max(outputDims.width, outputDims.height) * 1.5);
        src = { x: dst.x + offsetPx / outputDims.width, y: dst.y };
      } else {
        src = end;
      }
      // dst/src/radius are OUTPUT-frame (imagePointFromClient + brush radius);
      // the store holds ANCHOR-space coords, so convert before committing
      // (no-op when geometry is identity — see anchorSpace.ts).
      if (anchorDims) {
        const dstA = outputToAnchor(dst.x, dst.y, inputGeometry, anchorDims.width, anchorDims.height);
        const srcA = outputToAnchor(src.x, src.y, inputGeometry, anchorDims.width, anchorDims.height);
        const radiusA = outputRadiusToAnchor(radius, inputGeometry, anchorDims.width, anchorDims.height);
        commitSpot(dstA, srcA, radiusA);
      } else {
        commitSpot(dst, src, radius);
      }
    };
    spotDraftCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const overlayVisible = imageStatus !== 'ready' || gpuError !== null;
  // Compare view (compare pack): resolve which mode the compare pane is
  // showing, for the badge label only (the render effect above computes the
  // SAME thing to drive the actual compareRender call — kept as two small
  // derivations rather than lifting one to a ref, since this one is cheap and
  // only feeds text).
  const compareOutputs = graph.nodes.filter((n) => n.kind === 'output');
  const compareResolvedActiveId =
    (activeOutputId && compareOutputs.some((n) => n.id === activeOutputId) && activeOutputId) ||
    compareOutputs[0]?.id;
  const compareModeBNode =
    compareOutputId && compareOutputId !== compareResolvedActiveId
      ? compareOutputs.find((n) => n.id === compareOutputId)
      : undefined;

  // Embedded-preview-first opening: rotate the overlay to match the bare
  // JPEG's own EXIF orientation (round-8 fix — see appStore.ts's
  // openingPreview.flip / sonyLensProfile.ts's EmbeddedPreview.flip doc
  // comments for why the bytes need this at all). Same code space as
  // RawDecoder's flip: 0=none, 3=180°, 5=90°CCW, 6=90°CW.
  const previewRotateDeg =
    openingPreview?.flip === 6 ? 90 : openingPreview?.flip === 5 ? -90 : openingPreview?.flip === 3 ? 180 : 0;
  const previewSwap = previewRotateDeg === 90 || previewRotateDeg === -90;
  // Only a ±90° rotation needs the FRAME's own pixel box (object-fit: contain
  // math changes when content and container swap which axis is limiting —
  // see the doc comment on previewImgStyle below); 0°/180° reuse the
  // existing inset:0 sizing unchanged, so this stays null (and unobserved)
  // for the overwhelmingly common unrotated case.
  const [openingPreviewFrame, setOpeningPreviewFrame] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!(imageStatus === 'loading' && openingPreview && previewSwap)) {
      setOpeningPreviewFrame(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setOpeningPreviewFrame({ width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [imageStatus, openingPreview, previewSwap]);
  // The overlay <img>'s inline style override: for 0°, none (unchanged
  // pre-round-8 behavior — className alone gives inset:0/100%/100%/contain).
  // For 180°, just add the rotation in place (aspect is unchanged by a
  // half-turn, so the existing inset:0 sizing/object-fit math still holds).
  // For ±90°, object-fit: contain alone isn't enough: the <img>'s own box
  // (not just its painted content) needs to be the TRANSPOSE of the frame,
  // sized explicitly from the frame's real pixel box + the source aspect, so
  // that after the rotate transform the element's rendered bounding box
  // (what getBoundingClientRect reports, and what verify-preview's portrait
  // check reads) is the correctly-oriented, tightly-fit rectangle rather
  // than the frame's own (still-landscape-panel-shaped) box.
  let previewImgStyle: React.CSSProperties | undefined;
  if (previewRotateDeg === 180) {
    previewImgStyle = { transform: 'rotate(180deg)' };
  } else if (previewSwap && openingPreviewFrame && openingPreview) {
    const correctedW = openingPreview.height;
    const correctedH = openingPreview.width;
    const scale = Math.min(openingPreviewFrame.width / correctedW, openingPreviewFrame.height / correctedH);
    const renderW = correctedW * scale;
    const renderH = correctedH * scale;
    previewImgStyle = {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: `${renderH}px`,
      height: `${renderW}px`,
      transform: `translate(-50%, -50%) rotate(${previewRotateDeg}deg)`,
    };
  } else if (previewSwap) {
    // Frame not measured yet (first paint before the layout effect above
    // runs) — fall back to the unrotated sizing rather than distort; the
    // layout effect resolves this before the browser actually paints.
    previewImgStyle = undefined;
  }
  return (
    <div className="canvas-view">
      <div className="canvas-panes">
        <div
          ref={containerRef}
          className={`canvas-viewport${compareMode ? ' canvas-viewport--compare-swap' : ''}${cropMode ? ' canvas-viewport--crop-mode' : ''}`}
          style={{ visibility: overlayVisible ? 'hidden' : 'visible' }}
        >
          <canvas
            ref={canvasRef}
            className={`canvas-view-canvas${wbPicking || colorKeyPicking || maskDrawMode !== null || spotMode ? ' canvas-view-canvas--picking' : ''}`}
            style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
            onClick={wbPicking ? handleWbPick : colorKeyPicking ? handleColorKeyPick : undefined}
            onPointerDown={maskDrawMode !== null ? handleMaskDrawPointerDown : spotMode ? handleSpotPointerDown : undefined}
            data-testid="canvas-view-canvas"
          />
          {!overlayVisible && drawGesture && outputDims && (
            <MaskDrawOverlay
              mode={drawGesture.mode}
              start={drawGesture.start}
              current={drawGesture.current}
              view={view}
              canvasWidth={outputDims.width}
              canvasHeight={outputDims.height}
            />
          )}
          {!overlayVisible && !cropMode && selectedMaskNode && outputDims && anchorDims && (
            <MaskOverlay
              key={selectedMaskNode.id}
              node={selectedMaskNode}
              view={view}
              canvasWidth={outputDims.width}
              canvasHeight={outputDims.height}
              geometry={inputGeometry}
              orientedWidth={anchorDims.width}
              orientedHeight={anchorDims.height}
            />
          )}
          {!overlayVisible && !cropMode && spotMode && outputDims && anchorDims && (
            <SpotOverlay
              key={activeSpotsNode?.id ?? 'none'}
              node={activeSpotsNode}
              view={view}
              canvasWidth={outputDims.width}
              canvasHeight={outputDims.height}
              geometry={inputGeometry}
              orientedWidth={anchorDims.width}
              orientedHeight={anchorDims.height}
            />
          )}
          {!overlayVisible && spotDraft && outputDims && (
            <SpotDrawOverlay
              dst={spotDraft.dst}
              src={spotDraft.src}
              radius={spotBrushRadius}
              view={view}
              canvasWidth={outputDims.width}
              canvasHeight={outputDims.height}
            />
          )}
          {!overlayVisible && compareMode && (
            <div className="compare-pane-badge" data-testid="compare-pane-badge-main">
              Current
            </div>
          )}
        </div>
        {/* Compare view (compare pack): a SECOND pane, ALWAYS mounted once an
            image exists — never conditionally on compareMode — so its canvas
            is transferred to the render worker exactly ONCE per image session
            (transferControlToOffscreen itself is not idempotent, unlike
            client.initCompare's own guard — see renderClient.ts); toggling
            compare on/off only flips CSS visibility below, it never remounts
            the canvas element. It does NOT bind its own pan/zoom listeners —
            useCanvasViewport only ever attaches to `containerRef` above — this
            pane's canvas just gets the exact same `view` transform applied to
            it, "shared viewport, events bind once" per the brief.
            Round-9 fix pack item 2 (LR convention: Before left, Current
            right): DOM order here is UNCHANGED for exactly the reason
            above — only flex `order` (canvas-viewport--compare-swap /
            canvas-compare-pane--compare-swap, styles.css) flips which pane
            renders on which side while compareMode is active. Each badge is
            a child of its own pane, so it moves with it for free. */}
        {image && (
          <div
            className={`canvas-compare-pane${compareMode ? ' canvas-compare-pane--compare-swap' : ' canvas-compare-pane--hidden'}`}
            data-testid="compare-pane"
          >
            <canvas
              ref={compareCanvasRef}
              className="compare-canvas-el"
              style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
              data-testid="compare-canvas"
            />
            {!overlayVisible && compareMode && (
              <div className="compare-pane-badge" data-testid="compare-pane-badge">
                {compareDocOverride ? 'Disk (sidecar diff)' : compareModeBNode ? outputName(compareModeBNode) : 'Before'}
              </div>
            )}
          </div>
        )}
      </div>
      {/* CropOverlay renders OUTSIDE .canvas-panes (which clips overflow to
          the zoomed/panned canvas via each pane's own .canvas-viewport)
          rather than inside it: the LR-style rotate zones (UX pack B §2) sit
          ~34px past each corner, and whenever the fitted image touches the
          viewport edge along an axis (routine in 'fit' mode — a landscape
          photo in a similarly-shaped viewport has ~0 vertical margin) that
          would clip the rotate zone right where it's needed. Position/
          transform math is unaffected: .canvas-panes is itself
          `position:absolute; inset:0` inside this same `.canvas-view`
          (position:relative), so both siblings share the identical (0,0)
          origin — only the clipping differs. Crop mode is itself a modal
          tool mutually exclusive with compare (deactivateOtherTools,
          appStore.ts), so there is never a second pane to worry about here. */}
      {!overlayVisible && cropMode && outputDims && (
        <CropOverlay
          view={view}
          canvasWidth={outputDims.width}
          canvasHeight={outputDims.height}
          setViewFree={setViewFree}
        />
      )}
      {/* Spot-mode brush-radius transient readout (round-10 fix pack item 7):
          `position: fixed` at the last known cursor's CLIENT coords (set by
          the wheel/`[`/`]` handlers above) — deliberately NOT inside the
          pan/zoom-transformed .canvas-viewport, since this is a screen-space
          tooltip, not an image-space overlay like CropOverlay/MaskOverlay. */}
      {spotRadiusReadout && (
        <div
          className="spot-radius-readout"
          data-testid="spot-radius-readout"
          style={{ left: spotRadiusReadout.x, top: spotRadiusReadout.y }}
        >
          {spotRadiusReadout.text}
        </div>
      )}
      {!overlayVisible && <HistogramPanel />}
      {!overlayVisible && showBefore && (
        <div className="before-badge" data-testid="before-badge">
          Before
        </div>
      )}
      {/* Inspect mode (per-node-preview pack, tier 2): App.tsx's Escape chain
          and an image switch (appStore.ts's openImageByPath) both clear
          inspectNodeId the same way this ✕ button does — one single source
          of truth (setInspectNode(null)), three ways to reach it. */}
      {!overlayVisible && inspectedNode && (
        <div className="canvas-inspect-badge" data-testid="inspect-badge">
          <span>Inspecting: {nodeLabel(inspectedNode, fileName)}</span>
          <button
            type="button"
            className="canvas-inspect-exit"
            data-testid="inspect-exit"
            onClick={() => setInspectNode(null)}
            title="Stop inspecting (Esc)"
          >
            ×
          </button>
        </div>
      )}
      {!overlayVisible && (
        <div className="canvas-controls">
          <button
            onClick={toggleBefore}
            data-testid="view-before"
            className={showBefore ? 'active' : undefined}
            title="Show the unedited image (\)"
          >
            A/B
          </button>
          <button
            onClick={toggleGrayscaleView}
            data-testid="view-grayscale"
            className={grayscaleView ? 'active' : undefined}
            title="Grayscale check view (G)"
          >
            BW
          </button>
          <button onClick={fit} data-testid="view-fit">
            Fit
          </button>
          <button onClick={() => oneToOne()} data-testid="view-100">
            100%
          </button>
          <span className="canvas-zoom-readout" data-testid="zoom-readout">
            {Math.round(view.scale * devicePixelRatio * 100)}%
          </span>
        </div>
      )}
      {/* Embedded-preview-first opening (the Lightroom trick): the ARW's own
          embedded camera JPEG, shown the instant extraction (no decode)
          succeeds and gone the moment the real image reaches 'ready' — see
          appStore.ts's openImageByPath / clearOpeningPreview. Dead simple by
          design: no pan/zoom wiring, no crossfade (v1 — see ROADMAP), and it
          renders BEFORE (so, beneath) the "Decoding…" indicator below so
          that text stays readable over it. Gated on imageStatus alone, not
          overlayVisible (which also fires on gpuError) — a stale preview has
          no business surviving a GPU error on some OTHER already-ready
          image. */}
      {imageStatus === 'loading' && openingPreview && (
        <img
          src={openingPreview.url}
          alt="Camera preview"
          className="opening-preview-overlay"
          data-testid="opening-preview-overlay"
          style={previewImgStyle}
        />
      )}
      {imageStatus === 'loading' && openingPreview && (
        <div className="preview-badge" data-testid="preview-badge">
          Preview
        </div>
      )}
      {overlayVisible && (
        <div className="canvas-overlay">
          {gpuError !== null ? (
            <span style={{ color: '#e06c75' }}>Render failed: {gpuError}</span>
          ) : (
            <>
              {imageStatus === 'idle' && <span>Open a RAW or JPEG file to start (⌘O / Open button)</span>}
              {imageStatus === 'loading' && (
                // Round-10 fix pack item 4 ("decode… is easy to miss"): a
                // pill with a spinner, not a bare word lost in the empty
                // canvas. The ~150ms fade-in (CSS animation-delay below,
                // styles.css) means a fast JPEG open that never spends 150ms
                // in 'loading' never shows this at all — no flicker, no
                // layout shift (this chip sits inside the already-absolute
                // .canvas-overlay, so its opacity animating in reserves no
                // space of its own).
                <div className="canvas-loading-chip" data-testid="canvas-loading-chip">
                  <span className="canvas-loading-spinner" aria-hidden="true" />
                  {fileName && isRawFileName(fileName) ? 'Decoding RAW…' : 'Loading…'}
                </div>
              )}
              {imageStatus === 'error' && <span style={{ color: '#e06c75' }}>Decode failed: {imageError}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
