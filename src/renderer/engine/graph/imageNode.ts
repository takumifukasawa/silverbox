/**
 * Image node (composite/mask-by-another-file feature): a zero-input SOURCE
 * node — like 'input', but referencing a SECOND file by path instead of the
 * currently-open image. Typical wiring: feed a blend's 'b' port (composite
 * with another file) or a blend's 'mask' port (use an arbitrary image as a
 * mask, read via `.r`) — see graphDoc.ts's buildPlan for how a zero-input
 * source node slots into `resolve()` (alongside 'input', which returns -1
 * directly instead of pushing a PlanStep; 'image' DOES push a step, since
 * -1 is reserved for the decoded MAIN image).
 *
 * Decode/caching lives OUTSIDE this file (imageNodeSource.ts, main-thread
 * only + renderWorker.ts's per-path GPU texture cache) — this module is just
 * the doc-shape (params/sanitizer) and the two tiny path helpers every one
 * of those call sites needs: `resolveImagePath` (relative-to-sidecar
 * resolution) and `imageBaseName` (node label / Inspector filename).
 *
 * v1 accepts only an absolute path from the UI's "Choose…" dialog; a
 * relative path is also ACCEPTED on parse (hand-authored sidecars, and the
 * planned repo-portability upgrade) and resolved against the sidecar's own
 * directory — see resolveImagePath.
 */

export const IMAGE_KIND = 'image';

export interface ImageParams {
  /** Absolute (v1 UI) or sidecar-relative (accepted on parse) path to the referenced file. Empty = no file chosen yet ⇒ solid mid-gray output. */
  path: string;
}

export function defaultImageParams(): ImageParams {
  return { path: '' };
}

/**
 * Normalize an untrusted image payload; missing/malformed ⇒ `path: ''` (the
 * identity-ish "no file chosen" default — gray output, not a hard error),
 * same quiet-fallback convention sanitizeRating uses rather than throwing
 * (a bad/missing image param must never take an otherwise-good sidecar
 * down with it).
 */
export function sanitizeImageParams(raw: unknown, _nodeId: string): ImageParams {
  if (typeof raw !== 'object' || raw === null) return defaultImageParams();
  const src = raw as { path?: unknown };
  return { path: typeof src.path === 'string' ? src.path : '' };
}

/** Basename of a path (last '/'-separated segment) — node label / Inspector filename display. Empty/no-slash path passes through unchanged. */
export function imageBaseName(path: string): string {
  if (path === '') return path;
  const base = path.split('/').pop();
  return base && base.length > 0 ? base : path;
}

/** Directory of a path (everything before the last '/'), or '' when there is none — used to resolve a relative image-node path against the sidecar's own directory. */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/**
 * Resolve a stored image-node path against the sidecar's directory: an
 * empty path (no file chosen) and an ABSOLUTE path (v1 UI's "Choose…"
 * dialog always writes one) pass through unchanged; anything else
 * (hand-authored relative path) resolves against `sidecarDir` — the
 * planned repo-portability upgrade the file doc comment mentions. Falls
 * back to the raw path when `sidecarDir` is unavailable (dimensionless
 * validation callers, same "can't resolve, leave as-is" shape
 * graphDoc.ts's migrateCoordsToAnchor uses for missing srcDims).
 */
export function resolveImagePath(path: string, sidecarDir: string | null): string {
  if (path === '' || path.startsWith('/') || !sidecarDir) return path;
  return `${sidecarDir}/${path}`;
}
