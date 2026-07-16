import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, extname } from 'node:path';
import {
  IPC,
  PROJECT_MANIFEST_NAME,
  SIDECAR_SUFFIX,
  type CliCheckImageRequest,
  type CliCheckOutcome,
  type CliDiffImageRequest,
  type CliDiffImageResult,
  type CliProgressResult,
  type ExportEncodeRequest,
  type ExportEncodeResult,
  type ExportLutRequest,
  type ExportLutResult,
  type ExternalToolRequest,
  type ExternalToolResult,
  type DenoiseRunRequest,
  type DenoiseRunResult,
  type FolderImageEntry,
  type OpenImageDialogResult,
  type PingResult,
  type PresetSummary,
  type Settings,
} from '../../shared/ipc';
import { CLI_USAGE, buildCliJob, formatCliProgress, parseCliArgs } from './cliArgs';
import { diffRenderImages } from './diffRender';
import { denoiseRunCount, runDenoise } from './denoise';
import { externalToolSpawnCount, runExternalTool } from './externalTool';
import { checkGoldenImage } from './goldenRender';
import { encodeExport } from './imageExport';
import { encodeLutExport } from './lutExport';
import { deletePreset, listPresets, readPreset, writePreset } from './presets';
import { readSettings, updateSettings } from './settings';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw', 'x3f', 'jpg', 'jpeg'];

/** Round-9 fix pack item 4: the Image node's own "Choose…" picker additionally offers PNG (createImageBitmap already decodes it — see decodeWorker.ts's prepareJpeg); the MAIN photo-open dialog below stays on IMAGE_EXTENSIONS unchanged. */
const IMAGE_NODE_EXTENSIONS = [...IMAGE_EXTENSIONS, 'png'];

/**
 * Headless CLI renderer: `electron . --render <args>` (see bin/silverbox-render
 * and the "render" npm script) — everything after `--render` is the CLI's
 * own argv, parsed in ./cliArgs. Detected from raw process.argv (before
 * Electron/Chromium have stripped their own flags) so this decision is made
 * BEFORE any window gets created.
 */
const RENDER_FLAG_INDEX = process.argv.indexOf('--render');
const isCliRenderMode = RENDER_FLAG_INDEX !== -1;
const cliArgv = isCliRenderMode ? process.argv.slice(RENDER_FLAG_INDEX + 1) : [];

/**
 * Best-effort star-rating extraction from a sidecar's raw JSON text (ratings
 * pack) — never throws: malformed JSON, a missing `rating` key, or an
 * out-of-range/non-numeric value all sanitize quietly to 0 (unrated). This
 * is deliberately NOT the renderer's full parseGraphDoc/graphDoc.ts (that
 * module pulls in the whole engine graph — ops, Develop, custom shaders —
 * and throws on anything its own schema migration doesn't understand);
 * listImages needs exactly one wrapper-level number, cheaply, for every file
 * in a folder, so it stays a tiny standalone JSON.parse here in main instead
 * of importing renderer code into the main process.
 */
function extractSidecarRating(raw: string): number {
  try {
    const wrapper = JSON.parse(raw) as { rating?: unknown };
    const r = wrapper.rating;
    if (typeof r !== 'number' || !Number.isFinite(r)) return 0;
    return Math.min(5, Math.max(0, Math.round(r)));
  } catch {
    return 0;
  }
}

/**
 * Cheap content fingerprint of a photo file (project-storage migration,
 * stage 3 — docs/brief-bank/project-storage.md's "Missing photos" section):
 * used by relink to verify a candidate replacement is (probably) the SAME
 * photo, without hashing the whole multi-tens-of-MB RAW file.
 *
 * STABILITY CONTRACT — this recipe must never change once shipped, since a
 * look's stored `fingerprint` (SidecarDoc.fingerprint) is compared against a
 * FRESH computation of this same function on a relink candidate; changing
 * the recipe would silently break every fingerprint ever written. The exact
 * byte layout hashed (SHA-256, lowercase hex digest):
 *
 *   1. the file's size in bytes, as an 8-byte little-endian unsigned integer
 *   2. the file's first min(65536, size) bytes
 *   3. the file's last min(65536, size) bytes
 *
 * For a file smaller than 128KB, (2) and (3) overlap (or are identical) —
 * that's fine, the recipe is still fully deterministic given the file's
 * bytes, which is all that matters (no different file could ever produce
 * the same head/tail/size triple by accident any more than a whole-file hash
 * could). Reading only the head+tail (not the whole file) keeps this cheap
 * even for a 60MB+ ARW.
 */
async function computeFingerprint(path: string): Promise<string> {
  const st = await stat(path);
  const size = st.size;
  const headLen = Math.min(65536, size);
  const tailLen = Math.min(65536, size);
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(headLen);
    if (headLen > 0) await handle.read(head, 0, headLen, 0);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) await handle.read(tail, 0, tailLen, size - tailLen);
    const sizePrefix = Buffer.alloc(8);
    sizePrefix.writeBigUInt64LE(BigInt(size));
    const hash = createHash('sha256');
    hash.update(sizePrefix);
    hash.update(head);
    hash.update(tail);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/** True when `path`'s containing directory is literally named `looks` — the one shape a project look file ever has (`<projectDir>/looks/<name>.json`). */
function isProjectLookPath(path: string): boolean {
  return path.endsWith('.json') && basename(dirname(path)) === 'looks';
}

/**
 * Validate a path handed to readSidecar/writeSidecar (project-storage
 * migration, stage 1). READS accept either shape: a legacy adjacent sidecar
 * (`<image>.silverbox.json`, kept readable forever — principle 9 — for old
 * documents and the CLI's stage-2-pending import path) or a project look
 * file. WRITES accept ONLY a project look path — this is the one place the
 * migration's absolute etiquette rule ("the app never writes into a photo
 * folder") is structurally enforced rather than merely a convention callers
 * are expected to honor: a caller cannot write an adjacent sidecar through
 * this handler even by mistake.
 */
function assertSidecarPath(path: unknown, mode: 'read' | 'write'): string {
  if (typeof path !== 'string' || !path.endsWith('.json')) {
    throw new Error('sidecar/look path must end with .json');
  }
  if (mode === 'write') {
    if (!isProjectLookPath(path)) {
      throw new Error("writes are only allowed inside a project's looks/ directory — the app never writes into photo folders");
    }
    return path;
  }
  if (!path.endsWith(SIDECAR_SUFFIX) && !isProjectLookPath(path)) {
    throw new Error(`sidecar path must end with ${SIDECAR_SUFFIX} or be inside a project's looks/ directory`);
  }
  return path;
}

// --- Sidecar hot-reload watcher (the AI-editing loop) -----------------------
//
// One watch lives at a time, scoped to this window: armSidecarWatch tears
// down whatever was watched before it sets up the new one, so re-arming on
// every openImageByPath (renderer side) is exactly "watch whatever image is
// currently open, nothing else." Reference held at module scope (not inside
// registerIpc) so app-quit/window-close teardown can reach it too.
let mainWindow: BrowserWindow | null = null;
let sidecarWatcher: FSWatcher | null = null;
let sidecarWatchDebounce: ReturnType<typeof setTimeout> | null = null;

/** ~150ms: long enough to collapse a burst of writes (an editor's own atomic save, a multi-step AI edit) into one push, short enough to feel instant. */
const SIDECAR_WATCH_DEBOUNCE_MS = 150;

function teardownSidecarWatch(): void {
  if (sidecarWatchDebounce !== null) {
    clearTimeout(sidecarWatchDebounce);
    sidecarWatchDebounce = null;
  }
  sidecarWatcher?.close();
  sidecarWatcher = null;
}

/**
 * Arm the sidecar watcher for `sidecarPath`. We watch the CONTAINING
 * DIRECTORY, not the file itself: our own writeSidecar (above) and any
 * well-behaved external editor write atomically (temp file, then rename into
 * place), and `fs.watch` on a single file loses track of it across a rename
 * — the inode underneath changes identity. Events are filtered down to the
 * sidecar's own basename and debounced (SIDECAR_WATCH_DEBOUNCE_MS) before
 * pushing `sidecarChanged` to the renderer, which carries no payload — it
 * just tells the renderer "go re-read the sidecar and decide what changed"
 * (self-write suppression, dirty-vs-clean, malformed handling all live
 * renderer-side, see appStore.ts's handleExternalSidecarChange).
 */
function armSidecarWatch(sidecarPath: string): void {
  teardownSidecarWatch();
  const dir = dirname(sidecarPath);
  const base = basename(sidecarPath);
  try {
    sidecarWatcher = watch(dir, (_eventType, filename) => {
      // Some platforms don't always supply `filename` for a directory watch;
      // when absent, don't filter it out — worst case is one harmless extra
      // round-trip (the renderer's content compare is a no-op if nothing
      // relevant changed).
      if (filename !== null && filename !== base) return;
      if (sidecarWatchDebounce !== null) clearTimeout(sidecarWatchDebounce);
      sidecarWatchDebounce = setTimeout(() => {
        sidecarWatchDebounce = null;
        mainWindow?.webContents.send(IPC.sidecarChanged);
      }, SIDECAR_WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    // Directory vanished/unreadable — nothing to watch; the loop just never
    // gets a hot-reload push for this image (same net effect as no watcher).
    console.warn(`sidecar watch failed for ${dir}:`, err);
  }
}

function registerIpc(): void {
  // CLI tooling parity (project-storage.md stage 2): a warning that isn't
  // any one file's structured result (currently just "--project playlist
  // fallback") — always to stderr, independent of --json (see IPC.cliWarn's
  // doc comment). Harmless outside `--render` — only runCliRender/runCliCheck/
  // runCliDiff ever call it.
  ipcMain.on(IPC.cliWarn, (_ev, message: unknown) => {
    if (typeof message === 'string') process.stderr.write(`silverbox-render: ${message}\n`);
  });

  // File-association open (project-storage migration, stage 2 — see
  // IPC.openPath's doc comment): the renderer signals it's mounted and
  // listening; flush whatever `open-file` queued before the window finished
  // loading (see the `app.on('open-file', …)` registration further down).
  ipcMain.on(IPC.appReady, () => {
    rendererOpenPathReady = true;
    if (pendingOpenPath && mainWindow) {
      mainWindow.webContents.send(IPC.openPath, pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  ipcMain.handle(IPC.ping, (): PingResult => {
    return {
      pid: process.pid,
      versions: {
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
      },
    };
  });

  ipcMain.handle(IPC.openImageDialog, async (_ev, scope: unknown): Promise<OpenImageDialogResult> => {
    // scope === 'imageNode': the Image node's own "Choose…" picker (round-9
    // fix pack item 4) — additionally offers PNG. Anything else (including
    // no argument at all, the main "Open…" toolbar action's call shape)
    // keeps the original RAW/JPEG-only filter untouched.
    const imageNodeScope = scope === 'imageNode';
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: imageNodeScope ? 'Images (RAW / JPEG / PNG)' : 'Images (RAW / JPEG)',
          extensions: imageNodeScope ? IMAGE_NODE_EXTENSIONS : IMAGE_EXTENSIONS,
        },
      ],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    return { canceled: false, path, fileName: basename(path) };
  });

  ipcMain.handle(IPC.openFolderDialog, async (): Promise<OpenImageDialogResult> => {
    // `createDirectory` (macOS-only NSOpenPanel option): lets "Save as
    // project…" pick a BRAND-NEW destination folder without leaving the
    // dialog — harmless for every other caller of this same dialog (Open
    // Folder…, Import sidecars from folder…, Scan folder for candidates),
    // which only ever browse to an existing folder anyway.
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    return { canceled: false, path, fileName: basename(path) };
  });

  ipcMain.handle(IPC.listImages, async (_ev, dir: unknown): Promise<FolderImageEntry[]> => {
    if (typeof dir !== 'string') throw new Error('listImages: dir must be a string');
    // No recursion (folder filmstrip v1 — ROADMAP "nice to have"): readdir
    // throws ENOTDIR/ENOENT for anything that isn't a readable directory,
    // which the renderer's drop handler relies on to tell "dropped a folder"
    // from "dropped a file" (see App.tsx).
    //
    // Project-storage migration (stage 1): this handler is now PURE
    // enumeration — appStore.ts's openFolder uses it only to discover which
    // files to ADD to the active project's playlist. hasLook/rating/missing
    // are meaningless here (a look lives in a PROJECT's looks/, not next to
    // the photo) and always come back false/0/false; the filmstrip's real
    // per-cell status is a separate join against the playlist afterward (see
    // IPC.projectPhotosStatus).
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: FolderImageEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      const ext = extname(dirent.name).slice(1).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      const path = join(dir, dirent.name);
      const st = await stat(path);
      entries.push({ name: dirent.name, path, hasLook: false, mtimeMs: st.mtimeMs, rating: 0, missing: false });
    }
    // Filename order, not mtime: hardlinked test fixtures (the verify suite's
    // own isolation trick — see run-verify.mjs) share one inode and so an
    // identical mtime across several distinctly-named files, which would sort
    // ambiguously/unstably. Filename order is also just what a folder listing
    // reads as "sorted" to a user.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  });

  ipcMain.handle(IPC.readFile, async (_ev, path: unknown): Promise<ArrayBuffer> => {
    if (typeof path !== 'string') throw new Error('readFile: path must be a string');
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  ipcMain.handle(IPC.readSidecar, async (_ev, path: unknown): Promise<string | null> => {
    try {
      return await readFile(assertSidecarPath(path, 'read'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.writeSidecar, async (_ev, path: unknown, content: unknown): Promise<void> => {
    if (typeof content !== 'string') throw new Error('writeSidecar: content must be a string');
    const target = assertSidecarPath(path, 'write');
    // A brand-new project's looks/ directory may not exist yet by the time
    // its first look is saved (the manifest write that normally creates it —
    // IPC.projectWrite, driven by appStore.ts's debounced playlist save — is
    // not synchronized with this call, e.g. an immediate ⌘S right after a
    // fresh quick-project photo's first edit) — ensure it here rather than
    // race that.
    await mkdir(dirname(target), { recursive: true });
    // Atomic write: a crash mid-save must not leave a truncated sidecar. The
    // temp dir lives next to the target so rename() stays on one filesystem.
    const tmpDir = await mkdtemp(join(dirname(target), '.silverbox-save-'));
    const tmpFile = join(tmpDir, basename(target));
    try {
      await writeFile(tmpFile, content, 'utf8');
      await rename(tmpFile, target);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle(IPC.watchSidecar, async (_ev, path: unknown): Promise<void> => {
    armSidecarWatch(assertSidecarPath(path, 'read'));
  });

  ipcMain.handle(IPC.projectRead, async (_ev, dir: unknown): Promise<string | null> => {
    if (typeof dir !== 'string') throw new Error('readProjectManifest: dir must be a string');
    try {
      return await readFile(join(dir, PROJECT_MANIFEST_NAME), 'utf8');
    } catch (err) {
      // ENOENT: no manifest there yet. ENOTDIR: `dir` isn't even a
      // directory (e.g. a single image file was handed to this by the
      // drag-drop project/folder disambiguation) — both mean "no project
      // here", not a real failure.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.projectWrite, async (_ev, dir: unknown, content: unknown): Promise<void> => {
    if (typeof dir !== 'string') throw new Error('writeProjectManifest: dir must be a string');
    if (typeof content !== 'string') throw new Error('writeProjectManifest: content must be a string');
    // Ensure the project's own shape exists before writing — this is what
    // lets the renderer's quick-project flow "create dir + manifest if
    // missing" in one round trip; an already-existing project is a harmless
    // no-op (mkdir recursive). looks/ is created eagerly too so the
    // sidecar-watch/writeSidecar paths never race an empty project dir.
    await mkdir(join(dir, 'looks'), { recursive: true });
    const target = join(dir, PROJECT_MANIFEST_NAME);
    const tmpDir = await mkdtemp(join(dir, '.silverbox-save-'));
    const tmpFile = join(tmpDir, PROJECT_MANIFEST_NAME);
    try {
      await writeFile(tmpFile, content, 'utf8');
      await rename(tmpFile, target);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle(
    IPC.projectPhotosStatus,
    async (_ev, dir: unknown, photos: unknown): Promise<FolderImageEntry[]> => {
      if (typeof dir !== 'string') throw new Error('projectPhotosStatus: dir must be a string');
      if (!Array.isArray(photos)) throw new Error('projectPhotosStatus: photos must be an array');
      const out: FolderImageEntry[] = [];
      for (const p of photos as Array<{ path?: unknown; look?: unknown }>) {
        if (typeof p.path !== 'string' || typeof p.look !== 'string') continue;
        // `p.path` is already resolved absolute by the renderer (see
        // engine/graph/projectDoc.ts's resolveProjectPath) — this handler
        // stays project-path-agnostic, same division of labor as
        // imageNodeSource.ts's own path resolution.
        let mtimeMs = 0;
        let missing = false;
        try {
          mtimeMs = (await stat(p.path)).mtimeMs;
        } catch {
          missing = true;
        }
        let hasLook = false;
        let rating = 0;
        try {
          const text = await readFile(join(dir, 'looks', p.look), 'utf8');
          hasLook = true;
          rating = extractSidecarRating(text);
        } catch {
          // no look yet, or unreadable — same "not edited, not rated"
          // fallback the pre-migration listImages handler used to compute.
        }
        out.push({ name: basename(p.path), path: p.path, hasLook, mtimeMs, rating, missing });
      }
      return out;
    }
  );

  // Fingerprint (project-storage migration, stage 3 — relink's verification
  // anchor): see computeFingerprint's own doc comment for the stability
  // contract. null on ENOENT (same "not there" convention as readSidecar/
  // readProjectManifest), not a thrown error — a photo that's since vanished
  // again is a normal, expected outcome for a caller checking a candidate.
  ipcMain.handle(IPC.fingerprintFile, async (_ev, path: unknown): Promise<string | null> => {
    if (typeof path !== 'string') throw new Error('fingerprintFile: path must be a string');
    try {
      return await computeFingerprint(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });

  // "Scan folder for candidates" (Missing photos, stage 3): ONE round trip
  // does the whole job — list `dir` non-recursively (same IMAGE_EXTENSIONS
  // filter as listImages), try basename-matching candidates first then the
  // rest, and return the first whose fingerprint matches (or, when the look
  // never had a fingerprint to verify against, the first exact-basename
  // match, unverified). null when nothing matches.
  ipcMain.handle(
    IPC.scanFolderForRelink,
    async (_ev, dir: unknown, basenameHint: unknown, expectedFingerprint: unknown): Promise<string | null> => {
      if (typeof dir !== 'string') throw new Error('scanFolderForRelink: dir must be a string');
      if (typeof basenameHint !== 'string') throw new Error('scanFolderForRelink: basenameHint must be a string');
      if (expectedFingerprint !== null && typeof expectedFingerprint !== 'string') {
        throw new Error('scanFolderForRelink: expectedFingerprint must be a string or null');
      }
      const dirents = await readdir(dir, { withFileTypes: true });
      const candidates: string[] = [];
      for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        const ext = extname(dirent.name).slice(1).toLowerCase();
        if (!IMAGE_EXTENSIONS.includes(ext)) continue;
        candidates.push(join(dir, dirent.name));
      }
      // Basename-matching candidates first, then the rest in filename order
      // (mirrors listImages' own sort — "sorted" reads the same way here).
      candidates.sort((a, b) => {
        const aFirst = basename(a) === basenameHint ? 0 : 1;
        const bFirst = basename(b) === basenameHint ? 0 : 1;
        return aFirst !== bFirst ? aFirst - bFirst : a.localeCompare(b);
      });
      if (expectedFingerprint === null) {
        // No stored fingerprint to verify against (a pre-stage-3 look) — the
        // best this can do is an unverified exact-basename match.
        return candidates.find((c) => basename(c) === basenameHint) ?? null;
      }
      for (const candidate of candidates) {
        let fp: string;
        try {
          fp = await computeFingerprint(candidate);
        } catch {
          continue; // vanished/unreadable mid-scan — try the next candidate
        }
        if (fp === expectedFingerprint) return candidate;
      }
      return null;
    }
  );

  // "Import sidecars from folder…" (Migration & compatibility, stage 3):
  // pure enumeration, same division of labor as listImages — the renderer
  // (appStore.ts's importSidecarsFromFolder) reads/parses/rewrites each one.
  ipcMain.handle(IPC.listSidecarFiles, async (_ev, dir: unknown): Promise<string[]> => {
    if (typeof dir !== 'string') throw new Error('listSidecarFiles: dir must be a string');
    const dirents = await readdir(dir, { withFileTypes: true });
    return dirents
      .filter((d) => d.isFile() && d.name.endsWith(SIDECAR_SUFFIX))
      .map((d) => join(dir, d.name))
      .sort((a, b) => a.localeCompare(b));
  });

  // "Save as project…" (Quick project → real project, MOVE not copy — user
  // decision, docs/brief-bank/project-storage.md's "Quick project" section):
  // physically relocates each given look (+ its golden/ PNG, if any) from
  // `srcDir` into `destDir`. Manifest writes are NOT this handler's job —
  // the renderer writes both (the new project's + the emptied quick
  // project's) through the existing projectWrite handler above, same as
  // every other playlist mutation.
  ipcMain.handle(
    IPC.moveProjectFiles,
    async (_ev, srcDir: unknown, destDir: unknown, lookNames: unknown): Promise<void> => {
      if (typeof srcDir !== 'string' || typeof destDir !== 'string') {
        throw new Error('moveProjectFiles: srcDir/destDir must be strings');
      }
      if (!Array.isArray(lookNames) || !lookNames.every((n) => typeof n === 'string')) {
        throw new Error('moveProjectFiles: lookNames must be an array of strings');
      }
      await mkdir(join(destDir, 'looks'), { recursive: true });
      // rename() is atomic and free within one filesystem; destDir may be on
      // a DIFFERENT volume than the quick project (an external drive, a
      // different mount) — node reports that as EXDEV, falling back to a
      // copy+delete (still a MOVE from the user's point of view: nothing is
      // left behind in srcDir once this resolves).
      const moveOne = async (src: string, dest: string): Promise<void> => {
        try {
          await rename(src, dest);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await copyFile(src, dest);
          await rm(src, { force: true });
        }
      };
      for (const name of lookNames as string[]) {
        await moveOne(join(srcDir, 'looks', name), join(destDir, 'looks', name));
        // Golden renders (`--check`/`--update` with `--project` —
        // CliCheckJob.projectDir's doc comment): `<projectDir>/golden/
        // <look-name>.png`, look-name = the look's own filename with `.json`
        // dropped. Moved alongside its look, if one exists, so a `--check`
        // run against the NEW project location still has its baseline.
        const goldenName = `${name.replace(/\.json$/, '')}.png`;
        const goldenSrc = join(srcDir, 'golden', goldenName);
        try {
          await stat(goldenSrc);
        } catch {
          continue; // no golden for this look — nothing to move
        }
        await mkdir(join(destDir, 'golden'), { recursive: true });
        await moveOne(goldenSrc, join(destDir, 'golden', goldenName));
      }
    }
  );

  ipcMain.handle(IPC.exportImageDialog, async (_ev, defaultPath: unknown): Promise<OpenImageDialogResult> => {
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      filters: [
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'PNG', extensions: ['png'] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: result.filePath, fileName: basename(result.filePath) };
  });

  ipcMain.handle(IPC.exportEncode, async (_ev, req: ExportEncodeRequest): Promise<ExportEncodeResult> => {
    return encodeExport(req);
  });

  ipcMain.handle(IPC.exportLutDialog, async (_ev, defaultPath: unknown): Promise<OpenImageDialogResult> => {
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      filters: [{ name: 'Adobe Cube LUT', extensions: ['cube'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: result.filePath, fileName: basename(result.filePath) };
  });

  ipcMain.handle(IPC.exportLut, async (_ev, req: ExportLutRequest): Promise<ExportLutResult> => {
    return encodeLutExport(req);
  });

  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => readSettings());

  ipcMain.handle(IPC.settingsUpdate, async (_ev, partial: unknown): Promise<Settings> => {
    if (typeof partial !== 'object' || partial === null) {
      throw new Error('settingsUpdate: partial must be an object');
    }
    return updateSettings(partial as Partial<Settings>);
  });

  ipcMain.handle(IPC.presetsList, async (): Promise<PresetSummary[]> => listPresets());

  ipcMain.handle(IPC.presetRead, async (_ev, slug: unknown): Promise<string | null> => readPreset(slug));

  ipcMain.handle(IPC.presetWrite, async (_ev, slug: unknown, content: unknown): Promise<void> => {
    await writePreset(slug, content);
  });

  ipcMain.handle(IPC.presetDelete, async (_ev, slug: unknown): Promise<void> => {
    await deletePreset(slug);
  });

  ipcMain.handle(IPC.goldenCheck, async (_ev, req: CliCheckImageRequest): Promise<CliCheckOutcome> => {
    return checkGoldenImage(req);
  });

  ipcMain.handle(IPC.diffRenderImages, async (_ev, req: CliDiffImageRequest): Promise<CliDiffImageResult> => {
    return diffRenderImages(req);
  });

  ipcMain.handle(IPC.externalToolRun, async (_ev, req: ExternalToolRequest): Promise<ExternalToolResult> => {
    return runExternalTool(req);
  });

  ipcMain.handle(IPC.externalToolSpawnCount, async (): Promise<number> => externalToolSpawnCount());

  ipcMain.handle(IPC.denoiseRun, async (_ev, req: DenoiseRunRequest): Promise<DenoiseRunResult> => {
    const settings = await readSettings();
    return runDenoise(req, settings.denoiseModelConsent, settings.denoiseModelUrl);
  });

  ipcMain.handle(IPC.denoiseRunCount, async (): Promise<number> => denoiseRunCount());
}

/**
 * Verify-harness mode: the suite launches dozens of app instances in a row,
 * and each one appearing on screen makes the machine unusable while it runs.
 * The window is never shown at all — WebGPU renders and readbacks don't need
 * a visible window, backgroundThrottling:false keeps timers/rAF at full
 * rate, and CDP screenshots force their own frame capture. The macOS
 * accessory policy also keeps the app out of the Dock. `headless` folds in
 * the CLI's own `--render` mode too: it forces the exact same windowless path
 * WITHOUT requiring SILVERBOX_TEST (a real user running the CLI never sets
 * that env var).
 */
const testMode = process.env['SILVERBOX_TEST'] === '1';
const headless = testMode || isCliRenderMode;

/**
 * File-association open (project-storage migration, stage 2, packaged app
 * only — see PROJECT_MANIFEST_NAME's doc comment and package.json's `build.
 * fileAssociations`). macOS delivers a double-clicked/opened `.silverbox`
 * file via the `open-file` app event, NOT `process.argv` (that's the
 * Windows/Linux shape, wired via `second-instance` + a single-instance
 * lock — NOT implemented here: this app targets macOS only today, see
 * DESIGN.md). `open-file` can fire before `ready` (a cold launch via
 * double-click) — registered at module scope, synchronously, so an early
 * firing is never missed (Electron's own documented requirement); queued in
 * `pendingOpenPath` until the renderer says it's listening (`appReady`,
 * registered in registerIpc() above) or sent immediately if it already is
 * (the app was already running — a second double-click).
 */
let pendingOpenPath: string | null = null;
let rendererOpenPathReady = false;
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (headless) return; // no real double-click scenario in test/CLI runs
  if (rendererOpenPathReady && mainWindow) {
    mainWindow.webContents.send(IPC.openPath, path);
  } else {
    pendingOpenPath = path;
  }
});

if (isCliRenderMode) {
  // Force the real fresh-open defaults (lens profile, base curve) regardless
  // of SILVERBOX_TEST — see SilverboxApi.testFlags's `forceDefaults` doc
  // comment. Set here, in main, before any window/preload gets created:
  // preload reads process.env at renderer-process spawn time (the same
  // inheritance SILVERBOX_TEST itself already relies on), so this must land
  // before the first `new BrowserWindow(...)` call below.
  process.env['SILVERBOX_CLI_RENDER'] = '1';
}

// Verify-suite parallelism: every script that shows up here mutates
// <userData>/settings.json (autosave, presets, …). Running the suite's
// scripts concurrently against the OS-default userData dir means they'd
// stomp each other's settings.json. In test mode only, an explicit
// SILVERBOX_USER_DATA env var repoints Electron's userData dir before
// anything (readSettings included) touches it — the runner assigns each
// pooled script its own fresh temp directory here (verify-cli.mjs mints its
// own the same way for its --preset-by-name check).
const testUserData = process.env['SILVERBOX_USER_DATA'];
if (testMode && testUserData) app.setPath('userData', testUserData);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: '#1e1e1e',
    show: !headless,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // ESM preload requires an unsandboxed renderer; contextIsolation stays on.
      sandbox: false,
      // hidden/unfocused windows must keep timers and rAF at full rate
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    teardownSidecarWatch();
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * `--render`/`--check`'s whole lifecycle: parse argv (already read before
 * app.whenReady — see cliArgv above), print usage/errors and exit for bad
 * usage, else create the hidden window, hand it the job once the renderer
 * signals ready (cli:ready — closes the mount race, see App.tsx), and stream
 * results back as they complete (cli:progress) until the batch finishes
 * (cli:done). Exit code: 2 for bad usage, 1 if any file errored/failed/had
 * no golden (see hadFailure below), 0 otherwise — set via app.exit() (never
 * process.exit(), which wouldn't flush Electron's own teardown).
 */
async function runCliMode(): Promise<void> {
  const parsed = parseCliArgs(cliArgv);
  if ('error' in parsed) {
    console.error(`silverbox-render: ${parsed.error}\n`);
    console.error(CLI_USAGE);
    app.exit(2);
    return;
  }
  if (parsed.help) {
    console.log(CLI_USAGE);
    app.exit(0);
    return;
  }
  // --diff never carries positional images (its one image comes via
  // --image — see cliArgs.ts's own validation, which already rejects any
  // positional image alongside --diff) — this guard is only meaningful for
  // --render/--check's `<image…>` argument list.
  if (parsed.mode !== 'diff' && parsed.images.length === 0) {
    console.error('silverbox-render: no input images given\n');
    console.error(CLI_USAGE);
    app.exit(2);
    return;
  }

  const job = buildCliJob(parsed, process.cwd());
  // Legacy-adjacent-golden nudge (CLI tooling parity item 3): printed once
  // per invocation, not per image — a batch of 500 goldens shouldn't spam
  // 500 identical lines. Only for --check without --project; --project's
  // own golden location needs no nudge (it's already the recommended path).
  if (job.mode === 'check' && job.projectDir === null) {
    console.error(
      'silverbox-render: note: goldens are stored next to the photo (legacy) — pass --project <dir> to keep them inside a project instead\n'
    );
  }
  const win = createWindow();
  let hadFailure = false;

  // A --check run's failure conditions (a golden ΔE fail, a missing golden
  // without --update, a dims-changed) are just as much "this batch did not
  // come out clean" as a --render error — same exit-code bucket, see
  // CLI_USAGE's documented exit codes for both modes.
  const onProgress = (_ev: unknown, result: CliProgressResult): void => {
    if ('error' in result) hadFailure = true;
    // --diff (CliDiffOutcome) is purely informational — never a failure,
    // even its own 'dims-changed' status, regardless of whether differences
    // were found (see cliArgs.ts's CLI_USAGE "git diff" exit-code note).
    // Checked BEFORE the 'status'/'pass' branches below since a dims-changed
    // diff outcome would otherwise be caught by the --check status check.
    else if ('lines' in result) {
      /* never a failure */
    }
    // '--min-rating' skips are a deliberate no-op, not a failure (see
    // CliRenderJob.minRating's doc comment) — every other 'status' value
    // (--check's no-golden/dims-changed) IS a failure unless --update.
    else if ('status' in result && result.status !== 'updated' && result.status !== 'skipped-rating') hadFailure = true;
    else if ('pass' in result && !result.pass) hadFailure = true;
    const { stderr, line } = formatCliProgress(result, parsed.json);
    (stderr ? process.stderr : process.stdout).write(line + '\n');
  };
  ipcMain.on(IPC.cliProgress, onProgress);

  // A renderer crash / an unhandled hang must not wedge a CI job forever —
  // 10 minutes comfortably covers even a large batch on modest hardware.
  const CLI_TIMEOUT_MS = 10 * 60 * 1000;
  let timedOut = false;
  await new Promise<void>((resolveJob) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error('silverbox-render: timed out waiting for the render to finish');
      resolveJob();
    }, CLI_TIMEOUT_MS);
    ipcMain.once(IPC.cliDone, () => {
      clearTimeout(timeout);
      resolveJob();
    });
    ipcMain.once(IPC.cliReady, () => {
      win.webContents.send(IPC.cliRun, job);
    });
  });
  ipcMain.removeListener(IPC.cliProgress, onProgress);
  app.exit(timedOut || hadFailure ? 1 : 0);
}

void app.whenReady().then(async () => {
  if (headless && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  // No native menu bar for a batch CLI invocation (verify-cli.mjs's "runs
  // windowless, no focus/UI side effects" contract) — left untouched for the
  // normal app and the verify suite, both of which still want it.
  if (isCliRenderMode) Menu.setApplicationMenu(null);
  // Load (and, on first run, create) settings.json before the renderer can
  // possibly ask for it over IPC.
  await readSettings();
  registerIpc();

  if (isCliRenderMode) {
    await runCliMode();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  teardownSidecarWatch();
  if (process.platform !== 'darwin') app.quit();
});
