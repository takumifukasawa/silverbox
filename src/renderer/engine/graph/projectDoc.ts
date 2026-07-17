/**
 * ProjectDoc: the JSON-serializable project manifest (`project.silverbox` —
 * docs/brief-bank/project-storage.md). This is the ONE place a Silverbox
 * document lives now: a project owns a directory (`looks/` for per-photo
 * looks, see graphDoc.ts's `photo` wrapper field) plus this manifest, which
 * is just a name and a playlist (photo path → look filename). Same
 * parser/sanitizer conventions as graphDoc.ts: structural garbage throws,
 * unknown wrapper-level keys round-trip verbatim (DESIGN §9), and every path
 * helper here is a pure function — no Electron/main dependency, since the
 * renderer has no `node:path` (contextIsolation keeps node out of this
 * process; see resolveImagePath/dirnameOf in imageNode.ts for the same
 * manual-split precedent).
 */

export const PROJECT_SCHEMA_VERSION = 1;

/** One playlist row: a photo and the look filename that holds its develop history. */
export interface ProjectPhoto {
  /** Photo location — relative to the project dir when the photo lives INSIDE it, absolute when it doesn't (see relativizeProjectPath); resolve with resolveProjectPath, which also still accepts an older `../`-style relative path written before this policy. */
  path: string;
  /** Filename inside `looks/` (see deriveLookName) — a bare filename, never a path. */
  look: string;
}

export interface ProjectManifest {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  name: string;
  photos: ProjectPhoto[];
  /** Unrecognized wrapper-level keys (DESIGN §9 passthrough) — round-tripped verbatim by serializeProjectManifest. */
  unknown?: Record<string, unknown>;
}

/** Wrapper-level keys serializeProjectManifest/parseProjectManifest know about; anything else round-trips verbatim (DESIGN §9), same convention as graphDoc.ts's KNOWN_WRAPPER_KEYS. */
const KNOWN_PROJECT_KEYS = new Set(['schemaVersion', 'name', 'photos']);

/** A brand-new, empty project (the quick project's first-ever open, or "New project…" once that UI exists). */
export function defaultProjectManifest(name: string): ProjectManifest {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, name, photos: [] };
}

/** Serialize a manifest for `project.silverbox` — pretty-printed and newline-terminated for git, same convention as serializeGraphDoc. Unknown wrapper keys are spread first so known keys win on conflict. */
export function serializeProjectManifest(manifest: ProjectManifest): string {
  const wrapper = {
    ...(manifest.unknown ?? {}),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: manifest.name,
    photos: manifest.photos.map((p) => ({ path: p.path, look: p.look })),
  };
  return JSON.stringify(wrapper, null, 2) + '\n';
}

/**
 * Parse + validate a project manifest; throws with a reason on anything
 * malformed (structural garbage — same policy as parseGraphDoc, NOT the
 * quiet-fallback policy sanitizeRating uses, since a manifest is the whole
 * project's identity, not one lenient field). Unrecognized wrapper keys are
 * preserved on the returned `unknown` so a rewrite round-trips them verbatim.
 */
export function parseProjectManifest(text: string): ProjectManifest {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('project manifest must be an object');
  const wrapper = raw as Record<string, unknown>;
  if (wrapper.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`unsupported project schemaVersion ${String(wrapper.schemaVersion)}`);
  }
  if (typeof wrapper.name !== 'string' || wrapper.name.trim() === '') {
    throw new Error('project manifest needs a non-empty name');
  }
  const rawPhotos = wrapper.photos;
  if (!Array.isArray(rawPhotos)) throw new Error('project manifest needs a photos array');
  const photos: ProjectPhoto[] = rawPhotos.map((p: unknown, i: number) => {
    if (typeof p !== 'object' || p === null) throw new Error(`photos[${i}] must be an object`);
    const rec = p as Record<string, unknown>;
    if (typeof rec.path !== 'string' || rec.path.trim() === '') {
      throw new Error(`photos[${i}].path must be a non-empty string`);
    }
    if (typeof rec.look !== 'string' || rec.look.trim() === '') {
      throw new Error(`photos[${i}].look must be a non-empty string`);
    }
    return { path: rec.path, look: rec.look };
  });
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wrapper)) {
    if (!KNOWN_PROJECT_KEYS.has(k)) unknown[k] = v;
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: wrapper.name,
    photos,
    ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
  };
}

/** Basename of a POSIX path (last '/'-separated segment) — same manual-split convention as imageNode.ts's imageBaseName (the renderer has no node:path). */
function basenameOf(path: string): string {
  const base = path.split('/').pop();
  return base && base.length > 0 ? base : path;
}

/**
 * Derive the `looks/` filename for a photo whose ABSOLUTE path is
 * `photoAbsPath`: `basename + '.json'`, suffixed `-2`, `-3`… when that name
 * is already taken by a DIFFERENT photo. `existingByAbsPath` maps every
 * OTHER playlist entry's already-resolved absolute path to its current look
 * filename — callers resolve project.photos against the project dir before
 * calling this (see appStore.ts's ensureProjectAndAddPhoto/openFolder),
 * keeping this function itself free of any project-dir/relative-path
 * knowledge. Only ever called for a photo NOT already in the map (an
 * already-present photo just reuses its existing look — see callers).
 */
export function deriveLookName(photoAbsPath: string, existingByAbsPath: Map<string, string>): string {
  const stem = basenameOf(photoAbsPath);
  const takenByOther = (name: string): boolean => {
    for (const [otherPath, look] of existingByAbsPath) {
      if (look === name && otherPath !== photoAbsPath) return true;
    }
    return false;
  };
  const base = `${stem}.json`;
  if (!takenByOther(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}.json`;
    if (!takenByOther(candidate)) return candidate;
  }
}

function splitPosix(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Resolve a playlist/look `photo` path against the project dir: an absolute
 * path (an out-of-tree photo) passes through unchanged; a relative path
 * (the common case, e.g. `"../photos/DSC001.ARW"`) resolves against
 * `projectDir`, `.`/`..` segments and all. `projectDir` itself is always
 * absolute (the quick project's settings-derived path, or a user-chosen
 * project directory).
 */
export function resolveProjectPath(projectDir: string, path: string): string {
  if (path.startsWith('/')) return path;
  const parts = splitPosix(projectDir);
  for (const seg of splitPosix(path)) {
    if (seg === '.') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/**
 * Inverse of resolveProjectPath: express `absPath` relative to `projectDir`
 * when — and only when — `absPath` lives INSIDE `projectDir` (never escapes
 * it via `..`); an out-of-tree photo is stored ABSOLUTE instead (NG fix
 * pack, project-storage path policy: a `../../Documents/…`-style relative
 * path is fragile the moment the project folder itself moves, since every
 * `..` is counted from the project dir's OWN location, not the photo's — an
 * absolute path has no such dependency). Always forward slashes (POSIX
 * throughout — the renderer has no `node:path`). Falls back to `absPath`
 * unchanged when either side isn't absolute (not this app's supported
 * platform shape, but a safe no-op either way).
 *
 * `resolveProjectPath` (above) is unaffected and deliberately still accepts
 * a `..`-relative `path` — this is a WRITE-side policy change only; a
 * manifest written by an older Silverbox (or hand-authored with `../`) keeps
 * resolving exactly as before (read-side compat, docs/sidecar-spec.md §2).
 */
export function relativizeProjectPath(projectDir: string, absPath: string): string {
  if (!projectDir.startsWith('/') || !absPath.startsWith('/')) return absPath;
  const dirParts = splitPosix(projectDir);
  const fileParts = splitPosix(absPath);
  let common = 0;
  while (common < dirParts.length && common < fileParts.length && dirParts[common] === fileParts[common]) common++;
  if (common < dirParts.length) return absPath; // escapes projectDir — store absolute, not a fragile ../..
  const rel = fileParts.slice(common).join('/');
  return rel.length > 0 ? rel : '.';
}
