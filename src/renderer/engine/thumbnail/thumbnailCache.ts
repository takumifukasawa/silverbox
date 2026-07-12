/**
 * Folder-filmstrip thumbnail cache (ROADMAP "nice to have" — browse a
 * folder, NOT a catalog): lazy, concurrency-limited, per-path blob URLs.
 * NO on-disk cache — that's catalog territory (DESIGN.md non-goal); every
 * thumbnail is recomputed from the source file's own bytes each time a
 * folder is opened, and the cache lives only as long as this renderer
 * process's memory does.
 *
 * Two decode strategies, picked by file kind:
 *  - Sony RAW: reuse extractSonyEmbeddedPreview (sonyLensProfile.ts) with
 *    `{ prefer: 'smallest-above' }` — the a7C II's own 160×120 IFD1 thumb is
 *    already thumbnail-sized, so the embedded bytes go straight into a Blob:
 *    URL with no further decode/resize.
 *  - JPEG (and any RAW without a Sony embedded thumb): createImageBitmap
 *    with `resizeWidth` does the decode-time downscale cheaply, then a small
 *    canvas re-encodes it to a JPEG Blob for the `<img>` src.
 *
 * Loading is triggered lazily (Filmstrip.tsx's IntersectionObserver, one per
 * cell) and funneled through a small concurrency-limited queue so a
 * 400-image folder never decodes 400 previews at once. `revokeAllThumbnails`
 * is the folder-switch cleanup — Filmstrip.tsx calls it (via a `key={dir}`
 * remount, whose unmount cleanup fires it) whenever the folder context
 * changes, so blob: URLs never accumulate across folder switches.
 */
import { extractSonyEmbeddedPreview } from '../lens/sonyLensProfile';
import { isRawFileName } from '../decoder/librawDecoder';

/** Long-edge target (px) for every filmstrip thumbnail — matches the a7C II's own IFD1 thumb, so the RAW path needs no resize at all. */
const THUMBNAIL_LONG_EDGE = 160;
/** At most this many thumbnail loads run at once (a 400-file folder must not decode 400 previews eagerly). */
const THUMBNAIL_CONCURRENCY = 4;

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

/** Verify-only: every blob: URL revokeAllThumbnails has revoked so far, in order (proves a folder switch doesn't leak the previous folder's URLs). */
const revokedThumbnailUrls: string[] = [];
export function thumbnailRevocationLog(): readonly string[] {
  return revokedThumbnailUrls;
}

/** Revoke every cached thumbnail blob: URL and clear the cache — the folder-switch cleanup (see Filmstrip.tsx). */
export function revokeAllThumbnails(): void {
  for (const url of cache.values()) {
    URL.revokeObjectURL(url);
    revokedThumbnailUrls.push(url);
  }
  cache.clear();
  inFlight.clear();
}

// --- concurrency-limited queue ----------------------------------------------

let active = 0;
const waiters: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (active < THUMBNAIL_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

/** JPEG (or non-Sony-RAW) thumbnail: decode-scale via createImageBitmap, re-encode via an OffscreenCanvas. */
async function decodeResizedThumbBlob(bytes: ArrayBuffer): Promise<string | null> {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob, { resizeWidth: THUMBNAIL_LONG_EDGE, resizeQuality: 'medium' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return URL.createObjectURL(outBlob);
  } finally {
    bitmap.close();
  }
}

/**
 * Load (or return the already-cached) thumbnail blob: URL for `path`. Never
 * throws — any failure (unreadable file, undecodable image, no embedded
 * preview) resolves to null and the caller just leaves that cell showing its
 * placeholder. Concurrent calls for the SAME path share one in-flight
 * promise rather than double-decoding.
 */
export function getThumbnail(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(path);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    await acquireSlot();
    try {
      const bytes = await window.silverbox.readFile(path);
      const fileName = path.split('/').pop() ?? path;
      let url: string | null = null;
      if (isRawFileName(fileName)) {
        const preview = extractSonyEmbeddedPreview(bytes, { prefer: 'smallest-above', minLongEdge: THUMBNAIL_LONG_EDGE });
        if (preview) url = URL.createObjectURL(new Blob([preview.bytes], { type: 'image/jpeg' }));
      } else {
        url = await decodeResizedThumbBlob(bytes);
      }
      if (url) cache.set(path, url);
      return url;
    } catch {
      return null;
    } finally {
      releaseSlot();
      inFlight.delete(path);
    }
  })();
  inFlight.set(path, promise);
  return promise;
}
