/**
 * The library + `<userData>/presets/<slug>.json` — one file per develop
 * preset (task #37), now DUAL-LOCATION (docs/brief-bank/
 * linked-looks-stage-e.md): reads are the union of the visible library
 * (`settings.libraryDir`, library wins on a slug collision) and the legacy
 * `<userData>/presets` dir forever (compat rule 9); writes (save/update/
 * delete) go to the library ONLY. `migrateLegacyPresetsIfNeeded` is the
 * one-time copy that seeds the library from whatever already existed in
 * userData — originals are NEVER deleted by it.
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
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PresetSummary } from '../../shared/ipc';
import { readSettings } from './settings';

/** The visible library dir (`settings.libraryDir`) — resolved fresh on every call via readSettings' own in-memory cache, so a settings.json edit takes effect on the very next read/write. */
async function libraryDir(): Promise<string> {
  const settings = await readSettings();
  return settings.libraryDir;
}

/** The pre-library storage location, kept readable forever (compat rule 9) but never written to again. */
function legacyPresetsDir(): string {
  return join(app.getPath('userData'), 'presets');
}

/** Sentinel marking "the one-time legacy→library copy already ran for THIS library dir" — a library the user re-points `settings.libraryDir` at gets its own independent migration. */
const MIGRATION_MARKER = '.migrated-presets';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * One-time migration (linked-looks-stage-e.md semantic 2): COPY every
 * `<userData>/presets/*.json` into the library the first run that ever sees
 * this library dir (no marker yet) — originals are LEFT IN PLACE, never
 * deleted, and a slug already present in the library (a previous partial
 * run, or a library the user seeded by hand) is never overwritten. Also
 * satisfies semantic 8 (the app creates `~/Silverbox/Library/` on first
 * use, mkdir -p) even when there is nothing to migrate. Called once at app
 * boot (main/index.ts); idempotent — a second call is a cheap marker-file
 * stat and returns immediately.
 */
export async function migrateLegacyPresetsIfNeeded(): Promise<void> {
  const dir = await libraryDir();
  if (await pathExists(join(dir, MIGRATION_MARKER))) return;
  await mkdir(dir, { recursive: true });
  let legacyEntries: string[] = [];
  try {
    legacyEntries = await readdir(legacyPresetsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const entry of legacyEntries) {
    if (!entry.endsWith('.json')) continue;
    const dest = join(dir, entry);
    if (await pathExists(dest)) continue; // never overwrite an existing library file
    await copyFile(join(legacyPresetsDir(), entry), dest);
  }
  await writeFile(join(dir, MIGRATION_MARKER), '', 'utf8');
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
 * List every `*.json` in one dir that parses to at least `{ name: string }`;
 * anything else (invalid JSON, non-object, missing name) is skipped with a
 * console.warn — the file itself is never touched, so a hand-edited/
 * corrupted file doesn't lose data, it just doesn't show up until it's
 * fixed. Missing directory (nothing saved there yet) is an empty list, not
 * an error. Shared by listPresets' two locations below.
 */
async function listDir(dir: string): Promise<PresetSummary[]> {
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
  return result;
}

/**
 * List every preset/library-template summary — the UNION of the library and
 * the legacy `<userData>/presets` dir (stage-e semantic 2), library winning
 * on a slug collision (a `Map` keyed by slug, library entries applied
 * second so they overwrite any same-slug legacy entry).
 */
export async function listPresets(): Promise<PresetSummary[]> {
  const [legacyList, libraryList] = await Promise.all([listDir(legacyPresetsDir()), listDir(await libraryDir())]);
  const bySlug = new Map<string, PresetSummary>();
  for (const p of legacyList) bySlug.set(p.slug, p);
  for (const p of libraryList) bySlug.set(p.slug, p); // library wins
  const result = Array.from(bySlug.values());
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Read one preset's raw JSON text — library first, then the legacy dir (stage-e semantic 2); null if it exists in neither. */
export async function readPreset(slug: unknown): Promise<string | null> {
  const safeSlug = assertSlug(slug);
  try {
    return await readFile(join(await libraryDir(), `${safeSlug}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    return await readFile(join(legacyPresetsDir(), `${safeSlug}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write (create or overwrite) one preset's raw JSON text — ALWAYS to the library (stage-e semantic 2: writes go to the new location only). */
export async function writePreset(slug: unknown, content: unknown): Promise<void> {
  const safeSlug = assertSlug(slug);
  if (typeof content !== 'string') throw new Error('writePreset: content must be a string');
  await atomicWriteFile(join(await libraryDir(), `${safeSlug}.json`), content);
}

/**
 * Delete one preset's file(s); a no-op if it's already gone everywhere.
 * Deletes whichever copies actually exist for this slug — the library's
 * (the normal case: "writes go to the library only" extends to deletes) AND
 * the legacy dir's, if a migrated duplicate also happens to sit there (so
 * deleting a post-migration preset doesn't leave its legacy twin to
 * resurrect it in the next listPresets() union). A slug that only ever
 * existed in the legacy dir (never migrated/saved-over) has its delete
 * land there — its only copy, per the brief's explicit carve-out.
 */
export async function deletePreset(slug: unknown): Promise<void> {
  const safeSlug = assertSlug(slug);
  const unlinkIfPresent = async (path: string): Promise<void> => {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };
  await Promise.all([
    unlinkIfPresent(join(await libraryDir(), `${safeSlug}.json`)),
    unlinkIfPresent(join(legacyPresetsDir(), `${safeSlug}.json`)),
  ]);
}
