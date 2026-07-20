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
 *    already thumbnail-sized, so when `flip === 0` the embedded bytes go
 *    straight into a Blob: URL with no further decode/resize. When the
 *    preview carries a rotation (portrait ARW — round-10 fix: the sliced
 *    JPEG stream has no EXIF of its own, see EmbeddedPreview.flip's doc
 *    comment), it's decoded and re-encoded through an OffscreenCanvas that
 *    applies the rotation (and swaps width/height for the ±90° cases) so the
 *    cached blob is upright pixels, not just an upright <img> box — the
 *    filmstrip grid sizes cells from the bitmap's own aspect ratio.
 *  - JPEG (and any RAW without a Sony embedded thumb): createImageBitmap
 *    with `resizeWidth` does the decode-time downscale cheaply (honoring the
 *    source's own EXIF orientation via `imageOrientation: 'from-image'`),
 *    then a small canvas re-encodes it to a JPEG Blob for the `<img>` src.
 *
 * Loading is triggered lazily (Filmstrip.tsx's IntersectionObserver, one per
 * cell) and funneled through a small concurrency-limited queue so a
 * 400-image folder never decodes 400 previews at once. `revokeAllThumbnails`
 * is the folder-switch cleanup — Filmstrip.tsx calls it (via a `key={dir}`
 * remount, whose unmount cleanup fires it) whenever the folder context
 * changes, so blob: URLs never accumulate across folder switches.
 *
 * Develop-aware thumbnails (docs/brief-bank/develop-aware-thumbnails-impl.md,
 * semantics 1/3/5/6 — "the OTHER cells must show a photo's edited look
 * without ever decoding its RAW"): `getDevelopAwareThumbnail` renders a
 * photo's saved look OVER these same cached preview pixels, entirely
 * in-memory, through the SAME concurrency queue as the plain decode above.
 * It is a DIRECTION indicator, not a color-accurate preview — three honesty
 * costs, all deliberate:
 *  1. The embedded preview is the camera's own sRGB-tone-mapped JPEG, not
 *     linear sensor data. Each sample is sRGB-DECODED to approximate linear
 *     (srgb.ts's exact transfer functions, never a gamma-2.2 shortcut)
 *     before the CPU mirror runs, then sRGB-ENCODED back — this avoids
 *     double-applying the camera's own tone curve, but it can never recover
 *     highlights the camera already clipped or the sensor's native gamut.
 *  2. Geometry (crop/rotate/lens) is never applied — the preview's framing
 *     is already baked, and RenderPlan.geometry/.lens are simply never
 *     consulted (cpuEvalPlan itself never reads them, so this needs no
 *     special-casing here).
 *  3. Spatial (neighborhood) ops have no CPU mirror by construction (Detail,
 *     spots, masks' blend consumer, custom WGSL, external, denoise — see
 *     graphDoc.ts's PlanStep/cpuEvalPlan doc comments); a look whose active
 *     chain contains one throws when cpuEvalPlan reaches that step. Caught
 *     here and treated as "can't mirror this one, fall back to the plain
 *     preview" — same never-throw posture as an unparseable look file.
 * A plan compiled from the look's ACTIVE output chain that resolves to ZERO
 * steps (buildPlan's own identity-resolution invariant — untouched op ⇒ no
 * step emitted) is the DEFAULT case: `getDevelopAwareThumbnail` returns null
 * and the caller (Filmstrip.tsx) keeps showing the plain preview blob with
 * NO pixel work at all — this is also exactly what makes "revert to default"
 * fall back to the plain preview for free, no separate bookkeeping needed.
 */
import { cpuEvalPlan, type RenderPlan } from '../graph/graphDoc';
import { srgbDecode, srgbEncode } from '../color/srgb';
import { extractSonyEmbeddedPreview } from '../lens/sonyLensProfile';
import { isRawFileName } from '../decoder/librawDecoder';

/** Long-edge target (px) for every filmstrip thumbnail — matches the a7C II's own IFD1 thumb, so the RAW path needs no resize at all. */
const THUMBNAIL_LONG_EDGE = 160;
/** At most this many thumbnail loads run at once (a 400-file folder must not decode 400 previews eagerly). */
const THUMBNAIL_CONCURRENCY = 4;

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
/** Decoded-once pixels behind each path's plain preview blob (develop-aware thumbnails, semantic 6) — populated lazily, ONLY for a path that actually needs a CPU pass (a default-look photo never touches this). */
const pixelCache = new Map<string, ImageData>();
/** Develop-aware blob: URL per path (semantic 5 — lives in this SAME cache shape, in-memory only, never a file). Separate from `cache` so a reverted-to-default look can fall back to the plain preview without recomputing anything. */
const developCache = new Map<string, string>();

/** Verify-only: every blob: URL revokeAllThumbnails has revoked so far, in order (proves a folder switch doesn't leak the previous folder's URLs). */
const revokedThumbnailUrls: string[] = [];
export function thumbnailRevocationLog(): readonly string[] {
  return revokedThumbnailUrls;
}

/** Verify-only: the plain (non-develop-aware) cached blob: URL for `path`, or undefined if not loaded yet — lets a script assert a default-look cell renders EXACTLY this (no CPU pass took over — semantics 1/5). */
export function plainThumbnailUrlFor(path: string): string | undefined {
  return cache.get(path);
}

/** Revoke every cached thumbnail blob: URL (plain AND develop-aware) and clear every cache — the folder-switch cleanup (see Filmstrip.tsx). */
export function revokeAllThumbnails(): void {
  for (const url of cache.values()) {
    URL.revokeObjectURL(url);
    revokedThumbnailUrls.push(url);
  }
  for (const url of developCache.values()) {
    URL.revokeObjectURL(url);
    revokedThumbnailUrls.push(url);
  }
  cache.clear();
  inFlight.clear();
  pixelCache.clear();
  developCache.clear();
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

/** JPEG (or non-Sony-RAW) thumbnail: decode-scale via createImageBitmap, re-encode via an OffscreenCanvas. `imageOrientation: 'from-image'` makes the decode itself honor the source's EXIF orientation, so `bitmap.width`/`height` are already the upright dimensions. */
async function decodeResizedThumbBlob(bytes: ArrayBuffer): Promise<string | null> {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: THUMBNAIL_LONG_EDGE,
    resizeQuality: 'medium',
    imageOrientation: 'from-image',
  });
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
 * Sony RAW embedded-preview thumbnail whose preview needs rotating (round-10
 * fix — see the file-header doc comment and EmbeddedPreview.flip's doc
 * comment for why the bare sliced JPEG has no orientation of its own). Same
 * RawDecoder rotation code space as everywhere else in this app: 0=none,
 * 3=180°, 5=90°CCW, 6=90°CW. Decodes the preview bytes as-is (already
 * thumbnail-sized — no resizeWidth needed), rotates onto an OffscreenCanvas
 * sized to the POST-rotation box (width/height swapped for the ±90° cases,
 * matching CanvasView.tsx's opening-preview-overlay swap logic), then
 * re-encodes so the cached blob's own pixels are upright.
 */
async function decodeRotatedThumbBlob(bytes: ArrayBuffer, flip: number): Promise<string | null> {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  try {
    const swapped = flip === 5 || flip === 6;
    const canvas = new OffscreenCanvas(swapped ? bitmap.height : bitmap.width, swapped ? bitmap.width : bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const degrees = flip === 6 ? 90 : flip === 5 ? -90 : flip === 3 ? 180 : 0;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
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
        if (preview) {
          url =
            preview.flip === 0
              ? URL.createObjectURL(new Blob([preview.bytes], { type: 'image/jpeg' }))
              : await decodeRotatedThumbBlob(preview.bytes, preview.flip);
        }
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

/**
 * Decode `path`'s already-cached plain preview blob into raw RGBA pixels,
 * ONCE (develop-aware thumbnails, semantic 6) — every subsequent look-version
 * bump for the same path reuses these pixels instead of re-decoding the
 * blob. Does NOT itself trigger a preview fetch: `getThumbnail` must already
 * have resolved (Filmstrip.tsx only calls the develop-aware path after its
 * own plain-preview `url` state is set — see that file's own comment), so
 * this is a synchronous cache hit on `cache.get(path)`, never a RAW decode.
 * Returns null when there's no cached preview to decode (nothing loaded
 * yet, or the earlier decode itself failed).
 *
 * Deliberately decodes via a detached `Image` element (`img.decode()`), NOT
 * `fetch(url)` — this app's CSP scopes `blob:` access to `img-src` (which is
 * how the plain `<img>` thumbnails already render one), NOT `connect-src`;
 * `fetch()` on a `blob:` URL is blocked outright and fails silently into
 * this function's own catch, which would otherwise look like "no preview
 * cached yet" instead of the real cause.
 */
async function getThumbnailPixels(path: string): Promise<ImageData | null> {
  const cachedPixels = pixelCache.get(path);
  if (cachedPixels) return cachedPixels;
  const url = cache.get(path);
  if (!url) return null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    try {
      const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
      pixelCache.set(path, pixels);
      return pixels;
    } finally {
      img.src = ''; // release the decoded frame promptly — nothing else references this detached element
    }
  } catch {
    return null;
  }
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Render `plan` (buildPlan'd from a photo's OWN look file) over `path`'s
 * already-cached preview pixels — the develop-aware filmstrip thumbnail
 * (docs/brief-bank/develop-aware-thumbnails-impl.md). See this file's own
 * doc comment for the three honesty costs (approximate-linear, no geometry,
 * no spatial ops). Runs through the SAME concurrency-limited queue as the
 * plain decode (DESIGN §10 — the CPU pass must never jank the strip when a
 * batch write touches many cells at once).
 *
 * Returns null (caller falls back to the plain preview, zero further work)
 * when: the plan is the identity plan (`plan.steps.length === 0` — buildPlan
 * already resolved every node to a bit-exact pass-through, i.e. the look IS
 * the default — this is also what makes "revert to default" work for free),
 * there are no cached pixels to develop yet, or the plan's active chain
 * contains a step with no CPU mirror (a spatial op — cpuEvalPlan throws,
 * caught here rather than propagated, same never-throw posture as an
 * unparseable look file).
 */
export async function getDevelopAwareThumbnail(path: string, plan: RenderPlan): Promise<string | null> {
  if (plan.steps.length === 0) return null; // identity plan — the look IS the default, zero CPU work (semantics 1/3/5)
  await acquireSlot();
  try {
    const pixels = await getThumbnailPixels(path);
    if (!pixels) return null;
    const { width, height, data } = pixels;
    const out = new Uint8ClampedArray(data.length);
    try {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          // sRGB-DECODE the baked preview sample to approximate linear
          // (NOT gamma-2.2 — srgb.ts's exact piecewise transfer, the engine
          // invariant), run the develop chain's CPU mirror, sRGB-ENCODE back.
          const linear: [number, number, number] = [
            srgbDecode(data[i]! / 255),
            srgbDecode(data[i + 1]! / 255),
            srgbDecode(data[i + 2]! / 255),
          ];
          const developed = cpuEvalPlan(plan, linear, x, y, width, height);
          out[i] = clamp255(srgbEncode(developed[0]) * 255);
          out[i + 1] = clamp255(srgbEncode(developed[1]) * 255);
          out[i + 2] = clamp255(srgbEncode(developed[2]) * 255);
          out[i + 3] = data[i + 3]!; // alpha untouched — never part of the develop chain
        }
      }
    } catch {
      // A spatial op (Detail, spots, a mask-consuming blend, custom WGSL) or
      // an out-of-process step (external/denoise) has no CPU mirror —
      // cpuEvalPlan throws by design (graphDoc.ts's own contract). This
      // direction indicator simply can't mirror it; fall back to the plain
      // preview rather than propagate.
      return null;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(out, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const url = URL.createObjectURL(blob);
    const prev = developCache.get(path);
    developCache.set(path, url);
    if (prev) {
      URL.revokeObjectURL(prev);
      revokedThumbnailUrls.push(prev);
    }
    return url;
  } catch {
    return null;
  } finally {
    releaseSlot();
  }
}
