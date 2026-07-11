/**
 * LUT export verify (task #33): .cube + Unity/UE strip PNGs + WebGL snippet.
 *
 *  1. Identity graph (fresh open, no edits): exported .cube parses (header +
 *     exactly 33³ data lines) and every lattice entry equals its own input
 *     coordinate within 1e-5 — the engine's identity invariant surfacing in
 *     the export.
 *  2. ev=+1 on the Develop node: ~5 lattice points match a hand-computed
 *     expectation (sRGB decode → SRGB_TO_WORK → ×2 → WORK_TO_SRGB → sRGB
 *     encode, matrices hardcoded below from workingSpace.ts) within 1e-4 —
 *     proves the LUT pipeline matches the documented color math end to end.
 *  3/4. The same ev=+1 export's Unity (1024×32) and UE (256×16) strips: right
 *     dims, and their (0,0,0)/(last) texels match the .cube's first/last
 *     entries within 1/255.
 *  5. Spatial exclusion: Detail sharpen active still exports (4 files) with a
 *     non-empty, node-naming skipped list; disabling it again empties the
 *     list.
 *  6. .cube ordering (red fastest): a red-channel-only tone-curve black-point
 *     lift makes entry index 1 (r=1/32,g=0,b=0) differ from entry index 33
 *     (r=0,g=1/32,b=0) in the expected direction (more red input ⇒ more red
 *     output under the monotonic lift) — proves the axes aren't transposed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
rmSync(ARW_PATH + '.silverbox.json', { force: true });

const ARTIFACTS = join(projectRoot, 'test-artifacts');
const OUT_IDENTITY = join(ARTIFACTS, 'lut-identity');
const OUT_EV = join(ARTIFACTS, 'lut-ev1');
const OUT_SPATIAL_ON = join(ARTIFACTS, 'lut-spatial-on');
const OUT_SPATIAL_OFF = join(ARTIFACTS, 'lut-spatial-off');
const OUT_REDCURVE = join(ARTIFACTS, 'lut-redcurve');
const ALL_BASES = [OUT_IDENTITY, OUT_EV, OUT_SPATIAL_ON, OUT_SPATIAL_OFF, OUT_REDCURVE];
const SUFFIXES = ['.cube', '-unity.png', '-ue.png', '-webgl.txt'];

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

mkdirSync(ARTIFACTS, { recursive: true });
for (const base of ALL_BASES) for (const suf of SUFFIXES) rmSync(base + suf, { force: true });

// --- hand-computed color math (must match src/renderer/engine/color/*.ts) --
// SRGB_TO_WORK / WORK_TO_SRGB: workingSpace.ts's Rec.2020<->sRGB matrices.
const SRGB_TO_WORK = [
  [0.627409, 0.32926, 0.043272],
  [0.069125, 0.919549, 0.011321],
  [0.016423, 0.088048, 0.895617],
];
const WORK_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];
const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
// srgb.ts's exact piecewise transfer functions.
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const srgbEncode = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Expected sRGB-encoded output for a lattice point under Develop ev=+1 alone (wbGains=[1,1,1] at as-shot). */
function expectedEv1(rEnc, gEnc, bEnc) {
  const lin = [srgbDecode(rEnc), srgbDecode(gEnc), srgbDecode(bEnc)];
  const work = mul3(SRGB_TO_WORK, lin).map((v) => v * 2); // +1 EV = ×2 in linear working space
  const outLin = mul3(WORK_TO_SRGB, work);
  return outLin.map(srgbEncode);
}

const CUBE_SIZE = 33;

/** Parse a .cube file: header lines (non-numeric-leading) + `size^3` "r g b" data lines. */
function parseCube(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let i = 0;
  const header = {};
  while (i < lines.length && !/^[-\d.]/.test(lines[i])) {
    const parts = lines[i].split(/\s+/);
    header[parts[0]] = parts.slice(1).join(' ');
    i++;
  }
  const data = [];
  for (; i < lines.length; i++) {
    data.push(lines[i].split(/\s+/).map(Number));
  }
  return { header, data };
}

const maxAbsDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Raw RGBA8 pixel reader for a strip PNG (no ICC — plain raw bytes). */
async function readStrip(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    px(x, y) {
      const idx = (y * info.width + x) * info.channels;
      return [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
    },
  };
}

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

  const setDev = (path, value) => page.evaluate(([p, v]) => window.__debug.updateNodeParam('dev', p, v), [path, value]);
  const exportLutAndWait = async (basePath) => {
    await page.evaluate((p) => window.__debug.exportLutTo(p), basePath);
    await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 120_000 });
    const state = await page.evaluate(() => window.__debug.exportState());
    const info = await page.evaluate(() => window.__debug.exportLutState());
    return { state, info };
  };

  // -------------------------------------------------------------------
  console.log('verify-lut (1. identity graph -> identity LUT):');
  const identityRun = await exportLutAndWait(OUT_IDENTITY);
  check('identity export completes', identityRun.state.status === 'idle', identityRun.state);
  check('identity export reports 4 files, nothing skipped', identityRun.info?.count === 4 && identityRun.info?.skipped.length === 0, identityRun.info);
  check('.cube file exists', existsSync(OUT_IDENTITY + '.cube'), OUT_IDENTITY + '.cube');

  const identityCube = parseCube(readFileSync(OUT_IDENTITY + '.cube', 'utf8'));
  check('.cube header advertises LUT_3D_SIZE 33', identityCube.header.LUT_3D_SIZE === '33', identityCube.header);
  check('.cube has exactly 33^3 data lines', identityCube.data.length === CUBE_SIZE ** 3, identityCube.data.length);

  let maxIdentityDiff = 0;
  for (let idx = 0; idx < identityCube.data.length; idx++) {
    const r = idx % CUBE_SIZE;
    const g = Math.floor(idx / CUBE_SIZE) % CUBE_SIZE;
    const b = Math.floor(idx / (CUBE_SIZE * CUBE_SIZE));
    const expected = [r / (CUBE_SIZE - 1), g / (CUBE_SIZE - 1), b / (CUBE_SIZE - 1)];
    maxIdentityDiff = Math.max(maxIdentityDiff, maxAbsDiff(identityCube.data[idx], expected));
  }
  check('every lattice entry equals its input coordinate within 1e-5', maxIdentityDiff < 1e-5, { maxIdentityDiff });

  // -------------------------------------------------------------------
  console.log('verify-lut (2. ev=+1 matches hand-computed color math):');
  await setDev('basic.ev', 1);
  const evRun = await exportLutAndWait(OUT_EV);
  check('ev=+1 export completes with nothing skipped', evRun.state.status === 'idle' && evRun.info?.skipped.length === 0, evRun);

  const evCube = parseCube(readFileSync(OUT_EV + '.cube', 'utf8'));
  const samplePoints = [
    [8, 16, 24],
    [0, 0, 0],
    [32, 32, 32],
    [4, 20, 10],
    [30, 2, 15],
  ];
  for (const [ri, gi, bi] of samplePoints) {
    const idx = bi * CUBE_SIZE * CUBE_SIZE + gi * CUBE_SIZE + ri;
    const expected = expectedEv1(ri / (CUBE_SIZE - 1), gi / (CUBE_SIZE - 1), bi / (CUBE_SIZE - 1));
    const actual = evCube.data[idx];
    const diff = maxAbsDiff(expected, actual);
    check(`ev=+1 lattice point (r=${ri},g=${gi},b=${bi}) matches hand-computed expectation within 1e-4`, diff < 1e-4, {
      expected,
      actual,
      diff,
    });
  }

  // -------------------------------------------------------------------
  console.log('verify-lut (3. Unity strip: dims + endpoints vs the .cube):');
  const unityMeta = await sharp(OUT_EV + '-unity.png').metadata();
  check('unity strip is 1024x32', unityMeta.width === 1024 && unityMeta.height === 32, unityMeta);
  const unityStrip = await readStrip(OUT_EV + '-unity.png');
  const unityFirst = unityStrip.px(0, 0);
  const unityLast = unityStrip.px(unityStrip.width - 1, unityStrip.height - 1);
  const cubeFirst = evCube.data[0];
  const cubeLast = evCube.data[evCube.data.length - 1];
  check('unity strip (0,0,0) texel matches .cube first entry within 1/255', maxAbsDiff(unityFirst, cubeFirst) < 1 / 255 + 1e-6, {
    unityFirst,
    cubeFirst,
  });
  check('unity strip last texel matches .cube last entry within 1/255', maxAbsDiff(unityLast, cubeLast) < 1 / 255 + 1e-6, {
    unityLast,
    cubeLast,
  });

  // -------------------------------------------------------------------
  console.log('verify-lut (4. UE strip: dims + endpoints vs the .cube):');
  const ueMeta = await sharp(OUT_EV + '-ue.png').metadata();
  check('UE strip is 256x16', ueMeta.width === 256 && ueMeta.height === 16, ueMeta);
  const ueStrip = await readStrip(OUT_EV + '-ue.png');
  const ueFirst = ueStrip.px(0, 0);
  const ueLast = ueStrip.px(ueStrip.width - 1, ueStrip.height - 1);
  check('UE strip (0,0,0) texel matches .cube first entry within 1/255', maxAbsDiff(ueFirst, cubeFirst) < 1 / 255 + 1e-6, {
    ueFirst,
    cubeFirst,
  });
  check('UE strip last texel matches .cube last entry within 1/255', maxAbsDiff(ueLast, cubeLast) < 1 / 255 + 1e-6, {
    ueLast,
    cubeLast,
  });

  check('webgl snippet file exists', existsSync(OUT_EV + '-webgl.txt'), OUT_EV + '-webgl.txt');
  const webglText = readFileSync(OUT_EV + '-webgl.txt', 'utf8');
  check('webgl snippet defines applyLut(sampler2D, vec3)', webglText.includes('vec3 applyLut(sampler2D'), {
    snippet: webglText.slice(0, 120),
  });

  await setDev('basic.ev', 0);

  // -------------------------------------------------------------------
  console.log('verify-lut (5. spatial exclusion — Detail sharpen active):');
  await setDev('detail.sharpen.amount', 100);
  const spatialOnRun = await exportLutAndWait(OUT_SPATIAL_ON);
  check('export still succeeds with a spatial op active (4 files)', spatialOnRun.state.status === 'idle' && spatialOnRun.info?.count === 4, spatialOnRun);
  check(
    'skipped list is non-empty and names the Develop node + Detail',
    spatialOnRun.info?.skipped.some((s) => s.startsWith('dev:') && s.includes('Detail')),
    spatialOnRun.info?.skipped
  );

  await setDev('detail.sharpen.amount', 0);
  const spatialOffRun = await exportLutAndWait(OUT_SPATIAL_OFF);
  check('export succeeds once the spatial op is disabled again', spatialOffRun.state.status === 'idle', spatialOffRun.state);
  check('skipped list is empty once the spatial op is disabled again', spatialOffRun.info?.skipped.length === 0, spatialOffRun.info?.skipped);

  // -------------------------------------------------------------------
  console.log('verify-lut (5b. position-dependent effects — grain/vignette excluded, not baked):');
  // Grain carries a CPU mirror, so it slips past the cpu === null detection —
  // without the explicit reset it would bake ONE fixed noise sample into
  // every lattice point as a uniform offset. The export must instead skip it
  // (reported) and, with grain the only edit, produce an identity LUT again.
  await setDev('effects.grain', 60);
  await setDev('effects.vignette', -40);
  const grainRun = await exportLutAndWait(OUT_SPATIAL_ON + '-grain');
  check(
    'skipped list names grain and vignette as position-dependent',
    grainRun.info?.skipped.some((s) => s.includes('grain') && s.includes('vignette')),
    grainRun.info?.skipped
  );
  const grainCube = parseCube(readFileSync(OUT_SPATIAL_ON + '-grain.cube', 'utf8'));
  let maxGrainDiff = 0;
  for (let idx = 0; idx < grainCube.data.length; idx++) {
    const r = idx % CUBE_SIZE;
    const g = Math.floor(idx / CUBE_SIZE) % CUBE_SIZE;
    const b = Math.floor(idx / (CUBE_SIZE * CUBE_SIZE));
    maxGrainDiff = Math.max(
      maxGrainDiff,
      maxAbsDiff(grainCube.data[idx], [r / (CUBE_SIZE - 1), g / (CUBE_SIZE - 1), b / (CUBE_SIZE - 1)])
    );
  }
  check('grain/vignette-only graph still exports an IDENTITY LUT (nothing baked in)', maxGrainDiff < 1e-5, {
    maxGrainDiff,
  });
  await setDev('effects.grain', 0);
  await setDev('effects.vignette', 0);

  // -------------------------------------------------------------------
  console.log('verify-lut (6. .cube ordering — red fastest, not transposed):');
  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'r', [
      [0, 40],
      [255, 255],
    ])
  );
  const redRun = await exportLutAndWait(OUT_REDCURVE);
  check('red-curve export completes', redRun.state.status === 'idle', redRun.state);
  const redCube = parseCube(readFileSync(OUT_REDCURVE + '.cube', 'utf8'));
  // index 1 = (r=1/32, g=0, b=0); index 33 = (r=0, g=1/32, b=0) — red-fastest
  // ordering means only index 1 carries extra red input, so its RED channel
  // must read higher than index 33's under the monotonic red-channel lift.
  const entry1 = redCube.data[1];
  const entry33 = redCube.data[CUBE_SIZE];
  check(
    'entry index 1 (extra red input) reads a higher red channel than entry index 33 (extra green input)',
    entry1[0] > entry33[0] + 0.01,
    { entry1, entry33 }
  );
  await page.evaluate(() =>
    window.__debug.setToneCurvePoints('dev', 'r', [
      [0, 0],
      [255, 255],
    ])
  );

  // -------------------------------------------------------------------
  console.log('verify-lut (UI: Export LUT button lives in the export dialog):');
  await page.locator('[data-testid="export-button"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 5_000 });
  check(
    'the "Export LUT" button is present and enabled while an image is open',
    await page.locator('[data-testid="export-lut-button"]').isEnabled(),
    await page.locator('[data-testid="export-lut-button"]').count()
  );
  await page.locator('[data-testid="export-close-button"]').click();
} finally {
  await app.close();
  rmSync(ARW_PATH + '.silverbox.json', { force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
