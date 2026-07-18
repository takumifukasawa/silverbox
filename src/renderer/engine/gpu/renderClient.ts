/**
 * Main-thread client for the render worker (render-isolation, DESIGN.md §10,
 * phase B). See renderWorker.ts for what runs on the other side and
 * renderProtocol.ts for the message shapes.
 *
 * There is exactly one render worker for the app's lifetime (Silverbox
 * develops one image at a time — DESIGN.md's non-goals), so the underlying
 * Worker is a lazily-created module singleton: it is reachable both by the
 * one RenderWorkerClient instance CanvasView creates (once a canvas exists
 * to transfer) AND by the shader-artifact mirror calls appStore.ts makes
 * independently of it (a document can open — clearing/seeding custom-shader
 * artifacts — before any canvas has mounted). Both paths share one worker.
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import type { GraphDoc } from '../graph/graphDoc';
import type { CustomShaderArtifact } from '../graph/customShaderNode';
import type { DenoiseRunResult, ExportColorSpace, ExternalToolResult } from '../../../../shared/ipc';
import type { HistogramData, RendererStats, ScopeSamples } from './graphRenderer';
import type {
  RenderWorkerCommand,
  RenderWorkerRequest,
  RenderWorkerRequestMethod,
  RenderWorkerResponse,
} from './renderProtocol';

let worker: Worker | null = null;

function getWorker(): Worker {
  worker ??= new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/** Mirror a main-side customShaderNode artifact mutation into the worker's own cache (see renderWorker.ts). */
export function mirrorShaderArtifactSet(nodeId: string, artifact: CustomShaderArtifact): void {
  const msg: RenderWorkerCommand = { type: 'shaderArtifactSet', nodeId, artifact };
  getWorker().postMessage(msg);
}

/** Mirror clearCustomShaderArtifacts() — called when a new document is opened. */
export function mirrorShaderArtifactClear(): void {
  const msg: RenderWorkerCommand = { type: 'shaderArtifactClear' };
  getWorker().postMessage(msg);
}

/**
 * DCP profile mode (docs/brief-bank/dcp-profile.md, stage 1): mirror a
 * freshly-baked DCP residual lattice (or `null` to clear it) into the render
 * worker — see appStore.ts's `refreshDcpProfile`. Fire-and-forget, like the
 * shaderArtifact* mirrors above; the caller is responsible for bumping
 * `dcpProfileRev` afterward so CanvasView's render effect re-posts a fresh
 * 'render' and the change actually shows up (same shape as imageNodeRev).
 */
export function mirrorDcpLattice(lattice: readonly number[] | null): void {
  const msg: RenderWorkerCommand = { type: 'dcpLattice', lattice };
  getWorker().postMessage(msg);
}

let nextReqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** The one live client, so the shared worker's onmessage router can reach it for out-of-band messages (initError). */
let activeClient: RenderWorkerClient | null = null;

function routeMessage(ev: MessageEvent<RenderWorkerResponse>): void {
  const msg = ev.data;
  if (msg.type === 'initError') {
    activeClient?.handleInitError(msg.message);
    return;
  }
  if (msg.type === 'error') {
    activeClient?.handleRuntimeError(msg.message);
    return;
  }
  if (msg.type === 'externalRunRequest') {
    activeClient?.handleExternalRunRequest(msg);
    return;
  }
  if (msg.type === 'externalNodeReady') {
    activeClient?.handleExternalNodeReady(msg.nodeId);
    return;
  }
  if (msg.type === 'denoiseRunRequest') {
    activeClient?.handleDenoiseRunRequest(msg);
    return;
  }
  if (msg.type === 'denoiseNodeReady') {
    activeClient?.handleDenoiseNodeReady(msg.nodeId);
    return;
  }
  if (msg.type === 'framePresented') {
    activeClient?.handleFramePresented(msg.gen);
    return;
  }
  const entry = pending.get(msg.reqId);
  if (!entry) return;
  pending.delete(msg.reqId);
  if (msg.ok) entry.resolve(msg.result);
  else entry.reject(new Error(msg.error));
}

function request<T>(gen: number, method: RenderWorkerRequestMethod, transfer: Transferable[] = []): Promise<T> {
  const reqId = nextReqId++;
  const w = getWorker();
  w.onmessage ??= routeMessage;
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    const msg: RenderWorkerRequest = { type: 'request', reqId, gen, ...method };
    w.postMessage(msg, transfer);
  });
}

export class RenderWorkerClient {
  private gen = 0;
  /** Mirrors GraphRenderer.hasImage — true once setImage() has been posted (see graphRenderer.ts). */
  hasImage = false;
  /** Verify/debug-only: counts render() calls (worker posts) — see CanvasView's __debug.renderPostCount(). */
  renderPostCount = 0;
  viewMode: 'color' | 'grayscale' = 'color';
  private onError: ((message: string) => void) | null = null;
  /** External-tool hook node (task #41): registered by CanvasView.tsx, forwards to externalNodeRunner.ts (the confirm-gate + IPC relay lives there, not here). */
  private onExternalRunRequest:
    | ((req: { nodeId: string; cacheKey: string; command: string; encoded: boolean; width: number; height: number; data: ArrayBuffer }) => void)
    | null = null;
  private onExternalNodeReady: ((nodeId: string) => void) | null = null;
  /** In-engine ML denoise (denoise v2, stage 1): registered by CanvasView.tsx, forwards to denoiseNodeRunner.ts (the IPC call lives there, not here) — same role as `onExternalRunRequest`. */
  private onDenoiseRunRequest: ((req: { nodeId: string; cacheKey: string; width: number; height: number; data: ArrayBuffer }) => void) | null = null;
  private onDenoiseNodeReady: ((nodeId: string) => void) | null = null;
  /** initCompare is idempotent per client instance (transferControlToOffscreen can only run once per canvas element) — mirrors the constructor's own one-shot transfer. */
  private compareInitialized = false;
  /** Flicker fix: registered by CanvasView.tsx to learn when the MAIN surface has actually presented a given gen — see renderProtocol.ts's 'framePresented' doc comment. */
  private onFramePresented: ((gen: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const w = getWorker();
    w.onmessage ??= routeMessage;
    activeClient = this;
    const offscreen = canvas.transferControlToOffscreen();
    const msg: RenderWorkerCommand = { type: 'init', canvas: offscreen };
    w.postMessage(msg, [offscreen]);
  }

  /** Surfaces an async GPU-init failure the same way GraphRenderer.create() rejecting used to (see CanvasView.tsx). */
  setErrorHandler(fn: (message: string) => void): void {
    this.onError = fn;
  }

  handleInitError(message: string): void {
    this.onError?.(message);
  }

  /** Routes an out-of-band worker failure (fire-and-forget 'image'/'render' rejecting) to the same handler as an init failure. */
  handleRuntimeError(message: string): void {
    this.onError?.(message);
  }

  /** External-tool hook node (task #41): registers the handler externalNodeRunner.ts's per-request entry point is wired through (CanvasView.tsx's mount effect). */
  setExternalRunRequestHandler(
    fn: (req: { nodeId: string; cacheKey: string; command: string; encoded: boolean; width: number; height: number; data: ArrayBuffer }) => void
  ): void {
    this.onExternalRunRequest = fn;
  }

  setExternalNodeReadyHandler(fn: (nodeId: string) => void): void {
    this.onExternalNodeReady = fn;
  }

  handleExternalRunRequest(req: {
    nodeId: string;
    cacheKey: string;
    command: string;
    encoded: boolean;
    width: number;
    height: number;
    data: ArrayBuffer;
  }): void {
    this.onExternalRunRequest?.(req);
  }

  handleExternalNodeReady(nodeId: string): void {
    this.onExternalNodeReady?.(nodeId);
  }

  /** External-tool hook node (task #41): apply a completed/failed round trip worker-side (see graphRenderer.ts's setExternalResult) — `result.data` is transferred when `result.ok`. */
  postExternalResult(nodeId: string, cacheKey: string, encoded: boolean, result: ExternalToolResult): void {
    const msg: RenderWorkerCommand = { type: 'externalResult', nodeId, cacheKey, encoded, result };
    getWorker().postMessage(msg, result.ok ? [result.data] : []);
  }

  /** In-engine ML denoise (denoise v2, stage 1): registers the handler denoiseNodeRunner.ts's per-request entry point is wired through (CanvasView.tsx's mount effect) — same role as setExternalRunRequestHandler. */
  setDenoiseRunRequestHandler(fn: (req: { nodeId: string; cacheKey: string; width: number; height: number; data: ArrayBuffer }) => void): void {
    this.onDenoiseRunRequest = fn;
  }

  setDenoiseNodeReadyHandler(fn: (nodeId: string) => void): void {
    this.onDenoiseNodeReady = fn;
  }

  handleDenoiseRunRequest(req: { nodeId: string; cacheKey: string; width: number; height: number; data: ArrayBuffer }): void {
    this.onDenoiseRunRequest?.(req);
  }

  handleDenoiseNodeReady(nodeId: string): void {
    this.onDenoiseNodeReady?.(nodeId);
  }

  /** In-engine ML denoise: apply a completed/failed round trip worker-side (see graphRenderer.ts's setDenoiseResult) — `result.data` is transferred when `result.ok`. */
  postDenoiseResult(nodeId: string, cacheKey: string, result: DenoiseRunResult): void {
    const msg: RenderWorkerCommand = { type: 'denoiseResult', nodeId, cacheKey, result };
    getWorker().postMessage(msg, result.ok ? [result.data] : []);
  }

  /** Current generation — CanvasView's debounced stats/scope consumers compare a response's gen against this. */
  currentGen(): number {
    return this.gen;
  }

  /** Flicker fix: registers the handler CanvasView.tsx's reveal gate calls on every 'framePresented' — see renderProtocol.ts's doc comment. */
  setFramePresentedHandler(fn: (gen: number) => void): void {
    this.onFramePresented = fn;
  }

  handleFramePresented(gen: number): void {
    this.onFramePresented?.(gen);
  }

  setImage(image: PreparedImage): void {
    this.hasImage = true;
    this.gen++;
    const msg: RenderWorkerCommand = { type: 'image', gen: this.gen, image };
    getWorker().postMessage(msg);
  }

  resize(width: number, height: number): void {
    const msg: RenderWorkerCommand = { type: 'resize', width, height };
    getWorker().postMessage(msg);
  }

  /**
   * Image node (composite/mask-by-another-file feature): post one
   * referenced file's decoded pixels, keyed by its raw (as-authored) path —
   * see renderProtocol.ts's 'imageNode' doc comment. `image.data`'s buffer
   * is transferred (imageNodeSource.ts's caller owns a disposable decode
   * result, same convention as setImage/renderToPixels).
   */
  setImageNodeSource(path: string, image: PreparedImage): void {
    const msg: RenderWorkerCommand = { type: 'imageNode', path, image };
    getWorker().postMessage(msg, [image.data.buffer]);
  }

  render(args: {
    doc: GraphDoc;
    renderScale: number;
    showBefore: boolean;
    outputId?: string;
    overlayMaskNodeId?: string | null;
    inspectNodeId?: string | null;
  }): void {
    this.gen++;
    this.renderPostCount++;
    const msg: RenderWorkerCommand = {
      type: 'render',
      gen: this.gen,
      doc: args.doc,
      renderScale: args.renderScale,
      viewMode: this.viewMode,
      showBefore: args.showBefore,
      outputId: args.outputId,
      overlayMaskNodeId: args.overlayMaskNodeId ?? null,
      inspectNodeId: args.inspectNodeId ?? null,
    };
    getWorker().postMessage(msg);
  }

  /**
   * Compare view (compare pack): transfers a SECOND canvas's control to the
   * SAME worker — see renderWorker.ts's doc comment for why this beats a
   * second Worker instance (one shared GPUDevice, one shared customShaderNode
   * artifact cache). Safe to call on every render-effect run; only the FIRST
   * call actually transfers (transferControlToOffscreen throws on a second
   * call against the same element, same guard shape as the constructor's).
   */
  initCompare(canvas: HTMLCanvasElement): void {
    if (this.compareInitialized) return;
    this.compareInitialized = true;
    const offscreen = canvas.transferControlToOffscreen();
    const msg: RenderWorkerCommand = { type: 'initCompare', canvas: offscreen };
    getWorker().postMessage(msg, [offscreen]);
  }

  compareResize(width: number, height: number): void {
    const msg: RenderWorkerCommand = { type: 'compareResize', width, height };
    getWorker().postMessage(msg);
  }

  /**
   * Renders into the compare pane. `showBefore`/`outputId` are the CALLER's
   * responsibility to resolve into "Mode A" (before) vs "Mode B" (a second
   * output) — see CanvasView.tsx's compare render effect. Shares this
   * client's own `gen` counter with render() (stamped onto every command),
   * but the WORKER tracks each surface's "current" gen separately, so a
   * compareRender never marks a concurrent main render() stale, or vice versa
   * (see renderWorker.ts's doc comment).
   */
  compareRender(args: { doc: GraphDoc; renderScale: number; showBefore: boolean; outputId?: string }): void {
    this.gen++;
    const msg: RenderWorkerCommand = {
      type: 'compareRender',
      gen: this.gen,
      doc: args.doc,
      renderScale: args.renderScale,
      viewMode: this.viewMode,
      showBefore: args.showBefore,
      outputId: args.outputId,
    };
    getWorker().postMessage(msg);
  }

  compareReadbackMean(): Promise<{ r: number; g: number; b: number } | null> {
    return request(this.gen, { method: 'compareReadbackMean' });
  }

  stats(): Promise<HistogramData | null> {
    return request(this.gen, { method: 'stats' });
  }

  scopeSamples(maxCols?: number, maxRows?: number): Promise<ScopeSamples | null> {
    return request(this.gen, { method: 'scopeSamples', maxCols, maxRows });
  }

  readbackMean(): Promise<{ r: number; g: number; b: number } | null> {
    return request(this.gen, { method: 'readbackMean' });
  }

  /** Verify-only (task #41): see graphRenderer.ts's readbackLinearMean doc comment. */
  readbackLinearMean(): Promise<{ r: number; g: number; b: number } | null> {
    return request(this.gen, { method: 'readbackLinearMean' });
  }

  readbackSharpness(): Promise<{ luma: number; chroma: number } | null> {
    return request(this.gen, { method: 'readbackSharpness' });
  }

  rendererStats(): Promise<RendererStats | null> {
    return request(this.gen, { method: 'rendererStats' });
  }

  statsCrop(x0: number, y0: number, w: number, h: number): Promise<HistogramData | null> {
    return request(this.gen, { method: 'statsCrop', x0, y0, w, h });
  }

  encodedCropForVerify(x0: number, y0: number, w: number, h: number): Promise<Uint8Array | null> {
    return request(this.gen, { method: 'encodedCropForVerify', x0, y0, w, h });
  }

  /**
   * Node thumbnails (per-node-preview pack, tier 1): `nodeSteps` is a
   * nodeId → step-index map from the CALLER's own buildPlan().nodeSteps
   * (CanvasView.tsx builds one locally every render pass already, for the
   * graphBroken check) — see renderProtocol.ts's 'thumbnails' doc comment
   * for why the worker doesn't recompute it. Resolves to null only when no
   * image is loaded yet (mirrors readbackMean's own null case).
   */
  thumbnails(
    nodeSteps: Record<string, number>,
    longEdge: number
  ): Promise<Record<string, { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }> | null> {
    return request(this.gen, { method: 'thumbnails', nodeSteps, longEdge });
  }

  /**
   * External-tool hook node export cut point (task #41): renders `doc` up to
   * `inspectNodeId` at full resolution and reads the result back as
   * linear-or-`encoded` RGBA float32 (see graphRenderer.ts's
   * captureCutPointPixels) — appStore.ts's export-time doc-rewrite uses this
   * BEFORE the real renderToPixels call, one external node at a time.
   */
  captureExternalInput(
    image: PreparedImage,
    doc: GraphDoc,
    renderScale: number,
    encoded: boolean,
    inspectNodeId: string,
    outputId?: string
  ): Promise<{ data: Float32Array; width: number; height: number }> {
    // Deliberately NOT transferring image.data.buffer (unlike renderToPixels'
    // one-shot convention): a doc with N external nodes calls this N times
    // (appStore.ts's export-time doc-rewrite loop) then still needs `image`
    // intact for the FINAL renderToPixels call — a structured-clone COPY
    // here costs one extra full-resolution buffer copy per external node,
    // acceptable for this inherently non-realtime, export-only path.
    return request(this.gen, { method: 'captureExternalInput', image, doc, renderScale, encoded, inspectNodeId, outputId });
  }

  /** External-tool hook node re-entry (task #41), export-side: see renderProtocol.ts's 'decodeExternalResult' doc comment. `data`'s buffer is transferred (the caller's own copy, freshly received from window.silverbox.runExternalTool). */
  decodeExternalResult(data: Float32Array, width: number, height: number, encoded: boolean): Promise<Float32Array> {
    return request<{ data: Float32Array }>(
      this.gen,
      { method: 'decodeExternalResult', data: data.buffer as ArrayBuffer, width, height, encoded },
      [data.buffer as ArrayBuffer]
    ).then((r) => r.data);
  }

  /** Export: `image` is a disposable full-resolution decode (see appStore.ts's exportImage) — its buffer is transferred, not copied. */
  renderToPixels(
    image: PreparedImage,
    doc: GraphDoc,
    renderScale: number,
    colorSpace: ExportColorSpace,
    outputId?: string,
    allowExternal?: boolean
  ): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
    return request(
      this.gen,
      { method: 'renderToPixels', image, doc, renderScale, colorSpace, outputId, allowExternal },
      [image.data.buffer]
    );
  }
}
