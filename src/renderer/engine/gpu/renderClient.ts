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
  viewMode: 'color' | 'grayscale' = 'color';
  private onError: ((message: string) => void) | null = null;

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

  render(args: { doc: GraphDoc; renderScale: number; showBefore: boolean }): void {
    this.gen++;
    const msg: RenderWorkerCommand = {
      type: 'render',
      gen: this.gen,
      doc: args.doc,
      renderScale: args.renderScale,
      viewMode: this.viewMode,
      showBefore: args.showBefore,
    };
    getWorker().postMessage(msg);
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

  /** Export: `image` is a disposable full-resolution decode (see appStore.ts's exportImage) — its buffer is transferred, not copied. */
  renderToPixels(
    image: PreparedImage,
    doc: GraphDoc,
    renderScale: number,
    colorSpace: ExportColorSpace
  ): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
    return request(
      this.gen,
      { method: 'renderToPixels', image, doc, renderScale, colorSpace },
      [image.data.buffer]
    );
  }
}
