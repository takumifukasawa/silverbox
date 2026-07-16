/**
 * CLI tooling parity with the project model (project-storage migration,
 * stage 2 — docs/brief-bank/project-storage.md's "Implementation stages"
 * item 2). verify-cli.mjs already covers the CLI's legacy (no `--project`)
 * behavior byte-for-byte unchanged; this script is additive, split out
 * because verify-cli.mjs was already long (the brief's own call). Same
 * pattern as verify-cli.mjs/verify-golden.mjs/verify-diff.mjs: spawns the
 * REAL CLI (`electron <projectRoot> --render …`), a genuine windowless app
 * instance per invocation — nothing here needs an open window.
 *
 * Fixture project layout (one workDir, one project subdirectory):
 *   <workDir>/photo1.ARW              — ON the project's playlist
 *   <workDir>/photo2.ARW              — NOT on the playlist (fallback check)
 *   <workDir>/MyProject/project.silverbox
 *   <workDir>/MyProject/looks/photo1.ARW.json   (photo: <workDir>/photo1.ARW)
 *
 * Checks (brief's numbered list):
 *  1. `--project <dir>` render resolves the project's look for a playlist
 *     photo (differs from a default-look render of the same image); accepts
 *     a path to project.silverbox itself, normalized to its directory; a
 *     photo NOT on the playlist renders the DEFAULT look with a stderr
 *     warning — the playlist and looks/ are untouched either way (a
 *     headless run must never silently mutate someone's project).
 *  2. Rendering directly from a look file (`<path>.json`) reproduces the
 *     equivalent `--project` image render byte-for-byte, and writes to the
 *     same output filename the photo itself would (not the look file's own
 *     basename). A relative look-file argument resolves against `--project`,
 *     not the launch cwd.
 *  3. A look with no `photo` field (including a legacy-style sidecar handed
 *     directly) is a clear per-file error naming the field and the fix.
 *  4. `--check --project` writes/reads the golden inside
 *     `<project>/golden/<look-name>.png`, passes on an immediate re-run, and
 *     leaves nothing next to the photo (etiquette); `--check` WITHOUT
 *     `--project` still prints the legacy adjacent-golden note (and only
 *     then).
 *  5. `--diff` with two photo-carrying looks and no `--image` derives it
 *     automatically; two looks disagreeing on `photo` (or missing it) is a
 *     clear error, not a silent guess.
 *  6. `--help` documents `--project` and look-file rendering.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SRC_ARW = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-cli-project-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-cli-project-userdata-'));

function link(name, src = SRC_ARW) {
  const dst = join(workDir, name);
  linkSync(src, dst);
  return dst;
}

function outDir(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const nowIso = () => new Date().toISOString();

/** schemaVersion-4 wire wrapper — same shape verify-cli.mjs writes; `photo` included only when given (matches serializeGraphDoc's own omit-when-absent). */
function graphWrapper(nodes, edges, { photo } = {}) {
  return { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), ...(photo !== undefined ? { photo } : {}), graph: { nodes, edges } };
}

function simpleLook(develop) {
  return {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 } },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, ...(develop ? { develop } : {}) },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
}

/** Write a look/sidecar-shaped JSON doc at an arbitrary path (a project's looks/*.json, or a bare standalone file). */
function writeLookFile(path, { develop, photo } = {}) {
  const { nodes, edges } = simpleLook(develop);
  writeFileSync(path, JSON.stringify(graphWrapper(nodes, edges, { photo }), null, 2) + '\n');
}

const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

/** Spawn the real CLI. `opts.cwd` lets the relative-look-path check prove resolution isn't against the launch cwd. */
function runCli(args, opts = {}) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    cwd: opts.cwd ?? projectRoot,
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNdjson(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
}

function expectedOutPath(inputPath, dir) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, '');
  return join(dir, `${stem}.jpg`);
}

async function rawBytesOf(path) {
  return sharp(path).raw().toBuffer();
}

// --- Fixture project ---------------------------------------------------
const photo1 = link('photo1.ARW');
const photo2 = link('photo2-not-on-playlist.ARW');
const myProjectDir = join(workDir, 'MyProject');
const looksDir = join(myProjectDir, 'looks');
mkdirSync(looksDir, { recursive: true });

const manifest = { schemaVersion: 1, name: 'CliProject', photos: [{ path: photo1, look: 'photo1.ARW.json' }] };
const manifestPath = join(myProjectDir, 'project.silverbox');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const photo1LookPath = join(looksDir, 'photo1.ARW.json');
writeLookFile(photo1LookPath, { develop: { basic: { ev: 2 } }, photo: photo1 });

try {
  // =========================================================================
  console.log('verify-cli-project (1. --project resolves the project look; playlist fallback; manifest path normalization):');
  const rDefault = runCli(['--out', outDir('default'), photo1]);
  check('default-look (no --project) render exits 0', rDefault.status === 0, rDefault);
  const bytesDefault = await rawBytesOf(expectedOutPath(photo1, outDir('default')));

  const rProject = runCli(['--out', outDir('project'), '--project', myProjectDir, photo1]);
  check('--project render exits 0', rProject.status === 0, { status: rProject.status, stderr: rProject.stderr });
  const outProject = expectedOutPath(photo1, outDir('project'));
  const bytesProject = await rawBytesOf(outProject);
  check("--project's look (ev=2) differs from the default-look render", !bytesDefault.equals(bytesProject), {
    sameBytes: bytesDefault.equals(bytesProject),
  });

  const rProjectFile = runCli(['--out', outDir('projectfile'), '--project', manifestPath, photo1]);
  check('--project accepts a path to project.silverbox itself (normalized to its dir)', rProjectFile.status === 0, {
    status: rProjectFile.status,
    stderr: rProjectFile.stderr,
  });
  const bytesProjectFile = await rawBytesOf(expectedOutPath(photo1, outDir('projectfile')));
  check('…and renders identically to --project <dir>', bytesProjectFile.equals(bytesProject), {
    sameBytes: bytesProjectFile.equals(bytesProject),
  });

  const manifestBefore = readFileSync(manifestPath, 'utf8');
  const looksBefore = readdirSync(looksDir).sort();
  const rFallback = runCli(['--out', outDir('fallback'), '--project', myProjectDir, photo2]);
  check('a photo NOT on the playlist still renders (default look), exit 0', rFallback.status === 0, {
    status: rFallback.status,
    stderr: rFallback.stderr,
  });
  check(
    'stderr warns the photo is not on the project playlist',
    /not on the project playlist/.test(rFallback.stderr),
    rFallback.stderr
  );
  const bytesFallback = await rawBytesOf(expectedOutPath(photo2, outDir('fallback')));
  const rPhoto2Default = runCli(['--out', outDir('photo2default'), photo2]);
  check('a plain default-look render of photo2 (no --project) exits 0', rPhoto2Default.status === 0, rPhoto2Default);
  const bytesPhoto2Default = await rawBytesOf(expectedOutPath(photo2, outDir('photo2default')));
  check(
    "the fallback render IS the default look (matches a plain default render of the same photo, not photo1's ev=2 look)",
    bytesFallback.equals(bytesPhoto2Default) && !bytesFallback.equals(bytesProject),
    { matchesDefault: bytesFallback.equals(bytesPhoto2Default), sameAsProjectLook: bytesFallback.equals(bytesProject) }
  );
  check('the playlist-fallback run never mutated the manifest', readFileSync(manifestPath, 'utf8') === manifestBefore, {
    before: manifestBefore,
    after: readFileSync(manifestPath, 'utf8'),
  });
  check('the playlist-fallback run never added a look file', JSON.stringify(readdirSync(looksDir).sort()) === JSON.stringify(looksBefore), {
    before: looksBefore,
    after: readdirSync(looksDir).sort(),
  });

  // =========================================================================
  console.log('verify-cli-project (2. rendering directly from a look file):');
  const rLookArg = runCli(['--out', outDir('lookarg'), photo1LookPath]);
  check('a bare look-file argument (standalone, no --project) exits 0', rLookArg.status === 0, {
    status: rLookArg.status,
    stderr: rLookArg.stderr,
  });
  const outLookArg = expectedOutPath(photo1, outDir('lookarg'));
  check(
    "the output filename is the PHOTO's basename (photo1.jpg), not the look file's",
    existsSync(outLookArg) && !existsSync(expectedOutPath(photo1LookPath, outDir('lookarg'))),
    { expected: outLookArg, wrongName: expectedOutPath(photo1LookPath, outDir('lookarg')) }
  );
  const bytesLookArg = await rawBytesOf(outLookArg);
  check(
    'renders byte-identical to the equivalent --project image render',
    bytesLookArg.equals(bytesProject),
    { sameBytes: bytesLookArg.equals(bytesProject) }
  );

  // A bare relative look path resolves against --project's dir, not the
  // launch cwd (CLI_USAGE's "path can be relative to project") — spawned
  // with cwd = workDir (NOT myProjectDir), so a wrong (cwd-relative)
  // resolution would fail to find the file at all.
  const rRelative = runCli(['--out', outDir('relative'), '--project', myProjectDir, 'looks/photo1.ARW.json'], { cwd: workDir });
  check('a relative look-file argument resolves against --project, not cwd', rRelative.status === 0, {
    status: rRelative.status,
    stderr: rRelative.stderr,
  });
  const bytesRelative = await rawBytesOf(expectedOutPath(photo1, outDir('relative')));
  check('…and renders the same look', bytesRelative.equals(bytesProject), { sameBytes: bytesRelative.equals(bytesProject) });

  // =========================================================================
  console.log('verify-cli-project (3. a look with no `photo` field is a clear per-file error):');
  const legacyStyle = join(workDir, 'legacy-style.silverbox.json');
  writeLookFile(legacyStyle, { develop: { basic: { ev: 1 } } }); // deliberately no `photo`
  const rNoPhoto = runCli(['--out', outDir('nophoto'), legacyStyle]);
  check('exits 1 (not a crash, not silently skipped)', rNoPhoto.status === 1, { status: rNoPhoto.status, stdout: rNoPhoto.stdout, stderr: rNoPhoto.stderr });
  check(
    'error names the `photo` field and the fix (pass the image instead)',
    /`photo`/.test(rNoPhoto.stdout + rNoPhoto.stderr) && /IMAGE/i.test(rNoPhoto.stdout + rNoPhoto.stderr),
    { stdout: rNoPhoto.stdout, stderr: rNoPhoto.stderr }
  );

  // =========================================================================
  console.log('verify-cli-project (4. --check --project: golden inside the project, etiquette, legacy note):');
  const rCheckUpdate = runCli(['--check', '--update', '--project', myProjectDir, '--json', photo1]);
  check('--check --update --project exits 0', rCheckUpdate.status === 0, { status: rCheckUpdate.status, stderr: rCheckUpdate.stderr });
  const projectGolden = join(myProjectDir, 'golden', 'photo1.ARW.png');
  check('golden PNG was written INSIDE the project (<project>/golden/<look-name>.png)', existsSync(projectGolden), projectGolden);
  const legacyGoldenNextToPhoto = `${photo1}.silverbox.golden.png`;
  check('etiquette: nothing new appeared next to the photo', !existsSync(legacyGoldenNextToPhoto), legacyGoldenNextToPhoto);
  check('--project --check does NOT print the legacy adjacent-golden note', !/legacy/i.test(rCheckUpdate.stderr), rCheckUpdate.stderr);
  check('the golden-writing run never mutated the manifest', readFileSync(manifestPath, 'utf8') === manifestBefore, {
    before: manifestBefore,
    after: readFileSync(manifestPath, 'utf8'),
  });

  const rCheckAgain = runCli(['--check', '--project', myProjectDir, '--json', photo1]);
  check('an immediate re-run (no edits) passes', rCheckAgain.status === 0, { status: rCheckAgain.status, stdout: rCheckAgain.stdout });
  const againLine = parseNdjson(rCheckAgain.stdout)[0];
  check('reports pass:true against the project golden', againLine?.pass === true, againLine);

  const legacyCheckPhoto = link('legacy-check.ARW');
  const rCheckLegacy = runCli(['--check', '--update', '--json', legacyCheckPhoto]);
  check('--check WITHOUT --project still works (legacy path)', rCheckLegacy.status === 0, rCheckLegacy);
  check(
    '…and prints the legacy adjacent-golden note on stderr',
    /legacy/i.test(rCheckLegacy.stderr) && /--project/.test(rCheckLegacy.stderr),
    rCheckLegacy.stderr
  );
  check('legacy path still writes next to the photo, unchanged', existsSync(`${legacyCheckPhoto}.silverbox.golden.png`), `${legacyCheckPhoto}.silverbox.golden.png`);

  // =========================================================================
  console.log('verify-cli-project (5. --diff with two photo-carrying looks, no --image):');
  const diffA = join(workDir, 'diffA.json');
  const diffB = join(workDir, 'diffB.json');
  writeLookFile(diffA, { develop: { basic: { ev: 0 } }, photo: photo1 });
  writeLookFile(diffB, { develop: { basic: { ev: 0.5 } }, photo: photo1 });
  const rDiff = runCli(['--diff', diffA, diffB, '--json']);
  check('--diff with no --image exits 0 when both sides agree on `photo`', rDiff.status === 0, { status: rDiff.status, stdout: rDiff.stdout, stderr: rDiff.stderr });
  const diffLine = parseNdjson(rDiff.stdout)[0];
  check('the image was derived (input === the shared photo path)', diffLine?.input === photo1, diffLine);
  check('reports param lines and ΔE stats', Array.isArray(diffLine?.lines) && typeof diffLine?.deltaE?.mean === 'number', diffLine);

  const diffC = join(workDir, 'diffC.json');
  writeLookFile(diffC, { develop: { basic: { ev: 0.2 } }, photo: photo2 }); // a DIFFERENT photo than diffA
  const rDiffMismatch = runCli(['--diff', diffA, diffC, '--json']);
  check('--diff with disagreeing `photo` fields and no --image exits 1', rDiffMismatch.status === 1, rDiffMismatch);
  const mismatchLine = parseNdjson(rDiffMismatch.stdout)[0];
  check('reports a clear "could not derive" error, not a silent guess', !!mismatchLine?.error && /could not derive/.test(mismatchLine.error), mismatchLine);

  // Explicit --image still wins even when both sides carry `photo` (existing
  // behavior priority, unchanged by this feature).
  const rDiffExplicit = runCli(['--diff', diffA, diffB, '--image', photo1, '--json']);
  check('an explicit --image is still honored alongside photo-carrying looks', rDiffExplicit.status === 0, rDiffExplicit);

  // =========================================================================
  console.log('verify-cli-project (6. --help documents --project and look-file rendering):');
  const rHelp = runCli(['--help']);
  check('--help documents --project <dir>', /--project <dir>/.test(rHelp.stdout), rHelp.stdout);
  check('--help documents rendering directly from a look file', /look file/i.test(rHelp.stdout), rHelp.stdout);
  check("--help documents --diff's --image now being optional", /OMITTED/.test(rHelp.stdout), rHelp.stdout);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
