/**
 * `<projectDir>/repair-sheets/<slug>.json` — one file per repair sheet
 * (ゴミ取りセット; docs/brief-bank/linked-looks-stage-f.md semantic 1). A sheet
 * is a named set of spots in PHYSICAL SENSOR PIXELS with its own tiny schema
 * (repairSheetDoc.ts parses/serializes it; this module only touches bytes) —
 * NOT a develop look, so it lives in its own dir, not shared-looks/.
 *
 * sharedLooks.ts's exact twin: PROJECT-scoped (a `dir` argument on every call),
 * same atomic-write discipline (temp file next to the target, rename over it,
 * so a crash mid-save never leaves a truncated sheet). Deliberately NO watcher
 * / hot-reload channel — a repair sheet is make-and-discard (parent spec §5),
 * never followed, so there is nothing to react to when one changes on disk.
 *
 * Project-local only, no library, EVER (parent spec §5).
 */
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PresetSummary } from '../../shared/ipc';

const REPAIR_SHEETS_DIRNAME = 'repair-sheets';

function repairSheetsDir(projectDir: string): string {
  return join(projectDir, REPAIR_SHEETS_DIRNAME);
}

/** Filenames are `<slug>.json`; the renderer sanitizes the slug before calling here — this just refuses to let a bad value escape the repair-sheets dir. */
function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug === '' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error('repair sheet slug must be a non-empty string of letters/digits/_/-');
  }
  return slug;
}

function assertProjectDir(dir: unknown): string {
  if (typeof dir !== 'string' || dir === '') throw new Error('repair sheet: projectDir must be a non-empty string');
  return dir;
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmpDir = await mkdtemp(join(dir, '.silverbox-save-'));
  const tmpFile = join(tmpDir, 'repair-sheet.json');
  try {
    await writeFile(tmpFile, content, 'utf8');
    await rename(tmpFile, target);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * List every `*.json` in `<projectDir>/repair-sheets/` that parses to at least
 * `{ name: string }`; anything else is skipped with a console.warn (never
 * crashes the list, never touches the bad file) — same convention as
 * listSharedLooks. Missing directory (no sheet created yet) is an empty list.
 */
export async function listRepairSheets(projectDir: unknown): Promise<PresetSummary[]> {
  const dir = repairSheetsDir(assertProjectDir(projectDir));
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
        throw new Error('repair sheet file must be an object with a string name');
      }
      const name = (raw as Record<string, unknown>).name as string;
      const createdAtRaw = (raw as Record<string, unknown>).createdAt;
      result.push({ slug, name, createdAt: typeof createdAtRaw === 'string' ? createdAtRaw : '' });
    } catch (err) {
      console.warn(`skipping malformed repair sheet file ${entry}:`, err);
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Read one repair sheet's raw JSON text; null if it doesn't exist. */
export async function readRepairSheet(projectDir: unknown, slug: unknown): Promise<string | null> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  try {
    return await readFile(join(repairSheetsDir(dir), `${safeSlug}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write (create or overwrite) one repair sheet's raw JSON text. */
export async function writeRepairSheet(projectDir: unknown, slug: unknown, content: unknown): Promise<void> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  if (typeof content !== 'string') throw new Error('writeRepairSheet: content must be a string');
  await atomicWriteFile(join(repairSheetsDir(dir), `${safeSlug}.json`), content);
}

/** Delete one repair sheet's file; a no-op if it's already gone (sheets are make-and-discard, no undo — semantic 8). */
export async function deleteRepairSheet(projectDir: unknown, slug: unknown): Promise<void> {
  const dir = assertProjectDir(projectDir);
  const safeSlug = assertSlug(slug);
  try {
    await unlink(join(repairSheetsDir(dir), `${safeSlug}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
