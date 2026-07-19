/**
 * `<projectDir>/shared-looks/<slug>.json` — one file per shared look
 * (docs/brief-bank/linked-looks-stage-b.md, per the parent spec's §4.1: the
 * shared look is the EXISTING preset file format, name+includes+graph —
 * presetDoc.ts parses/serializes it, this module only touches bytes). Same
 * atomic-write discipline as presets.ts/writeSidecar — write to a temp file
 * next to the target, rename over it, so a crash mid-save never leaves a
 * truncated look file.
 *
 * Deliberately PROJECT-scoped (a `dir` argument on every call), unlike
 * presets.ts's global `<userData>/presets/` — a shared look lives INSIDE the
 * project folder (parent spec §4.5: following never crosses the project
 * boundary; git-managed projects carry the look + link relationships in
 * full). This module is otherwise presets.ts's twin; kept as a separate file
 * rather than parameterizing presets.ts because the two dirs' identities
 * (global vs. per-project) are different enough concepts to want their own
 * doc comments and IPC channels (see shared/ipc.ts's sharedLooks* entries).
 */
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PresetSummary } from '../../shared/ipc';

const SHARED_LOOKS_DIRNAME = 'shared-looks';

function sharedLooksDir(projectDir: string): string {
  return join(projectDir, SHARED_LOOKS_DIRNAME);
}

/** Filenames are `<slug>.json`; the renderer sanitizes the slug before ever calling here — this just refuses to let a bad value escape the shared-looks dir. */
function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug === '' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error('shared look slug must be a non-empty string of letters/digits/_/-');
  }
  return slug;
}

function assertProjectDir(dir: unknown): string {
  if (typeof dir !== 'string' || dir === '') throw new Error('shared look: projectDir must be a non-empty string');
  return dir;
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmpDir = await mkdtemp(join(dir, '.silverbox-save-'));
  const tmpFile = join(tmpDir, 'shared-look.json');
  try {
    await writeFile(tmpFile, content, 'utf8');
    await rename(tmpFile, target);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * List every `*.json` in `<projectDir>/shared-looks/` that parses to at
 * least `{ name: string }`; anything else (invalid JSON, non-object,
 * missing name) is skipped with a console.warn — same "never crashes the
 * list, never touches the bad file" convention as presets.ts's listPresets.
 * Missing directory (no shared look created yet) is an empty list.
 */
export async function listSharedLooks(projectDir: unknown): Promise<PresetSummary[]> {
  const dir = sharedLooksDir(assertProjectDir(projectDir));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const result: PresetSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const slug = entry.slice(0, -'.json'.length);
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, entry), 'utf8'));
      if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).name !== 'string') {
        throw new Error('shared look file must be an object with a string name');
      }
      const name = (raw as Record<string, unknown>).name as string;
      const createdAtRaw = (raw as Record<string, unknown>).createdAt;
      result.push({ slug, name, createdAt: typeof createdAtRaw === 'string' ? createdAtRaw : '' });
    } catch (err) {
      console.warn(`skipping malformed shared look file ${entry}:`, err);
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Read one shared look's raw JSON text; null if it doesn't exist. */
export async function readSharedLook(projectDir: unknown, slug: unknown): Promise<string | null> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  try {
    return await readFile(join(sharedLooksDir(dir), `${safeSlug}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write (create or overwrite) one shared look's raw JSON text. */
export async function writeSharedLook(projectDir: unknown, slug: unknown, content: unknown): Promise<void> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  if (typeof content !== 'string') throw new Error('writeSharedLook: content must be a string');
  await atomicWriteFile(join(sharedLooksDir(dir), `${safeSlug}.json`), content);
}

/** Delete one shared look's file; a no-op if it's already gone. */
export async function deleteSharedLook(projectDir: unknown, slug: unknown): Promise<void> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  try {
    await unlink(join(sharedLooksDir(dir), `${safeSlug}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
