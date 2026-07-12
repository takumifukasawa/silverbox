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
import type { ExportColorSpace } from '../../../../shared/ipc';

/** Fire-and-forget commands: main → worker, no response expected. */
export type RenderWorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'image'; gen: number; image: PreparedImage }
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
  | { type: 'shaderArtifactClear' };

/** One entry of the request/response bridge's method union (see graphRenderer.ts for the referenced methods). */
export type RenderWorkerRequestMethod =
  | { method: 'stats' }
  | { method: 'scopeSamples'; maxCols?: number; maxRows?: number }
  | { method: 'readbackMean' }
  | { method: 'readbackSharpness' }
  | { method: 'rendererStats' }
  | { method: 'statsCrop'; x0: number; y0: number; w: number; h: number }
  | { method: 'encodedCropForVerify'; x0: number; y0: number; w: number; h: number }
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
  | { type: 'error'; message: string };
