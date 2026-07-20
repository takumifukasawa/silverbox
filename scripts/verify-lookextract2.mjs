/**
 * Look extraction MODE 2, stage 1 verify (docs/brief-bank/
 * look-extraction-mode2-stage1.md — the spike): the reference-set statistical
 * TONE solve, end to end through the real CLI, exactly like verify-lookextract.mjs
 * (mode 1) — a windowless `electron <projectRoot> --render --from-references …`
 * invocation, never driven through the UI (v1 has no in-app entry point).
 *
 * The correctness proof of the SOLVE itself (known curve → recover it) is the
 * unit test (engine/look/solve.test.ts); this script is the CLI/E2E half:
 * synthetic references are produced by RENDERING the test image through a KNOWN
 * tone curve (a strong lift, and a strong drop), so the extracted curve's
 * DIRECTION is checkable without decoding output pixels — since both extractions
 * share the SAME placeholder baseline, the bright-ref curve must sit ABOVE the
 * dark-ref curve at every interior control point (a relative direction proof
 * independent of the placeholder's realism).
 *
 * Checks:
 *  1. --from-references over 2 synthetic refs emits a preset; NDJSON carries
 *     {outputPath,solved,deferred,imageCount,report}; solved === ['tone'],
 *     deferred === the 4 stage-2 stages, imageCount === 2.
 *  2. The written preset is curves-only (includes === ['curves']) with a
 *     non-identity, monotone toneCurve.rgb.
 *  3. Direction: the BRIGHT-ref curve sits at/above the DARK-ref curve at every
 *     interior control point, strictly above at the midtone — the solved tone
 *     moves luma toward the reference set.
 *  4. The extracted preset applies cleanly through the REAL preset machinery
 *     (`--render --preset <extracted.json>` exits 0).
 *  5. Bad usage / runtime failures: no images, missing --out, a missing
 *     reference image, --help documents --from-references + the files-only
 *     boundary.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedLibraryDir } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-lookextract2-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-lookextract2-userdata-'));
// The visible library (docs/brief-bank/linked-looks-stage-e.md): an isolated
// libraryDir keeps a standalone run off the real ~/Silverbox/Library (the boot
// migration would otherwise mkdir into it) — same seed verify-lookextract does.
if (ownUserData) seedLibraryDir(userDataDir);

const nowIso = () => new Date().toISOString();
const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');
const ARW = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 180_000,
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
    })
    .filter(Boolean);
}

/** A valid preset FILE carrying a curves-only KNOWN look (the injected tone curve). */
function writeKnownPreset(path, rgbPoints) {
  const graph = {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 } },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop: { toneCurve: { rgb: rgbPoints } } },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
  const preset = {
    presetVersion: 1,
    name: 'known-look',
    createdAt: nowIso(),
    includes: ['curves'],
    look: { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph },
  };
  writeFileSync(path, JSON.stringify(preset, null, 2) + '\n');
  return path;
}

/** Render one source image through a known-look preset into `dir`; return the produced file's path. */
function renderRef(source, presetPath, dir) {
  mkdirSync(dir, { recursive: true });
  const r = runCli(['--out', dir, '--preset', presetPath, source]);
  if (r.status !== 0) throw new Error(`render ref failed (${source}): ${r.stdout}\n${r.stderr}`);
  const produced = readdirSync(dir).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f));
  if (produced.length === 0) throw new Error(`render produced no output in ${dir}`);
  return join(dir, produced[0]);
}

/** true when the point set is NOT the identity curve. */
function isIdentity(points) {
  return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 255 && points[1][1] === 255;
}

const IDENTITY_STAGES = ['global-chroma', 'hsl-bands', 'grading-wheels', 'grain'];

try {
  // A strong LIFT and a strong DROP — clearly separated reference looks.
  const liftPreset = writeKnownPreset(join(workDir, 'lift.json'), [[0, 0], [64, 110], [128, 195], [192, 238], [255, 255]]);
  const dropPreset = writeKnownPreset(join(workDir, 'drop.json'), [[0, 0], [64, 22], [128, 60], [192, 140], [255, 255]]);

  // Two synthetic bright refs (test ARW + JPG rendered through the lift) and
  // two dark refs (same two sources through the drop).
  console.log('verify-lookextract2 (rendering synthetic reference sets)…');
  const brightRefs = [renderRef(ARW, liftPreset, join(workDir, 'bright-arw')), renderRef(JPG, liftPreset, join(workDir, 'bright-jpg'))];
  const darkRefs = [renderRef(ARW, dropPreset, join(workDir, 'dark-arw')), renderRef(JPG, dropPreset, join(workDir, 'dark-jpg'))];

  // === 1. Extract from the bright set: NDJSON shape + stage report ===========
  console.log('verify-lookextract2 (1. --from-references emits a tone-solved preset):');
  const brightOut = join(workDir, 'extracted-bright.json');
  const rBright = runCli(['--from-references', ...brightRefs, '--out', brightOut, '--json']);
  check('exits 0', rBright.status === 0, { status: rBright.status, stdout: rBright.stdout, stderr: rBright.stderr });
  const brightOutcome = parseNdjson(rBright.stdout)[0];
  check(
    'NDJSON carries {outputPath,solved,deferred,imageCount,report}',
    brightOutcome?.outputPath === brightOut &&
      Array.isArray(brightOutcome.solved) &&
      Array.isArray(brightOutcome.deferred) &&
      typeof brightOutcome.imageCount === 'number' &&
      Array.isArray(brightOutcome.report),
    brightOutcome
  );
  check("solved is exactly ['tone']", JSON.stringify(brightOutcome?.solved) === JSON.stringify(['tone']), brightOutcome?.solved);
  check('deferred is the 4 stage-2 stages', JSON.stringify(brightOutcome?.deferred) === JSON.stringify(IDENTITY_STAGES), brightOutcome?.deferred);
  check('imageCount === 2 (the set was aggregated)', brightOutcome?.imageCount === 2, brightOutcome?.imageCount);

  // === 2. The written preset is curves-only, non-identity, monotone ==========
  console.log('verify-lookextract2 (2. the written preset is curves-only + a real tone curve):');
  check('preset file was written', existsSync(brightOut), brightOut);
  const brightPreset = JSON.parse(readFileSync(brightOut, 'utf8'));
  check("includes is exactly ['curves']", JSON.stringify(brightPreset.includes) === JSON.stringify(['curves']), brightPreset.includes);
  const brightDev = brightPreset.look.graph.nodes.find((n) => n.type === 'Develop');
  const brightRgb = brightDev?.develop?.toneCurve?.rgb;
  check('toneCurve.rgb is present and non-identity', Array.isArray(brightRgb) && !isIdentity(brightRgb), brightRgb);
  check(
    'toneCurve.rgb is strictly-increasing x, monotone y, pinned endpoints',
    Array.isArray(brightRgb) &&
      brightRgb[0][0] === 0 &&
      brightRgb[0][1] === 0 &&
      brightRgb[brightRgb.length - 1][0] === 255 &&
      brightRgb[brightRgb.length - 1][1] === 255 &&
      brightRgb.every((p, i) => i === 0 || (p[0] > brightRgb[i - 1][0] && p[1] >= brightRgb[i - 1][1])),
    brightRgb
  );

  // === 3. Direction: bright curve sits above the dark curve ===================
  console.log('verify-lookextract2 (3. the solved tone tracks the reference distribution):');
  const darkOut = join(workDir, 'extracted-dark.json');
  const rDark = runCli(['--from-references', ...darkRefs, '--out', darkOut, '--json']);
  check('dark-set extraction exits 0', rDark.status === 0, { status: rDark.status, stdout: rDark.stdout, stderr: rDark.stderr });
  const darkPreset = JSON.parse(readFileSync(darkOut, 'utf8'));
  const darkRgb = darkPreset.look.graph.nodes.find((n) => n.type === 'Develop')?.develop?.toneCurve?.rgb;
  // Both extractions share the SAME placeholder baseline → identical interior
  // x-coordinates; compare y's directly (the interior points, excluding the
  // shared pinned endpoints).
  const brightInterior = brightRgb.slice(1, -1);
  const darkInterior = darkRgb.slice(1, -1);
  check(
    'both curves share the same interior control x-coordinates (fixed baseline)',
    brightInterior.length === darkInterior.length && brightInterior.every((p, i) => p[0] === darkInterior[i][0]),
    { bright: brightInterior.map((p) => p[0]), dark: darkInterior.map((p) => p[0]) }
  );
  check(
    'bright-ref curve sits at/above the dark-ref curve at every interior control point',
    brightInterior.every((p, i) => p[1] >= darkInterior[i][1]),
    { bright: brightInterior.map((p) => p[1]), dark: darkInterior.map((p) => p[1]) }
  );
  const midIdx = Math.floor(brightInterior.length / 2);
  check(
    'strictly above at the midtone (the look genuinely moves luma toward the refs)',
    brightInterior[midIdx][1] > darkInterior[midIdx][1],
    { brightMid: brightInterior[midIdx], darkMid: darkInterior[midIdx] }
  );

  // === 4. The extracted preset applies through the REAL preset machinery ======
  console.log('verify-lookextract2 (4. the extracted preset applies through --render --preset):');
  const applyDir = join(workDir, 'apply-out');
  mkdirSync(applyDir, { recursive: true });
  const rApply = runCli(['--out', applyDir, '--preset', brightOut, ARW]);
  check('rendering with the extracted preset exits 0', rApply.status === 0, { status: rApply.status, stdout: rApply.stdout, stderr: rApply.stderr });

  // === 5. Human-mode output ===================================================
  console.log('verify-lookextract2 (5. human-mode output prints the written path + stage report):');
  const rHuman = runCli(['--from-references', ...brightRefs, '--out', join(workDir, 'extracted-human.json')]);
  check('exits 0', rHuman.status === 0, rHuman);
  check('prints "wrote <path>" with the solved/deferred summary', /wrote .*solved: tone.*deferred:/.test(rHuman.stdout), rHuman.stdout);

  // === 6. Bad usage / runtime failures ========================================
  console.log('verify-lookextract2 (6. bad usage and runtime failures):');
  const rNoOut = runCli(['--from-references', ...brightRefs]);
  check('missing --out is bad usage (exit 2)', rNoOut.status === 2, rNoOut.status);
  const rNoImages = runCli(['--from-references', '--out', join(workDir, 'never.json')]);
  check('no reference images is bad usage (exit 2)', rNoImages.status === 2, rNoImages.status);
  const missing = join(workDir, 'does-not-exist.jpg');
  const rMissing = runCli(['--from-references', missing, '--out', join(workDir, 'never2.json'), '--json']);
  check('a missing reference image exits 1', rMissing.status === 1, rMissing.status);
  const missingLine = parseNdjson(rMissing.stdout)[0];
  check('NDJSON carries {error}', !!missingLine?.error, missingLine);
  check('never wrote the output file on a decode failure', !existsSync(join(workDir, 'never2.json')), null);

  const rHelp = runCli(['--help']);
  check("--help documents --from-references' usage line", /--from-references <image…>/.test(rHelp.stdout), rHelp.stdout);
  check('--help documents the files-only boundary (no scraping/network/auth)', /no scraping, no network, no auth/.test(rHelp.stdout), rHelp.stdout);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
