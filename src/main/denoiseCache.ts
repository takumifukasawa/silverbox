/**
 * On-disk cache for in-engine ML denoise (denoise v2, stage 1):
 * `<userData>/denoise-cache/<cacheKey>.bin` — a bounded LRU (mtime-ordered),
 * same shape as v1's external-tool node cache (src/main/externalCache.ts),
 * minus the `encoded` flag (denoise ALWAYS runs on sRGB-encoded pixels, see
 * shared/ipc.ts's DenoiseRunRequest doc comment — there is no linear mode to
 * distinguish). `cacheKey` already folds in the input-pixel hash, the pinned
 * model's sha256, and the node id (see graphRenderer.ts's checkDenoiseNodes)
 * — deliberately EXCLUDING strength, since the cached payload is always the
 * FULL-STRENGTH inference result; the interactive strength blend happens
 * GPU-side at re-entry (cheap enough to redo per render).
 *
 * This is the on-disk half of the brief's "two-tier" cache; the other tier
 * is the renderer's own in-memory GPU-texture LRU (graphRenderer.ts's
 * `denoiseResultTextures`, mirroring `externalResultTextures`) — a hit there
 * never even reaches this module or an IPC call. A hit HERE still skips the
 * (expensive, seconds-to-minutes) ORT re-inference entirely.
 */
import { app } from 'electron';
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Total on-disk budget before oldest-mtime eviction — same figure and rationale as externalCache.ts's own budget (a Lightroom-calibration-adjacent constant, not derived from a formula): denoise results are the same order of magnitude (full-resolution RGBA float32 frames). */
const DENOISE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

const HEADER_BYTES = 8; // width:u32, height:u32

function cacheDir(): string {
  return join(app.getPath('userData'), 'denoise-cache');
}

function entryPath(cacheKey: string): string {
  // cacheKey is always our own hex sha256 (see graphRenderer.ts's checkDenoiseNodes) — never untrusted-path-shaped, but guard anyway (same discipline as externalCache.ts's entryPath) so a corrupt/foreign key can never be coerced into a path-traversal write.
  const safe = /^[0-9a-f]{16,128}$/i.test(cacheKey) ? cacheKey : Buffer.from(cacheKey).toString('hex');
  return join(cacheDir(), `${safe}.bin`);
}

export interface CachedDenoiseResult {
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** Read a cached result, if present and shape-consistent with `width`/`height`; touches mtime (LRU recency) on a hit. */
export async function readDenoiseCache(cacheKey: string, width: number, height: number): Promise<CachedDenoiseResult | null> {
  const path = entryPath(cacheKey);
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  if (buf.byteLength < HEADER_BYTES) return null;
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  if (w !== width || h !== height) return null;
  const expected = HEADER_BYTES + width * height * 4 * 4;
  if (buf.byteLength !== expected) return null;
  const now = new Date();
  await utimes(path, now, now).catch(() => {}); // best-effort LRU touch
  const slice = buf.subarray(HEADER_BYTES);
  const data = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
  return { width, height, data };
}

/** Write a fresh result, then sweep the directory down to DENOISE_CACHE_MAX_BYTES (oldest mtime first) if needed. */
export async function writeDenoiseCache(cacheKey: string, width: number, height: number, data: ArrayBuffer): Promise<void> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  await writeFile(entryPath(cacheKey), Buffer.concat([header, Buffer.from(data)]));
  await evictIfOverBudget(dir);
}

async function evictIfOverBudget(dir: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.bin'));
  } catch {
    return;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return { name, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const live = entries.filter((e): e is NonNullable<typeof e> => e !== null);
  let total = live.reduce((sum, e) => sum + e.size, 0);
  if (total <= DENOISE_CACHE_MAX_BYTES) return;
  live.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of live) {
    if (total <= DENOISE_CACHE_MAX_BYTES) break;
    try {
      await unlink(join(dir, e.name));
      total -= e.size;
    } catch {
      // best-effort eviction; a stubborn file just means the budget is exceeded a little longer, never a correctness issue
    }
  }
}
