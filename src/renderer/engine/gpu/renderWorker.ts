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
 */
import { GraphRenderer } from './graphRenderer';
import { buildPlan, type CompileContext, type GraphDoc, type RenderPlan } from '../graph/graphDoc';
import { setCustomShaderArtifact, clearCustomShaderArtifacts } from '../graph/customShaderNode';
import { createWbModel, type WbModel } from '../color/whiteBalance';
import type { RenderWorkerCommand, RenderWorkerRequest, RenderWorkerResponse } from './renderProtocol';

let resolveRenderer: ((r: GraphRenderer) => void) | null = null;
const rendererReady = new Promise<GraphRenderer>((resolve) => {
  resolveRenderer = resolve;
});

let offscreenCanvas: OffscreenCanvas | null = null;
/** Per-image WB model, rebuilt whenever a new 'image' command lands. */
let wbModel: WbModel = createWbModel({});
/** Gen of the most recently applied 'image'/'render' command (see renderProtocol.ts). */
let currentGen = 0;

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
  if (req.method !== 'renderToPixels' && req.gen < currentGen) {
    post({ type: 'response', reqId: req.reqId, gen: currentGen, ok: true, result: null });
    return;
  }
  try {
    switch (req.method) {
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
        const plan = buildPlan(req.doc, { wb, renderScale: req.renderScale });
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
      wbModel = createWbModel(msg.image.color ?? {});
      void rendererReady.then((renderer) => renderer.setImage(msg.image));
      return;
    }
    case 'render': {
      currentGen = msg.gen;
      const gen = msg.gen;
      // newest-wins, mirroring the cancellation check the old main-thread
      // effect did after its own await(s) — rendererReady/setGraph() are the
      // only await points, so a STALE render (superseded by a newer 'render'
      // message while awaiting either) must not draw over the current state.
      void rendererReady.then(async (renderer) => {
        if (gen !== currentGen) return;
        const plan = buildPreviewPlan(msg.doc, { wb: wbModel, renderScale: msg.renderScale }, msg.showBefore);
        renderer.viewMode = msg.viewMode;
        await renderer.setGraph(plan);
        if (gen !== currentGen) return;
        renderer.render();
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
