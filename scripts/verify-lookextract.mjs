/**
 * Look extraction verify (docs/brief-bank/look-extraction.md, mode 1 —
 * sidecar-consensus distillation): CLI-only, exactly like verify-diff.mjs's
 * own Part 2 — a real, windowless `electron <projectRoot> --render
 * --extract-look …` invocation, never driven through the UI (v1 has no
 * in-app entry point at all — "GUI: none in v1 beyond presets appearing in
 * the existing menu", per the brief). Fixture look files are hand-written
 * schemaVersion-4 JSON (the wire shape — see verify-cli.mjs's own doc
 * comment: nodes carry `type`, edges carry `from`/`to`).
 *
 * Checks:
 *  1. Four fixture looks agreeing tightly on `basic.ev`, wildly divergent on
 *     WB (temp/tint spanning their full sliders) → the written preset's
 *     `includes` contains 'basic-tone', excludes 'wb'; the preset's own
 *     Develop node carries the exact median ev and IDENTITY temp/tint (the
 *     excluded family never gets averaged in) — verified both from the
 *     CLI's own NDJSON outcome AND by reading the preset file back off disk.
 *  2. `--families basic-tone` restricts consideration — every other family
 *     reports "excluded by filter" regardless of how well the inputs
 *     actually agree (they agree perfectly here, at default).
 *  3. The written preset applies cleanly through the REAL preset machinery:
 *     `--preset <extracted.json>` on an ordinary `--render` renders exit 0.
 *  4. Human-mode output prints the written path + per-family report lines
 *     that parse (INCLUDED/EXCLUDED/SKIPPED, one per family).
 *  5. Bad usage / runtime failures: fewer than two looks, missing --out, an
 *     unknown/structural --families id, a missing look file, --help
 *     documents --extract-look.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-lookextract-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-lookextract-userdata-'));

const nowIso = () => new Date().toISOString();

/** schemaVersion-4 wire wrapper — the exact shape serializeGraphDoc writes (same helper as verify-cli.mjs/verify-diff.mjs). */
function graphWrapper(nodes, edges) {
  return { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph: { nodes, edges } };
}

/** The default input->Develop->output chain, `develop` merged onto identity defaults by parseGraphDoc's own sanitizer. */
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

function writeLookFile(path, develop) {
  const { nodes, edges } = simpleLook(develop);
  writeFileSync(path, JSON.stringify(graphWrapper(nodes, edges), null, 2) + '\n');
  return path;
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
  // === 1. Basic consensus: agreeing ev, wildly divergent WB =================
  console.log('verify-lookextract (1. consensus medians an agreeing family, excludes a divergent one):');
  const evs = [0.4, 0.45, 0.5, 0.42];
  const temps = [2000, 15000, 30000, 50000]; // spans the FULL 2000..50000 slider domain
  const tints = [-150, -50, 50, 150]; // spans the FULL -150..150 slider domain
  const lookPaths = evs.map((ev, i) => writeLookFile(join(workDir, `look-${i}.json`), { basic: { ev, temp: temps[i], tint: tints[i] } }));
  const outPath = join(workDir, 'extracted.json');

  const rJson = runCli(['--extract-look', ...lookPaths, '--out', outPath, '--json']);
  check('exits 0 (family exclusions are expected, not a failure)', rJson.status === 0, { status: rJson.status, stdout: rJson.stdout, stderr: rJson.stderr });
  const outcome = parseNdjson(rJson.stdout)[0];
  check('NDJSON carries {outputPath,includes,excluded,report}', outcome?.outputPath === outPath && Array.isArray(outcome.includes) && Array.isArray(outcome.excluded) && Array.isArray(outcome.report), outcome);
  check("includes 'basic-tone'", outcome?.includes.includes('basic-tone'), outcome?.includes);
  check("excludes 'wb'", !outcome?.includes.includes('wb') && outcome?.excluded.includes('wb'), outcome);

  check('the preset file was actually written', existsSync(outPath), outPath);
  const written = JSON.parse(readFileSync(outPath, 'utf8'));
  check('written preset carries includes matching the CLI outcome', JSON.stringify(written.includes) === JSON.stringify(outcome.includes), { written: written.includes, outcome: outcome.includes });
  const devNode = written.look.graph.nodes.find((n) => n.type === 'Develop');
  // median([0.40, 0.42, 0.45, 0.50]) = (0.42+0.45)/2
  check('extracted basic.ev is the median of the inputs', Math.abs(devNode.develop.basic.ev - 0.435) < 1e-9, devNode.develop.basic.ev);
  check('excluded wb stays at IDENTITY (0), never an averaged Kelvin nobody asked for', devNode.develop.basic.temp === 0 && devNode.develop.basic.tint === 0, devNode.develop.basic);

  // === 2. --families restricts consideration =================================
  console.log('verify-lookextract (2. --families restricts which families are even considered):');
  const outPathFiltered = join(workDir, 'extracted-filtered.json');
  const rFiltered = runCli(['--extract-look', ...lookPaths, '--out', outPathFiltered, '--families', 'basic-tone', '--json']);
  check('exits 0', rFiltered.status === 0, rFiltered);
  const outcomeFiltered = parseNdjson(rFiltered.stdout)[0];
  check('includes is EXACTLY [basic-tone]', JSON.stringify(outcomeFiltered?.includes) === JSON.stringify(['basic-tone']), outcomeFiltered?.includes);
  check(
    'every other family is reported excluded even though it trivially agrees (all default)',
    outcomeFiltered?.report.some((l) => l.startsWith('curves:') && l.includes('SKIPPED')) &&
      outcomeFiltered?.report.some((l) => l.startsWith('hsl:') && l.includes('SKIPPED')),
    outcomeFiltered?.report
  );

  // === 3. The extracted preset applies cleanly through the REAL preset machinery ===
  console.log('verify-lookextract (3. the extracted preset applies through --render --preset):');
  const arw = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
  const outDir = join(workDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const rRender = runCli(['--out', outDir, '--preset', outPath, arw]);
  check('rendering with the extracted preset exits 0 (parses/applies through the real machinery)', rRender.status === 0, { status: rRender.status, stdout: rRender.stdout, stderr: rRender.stderr });

  // === 4. Human-mode output ===================================================
  console.log('verify-lookextract (4. human-mode output prints the written path + per-family report):');
  const rHuman = runCli(['--extract-look', ...lookPaths, '--out', join(workDir, 'extracted-human.json')]);
  check('exits 0', rHuman.status === 0, rHuman);
  check('prints "wrote <path>"', rHuman.stdout.includes(`wrote ${join(workDir, 'extracted-human.json')}`), rHuman.stdout);
  check('reports basic-tone INCLUDED', /basic-tone: INCLUDED/.test(rHuman.stdout), rHuman.stdout);
  check('reports wb EXCLUDED', /wb: EXCLUDED/.test(rHuman.stdout), rHuman.stdout);

  // === 5. Bad usage / runtime failures =========================================
  console.log('verify-lookextract (5. bad usage and runtime failures):');
  const rOneLook = runCli(['--extract-look', lookPaths[0], '--out', outPath]);
  check('a single look file is bad usage (exit 2)', rOneLook.status === 2, rOneLook);

  const rNoOut = runCli(['--extract-look', ...lookPaths]);
  check('missing --out is bad usage (exit 2)', rNoOut.status === 2, rNoOut);

  const rBadFamily = runCli(['--extract-look', ...lookPaths, '--out', join(workDir, 'never-written.json'), '--families', 'spots', '--json']);
  check('an unknown/structural --families id is a runtime failure (exit 1), not bad usage', rBadFamily.status === 1, rBadFamily);
  const badFamilyLine = parseNdjson(rBadFamily.stdout)[0];
  check('reports a clear error naming the bad id', !!badFamilyLine?.error && /spots/.test(badFamilyLine.error), badFamilyLine);
  check('never wrote the output file', !existsSync(join(workDir, 'never-written.json')), null);

  const missingLook = join(workDir, 'does-not-exist.json');
  const rMissing = runCli(['--extract-look', missingLook, lookPaths[0], '--out', join(workDir, 'never-written-2.json'), '--json']);
  check('a missing look file exits 1', rMissing.status === 1, rMissing);
  const missingLine = parseNdjson(rMissing.stdout)[0];
  check('NDJSON carries {error}', !!missingLine?.error, missingLine);

  const rHelp = runCli(['--help']);
  check("--help documents --extract-look's usage line", /--extract-look <look…>/.test(rHelp.stdout), rHelp.stdout);
  check('--help documents the files-only boundary (no scraping/network/auth)', /no scraping, no\s*\n?\s*network, no\s*\n?\s*auth/.test(rHelp.stdout) || /no scraping/.test(rHelp.stdout), rHelp.stdout);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
