/**
 * "Adobe Color (local)" mode verify (stage base-2, fix ②, docs/research/lr-
 * base-gap.md — the sibling brief-bank doc is dcp-profile.md). Reuses
 * verify-dcp.mjs's own idioms throughout: the pure engine/color/dcp module
 * is bundled straight from TS source via esbuild and imported under plain
 * Node for checks 1-4 (no Electron needed); check 5 spawns the real headless
 * CLI to exercise the actual render pipeline end to end.
 *
 * Checks:
 *  1. Codec round-trip on an OWN-DATA synthetic fixture (scripts/fixtures/
 *     build-acrlook-fixture.mjs): encode our own small table through our own
 *     base85+zlib encoder → decode via the production `decodeAcrLookTable`
 *     → every entry, dims, and encoding come back bit-exact (float32
 *     precision), and the inflated payload bytes match exactly.
 *  2. `parseAcrLookXmp` on a synthetic XMP snippet (own `crs:*` fields, own
 *     numbers) round-trips the base85 text, MD5 value, camera-profile name,
 *     and ToneCurvePV2012 points exactly.
 *  3. IF the user's local "Adobe Color.xmp" exists (ADOBE_COLOR_LOOK_XMP_PATH
 *     — runtime-read only, never committed): decode it for real and verify
 *     MD5(payload) === the file's own `crs:LookTable` value (the format's
 *     own self-check) and dims === 36×16×16 (this project's own recorded
 *     measurement). SKIPPED with a clear message when the file is absent —
 *     this check must pass on any machine, with or without ACR installed.
 *  4. Pipeline math (renderDcpPixel's `extra` stage, bakeDcpLattice/
 *     bakeAcrLookLattice): the extra look-table stage measurably moves a
 *     pixel; the extra tone curve REPLACES (not stacks with) the DCP's own
 *     ProfileToneCurve — proven by exact equality against a DIFFERENT
 *     rendering with the curve swapped directly into the dcp object instead
 *     of passed via `extra`; `bakeAcrLookLattice` (localAdobeProfile.ts)
 *     matches `bakeDcpLattice(..., extra)` bit-exact (it's a thin wrapper).
 *  5. CLI render, pipeline identity: profile.source='acrlook' at amount 0 is
 *     a BIT-EXACT no-op, identical to bypass (the "identity params ⇒ no
 *     pass" invariant holds regardless of source) — machine-independent, no
 *     real Adobe files needed. IF the real local Adobe Standard DCP (for
 *     test.ARW's own camera) + Adobe Color.xmp BOTH exist: amount 100
 *     differs measurably from bypass AND from builtin-mode amount 100
 *     (genuinely different transforms) — SKIPPED gracefully otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';
import { buildTonelessFixtureDcp } from './fixtures/build-dcp-fixture.mjs';
import { buildAcrLookFixtureBase85, buildAcrLookFixtureXmp } from './fixtures/build-acrlook-fixture.mjs';
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
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};
const skip = (name, reason) => console.log(`  SKIP  ${name}  (${reason})`);

async function bundleToTempModule(relSrcPath, workDir, outName) {
  const result = await build({
    entryPoints: [join(projectRoot, relSrcPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  const outPath = join(workDir, outName);
  writeFileSync(outPath, result.outputFiles[0].text, 'utf8');
  return import(pathToFileURL(outPath).href);
}

const bundleWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-acrlook-bundle-'));
let dcp;
try {
  dcp = await bundleToTempModule('src/renderer/engine/color/dcp/index.ts', bundleWorkDir, 'dcp.bundle.mjs');
  check('bundled engine/color/dcp/index.ts via esbuild and imported it under plain Node', true, null);
} catch (err) {
  check('bundled engine/color/dcp/index.ts via esbuild and imported it', false, String(err.stack ?? err));
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} finally {
  rmSync(bundleWorkDir, { recursive: true, force: true });
}

const {
  decodeAcrLookTable,
  decodeBase85,
  parseAcrLookXmp,
  parseDcp,
  renderDcpPixel,
  bakeDcpLattice,
  bakeAcrLookLattice,
  ADOBE_COLOR_LOOK_XMP_PATH,
} = dcp;

const IDENTITY_MAT3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// === 1. codec round-trip on an OWN-DATA synthetic fixture ===================
console.log('verify-acrlook (codec round-trip, own-data synthetic fixture):');
const fixture = buildAcrLookFixtureBase85({ hueDivisions: 3, satDivisions: 2, valDivisions: 2, encoding: 'linear' });
const decodedFixture = await decodeAcrLookTable(fixture.base85);
check('hueDivisions/satDivisions/valDivisions round-trip', decodedFixture.hueDivisions === 3 && decodedFixture.satDivisions === 2 && decodedFixture.valDivisions === 2, {
  hueDivisions: decodedFixture.hueDivisions,
  satDivisions: decodedFixture.satDivisions,
  valDivisions: decodedFixture.valDivisions,
});
check('encoding round-trips as linear', decodedFixture.encoding === 'linear', decodedFixture.encoding);
check(
  'inflated payload bytes match the fixture builder\'s own payload bit-exact',
  decodedFixture.payload.length === fixture.payload.length && decodedFixture.payload.every((v, i) => v === fixture.payload[i]),
  { decodedLen: decodedFixture.payload.length, fixtureLen: fixture.payload.length }
);
let allEntriesMatch = true;
const { hueDivisions: H, satDivisions: S, valDivisions: V } = fixture;
for (let h = 0; h < H && allEntriesMatch; h++) {
  for (let s = 0; s < S && allEntriesMatch; s++) {
    for (let v = 0; v < V && allEntriesMatch; v++) {
      const [expHue, expSat, expVal] = fixture.entryAt(h, s, v);
      const idx = ((h * S + s) * V + v) * 3; // this codebase's HueSatTable convention (see bigTable.ts's doc comment)
      const got = [decodedFixture.table.data[idx], decodedFixture.table.data[idx + 1], decodedFixture.table.data[idx + 2]];
      if (Math.abs(got[0] - expHue) > 1e-3 || Math.abs(got[1] - expSat) > 1e-4 || Math.abs(got[2] - expVal) > 1e-4) {
        allEntriesMatch = false;
        console.log(`    mismatch at (h=${h},s=${s},v=${v}): expected ${[expHue, expSat, expVal]}, got ${got}`);
      }
    }
  }
}
check('every table entry round-trips (own reorder formula, float32 precision)', allEntriesMatch, allEntriesMatch);

// A base85 string that decodes to bytes that are NOT a valid zlib stream must throw actionably (not silently produce garbage).
try {
  const badStream = 'a'.repeat(20); // valid base85 characters, but the decoded bytes are not zlib-compressed data
  await decodeAcrLookTable(badStream);
  check('a non-zlib decoded payload throws', false, 'did not throw');
} catch (err) {
  check('a non-zlib decoded payload throws (inflate failure surfaces)', true, String(err.message ?? err));
}
// A character outside the 85-char alphabet must throw actionably too.
try {
  decodeBase85('€€€€€');
  check('a character outside the alphabet throws', false, 'did not throw');
} catch (err) {
  check('a character outside the alphabet throws (decodeBase85 error surfaces)', true, String(err.message ?? err));
}

// === 2. parseAcrLookXmp on a synthetic XMP snippet ==========================
console.log('\nverify-acrlook (parseAcrLookXmp on an own-data synthetic XMP snippet):');
const md5 = 'DEADBEEF'.repeat(4).slice(0, 32);
const curvePoints = [
  [0, 0],
  [64, 80],
  [192, 210],
  [255, 255],
];
const xmpText = buildAcrLookFixtureXmp({ base85: fixture.base85, md5, cameraProfile: 'Adobe Standard', curvePoints });
const parsedXmp = parseAcrLookXmp(xmpText);
check('parseAcrLookXmp returns a non-null result', parsedXmp != null, parsedXmp);
if (parsedXmp) {
  check('lookTableBase85 round-trips exactly', parsedXmp.lookTableBase85 === fixture.base85, parsedXmp.lookTableBase85 === fixture.base85);
  check('lookTableMd5 round-trips exactly', parsedXmp.lookTableMd5 === md5, parsedXmp.lookTableMd5);
  check('cameraProfile round-trips exactly', parsedXmp.cameraProfile === 'Adobe Standard', parsedXmp.cameraProfile);
  const expectedPoints = curvePoints.map(([x, y]) => [x / 255, y / 255]);
  const pointsMatch =
    parsedXmp.toneCurvePv2012.points.length === expectedPoints.length &&
    parsedXmp.toneCurvePv2012.points.every((p, i) => Math.abs(p[0] - expectedPoints[i][0]) < 1e-6 && Math.abs(p[1] - expectedPoints[i][1]) < 1e-6);
  check('ToneCurvePV2012 points round-trip exactly (normalized to [0,1])', pointsMatch, parsedXmp.toneCurvePv2012.points);
}
check('parseAcrLookXmp returns null on text with no crs:LookTable at all', parseAcrLookXmp('<x>no look table here</x>') === null, parseAcrLookXmp('<x>no look table here</x>'));

// === 3. real local Adobe Color.xmp self-check (SKIPPED gracefully when absent) ===
console.log('\nverify-acrlook (real local Adobe Color.xmp MD5 self-check — SKIP if absent):');
if (existsSync(ADOBE_COLOR_LOOK_XMP_PATH)) {
  const realXmpText = readFileSync(ADOBE_COLOR_LOOK_XMP_PATH, 'utf8');
  const realParsed = parseAcrLookXmp(realXmpText);
  check('the real local Adobe Color.xmp parses (crs:LookTable/Table_<hash>/ToneCurvePV2012 all present)', realParsed != null, realParsed != null);
  if (realParsed) {
    const realDecoded = await decodeAcrLookTable(realParsed.lookTableBase85);
    const actualMd5 = createHash('md5').update(Buffer.from(realDecoded.payload)).digest('hex');
    check(
      'MD5(decoded payload) matches the file\'s own crs:LookTable value (this format\'s own self-check)',
      actualMd5.toLowerCase() === realParsed.lookTableMd5.toLowerCase(),
      { actualMd5, expected: realParsed.lookTableMd5 }
    );
    check(
      'dims are 36×16×16 (this project\'s own recorded measurement of "Adobe Color")',
      realDecoded.hueDivisions === 36 && realDecoded.satDivisions === 16 && realDecoded.valDivisions === 16,
      { h: realDecoded.hueDivisions, s: realDecoded.satDivisions, v: realDecoded.valDivisions }
    );
  }
} else {
  skip('real local Adobe Color.xmp MD5 self-check', `no file at ${ADOBE_COLOR_LOOK_XMP_PATH} on this machine`);
}

// === 4. pipeline math — extra stage + bakeAcrLookLattice ====================
console.log('\nverify-acrlook (pipeline math: renderDcpPixel extra stage, bakeAcrLookLattice):');
const tonelessDcpBytes = buildTonelessFixtureDcp();
const tonelessDcpAb = tonelessDcpBytes.buffer.slice(tonelessDcpBytes.byteOffset, tonelessDcpBytes.byteOffset + tonelessDcpBytes.byteLength);
const standInAdobeStandard = parseDcp(tonelessDcpAb, 'silverbox-test-toneless.dcp');
check('the stand-in "Adobe Standard" fixture is tone-less (toneCurve === null)', standInAdobeStandard.toneCurve === null, standInAdobeStandard.toneCurve);

const testWorkingRgb = [0.5, 0.3, 0.6];
const testTempK = 4500;
const noExtra = renderDcpPixel(standInAdobeStandard, testWorkingRgb, IDENTITY_MAT3, testTempK);
const withLookExtra = renderDcpPixel(standInAdobeStandard, testWorkingRgb, IDENTITY_MAT3, testTempK, {
  lookTable: decodedFixture.table,
  lookTableEncoding: decodedFixture.encoding,
});
const lookMoved = Math.max(...withLookExtra.map((v, i) => Math.abs(v - noExtra[i]))) > 1e-4;
check('the extra look-table stage measurably moves the pixel vs. no extra stage', lookMoved, { noExtra, withLookExtra });

// extra.toneCurve REPLACES (not stacks with) dcp.toneCurve — proven by exact
// equality against rendering a DIFFERENT dcp object with the curve swapped
// in directly (toneless fixture + curve set on dcp.toneCurve itself).
const overrideCurve = { points: [[0, 0], [0.5, 0.7], [1, 1]] };
const viaExtra = renderDcpPixel(standInAdobeStandard, testWorkingRgb, IDENTITY_MAT3, testTempK, { toneCurve: overrideCurve });
const dcpWithCurveDirectly = { ...standInAdobeStandard, toneCurve: overrideCurve };
const viaDirectSwap = renderDcpPixel(dcpWithCurveDirectly, testWorkingRgb, IDENTITY_MAT3, testTempK);
const replaceMatches = viaExtra.every((v, i) => Math.abs(v - viaDirectSwap[i]) < 1e-9);
check('extra.toneCurve REPLACES dcp.toneCurve exactly (bit-identical to swapping it directly)', replaceMatches, { viaExtra, viaDirectSwap });

const N_SMALL = 5;
const extraForBake = { lookTable: decodedFixture.table, lookTableEncoding: decodedFixture.encoding, toneCurve: overrideCurve };
const latticeViaBakeDcp = bakeDcpLattice(standInAdobeStandard, IDENTITY_MAT3, testTempK, N_SMALL, extraForBake);
const latticeViaAcrLookWrapper = bakeAcrLookLattice(
  standInAdobeStandard,
  decodedFixture.table,
  decodedFixture.encoding,
  overrideCurve,
  IDENTITY_MAT3,
  testTempK,
  N_SMALL
);
const latticesMatch = latticeViaBakeDcp.every((v, i) => v === latticeViaAcrLookWrapper[i]);
check('bakeAcrLookLattice is bit-exact vs. bakeDcpLattice called with the same extra stage', latticesMatch, { len: latticeViaBakeDcp.length });

// === 5. CLI render: pipeline identity + (skip-gracefully) real-file render ==
console.log('\nverify-acrlook (CLI render: amount 0 = bypass; amount 100 differs when local files exist):');

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-acrlook-cli-'));
const outDir = join(workDir, 'out');
mkdirSync(outDir, { recursive: true });
const arwPath = join(workDir, 'DSC-ACRLOOK.ARW');
linkSync(SRC_ARW, arwPath);
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-acrlook-userdata-'));
if (ownUserData) seedLibraryDir(userDataDir);

const nowIso = () => new Date().toISOString();
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
function writeVariantSidecar(name, develop) {
  const path = join(workDir, `${name}.ARW`);
  linkSync(SRC_ARW, path);
  const { nodes, edges } = simpleLook(develop);
  writeFileSync(path + '.silverbox.json', JSON.stringify({ schemaVersion: 4, createdAt: nowIso(), graph: { nodes, edges } }, null, 2) + '\n');
  return path;
}

const bypassPath = writeVariantSidecar('bypass', undefined);
const acrlook0Path = writeVariantSidecar('acrlook0', { profile: { amount: 0, source: 'acrlook' } });
const acrlook100Path = writeVariantSidecar('acrlook100', { profile: { amount: 100, source: 'acrlook' } });
const builtin100Path = writeVariantSidecar('builtin100', { profile: { amount: 100, source: 'builtin' } });

const electronBin = join(projectRoot, 'node_modules', '.bin', 'electron');
function runCli(inputs) {
  return spawnSync(electronBin, [projectRoot, '--render', '--out', outDir, ...inputs], {
    env: { ...process.env, SILVERBOX_USER_DATA: userDataDir },
    encoding: 'utf8',
    timeout: 180_000,
  });
}
const render = runCli([bypassPath, acrlook0Path, acrlook100Path, builtin100Path]);
check('CLI render exits 0', render.status === 0, { status: render.status, stderr: render.stderr });

async function rawBytesOf(path) {
  return sharp(path).raw().toBuffer();
}
async function meanAbsDiff(pathA, pathB) {
  const [a, b] = await Promise.all([rawBytesOf(pathA), rawBytesOf(pathB)]);
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

if (render.status === 0) {
  const bypassOut = join(outDir, 'bypass.jpg');
  const acrlook0Out = join(outDir, 'acrlook0.jpg');
  const acrlook100Out = join(outDir, 'acrlook100.jpg');
  const builtin100Out = join(outDir, 'builtin100.jpg');
  const allExist = [bypassOut, acrlook0Out, acrlook100Out, builtin100Out].every(existsSync);
  check('every expected output file exists', allExist, { bypassOut, acrlook0Out, acrlook100Out, builtin100Out });
  if (allExist) {
    const dBypassVsAcrlook0 = await meanAbsDiff(bypassOut, acrlook0Out);
    check('amount 0 (acrlook source) is a bit-exact no-op — identical to bypass, machine-independent', dBypassVsAcrlook0 === 0, dBypassVsAcrlook0);

    // exiftool -Make/-Model on SRC_ARW would be the precise check; this
    // mirrors localAdobeProfile.ts's own discovery path construction against
    // the well-known Sony naming convention for the project's own test ARW.
    const realAdobeStandardGlobExists = existsSync(
      '/Library/Application Support/Adobe/CameraRaw/CameraProfiles/Adobe Standard/Sony ILCE-7CM2 Adobe Standard.dcp'
    );
    const realLookExists = existsSync(ADOBE_COLOR_LOOK_XMP_PATH);
    if (realAdobeStandardGlobExists && realLookExists) {
      const dBypassVsAcrlook100 = await meanAbsDiff(bypassOut, acrlook100Out);
      check('amount 100 (acrlook source) differs measurably from bypass (real local files present)', dBypassVsAcrlook100 > 0.002, dBypassVsAcrlook100);

      const dAcrlook100VsBuiltin100 = await meanAbsDiff(acrlook100Out, builtin100Out);
      check(
        'acrlook mode at amount 100 differs from builtin mode at amount 100 (genuinely different transforms)',
        dAcrlook100VsBuiltin100 > 0.002,
        dAcrlook100VsBuiltin100
      );
    } else {
      skip('amount 100 measurable-difference checks', 'the real local Adobe Standard DCP for Sony ILCE-7CM2 and/or Adobe Color.xmp are not present on this machine');
    }
  }
}

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
