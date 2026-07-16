/**
 * In-engine ML denoise node (denoise v2, stage 1) — main-thread
 * orchestration: mirrors externalNodeRunner.ts's shape (the render worker
 * computes WHAT to run — readback + hash + debounce, see
 * GraphRenderer.checkDenoiseNodes — while this module is the main-thread
 * entry point that actually makes the IPC call), but the GATE is different
 * in kind from v1's per-command confirm:
 *
 * SECURITY: a denoise node needs no per-run confirmation (it's a first-party
 * built-in, not an arbitrary user command — no `--allow-external`-style CLI
 * opt-in either, see docs/brief-bank/denoise-v2.md). The ONE thing that
 * needs consent is the model DOWNLOAD, and that consent is a persisted
 * Settings field (`denoiseModelConsent`) the Inspector's "Download denoise
 * model" button sets via the ordinary `settingsUpdate` action — there is no
 * separate confirm Set here the way externalNodeRunner.ts keeps one. This
 * module still keeps a `pendingByNode` map for the SAME reason
 * externalNodeRunner.ts does: once the user clicks consent, the render
 * pipeline needs to retry the LAST computed request immediately rather than
 * waiting for another upstream pixel edit to re-arm checkDenoiseNodes'
 * debounce (see `retryPending`, the consent-flow analogue of
 * confirmAndRetry).
 *
 * Main (src/main/denoiseModel.ts) is a SECOND, independent gate on the same
 * consent flag — it re-reads settings.json itself before ever downloading,
 * so this module trusting `consented` at all is a UX nicety (skip a
 * doomed-to-fail IPC round trip), never the actual security boundary.
 */

export interface DenoiseRunRequest {
  nodeId: string;
  cacheKey: string;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface DenoiseNodeClient {
  postDenoiseResult(
    nodeId: string,
    cacheKey: string,
    result: { ok: true; width: number; height: number; data: ArrayBuffer; ep: string } | { ok: false; reason: string; needsConsent: boolean }
  ): void;
}

/** Most recent request per node — lets a just-granted consent retry immediately without waiting for another upstream edit. */
const pendingByNode = new Map<string, DenoiseRunRequest>();
/** One in-flight IPC call at a time per node — a burst of upstream changes must not pile up concurrent inference runs for the SAME node. */
const runningNodes = new Set<string>();

/** The last request seen for `nodeId` (for the post-consent immediate retry), or undefined if none yet this session. */
export function pendingDenoiseRequest(nodeId: string): DenoiseRunRequest | undefined {
  return pendingByNode.get(nodeId);
}

/**
 * Handle one 'denoiseRunRequest' from the render worker: if the model isn't
 * consented yet AND main confirms it actually needs consent (a real
 * needsConsent:false failure — e.g. a corrupt download — is a normal error
 * badge, not a consent prompt), surface `onNeedsConsent`; otherwise run (or
 * skip if already running) via IPC. Never throws — a transport-level
 * failure is reported through the SAME `onSettled`/`postDenoiseResult` path
 * as an ordinary inference failure, so the UI has exactly one failure shape
 * to handle (mirrors handleExternalRunRequest).
 */
export async function handleDenoiseRunRequest(
  req: DenoiseRunRequest,
  client: DenoiseNodeClient,
  onNeedsConsent: (nodeId: string) => void,
  onSettled: (nodeId: string, ok: boolean, error?: string) => void,
  onStarted?: (nodeId: string) => void
): Promise<void> {
  pendingByNode.set(req.nodeId, req);
  if (runningNodes.has(req.nodeId)) return;
  runningNodes.add(req.nodeId);
  onStarted?.(req.nodeId);
  try {
    const result = await window.silverbox.runDenoise({ cacheKey: req.cacheKey, width: req.width, height: req.height, data: req.data });
    client.postDenoiseResult(req.nodeId, req.cacheKey, result);
    if (!result.ok && result.needsConsent) {
      onNeedsConsent(req.nodeId);
      onSettled(req.nodeId, false, undefined); // clear any stale "running" state without treating this as an error badge — see setDenoiseNodeError's needsConsent branch in appStore.ts
    } else {
      onSettled(req.nodeId, result.ok, result.ok ? undefined : result.reason);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    client.postDenoiseResult(req.nodeId, req.cacheKey, { ok: false, reason, needsConsent: false });
    onSettled(req.nodeId, false, reason);
  } finally {
    runningNodes.delete(req.nodeId);
  }
}

/**
 * The Inspector's consent button, right after `updateSettings({
 * denoiseModelConsent: true })` resolves: retry the last pending request for
 * `nodeId` immediately (if one is queued) rather than waiting for the next
 * upstream edit to re-arm checkDenoiseNodes' debounce.
 */
export function retryPendingDenoise(
  nodeId: string,
  client: DenoiseNodeClient,
  onStarted: (nodeId: string) => void,
  onSettled: (nodeId: string, ok: boolean, error?: string) => void
): void {
  const pending = pendingByNode.get(nodeId);
  if (pending) {
    void handleDenoiseRunRequest(pending, client, () => {}, onSettled, onStarted);
  }
}
