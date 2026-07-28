/**
 * LUT import node — main-thread load orchestration (mirrors
 * imageNodeSource.ts's shape almost exactly: render-isolation, DESIGN.md
 * §10, puts the render worker off-limits for file IO, so a referenced .cube
 * is read + parsed HERE and the resulting table travels to the render
 * worker exactly like an image-node decode does).
 *
 * Lazy + cached, same "simplest correct" call as the Image node:
 * `syncLutSources` is meant to be invoked from CanvasView's render effect
 * (every time the doc or the main image changes); a path already settled
 * (successfully OR unsuccessfully) is never re-attempted until
 * `clearLutSourceCache` runs — CanvasView calls that on every main-image
 * switch, same reasoning as the Image node: a doc opened against a
 * DIFFERENT photo must never see a stale relative-path→wrong-file mapping
 * survive from the previous one (LUT paths are sidecar-relative too — see
 * imageNode.ts's resolveImagePath, reused verbatim here).
 *
 * Unlike the Image node, a settled result here is the PARSED TABLE, not
 * decoded pixels — it travels to the worker via renderClient.ts's
 * setLutTable, which threads it into buildPlan's ctx.lutTables (so the CPU
 * mirror closure can be built worker-side, buildPlan's own job — see
 * graphDoc.ts) AND (3D tables only) into GraphRenderer's per-path strip-
 * texture cache (see graphRenderer.ts's setLutTexture).
 */
import { parseCubeLut, type CubeLut } from '../color/lutCube';
import { LUT_KIND } from './lutNode';
import { resolveImagePath } from './imageNode';
import type { GraphDoc } from './graphDoc';

/** Bumped once per REAL parse attempt (cache miss) — verify-lut.mjs's cache check reads this via window.__debug.lutSourceDecodeCount(). */
let decodeCount = 0;
export function lutSourceDecodeCount(): number {
  return decodeCount;
}

type PathStatus = 'ok' | 'bad';
/** Settled outcome per RAW path (as-authored `lut.path`) — present once a load attempt has finished, either way. */
const pathStatus = new Map<string, PathStatus>();
/** Paths with a load currently in flight — prevents a second concurrent attempt for the same path. */
const inFlight = new Set<string>();
/**
 * MAIN-THREAD copy of every parsed table, keyed by raw path — the render
 * worker gets its own copy via renderClient.ts's setLutTable (see
 * renderProtocol.ts's 'lutTable' doc comment), but a handful of call sites
 * build a RenderPlan on the main thread directly (CanvasView.tsx's
 * cpuReferenceMean — the verify harness's GPU/CPU parity check depends on
 * it) and need the SAME table without reaching into the worker's isolated
 * memory. Populated in lockstep with `pathStatus`; cleared alongside it.
 */
const tableCache = new Map<string, CubeLut | null>();

/** Reset all load state — called on every main-image switch (see this file's doc comment). */
export function clearLutSourceCache(): void {
  pathStatus.clear();
  inFlight.clear();
  tableCache.clear();
}

/** Main-thread snapshot of every parsed table loaded so far — see `tableCache`'s doc comment. Threaded into CompileContext.lutTables by any MAIN-THREAD buildPlan caller (CanvasView.tsx's cpuReferenceMean). */
export function lutTableCache(): ReadonlyMap<string, CubeLut | null> {
  return tableCache;
}

export interface LutSourceClient {
  setLutTable(path: string, table: CubeLut | null): void;
}

async function loadAndPost(
  rawPath: string,
  sidecarDir: string | null,
  client: LutSourceClient,
  stale: () => boolean,
  onSettled: () => void
): Promise<void> {
  try {
    const resolved = resolveImagePath(rawPath, sidecarDir);
    const bytes = await window.silverbox.readFile(resolved);
    if (stale()) return;
    const text = new TextDecoder('utf-8').decode(bytes);
    const table = parseCubeLut(text);
    decodeCount++;
    if (stale()) return;
    pathStatus.set(rawPath, table ? 'ok' : 'bad');
    tableCache.set(rawPath, table);
    client.setLutTable(rawPath, table);
    onSettled();
  } catch {
    // Missing/unreadable file: settle as 'bad' and still notify the caller —
    // same "the render effect must re-run at least once more to flip the
    // missing-badge state" contract as imageNodeSource.ts's decodeAndPost.
    if (!stale()) {
      pathStatus.set(rawPath, 'bad');
      tableCache.set(rawPath, null);
      client.setLutTable(rawPath, null);
      onSettled();
    }
  } finally {
    inFlight.delete(rawPath);
  }
}

/**
 * Scan `doc` for 'lut' nodes with a non-empty path; kick off a load for each
 * distinct raw path not yet settled/in flight, and report each such node's
 * current missing-state via `onMissing(nodeId, missing)` — same contract as
 * imageNodeSource.ts's syncImageNodeSources (called every render-effect
 * pass; `missing` only flips true once a load has actually FAILED or
 * produced an unparsable file, never while merely loading). `onSettled`
 * fires ONCE per load that actually finishes — the caller's signal to
 * re-run its own effect and post a fresh render. No-op when `client` is
 * null.
 */
export function syncLutSources(
  doc: GraphDoc,
  sidecarDir: string | null,
  client: LutSourceClient | null,
  stale: () => boolean,
  onMissing: (nodeId: string, missing: boolean) => void,
  onSettled: () => void
): void {
  if (!client) return;
  const seen = new Set<string>();
  for (const node of doc.nodes) {
    if (node.kind !== LUT_KIND) continue;
    const path = node.lut?.path ?? '';
    if (!path) {
      onMissing(node.id, false); // no file chosen yet — identity, but not a "missing file" badge
      continue;
    }
    if (!seen.has(path)) {
      seen.add(path);
      if (!pathStatus.has(path) && !inFlight.has(path)) {
        inFlight.add(path);
        void loadAndPost(path, sidecarDir, client, stale, onSettled);
      }
    }
    onMissing(node.id, pathStatus.get(path) === 'bad');
  }
}
