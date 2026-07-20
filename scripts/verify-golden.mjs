/**
 * Golden renders verify (ROADMAP "Golden renders" — `silverbox-render --check`,
 * extending the headless CLI renderer verified by verify-cli.mjs). Same
 * pattern as verify-cli.mjs: spawns the REAL CLI (`electron <projectRoot>
 * --render --check …`), a genuine windowless app instance per invocation,
 * rather than driving the app through Playwright — nothing here needs an
 * open window, and a real process is the only way to prove `--check`'s exit
 * code and NDJSON actually work end to end.
 *
 * Isolation: every image is its OWN hardlink of the shared test ARW, and a
 * single userData temp dir (reused across every `--render` call in this
 * script) — same as verify-cli.mjs, since `--check` reuses that machinery
 * unchanged (windowless mode, userData isolation).
 *
 * Checks (brief's numbered list):
 *  1. `--check --update` on a freshly-sidecar'd image (non-default EV, so
 *     this is a real "protect this look" case) creates
 *     `<image>.silverbox.golden.png`: a valid PNG (sharp can decode it),
 *     512px long edge.
 *  2. An immediate `--check` (no edit in between) passes with mean ΔE well
 *     under the brief's documented "should be ≈0" bar — the pipeline is
 *     deterministic (no grain in this sidecar) so two separate CLI
 *     invocations of the identical look must reproduce the identical
 *     512px PNG bytes up to lossless-PNG round-trip, i.e. ΔE 0.
 *  3. Bumping the sidecar's EV by +0.3 EXTERNALLY (hand-edited JSON, like an
 *     AI/editor touching the sidecar between CLI runs) makes the next
 *     `--check` FAIL: exit 1, `pass:false`, a large (>1) mean ΔE — a
 *     sensibly-sized drift for a linear +0.3 EV gain across the whole
 *     frame — and the NDJSON line still parses.
 *  4. `--check --update` again re-syncs the golden to the new look; the
 *     following `--check` passes again.
 *  5. A second image with NO golden, in the SAME invocation as one that has
 *     one: the golden-having image still reports its normal pass/fail, the
 *     golden-less one reports `{status:"no-golden"}` (a FAILURE — exit 1 —
 *     without `--update`) and does NOT create a golden file; `--update`
 *     alone then creates it.
 *  6. (Not exercised by this script — see shared/color/deltaE.test.ts,
 *     vitest's `unit` pool entry) the ΔE module's own known-pair unit tests:
 *     white/white = 0, black/white ≈ 100, a slightly shifted color is a
 *     small ΔE.
 *
 * Plus two bad-usage checks exercising cliArgs.ts's new mode-exclusivity
 * validation: `--check` combined with a render-only flag, and `--update`
 * without `--check`, both exit 2.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { seedLibraryDir } from './lib/testProject.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-golden-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-golden-userdata-'));
// The visible library (docs/brief-bank/linked-looks-stage-e.md) — see
// verify-cli.mjs's own identical comment: an isolated libraryDir keeps a
// standalone run off the real ~/Silverbox/Library.
if (ownUserData) seedLibraryDir(userDataDir);

function link(name, src = SRC_ARW) {
  const dst = join(workDir, name);
  linkSync(src, dst);
  return dst;
}

const nowIso = () => new Date().toISOString();

/** schemaVersion-4 wire wrapper — the exact shape serializeGraphDoc writes (see verify-cli.mjs). */
function graphWrapper(nodes, edges) {
  return { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph: { nodes, edges } };
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

const sidecarPathFor = (arwPath) => `${arwPath}.silverbox.json`;
const goldenPathFor = (arwPath) => `${arwPath}.silverbox.golden.png`;

function writeSidecar(arwPath, develop) {
  const { nodes, edges } = simpleLook(develop);
  writeFileSync(sidecarPathFor(arwPath), JSON.stringify(graphWrapper(nodes, edges), null, 2) + '\n');
}

const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

/** Spawn the real CLI. Returns {status, stdout, stderr}. */
function runCli(args) {
  return spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Parse every non-empty stdout line as NDJSON; null entries surface a parse failure to the caller's check(). */
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

try {
  // =========================================================================
  console.log('verify-golden (1. --check --update creates a golden PNG):');
  const arwA = link('golden-a.ARW');
  // A non-default look (ev != 0), so protecting it is a meaningful case, not
  // an accidental coincidence with the default-look render.
  writeSidecar(arwA, { basic: { ev: 0.6 } });

  const r1 = runCli(['--check', '--update', arwA]);
  check('--check --update exits 0', r1.status === 0, { status: r1.status, stdout: r1.stdout, stderr: r1.stderr });
  const golden = goldenPathFor(arwA);
  check('golden PNG file exists', existsSync(golden), golden);
  const meta1 = await sharp(golden).metadata();
  check('golden is a valid PNG', meta1.format === 'png', meta1);
  check('golden long edge is 512', Math.max(meta1.width, meta1.height) === 512, meta1);

  // =========================================================================
  console.log('verify-golden (2. immediate --check passes with ΔE ≈ 0):');
  const r2 = runCli(['--check', '--json', arwA]);
  check('--check exits 0', r2.status === 0, { status: r2.status, stdout: r2.stdout, stderr: r2.stderr });
  const [line2] = parseNdjson(r2.stdout);
  check('NDJSON parses and carries a deltaE object', !!line2?.deltaE, r2.stdout);
  check(
    'deterministic re-render (no grain in this sidecar): mean ΔE < 0.05',
    (line2?.deltaE?.mean ?? Infinity) < 0.05,
    line2
  );
  check('reported pass:true', line2?.pass === true, line2);

  // =========================================================================
  console.log('verify-golden (3. bumping the sidecar EV externally makes --check FAIL):');
  {
    const doc = JSON.parse(readFileSync(sidecarPathFor(arwA), 'utf8'));
    const devNode = doc.graph.nodes.find((n) => n.id === 'dev');
    devNode.develop.basic.ev += 0.3;
    writeFileSync(sidecarPathFor(arwA), JSON.stringify(doc, null, 2) + '\n');
  }
  const r3 = runCli(['--check', '--json', arwA]);
  check('--check exits 1 after the external +0.3 EV edit', r3.status === 1, { status: r3.status, stdout: r3.stdout });
  const [line3] = parseNdjson(r3.stdout);
  check('NDJSON still parses', line3 !== null, r3.stdout);
  check('reported pass:false', line3?.pass === false, line3);
  check('mean ΔE > 1 (a sensibly-sized drift for +0.3 EV across the whole frame)', (line3?.deltaE?.mean ?? 0) > 1, line3);

  // =========================================================================
  console.log('verify-golden (4. --check --update again re-syncs the golden):');
  const r4 = runCli(['--check', '--update', arwA]);
  check('--check --update exits 0', r4.status === 0, { status: r4.status, stdout: r4.stdout, stderr: r4.stderr });
  const r4b = runCli(['--check', '--json', arwA]);
  const [line4b] = parseNdjson(r4b.stdout);
  check('--check now passes again', r4b.status === 0 && line4b?.pass === true, { status: r4b.status, line: line4b });

  // =========================================================================
  console.log('verify-golden (5. a second image with no golden, same invocation):');
  const arwB = link('golden-b.ARW');
  writeSidecar(arwB, { basic: { ev: -0.4 } });
  const r5 = runCli(['--check', '--json', arwA, arwB]);
  check('mixed batch (one golden, one missing) exits 1', r5.status === 1, { status: r5.status, stdout: r5.stdout });
  const lines5 = parseNdjson(r5.stdout);
  const lineA = lines5.find((l) => l?.input === arwA);
  const lineB = lines5.find((l) => l?.input === arwB);
  check('the image WITH a golden still reports pass:true', lineA?.pass === true, lineA);
  check('the image WITHOUT a golden reports status:"no-golden"', lineB?.status === 'no-golden', lineB);
  check('no golden file was created for it (no --update given)', !existsSync(goldenPathFor(arwB)), goldenPathFor(arwB));

  const r5u = runCli(['--check', '--update', '--json', arwB]);
  check('--update creates the previously-missing golden', r5u.status === 0 && existsSync(goldenPathFor(arwB)), {
    status: r5u.status,
    exists: existsSync(goldenPathFor(arwB)),
  });

  // =========================================================================
  console.log('verify-golden (bad usage: --check does not mix with render-only flags, --update needs --check):');
  const rBadMix = runCli(['--check', '--preset', 'whatever', arwA]);
  check('--check + --preset is bad usage (exit 2)', rBadMix.status === 2, rBadMix);
  const rBadUpdate = runCli(['--update', arwA]);
  check('--update without --check is bad usage (exit 2)', rBadUpdate.status === 2, rBadUpdate);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
