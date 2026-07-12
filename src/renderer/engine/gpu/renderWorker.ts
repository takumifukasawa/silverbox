/**
 * Render worker (render-isolation, DESIGN.md §10, phase B): owns the
 * GPUDevice, the GraphRenderer instance, and the OffscreenCanvas
 * configure/present cycle. See renderProtocol.ts for the message shapes and
 * renderClient.ts for the main-thread side.
 *
 * buildPlan is pure and side-effect-free (graphDoc.ts), so it runs AGAIN
 * here, over the doc the main thread posts, exactly as CanvasView used to
 * run it before this split — the RenderPlan itself never crosses (its `cpu`
 * closures are not structured-cloneable).
 *
 * customShaderNode's validated-artifact cache (nodeId → compiled WGSL) is a
 * per-realm module singleton; this worker gets its OWN instance, mirrored
 * from the main thread's cache via shaderArtifactSet/shaderArtifactClear
 * commands sent from every appStore.ts call site that mutates it. Being only
 * eventually consistent (a custom node briefly renders as identity until its
 * artifact lands here) is not a new race — buildPlan already tolerates a
 * node with no artifact yet today (see its CUSTOM_KIND branch), which is
 * exactly what happens main-side too while validateWgsl is still in flight.
 *
 * The per-image WbModel is rebuilt HERE from the posted image's own color
 * metadata (createWbModel is a pure function of it — see whiteBalance.ts) —
 * cheaper and simpler than trying to structured-clone a WbModel, which
 * carries a bound `gains()` method and so isn't cloneable at all.
 *
 * Compare view (compare pack): a second OffscreenCanvas/GraphRenderer pair
 * lives HERE, in this SAME worker, rather than in a second Worker instance.
 * Both options were considered — a second Worker would be simpler to wire
 * (its own independent module scope, no risk of one surface's state leaking
 * into the other) but at the cost of a second GPUDevice/adapter (more GPU
 * memory) AND a second customShaderNode artifact cache that every
 * mirrorShaderArtifactSet/Clear call site would need to reach too, or a
 * custom-shader node would silently render as identity in the compare pane
 * only. Staying in this worker means getGpuDevice()'s module singleton
 * (graphRenderer.ts) is shared automatically (one adapter/device, two
 * GPUCanvasContexts) and the artifact cache needs no new plumbing at all —
 * the tradeoff is the two render "surfaces" (main vs compare) needing their
 * own generation counters below (currentGen / currentCompareGen) so a
 * compareRender's staleness check never gets confused by an unrelated main
 * 'render' bumping the shared client-side counter, and vice versa.
 */
import { GraphRenderer } from './graphRenderer';
import { buildPlan, type CompileContext, type GraphDoc, type RenderPlan } from '../graph/graphDoc';
import { setCustomShaderArtifact, clearCustomShaderArtifacts } from '../graph/customShaderNode';
import { createWbModel, type WbModel } from '../color/whiteBalance';
import type { PreparedImage } from '../decoder/decodeWorker';
import type { RenderWorkerCommand, RenderWorkerRequest, RenderWorkerResponse } from './renderProtocol';

let resolveRenderer: ((r: GraphRenderer) => void) | null = null;
const rendererReady = new Promise<GraphRenderer>((resolve) => {
  resolveRenderer = resolve;
});

let offscreenCanvas: OffscreenCanvas | null = null;
/** Per-image WB model, rebuilt whenever a new 'image' command lands. */
let wbModel: WbModel = createWbModel({});
/** Decoded dims of the current preview image — fed to buildPlan for anchor-space mask/spot conversion. */
let currentImageDims: { width: number; height: number } | null = null;
/** Gen of the most recently applied 'image'/'render' command (main surface — see renderProtocol.ts). */
let currentGen = 0;

// --- Compare view (compare pack): second surface, same worker (see this file's doc comment) ---
let compareOffscreenCanvas: OffscreenCanvas | null = null;
let resolveCompareRenderer: ((r: GraphRenderer) => void) | null = null;
/** Null until the FIRST 'initCompare' lands (compare mode has never been entered this session) — every compare-* handler below no-ops on null instead of awaiting a promise that may never resolve. */
let compareRendererReady: Promise<GraphRenderer> | null = null;
/** Gen of the most recently applied 'image'/'compareRender' command (compare surface). Tracked SEPARATELY from currentGen — see this file's doc comment for why a shared counter would be wrong. */
let currentCompareGen = 0;
/** Most recently received 'image' command's payload, replayed onto the compare renderer if it initializes AFTER an image is already loaded (the ordinary case: the main canvas/image load first, compare mode is a later toggle). */
let lastImage: PreparedImage | null = null;

function post(message: RenderWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Build the plan for a preview render: pure buildPlan, with the SAME graph-broken / showBefore fallbacks CanvasView applied before this split. */
function buildPreviewPlan(doc: GraphDoc, ctx: CompileContext, showBefore: boolean): RenderPlan {
  let plan: RenderPlan;
  try {
    plan = buildPlan(doc, ctx);
  } catch {
    plan = { steps: [], output: -1 };
  }
  if (showBefore) plan = { steps: [], output: -1 };
  return plan;
}

async function handleRequest(req: RenderWorkerRequest): Promise<void> {
  const renderer = await rendererReady;
  // stale-request drop (efficiency only — see renderProtocol.ts doc comment;
  // never applied to renderToPixels, a deliberate one-shot export action
  // that must never be silently skipped just because the preview moved on).
  // compareReadbackMean checks the COMPARE surface's own gen (currentCompareGen)
  // — the shared client-side counter (renderClient.ts's `this.gen`) is stamped
  // onto both surfaces' commands, but a main 'render' bumping past a
  // compareRender's gen (or vice versa) must never mark the OTHER surface's
  // request stale — see this file's doc comment.
  const staleAgainst = req.method === 'compareReadbackMean' ? currentCompareGen : currentGen;
  if (req.method !== 'renderToPixels' && req.gen < staleAgainst) {
    post({ type: 'response', reqId: req.reqId, gen: staleAgainst, ok: true, result: null });
    return;
  }
  try {
    switch (req.method) {
      case 'compareReadbackMean': {
        if (!compareRendererReady) {
          post({ type: 'response', reqId: req.reqId, gen: currentCompareGen, ok: true, result: null });
          return;
        }
        const compareRenderer = await compareRendererReady;
        const result = await compareRenderer.readbackMean();
        post({ type: 'response', reqId: req.reqId, gen: currentCompareGen, ok: true, result });
        return;
      }
      case 'stats': {
        const result = await renderer.stats();
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result });
        return;
      }
      case 'scopeSamples': {
        const result = await renderer.scopeSamples(req.maxCols, req.maxRows);
        post(
          { type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result },
          result ? [result.data.buffer] : []
        );
        return;
      }
      case 'readbackMean': {
        const result = await renderer.readbackMean();
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result });
        return;
      }
      case 'readbackSharpness': {
        const result = await renderer.readbackSharpness();
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result });
        return;
      }
      case 'rendererStats': {
        const result = renderer.rendererStats();
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result });
        return;
      }
      case 'statsCrop': {
        const result = await renderer.statsCrop(req.x0, req.y0, req.w, req.h);
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result });
        return;
      }
      case 'encodedCropForVerify': {
        const result = await renderer.encodedCropForVerify(req.x0, req.y0, req.w, req.h);
        post(
          { type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result },
          result ? [result.buffer] : []
        );
        return;
      }
      case 'renderToPixels': {
        // export's own WbModel, freshly derived from the export request's
        // image (identical camera metadata to the preview in practice, but
        // never assumed — see this file's doc comment).
        const wb = createWbModel(req.image.color ?? {});
        const plan = buildPlan(req.doc, {
          wb,
          renderScale: req.renderScale,
          outputId: req.outputId,
          srcWidth: req.image.width,
          srcHeight: req.image.height,
        });
        const result = await renderer.renderToPixels(req.image, plan, req.colorSpace);
        post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result }, [result.data.buffer]);
        return;
      }
    }
  } catch (err) {
    post({
      type: 'response',
      reqId: req.reqId,
      gen: currentGen,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (ev: MessageEvent<RenderWorkerCommand | RenderWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'request') {
    void handleRequest(msg);
    return;
  }
  switch (msg.type) {
    case 'init': {
      offscreenCanvas = msg.canvas;
      GraphRenderer.create(msg.canvas).then(resolveRenderer!, (err) => {
        post({ type: 'initError', message: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    case 'image': {
      currentGen = msg.gen;
      currentCompareGen = msg.gen;
      wbModel = createWbModel(msg.image.color ?? {});
      currentImageDims = { width: msg.image.width, height: msg.image.height };
      lastImage = msg.image;
      // fire-and-forget, but a failure (e.g. a lost GPU device) must still
      // surface to the UI (task #45/worker-error-surfacing) instead of
      // vanishing silently — see renderProtocol.ts's 'error' response doc.
      void rendererReady
        .then((renderer) => renderer.setImage(msg.image))
        .catch((err) => {
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        });
      // Compare pane (compare pack): only push if the compare surface has
      // ever been initialized this session (initCompare) — a fresh doc's
      // 'initCompare' handler below replays `lastImage` itself, so there is
      // no ordering requirement between the two.
      if (compareRendererReady) {
        void compareRendererReady
          .then((renderer) => renderer.setImage(msg.image))
          .catch((err) => {
            post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          });
      }
      return;
    }
    case 'render': {
      currentGen = msg.gen;
      const gen = msg.gen;
      // newest-wins, mirroring the cancellation check the old main-thread
      // effect did after its own await(s) — rendererReady/setGraph() are the
      // only await points, so a STALE render (superseded by a newer 'render'
      // message while awaiting either) must not draw over the current state.
      void rendererReady
        .then(async (renderer) => {
          if (gen !== currentGen) return;
          const plan = buildPreviewPlan(
            msg.doc,
            {
              wb: wbModel,
              renderScale: msg.renderScale,
              outputId: msg.outputId,
              srcWidth: currentImageDims?.width,
              srcHeight: currentImageDims?.height,
            },
            msg.showBefore
          );
          renderer.viewMode = msg.viewMode;
          await renderer.setGraph(plan);
          if (gen !== currentGen) return;
          const overlayStepIndex = msg.overlayMaskNodeId
            ? plan.steps.findIndex((s) => s.nodeId === msg.overlayMaskNodeId)
            : -1;
          renderer.render(overlayStepIndex >= 0 ? overlayStepIndex : null);
        })
        .catch((err) => {
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    case 'resize': {
      if (offscreenCanvas) {
        offscreenCanvas.width = msg.width;
        offscreenCanvas.height = msg.height;
      }
      return;
    }
    case 'initCompare': {
      compareOffscreenCanvas = msg.canvas;
      compareRendererReady = new Promise((resolve) => {
        resolveCompareRenderer = resolve;
      });
      GraphRenderer.create(msg.canvas).then(
        (renderer) => {
          // Replay whatever image is already loaded — the ordinary case is
          // compare mode being toggled ON well after the main image opened
          // (see this file's doc comment on `lastImage`).
          if (lastImage) renderer.setImage(lastImage);
          resolveCompareRenderer!(renderer);
        },
        (err) => {
          post({ type: 'initError', message: err instanceof Error ? err.message : String(err) });
        }
      );
      return;
    }
    case 'compareResize': {
      if (compareOffscreenCanvas) {
        compareOffscreenCanvas.width = msg.width;
        compareOffscreenCanvas.height = msg.height;
      }
      return;
    }
    case 'compareRender': {
      currentCompareGen = msg.gen;
      const gen = msg.gen;
      // No-op until initCompare has landed (compare mode not yet entered
      // this session) — mirrors 'render''s own rendererReady await, just
      // over a promise that may not exist yet at all.
      if (!compareRendererReady) return;
      void compareRendererReady
        .then(async (renderer) => {
          if (gen !== currentCompareGen) return;
          const plan = buildPreviewPlan(
            msg.doc,
            {
              wb: wbModel,
              renderScale: msg.renderScale,
              outputId: msg.outputId,
              srcWidth: currentImageDims?.width,
              srcHeight: currentImageDims?.height,
            },
            msg.showBefore
          );
          renderer.viewMode = msg.viewMode;
          await renderer.setGraph(plan);
          if (gen !== currentCompareGen) return;
          renderer.render(null);
        })
        .catch((err) => {
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    case 'shaderArtifactSet': {
      setCustomShaderArtifact(msg.nodeId, msg.artifact);
      return;
    }
    case 'shaderArtifactClear': {
      clearCustomShaderArtifacts();
      return;
    }
  }
};
