/**
 * Per-node preview thumbnails (per-node-preview pack, tier 1): turns the
 * render worker's raw per-node RGBA batch (GraphRenderer.thumbnails(), via
 * RenderWorkerClient.thumbnails()) into blob: URLs for CanvasView to push
 * into appStore's `nodeThumbs: Record<nodeId, string>` map, which
 * NodeEditorPanel's custom node bodies read.
 *
 * Unlike thumbnailCache.ts (the folder filmstrip — decoded ONCE from a
 * file's own bytes, cached forever until a folder switch), these are
 * recomputed on every debounced post-render refresh, for every node in the
 * doc. Recomputing does NOT mean re-issuing a blob: URL for every node every
 * time, though: this module keeps the previous raw bytes per nodeId and only
 * builds a new blob (revoking the old URL) when a node's bytes actually
 * changed — an edit to node X must refresh X's own thumbnail but leave every
 * UPSTREAM node's thumbnail URL untouched (same string), which is what lets
 * the verify harness assert "this URL didn't change" for an unaffected node.
 *
 * Same revocation-audit discipline as thumbnailCache.ts: every URL this
 * module ever hands out is logged before being revoked —
 * nodeThumbRevocationLog() is the verify-only window into that.
 */

/** Verify-only: every blob: URL this module has revoked so far, in order. */
const revokedNodeThumbUrls: string[] = [];
export function nodeThumbRevocationLog(): readonly string[] {
  return revokedNodeThumbUrls;
}

function revoke(url: string): void {
  URL.revokeObjectURL(url);
  revokedNodeThumbUrls.push(url);
}

/** Previous raw RGBA bytes per nodeId, so an unchanged node keeps its existing blob: URL instead of minting a new one every refresh. */
let rawCache = new Map<string, Uint8ClampedArray<ArrayBuffer>>();

function bytesEqual(a: Uint8ClampedArray<ArrayBuffer>, b: Uint8ClampedArray<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Merge a fresh worker batch into `prevUrls`: unchanged nodes keep their old
 * URL (no blob work at all); changed or new nodes get a freshly encoded PNG
 * blob (old URL, if any, revoked); nodes present in `prevUrls` but absent
 * from `batch` (deleted, or no longer reachable from the resolved output)
 * are dropped and revoked. Returns the new `nodeThumbs` map for the caller
 * to write into the store.
 */
export async function updateNodeThumbs(
  prevUrls: Record<string, string>,
  batch: Record<string, { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }>
): Promise<Record<string, string>> {
  const nextRaw = new Map<string, Uint8ClampedArray<ArrayBuffer>>();
  const nextUrls: Record<string, string> = {};
  await Promise.all(
    Object.entries(batch).map(async ([nodeId, { width, height, data }]) => {
      const prevBytes = rawCache.get(nodeId);
      const prevUrl = prevUrls[nodeId];
      if (prevBytes && prevUrl && bytesEqual(prevBytes, data)) {
        nextRaw.set(nodeId, prevBytes);
        nextUrls[nodeId] = prevUrl;
        return;
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(data, width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      nextRaw.set(nodeId, data);
      nextUrls[nodeId] = URL.createObjectURL(blob);
      if (prevUrl) revoke(prevUrl);
    })
  );
  // Prune: nodes that vanished from this batch (deleted, or no longer
  // reachable from the resolved output) never get a new entry above, so any
  // leftover previous URL for them must be revoked here.
  for (const [nodeId, url] of Object.entries(prevUrls)) {
    if (!(nodeId in batch)) revoke(url);
  }
  rawCache = nextRaw;
  return nextUrls;
}

/** Revoke every URL in `thumbs` and forget all cached raw bytes — the image-switch / doc-close cleanup. */
export function clearNodeThumbs(thumbs: Record<string, string>): void {
  for (const url of Object.values(thumbs)) revoke(url);
  rawCache.clear();
}

/** Revoke and drop exactly one node's thumbnail — the immediate (non-debounced) prune on node deletion. */
export function pruneNodeThumb(thumbs: Record<string, string>, nodeId: string): Record<string, string> {
  const url = thumbs[nodeId];
  if (!url) return thumbs;
  revoke(url);
  rawCache.delete(nodeId);
  const next = { ...thumbs };
  delete next[nodeId];
  return next;
}
