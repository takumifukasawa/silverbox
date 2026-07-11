import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { srgbEncode } from '../engine/color/srgb';
import { WORK_TO_SRGB, WORKING_LUMA, WORKING_SPACE_ID } from '../engine/color/workingSpace';
import { solveNeutralWb } from '../engine/color/whiteBalance';
import { DECODE_OUTPUT_COLOR } from '../engine/decoder/librawDecoder';
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
  planHasCpuReference,
  type GeometryParams,
  type GraphDoc,
  type LensParams,
} from '../engine/graph/graphDoc';
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
import { cpuRgb2hsl } from '../engine/graph/developOps';
import type { ExportColorSpace, ExportMetadataPolicy, Settings } from '../../../shared/ipc';

declare global {
  interface Window {
    __debug?: {
      imageState(): { status: string; width?: number; height?: number; fullWidth?: number; fullHeight?: number };
      rendererKind(): 'webgpu';
      outputSize(): { width: number; height: number } | null;
      readbackMean(): Promise<{ r: number; g: number; b: number } | null>;
      readbackSharpness(): Promise<{ luma: number; chroma: number } | null>;
      cpuReferenceMean(): { r: number; g: number; b: number } | null;
      graphState(): GraphDoc;
      graphDirty(): boolean;
      sidecarState(): { notice: string | null; unreadable: boolean };
      shaderErrors(): Record<string, string>;
      /** In-page access to the decoded linear pixels for reference math. */
      imageForVerify(): { data: Float32Array; width: number; height: number } | null;
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
      /** Verify-only: cumulative count of render() calls posted to the render worker — used to prove a node drag doesn't re-post per mouse-move (#pointer-drag-lag). */
      renderPostCount(): number;
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
  const lastImageRef = useRef<unknown>(null);
  // Async GPU failures (device loss etc.) live in the store (see task
  // #45/worker-error-surfacing) so the render worker's out-of-band 'error'
  // message reaches the UI the same way a pre-worker GraphRenderer rejection
  // used to — this component just reads it, same as any other store field.
  const gpuError = useAppStore((s) => s.gpuError);
  const setGpuError = useAppStore((s) => s.setGpuError);
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const imageError = useAppStore((s) => s.imageError);
  const graph = useAppStore((s) => s.graph);
  const shaderRev = useAppStore((s) => s.shaderRev);
  const wbModel = useAppStore((s) => s.wbModel);
  const showBefore = useAppStore((s) => s.showBefore);
  const grayscaleView = useAppStore((s) => s.grayscaleView);
  const toggleBefore = useAppStore((s) => s.toggleBefore);
  const toggleGrayscaleView = useAppStore((s) => s.toggleGrayscaleView);
  const cropMode = useAppStore((s) => s.cropMode);
  const wbPicking = useAppStore((s) => s.wbPicking);
  const setWbPicking = useAppStore((s) => s.setWbPicking);
  const colorKeyPicking = useAppStore((s) => s.colorKeyPicking);
  const setColorKeyPicking = useAppStore((s) => s.setColorKeyPicking);
  const maskDrawMode = useAppStore((s) => s.maskDrawMode);
  const setMaskDrawMode = useAppStore((s) => s.setMaskDrawMode);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const activeOutputId = useAppStore((s) => s.activeOutputId);
  const maskOverlay = useAppStore((s) => s.maskOverlay);
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
  const selectedMaskNode = selectedNode?.kind === MASK_KIND ? selectedNode : undefined;
  // Crop mode previews the FULL (uncropped) straightened frame — the overlay
  // lets you re-adjust the crop rect against the whole image — so force crop
  // back to identity for RENDERING only; the true crop committed in the graph
  // is untouched and takes over once cropMode exits (Done). Angle AND
  // orientation stay live so straighten/rotate/flip are visible while cropping.
  const graphForBuild =
    cropMode && image
      ? {
          ...graph,
          nodes: graph.nodes.map((n) =>
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
      : graph;
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
  const { view, fit, oneToOne, setViewFree } = useCanvasViewport(
    containerRef,
    outputDims,
    wbPicking || colorKeyPicking || maskDrawMode !== null
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const statsTimerRef = useRef<number | undefined>(undefined);
  const scopeMode = useAppStore((s) => s.scopeMode);

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
        clientRef.current = client;
        useAppStore.getState().setRenderer(client);
      }
      const client = clientRef.current;
      if (lastImageRef.current !== image) {
        client.setImage(image);
        lastImageRef.current = image;
      }
      const renderScale = Math.max(image.width, image.height) / Math.max(image.fullWidth, image.fullHeight);
      // a broken input→output path renders as pass-through with a banner in
      // the node editor instead of killing the preview. buildPlan is pure and
      // side-effect-free (graphDoc.ts), so re-running it here — main-side,
      // redundant to the worker's own copy over the SAME doc — costs nothing
      // and needs no round trip just to learn whether it throws.
      try {
        buildPlan(planDoc, { wb: wbModel, renderScale, outputId: activeOutputId ?? undefined });
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
      });
      setGpuError(null);
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
    activeOutputId,
    maskOverlay,
    selectedMaskNode?.id,
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
        };
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
        return { notice: s.sidecarNotice, unreadable: s.sidecarUnreadable };
      },
      shaderErrors() {
        return useAppStore.getState().shaderErrors;
      },
      imageForVerify() {
        const image = useAppStore.getState().image;
        return image ? { data: image.data, width: image.width, height: image.height } : null;
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
      exportState() {
        const s = useAppStore.getState();
        return { status: s.exportStatus, error: s.exportError };
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
      renderPostCount() {
        return clientRef.current?.renderPostCount ?? 0;
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
      useAppStore.getState().addLocalAdjustmentWithShape(clampMaskShape(shape));
      setMaskDrawMode(null);
    };
    drawCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const overlayVisible = imageStatus !== 'ready' || gpuError !== null;
  return (
    <div className="canvas-view">
      <div
        ref={containerRef}
        className="canvas-viewport"
        style={{ visibility: overlayVisible ? 'hidden' : 'visible' }}
      >
        <canvas
          ref={canvasRef}
          className={`canvas-view-canvas${wbPicking || colorKeyPicking || maskDrawMode !== null ? ' canvas-view-canvas--picking' : ''}`}
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
          onClick={wbPicking ? handleWbPick : colorKeyPicking ? handleColorKeyPick : undefined}
          onPointerDown={maskDrawMode !== null ? handleMaskDrawPointerDown : undefined}
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
        {!overlayVisible && !cropMode && selectedMaskNode && outputDims && (
          <MaskOverlay
            key={selectedMaskNode.id}
            node={selectedMaskNode}
            view={view}
            canvasWidth={outputDims.width}
            canvasHeight={outputDims.height}
          />
        )}
      </div>
      {/* CropOverlay renders OUTSIDE .canvas-viewport (which clips overflow
          to the zoomed/panned canvas) rather than inside it: the LR-style
          rotate zones (UX pack B §2) sit ~34px past each corner, and
          whenever the fitted image touches the viewport edge along an axis
          (routine in 'fit' mode — a landscape photo in a similarly-shaped
          viewport has ~0 vertical margin) that would clip the rotate zone
          right where it's needed. Position/transform math is unaffected:
          .canvas-viewport is itself `position:absolute; inset:0` inside this
          same `.canvas-view` (position:relative), so both siblings share the
          identical (0,0) origin — only the clipping differs. */}
      {!overlayVisible && cropMode && outputDims && (
        <CropOverlay
          view={view}
          canvasWidth={outputDims.width}
          canvasHeight={outputDims.height}
          setViewFree={setViewFree}
        />
      )}
      {!overlayVisible && <HistogramPanel />}
      {!overlayVisible && showBefore && (
        <div className="before-badge" data-testid="before-badge">
          Before
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
      {overlayVisible && (
        <div className="canvas-overlay">
          {gpuError !== null ? (
            <span style={{ color: '#e06c75' }}>Render failed: {gpuError}</span>
          ) : (
            <>
              {imageStatus === 'idle' && <span>Open a RAW or JPEG file to start (⌘O / Open button)</span>}
              {imageStatus === 'loading' && <span>Decoding…</span>}
              {imageStatus === 'error' && <span style={{ color: '#e06c75' }}>Decode failed: {imageError}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
