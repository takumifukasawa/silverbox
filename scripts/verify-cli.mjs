/**
 * Headless CLI renderer verify (ROADMAP "Headless CLI renderer" — the batch
 * half of the text-first workflow: `git pull` a photo repo, run the CLI, get
 * JPEGs). Unlike every other verify-*.mjs script, this one does NOT drive the
 * app through Playwright — it spawns the REAL CLI (`electron <projectRoot>
 * --render …`, main/index.ts's `isCliRenderMode`), a genuine windowless app
 * instance per invocation, exactly the way a user's terminal would. Fixture
 * sidecars/presets are hand-written schemaVersion-4 JSON (the wire shape —
 * see graphDoc.ts's serializeGraphDoc/parseGraphDoc: nodes carry `type`, not
 * `kind`; edges carry `from`/`to`, not `source`/`target`) rather than driven
 * through the UI, since nothing here needs the app open first.
 *
 * Isolation: every image the CLI touches is its OWN hardlink of the shared
 * test ARW (never the real file — sidecars land right next to it), and a
 * single userData temp dir (reused across every `--render` call in this
 * script, minted fresh unless the runner already assigned one) isolates
 * `<userData>/presets` for the --preset-by-name check.
 *
 * Checks:
 *  1. No sidecar → the default look (base curve + lens profile) renders:
 *     output exists, full resolution, and its pixels differ measurably from
 *     an explicit-identity-sidecar ("neutral") render of the same source —
 *     proving the defaults actually applied, not a pass-through. A sidecar
 *     (ev=1, written by this script) → output differs from the no-sidecar
 *     render.
 *  2. --preset by path applies on top of IDENTITY geometry (ignoring the
 *     image's own sidecar entirely, crop included) and differs from the
 *     default-look render; --preset by NAME resolves by slug against
 *     <userData>/presets too. --quality 60 is a smaller file than 95;
 *     --max-dim caps the long edge.
 *  3. Two good inputs in one invocation → two outputs, exit 0. One good +
 *     one missing file → the good one still lands, exit 1, the bad one
 *     reported (stderr in human mode; both `--json` NDJSON parses, one
 *     object with `output`, one with `error`).
 *  4. --output all on a two-output sidecar → suffixed files, one per output,
 *     with genuinely different pixels (the second output bypasses Develop).
 *  5. Windowless: a plain invocation completes cleanly — there is no way to
 *     assert invisibility from a script; this documents that main/index.ts's
 *     `headless` flag reuses the exact SILVERBOX_TEST windowless machinery
 *     the rest of the suite already runs on, just without requiring the env
 *     var.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SRC_ARW = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const SRC_JPG = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const FULL_WIDTH = 4624;
const FULL_HEIGHT = 3080;

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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-cli-verify-'));
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-cli-userdata-'));
const outDir = join(workDir, 'out');
mkdirSync(outDir, { recursive: true });

function link(name, src = SRC_ARW) {
  const dst = join(workDir, name);
  linkSync(src, dst);
  return dst;
}

let jpgLinked = null;
try {
  jpgLinked = link('smoke.JPG', SRC_JPG);
} catch {
  // some environments may lack the JPG fixture — the one check that wants it
  // (below) just skips itself.
}

const nowIso = () => new Date().toISOString();

/** schemaVersion-4 wire wrapper — the exact shape serializeGraphDoc writes. */
function graphWrapper(nodes, edges) {
  return { schemaVersion: 4, createdAt: nowIso(), updatedAt: nowIso(), graph: { nodes, edges } };
}

/** The default input->Develop->output chain, `develop` merged onto identity defaults (mergeDevelopParams fills the rest). */
function simpleLook(develop, inputExtra) {
  return {
    nodes: [
      { id: 'in', type: 'input', position: { x: 20, y: 60 }, ...inputExtra },
      { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, ...(develop ? { develop } : {}) },
      { id: 'out', type: 'output', position: { x: 420, y: 60 } },
    ],
    edges: [
      { id: 'e0', from: 'in', to: 'dev' },
      { id: 'e1', from: 'dev', to: 'out' },
    ],
  };
}

function writeSidecar(arwPath, { develop, inputExtra } = {}) {
  const { nodes, edges } = simpleLook(develop, inputExtra);
  writeFileSync(arwPath + '.silverbox.json', JSON.stringify(graphWrapper(nodes, edges), null, 2) + '\n');
}

/** A preset FILE: presetDoc.ts's wire shape — `look` embeds a whole schemaVersion-4 wrapper, not a bare graph. */
function writePresetFile(path, name, develop) {
  const { nodes, edges } = simpleLook(develop);
  const wrapper = { presetVersion: 1, name, createdAt: nowIso(), look: graphWrapper(nodes, edges) };
  writeFileSync(path, JSON.stringify(wrapper, null, 2) + '\n');
}

const ELECTRON_BIN = join(projectRoot, 'node_modules', '.bin', 'electron');

/** Spawn the real CLI. Returns {status, stdout, stderr}. */
function runCli(args) {
  const result = spawnSync(ELECTRON_BIN, [projectRoot, '--render', ...args], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result;
}

function expectedOutPath(inputPath, dir) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, '');
  return join(dir, `${stem}.jpg`);
}

async function meanOf(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  const n = info.width * info.height * info.channels;
  for (let i = 0; i < n; i++) sum += data[i];
  return sum / n / 255;
}

/**
 * Raw decoded bytes — used for "these two renders actually differ" checks
 * instead of a mean-brightness threshold: two quite different looks (e.g. a
 * curve shift vs. a flat +1EV) can coincidentally land within a hair of the
 * same AVERAGE brightness while every pixel is different, so byte inequality
 * is the direct, unambiguous version of "pixels differ" the brief asks for.
 */
async function rawBytesOf(path) {
  return sharp(path).raw().toBuffer();
}

try {
  // =========================================================================
  console.log('verify-cli (1. no sidecar = default look; a sidecar changes the render):');
  const arwNoSidecar = link('nosidecar.ARW');
  const arwNeutral = link('neutral.ARW');
  writeSidecar(arwNeutral); // explicit identity look — a sidecar exists, so the fresh-open defaults never get injected (usedSidecar suppresses them)
  const arwWithSidecar = link('withsidecar.ARW');
  writeSidecar(arwWithSidecar, { develop: { basic: { ev: 1 } } });

  const r1 = runCli(['--out', outDir, arwNoSidecar]);
  check('no-sidecar render exits 0', r1.status === 0, { status: r1.status, stderr: r1.stderr });
  const outNoSidecar = expectedOutPath(arwNoSidecar, outDir);
  check('output file exists', existsSync(outNoSidecar), outNoSidecar);
  const metaNoSidecar = await sharp(outNoSidecar).metadata();
  check(
    `output is full resolution ${FULL_WIDTH}x${FULL_HEIGHT}`,
    metaNoSidecar.width === FULL_WIDTH && metaNoSidecar.height === FULL_HEIGHT,
    metaNoSidecar
  );

  const r1n = runCli(['--out', outDir, arwNeutral]);
  check('neutral (identity sidecar) render exits 0', r1n.status === 0, { status: r1n.status, stderr: r1n.stderr });
  const bytesNoSidecar = await rawBytesOf(outNoSidecar);
  const bytesNeutral = await rawBytesOf(expectedOutPath(arwNeutral, outDir));
  check(
    'default-look render differs from a neutral (identity) render — defaults actually applied',
    !bytesNoSidecar.equals(bytesNeutral),
    { sameBytes: bytesNoSidecar.equals(bytesNeutral) }
  );

  const r1s = runCli(['--out', outDir, arwWithSidecar]);
  check('with-sidecar (ev=1) render exits 0', r1s.status === 0, { status: r1s.status, stderr: r1s.stderr });
  const bytesWithSidecar = await rawBytesOf(expectedOutPath(arwWithSidecar, outDir));
  check(
    'a sidecar changes the render vs. the no-sidecar default-look render',
    !bytesWithSidecar.equals(bytesNoSidecar),
    { sameBytes: bytesWithSidecar.equals(bytesNoSidecar) }
  );

  if (jpgLinked) {
    const rJpg = runCli(['--out', outDir, jpgLinked]);
    check('a plain JPEG input renders too (no RAW-only assumption)', rJpg.status === 0 && existsSync(expectedOutPath(jpgLinked, outDir)), {
      status: rJpg.status,
      stderr: rJpg.stderr,
    });
  }

  // =========================================================================
  console.log('verify-cli (2. --preset by path/name, --quality, --max-dim):');
  const arwPreset = link('presettest.ARW');
  // a non-identity crop in the image's OWN sidecar — --preset must ignore it
  // entirely (identity geometry, per the CLI's documented preset semantics),
  // so a correct full-resolution output here is direct proof the sidecar's
  // geometry was never consulted.
  writeSidecar(arwPreset, {
    inputExtra: { geometry: { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0, orientation: { quarterTurns: 0, flipH: false } } },
  });
  const presetPath = join(workDir, 'cli-preset.json');
  writePresetFile(presetPath, 'CLI preset (by path)', { basic: { ev: -2 } });

  const r2 = runCli(['--out', outDir, '--preset', presetPath, arwPreset]);
  check('--preset by path exits 0', r2.status === 0, { status: r2.status, stderr: r2.stderr });
  const outPreset = expectedOutPath(arwPreset, outDir);
  const metaPreset = await sharp(outPreset).metadata();
  check(
    "--preset ignores the image's own sidecar geometry (full resolution, not the sidecar's crop)",
    metaPreset.width === FULL_WIDTH && metaPreset.height === FULL_HEIGHT,
    metaPreset
  );
  const bytesPreset = await rawBytesOf(outPreset);
  check('--preset render differs from the default-look render', !bytesPreset.equals(bytesNoSidecar), {
    sameBytes: bytesPreset.equals(bytesNoSidecar),
  });

  // --preset by NAME: a preset file living under <userData>/presets, looked
  // up by SLUG (its filename stem) rather than by path — exercises the
  // fallback half of readCliPresetText's two-way lookup (name, then slug).
  mkdirSync(join(userDataDir, 'presets'), { recursive: true });
  writePresetFile(join(userDataDir, 'presets', 'cli-name-preset.json'), 'A Totally Different Display Name', {
    basic: { ev: -2 },
  });
  const arwPresetByName = link('presetbyname.ARW');
  const r2n = runCli(['--out', outDir, '--preset', 'cli-name-preset', arwPresetByName]);
  check('--preset by name (slug fallback) exits 0', r2n.status === 0, { status: r2n.status, stderr: r2n.stderr });
  const meanPreset = await meanOf(outPreset);
  const meanPresetByName = await meanOf(expectedOutPath(arwPresetByName, outDir));
  check('--preset by name applied the same look as by path', Math.abs(meanPresetByName - meanPreset) < 1 / 255, {
    meanPresetByName,
    meanPreset,
  });

  const arwQLow = link('qlow.ARW');
  const arwQHigh = link('qhigh.ARW');
  const rQLow = runCli(['--out', outDir, '--quality', '60', arwQLow]);
  const rQHigh = runCli(['--out', outDir, '--quality', '95', arwQHigh]);
  check('--quality 60 exits 0', rQLow.status === 0, { status: rQLow.status, stderr: rQLow.stderr });
  check('--quality 95 exits 0', rQHigh.status === 0, { status: rQHigh.status, stderr: rQHigh.stderr });
  const sizeLow = statSync(expectedOutPath(arwQLow, outDir)).size;
  const sizeHigh = statSync(expectedOutPath(arwQHigh, outDir)).size;
  check('--quality 60 is a smaller file than --quality 95', sizeLow < sizeHigh, { sizeLow, sizeHigh });

  const arwMaxDim = link('maxdim.ARW');
  const rMaxDim = runCli(['--out', outDir, '--max-dim', '800', arwMaxDim]);
  check('--max-dim exits 0', rMaxDim.status === 0, { status: rMaxDim.status, stderr: rMaxDim.stderr });
  const metaMaxDim = await sharp(expectedOutPath(arwMaxDim, outDir)).metadata();
  check('--max-dim 800 caps the long edge at 800', Math.max(metaMaxDim.width, metaMaxDim.height) === 800, metaMaxDim);

  // =========================================================================
  console.log('verify-cli (3. multiple inputs; continues past a failure):');
  const arwTwoA = link('two-a.ARW');
  const arwTwoB = link('two-b.ARW');
  const r3 = runCli(['--out', outDir, arwTwoA, arwTwoB]);
  check('two good inputs exit 0', r3.status === 0, { status: r3.status, stdout: r3.stdout, stderr: r3.stderr });
  check('both outputs land', existsSync(expectedOutPath(arwTwoA, outDir)) && existsSync(expectedOutPath(arwTwoB, outDir)), {
    a: existsSync(expectedOutPath(arwTwoA, outDir)),
    b: existsSync(expectedOutPath(arwTwoB, outDir)),
  });

  const arwGoodHuman = link('good-human.ARW');
  const missingHuman = join(workDir, 'missing-human.ARW'); // deliberately never linked
  const r3h = runCli(['--out', outDir, arwGoodHuman, missingHuman]);
  check('good + missing exits 1 (not 0, not a hard crash)', r3h.status === 1, { status: r3h.status, stdout: r3h.stdout, stderr: r3h.stderr });
  check('the good file still lands', existsSync(expectedOutPath(arwGoodHuman, outDir)), expectedOutPath(arwGoodHuman, outDir));
  check("the missing file's error is reported on stderr (human mode)", r3h.stderr.includes(missingHuman), r3h.stderr);

  const arwGoodJson = link('good-json.ARW');
  const missingJson = join(workDir, 'missing-json.ARW');
  const r3j = runCli(['--out', outDir, '--json', arwGoodJson, missingJson]);
  check('good + missing under --json also exits 1', r3j.status === 1, { status: r3j.status, stdout: r3j.stdout });
  const jsonLines = r3j.stdout
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
  check('every non-empty stdout line under --json parses as JSON (NDJSON)', jsonLines.every((l) => l !== null), r3j.stdout);
  const successLine = jsonLines.find((l) => l?.input === arwGoodJson);
  const errorLine = jsonLines.find((l) => l?.input === missingJson);
  check(
    'NDJSON carries a success object ({input,output,width,height,bytes,ms})',
    !!successLine && typeof successLine.output === 'string' && typeof successLine.width === 'number' && typeof successLine.bytes === 'number',
    successLine
  );
  check('NDJSON carries an error object ({input,error}) for the missing file', !!errorLine && typeof errorLine.error === 'string', errorLine);

  // =========================================================================
  console.log("verify-cli (4. --output all: two-output sidecar → suffixed files):");
  const arwAllOutputs = link('alloutputs.ARW');
  // ev=1 on the Develop node is NOT optional here: an all-default Develop
  // node is itself an identity pass-through (engine invariant), which would
  // make 'main' (in->dev->out) bit-identical to 'web' (in->out2, bypassing
  // dev) and defeat the "pixels differ" check below.
  writeSidecar(arwAllOutputs, { develop: { basic: { ev: 1 } } });
  // …then hand-append a second output wired straight off input (bypassing
  // Develop), same trick verify-exportsettings.mjs uses to guarantee the two
  // outputs' pixels actually differ.
  {
    const sidecarPath = arwAllOutputs + '.silverbox.json';
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    doc.graph.nodes.push({ id: 'out2', type: 'output', position: { x: 420, y: 160 }, name: 'web' });
    doc.graph.edges.push({ id: 'e2', from: 'in', to: 'out2' });
    writeFileSync(sidecarPath, JSON.stringify(doc, null, 2) + '\n');
  }
  const r4 = runCli(['--out', outDir, '--output', 'all', arwAllOutputs]);
  check('--output all exits 0', r4.status === 0, { status: r4.status, stderr: r4.stderr });
  const outMain = join(outDir, 'alloutputs-main.jpg');
  const outWeb = join(outDir, 'alloutputs-web.jpg');
  check('both suffixed files land (…-main.jpg, …-web.jpg)', existsSync(outMain) && existsSync(outWeb), {
    main: existsSync(outMain),
    web: existsSync(outWeb),
  });
  check('the unsuffixed base path was never written (both outputs got a suffix)', !existsSync(join(outDir, 'alloutputs.jpg')), existsSync(join(outDir, 'alloutputs.jpg')));
  const meanMain = await meanOf(outMain);
  const meanWeb = await meanOf(outWeb);
  check("the two outputs' pixels differ (the second bypasses Develop)", Math.abs(meanMain - meanWeb) > 0.01, { meanMain, meanWeb });

  // =========================================================================
  console.log('verify-cli (5. windowless: completes cleanly, no window ever shown):');
  // There is no way to assert invisibility from an external script (this
  // process never gets a handle on the child's window at all) — main/index.ts
  // forces `show:false` for `isCliRenderMode` unconditionally (the exact same
  // `headless` flag SILVERBOX_TEST already drives for the rest of the verify
  // suite), so a clean, fast exit across every check above IS the evidence:
  // if a window had ever needed to become visible/focused, nothing here would
  // have run unattended in CI.
  const arwWindowless = link('windowless.ARW');
  const r5 = runCli(['--out', outDir, arwWindowless]);
  check('a plain invocation completes with exit 0 and no hang', r5.status === 0, { status: r5.status, stderr: r5.stderr });

  // =========================================================================
  console.log('verify-cli (bad usage: --help and no-images both skip rendering):');
  const rHelp = runCli(['--help']);
  check('--help exits 0 and prints usage', rHelp.status === 0 && /Usage: silverbox-render/.test(rHelp.stdout), rHelp);
  const rNoImages = runCli([]);
  check('no input images is bad usage (exit 2)', rNoImages.status === 2, rNoImages);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
