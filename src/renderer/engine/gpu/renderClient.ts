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
import type { ExportColorSpace } from '../../../../shared/ipc';
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
  /** initCompare is idempotent per client instance (transferControlToOffscreen can only run once per canvas element) — mirrors the constructor's own one-shot transfer. */
  private compareInitialized = false;

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

  /** Current generation — CanvasView's debounced stats/scope consumers compare a response's gen against this. */
  currentGen(): number {
    return this.gen;
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

  /** Export: `image` is a disposable full-resolution decode (see appStore.ts's exportImage) — its buffer is transferred, not copied. */
  renderToPixels(
    image: PreparedImage,
    doc: GraphDoc,
    renderScale: number,
    colorSpace: ExportColorSpace,
    outputId?: string
  ): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
    return request(
      this.gen,
      { method: 'renderToPixels', image, doc, renderScale, colorSpace, outputId },
      [image.data.buffer]
    );
  }
}
