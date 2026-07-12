/**
 * Image node (composite/mask-by-another-file feature) — main-thread decode
 * orchestration. Render-isolation (DESIGN.md §10) puts the render worker
 * entirely off-limits for decoding: it never runs libraw. So a referenced
 * file decodes HERE, on the renderer main thread, via the SAME imageLoader
 * the main image uses (decodeWorker.ts, RAW → baseline EV + working-space,
 * JPEG → SRGB_TO_WORK — identical ingest either way), and the resulting
 * pixels travel to the render worker exactly like the main image does (see
 * renderClient.ts's setImageNodeSource / renderProtocol.ts's 'imageNode').
 *
 * Lazy + cached, per the brief's "simplest correct" call: `syncImageNodeSources`
 * is meant to be invoked from CanvasView's render effect (every time the doc
 * or the main image changes) rather than being wired to any dedicated
 * open/save hook. A path already decoded (successfully OR unsuccessfully)
 * is never re-attempted until `clearImageNodeSourceCache` runs — CanvasView
 * calls that on every main-image switch, so a doc opened against a
 * DIFFERENT photo always starts fresh (no stale relative-path→wrong-file
 * mapping, no stale "missing" verdict surviving from a previous photo).
 *
 * Epoch guard: rather than threading appStore's own (module-private)
 * openImageEpoch through here, staleness is checked via the caller-supplied
 * `stale()` predicate right before a decode result is cached/posted — a
 * result that arrives after the main image has switched is simply dropped.
 * This is safe rather than merely convenient: the render worker's own
 * per-path caches (GraphRenderer.imageNodeTextures + renderWorker.ts's
 * compare-replay list) are ALREADY being cleared by that same image switch
 * (see setImage()'s doc comment), so a dropped-here result could at worst
 * have repopulated a cache that was about to be wiped anyway.
 */
import { loadImage } from '../decoder/imageLoader';
import { isRawFileName } from '../decoder/librawDecoder';
import type { PreparedImage } from '../decoder/decodeWorker';
import { IMAGE_KIND, resolveImagePath } from './imageNode';
import type { GraphDoc } from './graphDoc';

/** Bumped once per REAL decode (cache miss) — verify-imagenode.mjs's render-worker-cache check reads this via window.__debug.imageNodeDecodeCount(). */
let decodeCount = 0;
export function imageNodeDecodeCount(): number {
  return decodeCount;
}

type PathStatus = 'ok' | 'bad';
/** Settled outcome per RAW path (as-authored `image.path`) — present once a decode attempt has finished, either way. */
const pathStatus = new Map<string, PathStatus>();
/** Paths with a decode currently in flight — prevents a second concurrent attempt for the same path (e.g. two nodes sharing it, or two render-effect runs before the first settles). */
const inFlight = new Set<string>();

/** Reset all decode state — called on every main-image switch (see this file's doc comment). */
export function clearImageNodeSourceCache(): void {
  pathStatus.clear();
  inFlight.clear();
}

export interface ImageNodeSourceClient {
  setImageNodeSource(path: string, image: PreparedImage): void;
}

async function decodeAndPost(
  rawPath: string,
  sidecarDir: string | null,
  client: ImageNodeSourceClient,
  stale: () => boolean,
  onSettled: () => void
): Promise<void> {
  try {
    const resolved = resolveImagePath(rawPath, sidecarDir);
    const bytes = await window.silverbox.readFile(resolved);
    if (stale()) return;
    const fileName = resolved.split('/').pop() ?? resolved;
    // Same RAW/JPEG detection the headless CLI path uses (appStore.ts) — an
    // unsupported extension simply decodes as JPEG and fails naturally,
    // landing in the catch below as "missing/unreadable", not a special case.
    const kind = isRawFileName(fileName) ? 'raw' : 'jpg';
    const image = await loadImage(bytes, kind);
    decodeCount++;
    if (stale()) return;
    pathStatus.set(rawPath, 'ok');
    client.setImageNodeSource(rawPath, image);
    onSettled();
  } catch {
    // Missing/unreadable file: settle as 'bad' and STILL notify the caller
    // (unlike the success path, no texture needs uploading, but the render
    // effect must re-run at least once more to re-scan `pathStatus` and flip
    // this node's missing-badge state — otherwise nothing would ever tell it
    // the decode settled at all).
    if (!stale()) {
      pathStatus.set(rawPath, 'bad');
      onSettled();
    }
  } finally {
    inFlight.delete(rawPath);
  }
}

/**
 * Scan `doc` for 'image' nodes with a non-empty path; kick off a decode for
 * each distinct raw path not yet settled/in flight, and report each such
 * node's current missing-state via `onMissing(nodeId, missing)` (called
 * EVERY time this runs, including while a decode is still pending —
 * `missing` is only true once a decode has actually FAILED, never while
 * merely loading, so no badge flashes for an in-flight or not-yet-started
 * decode; the callback itself must be a cheap no-op-on-no-change store
 * write, since this function is meant to be called on every render-effect
 * pass). `onSettled` fires ONCE per decode that actually finishes (success
 * OR failure; never for a scan that finds nothing new) — the caller's
 * signal to re-run its own effect: a successful decode needs a fresh
 * render() call for the newly uploaded texture to show up, and a FAILED one
 * needs this function called again so it can re-scan `pathStatus` and
 * finally report `missing: true` (see CanvasView.tsx's imageNodeRev).
 * No-op when `client` is null (no render worker yet — mirrors every other
 * render-effect guard in CanvasView.tsx).
 */
export function syncImageNodeSources(
  doc: GraphDoc,
  sidecarDir: string | null,
  client: ImageNodeSourceClient | null,
  stale: () => boolean,
  onMissing: (nodeId: string, missing: boolean) => void,
  onSettled: () => void
): void {
  if (!client) return;
  const seen = new Set<string>();
  for (const node of doc.nodes) {
    if (node.kind !== IMAGE_KIND) continue;
    const path = node.image?.path ?? '';
    if (!path) {
      onMissing(node.id, false); // no file chosen yet — gray, but not a "missing file" badge
      continue;
    }
    if (!seen.has(path)) {
      seen.add(path);
      if (!pathStatus.has(path) && !inFlight.has(path)) {
        inFlight.add(path);
        void decodeAndPost(path, sidecarDir, client, stale, onSettled);
      }
    }
    onMissing(node.id, pathStatus.get(path) === 'bad');
  }
}
