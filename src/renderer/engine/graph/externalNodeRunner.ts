/**
 * External-tool hook node (denoise v1, task #41) — main-thread orchestration:
 * the confirm gate + the actual IPC round trip. Mirrors imageNodeSource.ts's
 * shape (a tiny module of session-scoped Maps/Sets, invoked from CanvasView's
 * effect wiring) but for a totally different reason to exist separately from
 * graphRenderer.ts: the render worker can compute WHAT to run (readback +
 * hash + debounce — see GraphRenderer.checkExternalNodes) but can never
 * itself decide WHETHER to run it or actually spawn anything — sub-processes
 * are main-process only, and the "has the user actually agreed to run this
 * command" gate is inherently main-thread UI state (a Set, never touched by
 * a Worker).
 *
 * SECURITY (the brief's own words): opening a sidecar with an external node
 * does NOT auto-run its command. A given (docKey, command) pair starts
 * DISABLED — `isExternalConfirmed` false — until `confirmExternalCommand` is
 * called (the Inspector's "Run external tool: <command>" button). This state
 * is SESSION-ONLY: `confirmed` is a plain in-memory Set, never read/written
 * to the sidecar or settings.json, and never cleared on doc/image switch
 * either — the brief's contract is "first time a given (doc, command) pair
 * is seen IN A SESSION", not "per doc-open." A text file from the internet
 * (a sidecar someone emailed you, or a git-shared preset) must not execute
 * arbitrary commands on open — this module is the ONE place that decision is
 * made before `window.silverbox.runExternalTool` is ever called.
 */

export interface ExternalRunRequest {
  nodeId: string;
  cacheKey: string;
  command: string;
  encoded: boolean;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface ExternalNodeClient {
  postExternalResult(
    nodeId: string,
    cacheKey: string,
    encoded: boolean,
    result: { ok: true; width: number; height: number; data: ArrayBuffer } | { ok: false; reason: string }
  ): void;
}

/** `${docKey}::${command}` pairs the user has explicitly confirmed this session — see this file's doc comment. */
const confirmed = new Set<string>();
/** Most recent request per node — lets the confirm button retry immediately without waiting for another upstream edit. */
const pendingByNode = new Map<string, ExternalRunRequest>();
/** One in-flight IPC call at a time per node — a burst of upstream changes must not pile up concurrent subprocess runs for the SAME node. */
const runningNodes = new Set<string>();

function confirmKey(docKey: string, command: string): string {
  return `${docKey}::${command}`;
}

export function isExternalConfirmed(docKey: string, command: string): boolean {
  return confirmed.has(confirmKey(docKey, command));
}

export function confirmExternalCommand(docKey: string, command: string): void {
  confirmed.add(confirmKey(docKey, command));
}

/** The last request seen for `nodeId` (for the confirm button's immediate retry), or undefined if none yet this session. */
export function pendingExternalRequest(nodeId: string): ExternalRunRequest | undefined {
  return pendingByNode.get(nodeId);
}

/**
 * Handle one 'externalRunRequest' from the render worker: gate on confirm,
 * then run (or skip) via IPC. Never throws — a transport-level failure
 * (IPC itself rejecting, vanishingly rare) is reported through the SAME
 * `onSettled`/`postExternalResult` path as an ordinary subprocess failure,
 * so the UI has exactly one failure shape to handle.
 */
export async function handleExternalRunRequest(
  req: ExternalRunRequest,
  docKey: string,
  client: ExternalNodeClient,
  onNeedsConfirm: (nodeId: string, command: string) => void,
  onSettled: (nodeId: string, ok: boolean, error?: string) => void
): Promise<void> {
  pendingByNode.set(req.nodeId, req);
  if (!isExternalConfirmed(docKey, req.command)) {
    onNeedsConfirm(req.nodeId, req.command);
    return;
  }
  if (runningNodes.has(req.nodeId)) return;
  runningNodes.add(req.nodeId);
  try {
    const result = await window.silverbox.runExternalTool({
      command: req.command,
      encoded: req.encoded,
      cacheKey: req.cacheKey,
      width: req.width,
      height: req.height,
      data: req.data,
    });
    client.postExternalResult(req.nodeId, req.cacheKey, req.encoded, result);
    onSettled(req.nodeId, result.ok, result.ok ? undefined : result.reason);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    client.postExternalResult(req.nodeId, req.cacheKey, req.encoded, { ok: false, reason });
    onSettled(req.nodeId, false, reason);
  } finally {
    runningNodes.delete(req.nodeId);
  }
}

/**
 * The Inspector's confirm button (per-node, but confirmation itself is keyed
 * by (docKey, command) — confirming one node auto-confirms any OTHER node
 * sharing the identical command string, same trust boundary either way):
 * marks the pair confirmed, then immediately retries the last pending
 * request for THIS node if one is queued, rather than waiting for the next
 * upstream edit to re-arm the debounce.
 */
export function confirmAndRetry(
  nodeId: string,
  docKey: string,
  command: string,
  client: ExternalNodeClient,
  onSettled: (nodeId: string, ok: boolean, error?: string) => void
): void {
  confirmExternalCommand(docKey, command);
  const pending = pendingByNode.get(nodeId);
  if (pending && pending.command === command) {
    void handleExternalRunRequest(pending, docKey, client, () => {}, onSettled);
  }
}
