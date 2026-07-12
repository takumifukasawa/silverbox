/**
 * On-disk cache for the external-tool hook node (denoise v1, task #41):
 * `<userData>/external-cache/<cacheKey>.bin` — a bounded LRU (mtime-ordered)
 * so a result survives across app restarts without growing forever. The
 * renderer keeps its OWN in-memory LRU of decoded GPU textures (see
 * graphRenderer.ts's `externalResultTextures`) — this is the SECOND, slower
 * tier: a cache MISS there but a HIT here still skips spawning the
 * subprocess (externalTool.ts checks this before running the command).
 *
 * File format: a tiny fixed header (width, height, encoded — all uint32) so
 * a read can sanity-check against the CALLER's own request before trusting
 * the payload, followed by tightly-packed RGBA float32 pixels — the exact
 * bytes externalTool.ts hands back to the renderer on both a hit and a fresh
 * run, so the two code paths converge to one return shape.
 */
import { app } from 'electron';
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Total on-disk budget before the oldest (by mtime) entries get evicted — a Lightroom-calibration-adjacent constant, not derived from any formula. */
const EXTERNAL_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

const HEADER_BYTES = 12; // width:u32, height:u32, encoded:u32 (0/1)

function cacheDir(): string {
  return join(app.getPath('userData'), 'external-cache');
}

function entryPath(cacheKey: string): string {
  // cacheKey is always our own hex sha256 (see externalNode hashing) — never
  // untrusted-path-shaped, but guard anyway so a corrupt/foreign key can
  // never be coerced into a path-traversal write.
  const safe = /^[0-9a-f]{16,128}$/i.test(cacheKey) ? cacheKey : Buffer.from(cacheKey).toString('hex');
  return join(cacheDir(), `${safe}.bin`);
}

export interface CachedExternalResult {
  width: number;
  height: number;
  encoded: boolean;
  data: ArrayBuffer;
}

/** Read a cached result, if present and shape-consistent with `width`/`height`/`encoded`; touches mtime (LRU recency) on a hit. */
export async function readExternalCache(
  cacheKey: string,
  width: number,
  height: number,
  encoded: boolean
): Promise<CachedExternalResult | null> {
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
  const enc = buf.readUInt32LE(8) === 1;
  if (w !== width || h !== height || enc !== encoded) return null;
  const expected = HEADER_BYTES + width * height * 4 * 4;
  if (buf.byteLength !== expected) return null;
  const now = new Date();
  await utimes(path, now, now).catch(() => {}); // best-effort LRU touch; a failure here just means slightly-off eviction order, never a correctness issue
  const slice = buf.subarray(HEADER_BYTES);
  const data = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
  return { width, height, encoded, data };
}

/** Write a fresh result, then sweep the directory down to EXTERNAL_CACHE_MAX_BYTES (oldest mtime first) if needed. */
export async function writeExternalCache(
  cacheKey: string,
  width: number,
  height: number,
  encoded: boolean,
  data: ArrayBuffer
): Promise<void> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  header.writeUInt32LE(encoded ? 1 : 0, 8);
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
  if (total <= EXTERNAL_CACHE_MAX_BYTES) return;
  // Oldest mtime first (least-recently-used/written) — reads touch mtime too
  // (see readExternalCache), so a frequently-reused entry survives longer.
  live.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of live) {
    if (total <= EXTERNAL_CACHE_MAX_BYTES) break;
    try {
      await unlink(join(dir, e.name));
      total -= e.size;
    } catch {
      // best-effort eviction; a stubborn file just means the budget is
      // exceeded a little longer, never a correctness issue
    }
  }
}
