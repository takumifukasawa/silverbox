/**
 * `<userData>/presets/<slug>.json` — one file per develop preset (task #37).
 *
 * Same atomic-write discipline as writeSidecar (index.ts) / settings.ts:
 * write to a temp file next to the target, rename over it, so a crash
 * mid-save never leaves a truncated preset file. Text-first and
 * git-shareable — a user can copy these between machines or commit them to
 * a repo, same philosophy as sidecars (ROADMAP.md "Presets").
 *
 * The renderer owns all (de)serialization/validation of a preset's actual
 * shape (presetVersion/name/createdAt/look — see
 * engine/graph/presetDoc.ts, which reuses serializeGraphDoc/parseGraphDoc
 * for the `look` payload); this module only touches the filesystem, plus
 * the minimal structural check needed so ONE malformed file can never break
 * `listPresets()` for every other preset — it is skipped (console.warn) and
 * left untouched on disk, never crashing the list.
 */
import { app } from 'electron';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PresetSummary } from '../../shared/ipc';

function presetsDir(): string {
  return join(app.getPath('userData'), 'presets');
}

/** Filenames are `<slug>.json`; the renderer sanitizes the slug before ever calling here — this just refuses to let a bad value escape the presets dir. */
function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug === '' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error('preset slug must be a non-empty string of letters/digits/_/-');
  }
  return slug;
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmpDir = await mkdtemp(join(dir, '.silverbox-save-'));
  const tmpFile = join(tmpDir, 'preset.json');
  try {
    await writeFile(tmpFile, content, 'utf8');
    await rename(tmpFile, target);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * List every `*.json` in the presets dir that parses to at least
 * `{ name: string }`; anything else (invalid JSON, non-object, missing
 * name) is skipped with a console.warn — the file itself is never touched,
 * so a hand-edited/corrupted file doesn't lose data, it just doesn't show
 * up until it's fixed. Missing directory (nothing saved yet) is an empty
 * list, not an error.
 */
export async function listPresets(): Promise<PresetSummary[]> {
  const dir = presetsDir();
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
        throw new Error('preset file must be an object with a string name');
      }
      const name = (raw as Record<string, unknown>).name as string;
      const createdAtRaw = (raw as Record<string, unknown>).createdAt;
      result.push({ slug, name, createdAt: typeof createdAtRaw === 'string' ? createdAtRaw : '' });
    } catch (err) {
      console.warn(`skipping malformed preset file ${entry}:`, err);
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Read one preset's raw JSON text; null if it doesn't exist. */
export async function readPreset(slug: unknown): Promise<string | null> {
  const safeSlug = assertSlug(slug);
  try {
    return await readFile(join(presetsDir(), `${safeSlug}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write (create or overwrite) one preset's raw JSON text. */
export async function writePreset(slug: unknown, content: unknown): Promise<void> {
  const safeSlug = assertSlug(slug);
  if (typeof content !== 'string') throw new Error('writePreset: content must be a string');
  await atomicWriteFile(join(presetsDir(), `${safeSlug}.json`), content);
}

/** Delete one preset file; a no-op if it's already gone. */
export async function deletePreset(slug: unknown): Promise<void> {
  const safeSlug = assertSlug(slug);
  try {
    await unlink(join(presetsDir(), `${safeSlug}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
