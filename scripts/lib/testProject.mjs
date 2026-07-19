/**
 * Test-harness helper for the project-storage migration (verify-suite side —
 * docs/brief-bank/project-storage.md's "Verify-suite impact" section; the
 * app-side work landed first, this module is what lets scripts keep up).
 * Looks no longer live next to the test image (writing an adjacent
 * `<image>.silverbox.json` is retired) — they live in a PROJECT's `looks/`
 * directory, one project per isolated script run (see run-verify.mjs's
 * setupIsolation, which mints a scratch project dir alongside the existing
 * per-script ARW/JPG hardlink + userData isolation).
 *
 * `SILVERBOX_TEST_PROJECT` is the one lever this whole module turns: main
 * reads it (src/main/index.ts → preload's `testFlags.projectDirOverride`)
 * and the renderer's `ensureActiveProject` uses it EXACTLY as given (no
 * subdir) as the quick-project directory. It MUST be set before
 * `electron.launch(...)` — Playwright's launched Electron process inherits
 * `process.env` at spawn time, same as every other SILVERBOX_TEST_* lever
 * this suite already relies on.
 *
 * `lookPathFor`'s no-collision assumption: every helper here derives a look
 * path by hand as `<basename(imagePath)>.json` — the plain, non-suffixed
 * shape `deriveLookName` (src/renderer/engine/graph/projectDoc.ts) produces
 * ONLY when no other photo in the project already holds that name. Every
 * verify script's test images have distinct basenames within whatever
 * project they open (a script opens `test.ARW`/`test.JPG`/one or two named
 * fixtures, never two files sharing a basename), so the suffix case never
 * engages here — verify-project.mjs, which deliberately EXERCISES the
 * collision suffix, computes its own suffixed path instead of using this
 * helper (see that script's own comment).
 *
 * When a script needs the APP's own answer instead of a hand-computed guess
 * (e.g. proving a path survived a reopen, or just being robust against this
 * module's assumption) — `window.__debug.projectState().currentLookPath` is
 * authoritative; prefer it wherever the app is already open and the point
 * being tested isn't the path-derivation logic itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Ensure `SILVERBOX_TEST_PROJECT` is set — minting a fresh OS-tmpdir-backed
 * project directory when a script runs standalone (outside run-verify.mjs's
 * per-script pool isolation, which already sets it) — and that the
 * directory exists on disk. Idempotent: a script that calls this more than
 * once (or after run-verify.mjs already set the var) just reuses the same
 * directory. Returns the directory.
 */
export function ensureTestProjectEnv() {
  if (!process.env.SILVERBOX_TEST_PROJECT) {
    process.env.SILVERBOX_TEST_PROJECT = mkdtempSync(join(tmpdir(), 'silverbox-verify-project-'));
  }
  // `looks/` too (not just the project dir itself): a script that hand-writes
  // a fixture look via writeFileSync/writeLookFixture BEFORE ever opening the
  // app needs this to already exist — the app's own writeSidecar IPC handler
  // mkdir's it lazily on first save, but a direct-to-disk fixture write has
  // no such handler in front of it.
  mkdirSync(join(process.env.SILVERBOX_TEST_PROJECT, 'looks'), { recursive: true });
  return process.env.SILVERBOX_TEST_PROJECT;
}

function projectDir() {
  const dir = process.env.SILVERBOX_TEST_PROJECT;
  if (!dir) throw new Error('SILVERBOX_TEST_PROJECT is not set — call ensureTestProjectEnv() before using scripts/lib/testProject.mjs');
  return dir;
}

/** Absolute path of `project.silverbox` in the active test project. */
export function manifestPath() {
  return join(projectDir(), 'project.silverbox');
}

/** The look path for `imagePath` under the active test project's `looks/` — see this module's doc comment for the no-collision assumption. */
export function lookPathFor(imagePath) {
  return join(projectDir(), 'looks', `${basename(imagePath)}.json`);
}

/** Force-delete `imagePath`'s look file (clean-slate before a test — the project-model equivalent of the old `rmSidecarSync(X_PATH + '.silverbox.json')` idiom). Never throws if absent. */
export function rmLook(imagePath) {
  rmSync(lookPathFor(imagePath), { force: true });
}

/** True when `imagePath` currently has a look file in the active project. */
export function hasLook(imagePath) {
  return existsSync(lookPathFor(imagePath));
}

/** Parse `imagePath`'s look file (throws if absent/malformed — same as a bare readFileSync + JSON.parse would). */
export function readLook(imagePath) {
  return JSON.parse(readFileSync(lookPathFor(imagePath), 'utf8'));
}

/** Write a hand-authored look fixture for `imagePath` (mkdir's `looks/` first — scripts write straight to disk, not through the app's writeSidecar IPC, which does the same mkdir-before-write itself). */
export function writeLookFixture(imagePath, obj) {
  mkdirSync(join(projectDir(), 'looks'), { recursive: true });
  writeFileSync(lookPathFor(imagePath), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** Wipe the active project's `looks/` + manifest for a clean-slate script that wants the WHOLE project reset, not just one photo's look. */
export function resetTestProject() {
  const dir = projectDir();
  rmSync(join(dir, 'looks'), { recursive: true, force: true });
  rmSync(join(dir, 'project.silverbox'), { force: true });
}

/** The shared-look path for `slug` under the active test project's `shared-looks/` (docs/brief-bank/linked-looks-stage-b.md) — presets.ts's twin, project-scoped. */
export function sharedLookPathFor(slug) {
  return join(projectDir(), 'shared-looks', `${slug}.json`);
}

/** True when shared look `slug` currently has a file in the active project. */
export function hasSharedLook(slug) {
  return existsSync(sharedLookPathFor(slug));
}

/** Parse shared look `slug`'s file (throws if absent/malformed). */
export function readSharedLook(slug) {
  return JSON.parse(readFileSync(sharedLookPathFor(slug), 'utf8'));
}
