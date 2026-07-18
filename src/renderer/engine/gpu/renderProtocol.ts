/**
 * Message protocol between the main thread and the render worker
 * (render-isolation, DESIGN.md §10 — "the renderer lives in a Worker; the
 * main thread keeps only the UI and the document"). Shared by both sides so
 * the message shapes can never drift: renderClient.ts (main thread) posts
 * these, renderWorker.ts (the worker) handles them.
 *
 * The DOCUMENT crosses the boundary, not the plan: RenderPlan's `cpu`
 * closures are not structured-cloneable, so the worker receives a GraphDoc +
 * compile context and runs buildPlan() itself (pure and side-effect-free —
 * see graphDoc.ts's buildPlan doc comment) using its OWN customShaderNode
 * artifact cache, kept in sync via the shaderArtifact* commands below.
 *
 * Generation counter: the client stamps every doc/state-changing command
 * with a monotonically increasing `gen`; every request's response is tagged
 * with the worker's CURRENT gen at completion time (not necessarily the
 * request's own gen — see renderWorker.ts), so the client can cheaply tell
 * whether a response still reflects the newest edit before writing it into
 * global store state (stats()/scopeSamples()'s debounced consumers — see
 * CanvasView.tsx). The worker also short-circuits a request whose OWN gen is
 * already behind its current one at dequeue time, skipping pointless GPU
 * work (not required for correctness, just efficiency).
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import type { GraphDoc } from '../graph/graphDoc';
import type { CustomShaderArtifact } from '../graph/customShaderNode';
import type { DenoiseRunResult, ExportColorSpace, ExternalToolResult } from '../../../../shared/ipc';

/** Fire-and-forget commands: main → worker, no response expected. */
export type RenderWorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'image'; gen: number; image: PreparedImage }
  /**
   * Image node (composite/mask-by-another-file feature): the main thread
   * decodes a referenced file via the SAME imageLoader the main image uses
   * (this file's own doc comment — render-isolation, DESIGN.md §10 — is why
   * the worker never runs libraw itself) and posts the result here, keyed
   * by the RAW (as-authored) `image.path` — the SAME string a PlanStep
   * 'image' carries (graphDoc.ts), so the worker's per-path cache and
   * buildPlan's step never need to agree on any resolved/absolute form.
   * Applied to BOTH the main and compare GraphRenderer instances (compare
   * Mode B can show a chain containing the image node too) and cached
   * worker-side so a compare pane initialized LATER can replay it — see
   * renderWorker.ts's `imageNodeCache`/`initCompare` handler.
   */
  | { type: 'imageNode'; path: string; image: PreparedImage }
  | {
      type: 'render';
      gen: number;
      doc: GraphDoc;
      renderScale: number;
      viewMode: 'color' | 'grayscale';
      showBefore: boolean;
      /** Selects which output node to resolve when the doc has more than one (named outputs); undefined = the doc's first. */
      outputId?: string;
      /** Selected mask node id whose value should composite as a canvas-only red overlay (masks milestone); null/undefined = no overlay. */
      overlayMaskNodeId?: string | null;
      /** Inspect mode (per-node-preview pack, tier 2): render THIS node's own output instead of `outputId`'s; null/undefined = normal output resolution. See graphDoc.ts's CompileContext.inspectNodeId. */
      inspectNodeId?: string | null;
    }
  | { type: 'resize'; width: number; height: number }
  /**
   * Compare view (compare pack): a SECOND OffscreenCanvas, transferred once
   * (like 'init') and rendered into by a SECOND GraphRenderer instance living
   * in this SAME worker — sharing the one GPUDevice (getGpuDevice's module
   * singleton, graphRenderer.ts) and the one customShaderNode artifact cache
   * (also module-scoped here), so no shader-artifact mirroring duplication is
   * needed beyond what shaderArtifactSet/Clear already do. See renderWorker.ts's
   * doc comment for why this beat a second Worker instance.
   */
  | { type: 'initCompare'; canvas: OffscreenCanvas }
  | { type: 'compareResize'; width: number; height: number }
  | {
      type: 'compareRender';
      gen: number;
      doc: GraphDoc;
      renderScale: number;
      viewMode: 'color' | 'grayscale';
      /** Mode A: true (the unedited decode, exactly like the main 'render' showBefore). Mode B: false. */
      showBefore: boolean;
      /** Mode B: the picked second output id. Mode A: unused (showBefore short-circuits buildPreviewPlan before outputId is ever consulted). */
      outputId?: string;
    }
  | { type: 'shaderArtifactSet'; nodeId: string; artifact: CustomShaderArtifact }
  | { type: 'shaderArtifactClear' }
  /**
   * DCP profile mode (docs/brief-bank/dcp-profile.md, Stage 1): the BAKED
   * residual lattice for the currently-configured DCP file, computed
   * main-thread-side (appStore.ts) where file IO (window.silverbox.readFile)
   * and parsing can happen — the worker only ever sees the resulting plain
   * number array, stored here and threaded into every buildPlan() ctx as
   * `dcpLattice` until the next 'dcpLattice' command replaces it (mirrors
   * `currentCameraModel`'s "set once on change, read on every render" shape).
   * `null` = no DCP configured, or the last load failed — the DEVELOP_KIND
   * branch's fallback (an all-zero lattice) then applies.
   */
  | { type: 'dcpLattice'; lattice: readonly number[] | null }
  /**
   * External-tool hook node (denoise v1, task #41): the completed (or
   * failed) result of one round trip through externalNodeRunner.ts's IPC
   * call — see graphRenderer.ts's setExternalResult. Caching/decoding only;
   * the caller (appStore.ts, via CanvasView's effect) is responsible for
   * re-posting a 'render' command afterward so the fresh texture actually
   * shows up (same "fire-and-forget, caller re-renders" shape as 'imageNode').
   */
  | { type: 'externalResult'; nodeId: string; cacheKey: string; encoded: boolean; result: ExternalToolResult }
  /**
   * In-engine ML denoise (denoise v2, stage 1): the completed (or failed)
   * result of one round trip through denoiseNodeRunner.ts's IPC call — see
   * graphRenderer.ts's setDenoiseResult. Same "caching/decoding only, caller
   * re-posts render()" shape as 'externalResult'.
   */
  | { type: 'denoiseResult'; nodeId: string; cacheKey: string; result: DenoiseRunResult };

/** One entry of the request/response bridge's method union (see graphRenderer.ts for the referenced methods). */
export type RenderWorkerRequestMethod =
  | { method: 'stats' }
  | { method: 'scopeSamples'; maxCols?: number; maxRows?: number }
  | { method: 'readbackMean' }
  /** Verify-only (task #41 — scripts/verify-external.mjs): see graphRenderer.ts's readbackLinearMean doc comment. */
  | { method: 'readbackLinearMean' }
  | { method: 'readbackSharpness' }
  | { method: 'rendererStats' }
  | { method: 'statsCrop'; x0: number; y0: number; w: number; h: number }
  | { method: 'encodedCropForVerify'; x0: number; y0: number; w: number; h: number }
  /**
   * Node thumbnails (per-node-preview pack, tier 1): `nodeSteps` is the
   * CALLER's own (main-thread) buildPlan().nodeSteps over the FULL,
   * non-truncated doc (never the inspect-mode-truncated one — see
   * CanvasView.tsx) — recomputing it worker-side would need the whole doc to
   * cross again just for this, and the two buildPlan() calls are guaranteed
   * to agree since it's a pure function of the same doc/ctx the 'render'
   * command was just posted with.
   */
  | { method: 'thumbnails'; nodeSteps: Record<string, number>; longEdge: number }
  /** Compare view: readback of the SECOND (compare-pane) GraphRenderer's current canvas content — see renderWorker.ts's compare* commands. */
  | { method: 'compareReadbackMean' }
  | {
      method: 'renderToPixels';
      image: PreparedImage;
      doc: GraphDoc;
      renderScale: number;
      colorSpace: ExportColorSpace;
      /** Selects which output node to render when the doc has more than one; undefined = the doc's first. */
      outputId?: string;
      /** External-tool hook node gate (task #41): false ONLY for a headless CLI render without `--allow-external` (see appStore.ts's exportOnePath) — every 'external' node then resolves as identity. Undefined/true = allowed (the interactive export path, and CLI WITH the flag — the doc-rewrite in exportOnePath has already replaced any real external node with an image node by the time this request is sent). */
      allowExternal?: boolean;
    }
  | {
      /**
       * External-tool hook node export cut point (task #41): renders `doc`
       * up to `inspectNodeId` (the node FEEDING the external node — see
       * appStore.ts's export-time doc-rewrite) at full resolution and reads
       * the result back as linear-or-encoded RGBA float32 — see
       * graphRenderer.ts's captureCutPointPixels.
       */
      method: 'captureExternalInput';
      image: PreparedImage;
      doc: GraphDoc;
      renderScale: number;
      encoded: boolean;
      outputId?: string;
      inspectNodeId: string;
    }
  | {
      /**
       * External-tool hook node re-entry (task #41), export-side counterpart
       * of GraphRenderer.setExternalResult: decode a completed round trip's
       * pixels back to LINEAR Rec.2020 (a no-op when `encoded` is false) so
       * appStore.ts's export-time doc-rewrite can wrap them as a
       * PreparedImage and feed the EXISTING image-node upload path. See
       * graphRenderer.ts's decodeExternalResultToCpu.
       */
      method: 'decodeExternalResult';
      data: ArrayBuffer;
      width: number;
      height: number;
      encoded: boolean;
    };

export type RenderWorkerRequest = { type: 'request'; reqId: number; gen: number } & RenderWorkerRequestMethod;

export type RenderWorkerResponse =
  | { type: 'response'; reqId: number; gen: number; ok: true; result: unknown }
  | { type: 'response'; reqId: number; gen: number; ok: false; error: string }
  | { type: 'initError'; message: string }
  /**
   * Out-of-band failure from a fire-and-forget command ('image'/'render' —
   * task #45/worker-error-surfacing): these have no reqId/response to reject,
   * so a failure (e.g. a lost GPU device) is instead posted here and routed
   * to the client's error handler exactly like initError, surfacing it in
   * the UI the same way a pre-worker GraphRenderer rejection used to.
   */
  | { type: 'error'; message: string }
  /**
   * External-tool hook node (task #41): the renderer wants to run `command`
   * over the given pixels for `nodeId` — main-thread only from here
   * (externalNodeRunner.ts owns the confirm gate + the actual IPC call, see
   * shared/ipc.ts's SilverboxApi.runExternalTool doc comment). Posted from
   * GraphRenderer.checkExternalNodes after the debounce settles; `data` is
   * transferred (renderWorker.ts's 'render' handler owns it, freshly
   * captured, never aliased elsewhere).
   */
  | {
      type: 'externalRunRequest';
      nodeId: string;
      cacheKey: string;
      command: string;
      encoded: boolean;
      width: number;
      height: number;
      data: ArrayBuffer;
    }
  /**
   * External-tool hook node (task #41): a result was ALREADY cached for this
   * node's current content hash (e.g. undo/redo back to previously-seen
   * upstream content) — no subprocess needed, but the main thread must still
   * re-post a 'render' command for resolveSteps to pick the cached texture up
   * (see GraphRenderer.checkExternalNodes' `notifyReady` callback).
   */
  | { type: 'externalNodeReady'; nodeId: string }
  /**
   * In-engine ML denoise (denoise v2, stage 1): the renderer wants ORT
   * inference run over the given pixels for `nodeId` — main-thread only from
   * here (denoiseNodeRunner.ts owns the actual IPC call, see shared/ipc.ts's
   * SilverboxApi.runDenoise doc comment). Posted from
   * GraphRenderer.checkDenoiseNodes after the debounce settles; `data` is
   * transferred, same convention as 'externalRunRequest'.
   */
  | {
      type: 'denoiseRunRequest';
      nodeId: string;
      cacheKey: string;
      width: number;
      height: number;
      data: ArrayBuffer;
    }
  /** In-engine ML denoise: a result was already cached for this node's current content hash — same role as 'externalNodeReady'. */
  | { type: 'denoiseNodeReady'; nodeId: string }
  /**
   * Flicker fix (NG investigation, 2026-07-17 "A flashes back mid-switch"):
   * posted right after the MAIN surface's renderer.render() actually submits
   * a frame for `gen` — the only signal the main thread has that whatever is
   * now sitting in the transferred canvas's backing store reflects THIS
   * gen's doc/image, not an older one. CanvasView.tsx's overlayVisible uses
   * it to keep the canvas hidden across an image switch until the frame it
   * is about to reveal has actually landed, instead of trusting imageStatus
   * alone (which flips to 'ready' the instant the STORE commit lands, well
   * before the worker's async setGraph()/render() round trip for the new
   * image has drawn anything). See renderWorker.ts's 'render' handler for
   * the post site and CanvasView.tsx's revealGenRef for the consumer.
   */
  | { type: 'framePresented'; gen: number };
