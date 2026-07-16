/**
 * Parallel verify-suite runner.
 *
 * Most entries are verify-*.mjs scripts that each build the app, launch a
 * windowless Electron instance, and drive it (plus the fast `unit` vitest
 * tier, a plain `command` entry — see runScript). Run serially (the old
 * `npm run verify`
 * chain, kept as `verify:serial`) that's ~15+ minutes. This runner builds
 * ONCE up front, then runs the scripts through a small concurrency pool
 * (default 3 at a time, override with SILVERBOX_VERIFY_JOBS), isolating the
 * shared state each script would otherwise collide over:
 *
 *  - Build: every script's own `electron-vite build` step is skipped via
 *    SILVERBOX_SKIP_BUILD=1 (this runner built `out/` already).
 *  - Test image + sidecar: each script gets its own temp dir containing a
 *    HARDLINK (same inode, same basename, instant — no copy) of the shared
 *    test ARW/JPG, via SILVERBOX_TEST_ARW/SILVERBOX_TEST_JPG. Sidecars each
 *    script writes/deletes next to its hardlink never touch another
 *    script's copy or the real source file.
 *  - userData (settings.json, autosave, export presets): each script gets
 *    its own fresh temp userData dir via SILVERBOX_USER_DATA (see
 *    testUserData handling in src/main/index.ts).
 *  - Project storage (docs/brief-bank/project-storage.md): each script gets
 *    its own fresh temp PROJECT dir via SILVERBOX_TEST_PROJECT — a sibling
 *    of workDir/userDataDir, never shared across pooled scripts, so looks/
 *    autosaves and project.silverbox playlist edits from one script's run
 *    never bleed into another's (see scripts/lib/testProject.mjs, the
 *    scripts-side counterpart of this lever).
 *
 * ms14 (electron-builder packaging, mutates dist/) is NOT poolable — it runs
 * SERIALLY after the pool, once nothing else is touching the build output.
 *
 * Usage:
 *   node scripts/run-verify.mjs           # full 32-script suite
 *   node scripts/run-verify.mjs --smoke   # ms1 + develop + ms10 + cst only
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const smokeMode = process.argv.includes('--smoke');
const jobs = Number.parseInt(process.env.SILVERBOX_VERIFY_JOBS ?? '', 10) || 3;

const SRC_ARW = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SRC_JPG = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

// Single ordered source of truth for the suite (old serial chain's order,
// kept as pool order). `exclusive: true` scripts never enter the pool — they
// run serially, after every pooled job has finished.
const ALL_SCRIPTS = [
  // Pure-function unit tier (vitest) — no electron/playwright, just a plain
  // command. Fast, so it leads the pool. See runScript's `command` handling.
  { name: 'unit', command: ['npx', 'vitest', 'run'] },
  { name: 'ms0', file: 'verify-ms0-decode.mjs' },
  { name: 'ms1', file: 'verify-ms1-app.mjs' },
  { name: 'ms2', file: 'verify-ms2-decode-display.mjs' },
  { name: 'ms3', file: 'verify-ms3-webgpu.mjs' },
  { name: 'ms4', file: 'verify-ms4-graph.mjs' },
  { name: 'ms5', file: 'verify-ms5-edit.mjs' },
  { name: 'ms6', file: 'verify-ms6-persist.mjs' },
  { name: 'ms7', file: 'verify-ms7-custom.mjs' },
  { name: 'ms8', file: 'verify-ms8-export.mjs' },
  { name: 'ms9', file: 'verify-ms9-viewport.mjs' },
  { name: 'ms10', file: 'verify-ms10-histogram.mjs' },
  { name: 'ms11', file: 'verify-ms11-undo.mjs' },
  { name: 'ms12', file: 'verify-ms12-tonecurve.mjs' },
  { name: 'ms13', file: 'verify-ms13-branch.mjs' },
  { name: 'develop', file: 'verify-develop.mjs' },
  { name: 'editing', file: 'verify-editing.mjs' },
  { name: 'wb', file: 'verify-wb.mjs' },
  { name: 'tonecurve', file: 'verify-tonecurve.mjs' },
  { name: 'hsl', file: 'verify-hsl.mjs' },
  { name: 'detail', file: 'verify-detail.mjs' },
  { name: 'dnd', file: 'verify-dnd.mjs' },
  { name: 'view', file: 'verify-view.mjs' },
  { name: 'grading', file: 'verify-grading.mjs' },
  { name: 'scopes', file: 'verify-scopes.mjs' },
  { name: 'effects', file: 'verify-effects.mjs' },
  { name: 'crop', file: 'verify-crop.mjs' },
  { name: 'lens', file: 'verify-lens.mjs' },
  { name: 'cst', file: 'verify-cst.mjs' },
  { name: 'polish', file: 'verify-polish.mjs' },
  { name: 'exportsettings', file: 'verify-exportsettings.mjs' },
  { name: 'masks', file: 'verify-masks.mjs' },
  { name: 'colorkey', file: 'verify-colorkey.mjs' },
  { name: 'spots', file: 'verify-spots.mjs' },
  { name: 'lut', file: 'verify-lut.mjs' },
  { name: 'presets', file: 'verify-presets.mjs' },
  { name: 'lensprofile', file: 'verify-lensprofile.mjs' },
  { name: 'basecurve', file: 'verify-basecurve.mjs' },
  { name: 'profilefit', file: 'verify-profilefit.mjs' },
  { name: 'hotreload', file: 'verify-hotreload.mjs' },
  { name: 'cli', file: 'verify-cli.mjs' },
  { name: 'cli-project', file: 'verify-cli-project.mjs' },
  { name: 'diff', file: 'verify-diff.mjs' },
  { name: 'golden', file: 'verify-golden.mjs' },
  { name: 'preview', file: 'verify-preview.mjs' },
  { name: 'filmstrip', file: 'verify-filmstrip.mjs' },
  { name: 'compare', file: 'verify-compare.mjs' },
  { name: 'nodepreview', file: 'verify-nodepreview.mjs' },
  { name: 'ratings', file: 'verify-ratings.mjs' },
  { name: 'imagenode', file: 'verify-imagenode.mjs' },
  { name: 'external', file: 'verify-external.mjs' },
  { name: 'bypass', file: 'verify-bypass.mjs' },
  { name: 'project', file: 'verify-project.mjs' },
  { name: 'ms14', file: 'verify-ms14-package.mjs', exclusive: true },
];

const SMOKE_NAMES = new Set(['unit', 'ms1', 'develop', 'ms10', 'cst']);

const selected = smokeMode ? ALL_SCRIPTS.filter((s) => SMOKE_NAMES.has(s.name)) : ALL_SCRIPTS;
const poolJobs = selected.filter((s) => !s.exclusive);
const exclusiveJobs = selected.filter((s) => s.exclusive);

const logDir = join(projectRoot, 'test-artifacts', 'logs');
mkdirSync(logDir, { recursive: true });

function fmtSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

/** Give one script its own hardlinked test image(s) + fresh userData temp dir. */
function setupIsolation(name) {
  const workDir = mkdtempSync(join(tmpdir(), `silverbox-verify-${name}-`));
  const userDataDir = mkdtempSync(join(tmpdir(), `silverbox-userdata-${name}-`));
  // Project storage: a sibling scratch dir per script, never shared — the
  // renderer's ensureActiveProject uses this EXACTLY (no subdir) as the
  // quick-project directory (see testFlags.projectDirOverride). mkdir'd here
  // (not just minted) so a script that reads it before ever opening an image
  // (e.g. checking "no project.silverbox yet") sees a real, empty directory.
  const projectDir = mkdtempSync(join(tmpdir(), `silverbox-project-${name}-`));
  const arwLink = join(workDir, basename(SRC_ARW));
  const jpgLink = join(workDir, basename(SRC_JPG));
  linkSync(SRC_ARW, arwLink);
  try {
    linkSync(SRC_JPG, jpgLink);
  } catch {
    // some environments may lack the JPG fixture; scripts that need it will
    // fail loudly on their own, which is the correct behavior here.
  }
  return {
    workDir,
    userDataDir,
    projectDir,
    env: {
      ...process.env,
      SILVERBOX_TEST: '1',
      SILVERBOX_SKIP_BUILD: '1',
      SILVERBOX_TEST_ARW: arwLink,
      SILVERBOX_TEST_JPG: jpgLink,
      SILVERBOX_USER_DATA: userDataDir,
      SILVERBOX_TEST_PROJECT: projectDir,
    },
    cleanup() {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

/** Run one verify script to completion, capturing its output to a log file. */
function runScript({ name, file, command }, { extraEnv } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const logPath = join(logDir, `${name}.log`);
    const logFd = openSync(logPath, 'w');
    // `command` entries (e.g. the vitest unit tier) run a plain argv; the rest
    // run `node scripts/<file>`.
    const [cmd, ...args] = command ?? ['node', join(projectRoot, 'scripts', file)];
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      env: extraEnv ?? process.env,
    });
    child.stdout.on('data', (chunk) => writeSync(logFd, chunk));
    child.stderr.on('data', (chunk) => writeSync(logFd, chunk));
    child.on('close', (code) => {
      closeSync(logFd);
      resolve({ name, ok: code === 0, code, durationMs: Date.now() - start, logPath });
    });
    child.on('error', (err) => {
      writeSync(logFd, String(err?.stack ?? err));
      closeSync(logFd);
      resolve({ name, ok: false, code: -1, durationMs: Date.now() - start, logPath });
    });
  });
}

function printCompletion(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${result.name.padEnd(16)} ${fmtSeconds(result.durationMs).padStart(7)}s`);
}

async function runPool(scripts, concurrency) {
  const results = new Array(scripts.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= scripts.length) return;
      const script = scripts[i];
      const isolation = setupIsolation(script.name);
      try {
        const result = await runScript(script, { extraEnv: isolation.env });
        results[i] = result;
        printCompletion(result);
      } finally {
        isolation.cleanup();
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, scripts.length) || 1 }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runExclusive(scripts) {
  const results = [];
  for (const script of scripts) {
    const isolation = setupIsolation(script.name);
    try {
      const result = await runScript(script, { extraEnv: isolation.env });
      results.push(result);
      printCompletion(result);
    } finally {
      isolation.cleanup();
    }
  }
  return results;
}

console.log(smokeMode ? 'verify:smoke' : 'verify (parallel)');
const overallStart = Date.now();

console.log('building once (out/)…');
const buildStart = Date.now();
execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
const buildMs = Date.now() - buildStart;
console.log(`build done in ${fmtSeconds(buildMs)}s\n`);

console.log(`pool (concurrency ${jobs}): ${poolJobs.map((s) => s.name).join(', ')}`);
const poolResults = await runPool(poolJobs, jobs);

let exclusiveResults = [];
if (exclusiveJobs.length > 0) {
  console.log(`\nexclusive tail (serial): ${exclusiveJobs.map((s) => s.name).join(', ')}`);
  exclusiveResults = await runExclusive(exclusiveJobs);
}

const allResults = [...poolResults, ...exclusiveResults];
const totalMs = Date.now() - overallStart;

console.log('\n--- summary ---');
const nameWidth = Math.max(...allResults.map((r) => r.name.length));
for (const r of allResults) {
  const status = r.ok ? 'PASS' : 'FAIL';
  const logNote = r.ok ? '' : `  log: ${r.logPath}`;
  console.log(`  ${status}  ${r.name.padEnd(nameWidth)}  ${fmtSeconds(r.durationMs).padStart(7)}s${logNote}`);
}

const passCount = allResults.filter((r) => r.ok).length;
console.log(`\nbuild: ${fmtSeconds(buildMs)}s, total wall time: ${fmtSeconds(totalMs)}s`);
console.log(`SUITE: ${passCount === allResults.length ? 'PASS' : 'FAIL'} ${passCount}/${allResults.length}`);

process.exit(passCount === allResults.length ? 0 : 1);
