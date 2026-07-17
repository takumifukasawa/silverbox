/**
 * Sony embedded lens-profile verify (task #34, F3b). Runs with
 * SILVERBOX_TEST_LENS_PROFILE_DEFAULT=1 so the "profile ON for a fresh open"
 * default fires inside the suite (it is suppressed for every other script so
 * their bit-exact CPU baselines stay intact — see appStore.openImageByPath).
 *
 * Checks:
 *  1. Opening the ARW exposes the parsed profile (n=11 + the exact distortion knots).
 *  2. Checkbox ON by default; unchecking returns to the bit-exact, CPU-
 *     referenceable baseline; one undo entry per toggle; ON ≠ OFF render.
 *  3. Sidecar round-trip: enabled survives save/reopen; a v3 sidecar with NO
 *     profile key loads enabled:false.
 *  4. JPEG open: no profile, checkbox disabled.
 *  5. Geometry: enabling the profile un-barrels the corner (moves corner
 *     content toward center) AND aligns the ARW corner to the in-camera JPEG
 *     better than uncorrected (NCC, corrected > uncorrected).
 *  6. Manual lens sliders still work WITH the profile on (stacking).
 *  7. Cross-lens geometry regression guard (FE 50mm F2.5 G): the m =
 *     1.1/16384 distortion constant was calibrated against the FE 24mm F2.8
 *     G by check #5 above (preview-resolution, single corner, vs
 *     test.ARW). This re-derives the same evidence on a SECOND lens with
 *     different distortion characteristics, at FULL resolution across all 5
 *     windows, via the real CLI renderer — see that section's own comment
 *     for the full rationale. Gated on a personal reference fixture; skips
 *     loudly when absent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, linkSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, lookPathFor } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';
// Re-enable the fresh-open default INSIDE the suite for this script only.
process.env.SILVERBOX_TEST_LENS_PROFILE_DEFAULT = '1';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
ensureTestProjectEnv();
const SIDECAR = lookPathFor(ARW_PATH);
const GPU_CPU_TOLERANCE = 1 / 255;

const EXPECTED_DISTORTION = [0, -11, -41, -91, -162, -249, -355, -476, -611, -759, -918];

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
const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const meanAbsDiff = (a, b) => (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
const arraysEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Grayscale NxN corner patch (top-left 15%) of a canvas screenshot buffer, as a Float64 array. */
async function cornerPatch(pngBuf, n = 48) {
  const meta = await sharp(pngBuf).metadata();
  const side = Math.round(Math.min(meta.width, meta.height) * 0.15);
  const raw = await sharp(pngBuf)
    .extract({ left: 0, top: 0, width: side, height: side })
    .greyscale()
    .resize(n, n, { fit: 'fill' })
    .raw()
    .toBuffer();
  return Float64Array.from(raw);
}
/** Normalized cross-correlation of two equal-length patches. */
function ncc(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openImage = async (p) => {
    await page.evaluate((path) => {
      void window.__openImageByPath(path);
    }, p);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const lensState = () => page.evaluate(() => window.__debug.lensState());
  const profileState = () => page.evaluate(() => window.__debug.lensProfileState());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const setLens = (lens) => page.evaluate((l) => window.__debug.setLens(l), lens);
  const setProfileEnabled = async (enabled) => {
    const cur = await lensState();
    await setLens({ ...cur, profile: { enabled } });
  };
  // Re-render lands on a debounced histogram refresh (verify-lens technique).
  const histogramAfter = async (mutate) => {
    const before = await page.evaluate(() => window.__debug.histogramState());
    await mutate();
    await page.waitForFunction(
      (prev) => {
        const h = window.__debug.histogramState();
        return h !== null && JSON.stringify(h) !== prev;
      },
      JSON.stringify(before),
      { timeout: 15_000 }
    );
  };

  // === 1. parsed profile on the ARW ===
  console.log('verify-lensprofile (parsed profile):');
  await openImage(ARW_PATH);
  const outDims = await page.evaluate(() => window.__debug.outputDims());
  console.log(`  info: decoded preview raster = ${outDims.width}×${outDims.height} (r_max = decoded corner)`);
  const ps = await profileState();
  check('ARW exposes an embedded profile', ps.hasProfile === true, ps.hasProfile);
  check('distortion knots parsed exactly (n=11)', arraysEqual(ps.distortion, EXPECTED_DISTORTION), ps.distortion);
  check('CA + vignette curves present (n=11 each)', ps.caRed?.length === 11 && ps.caBlue?.length === 11 && ps.vignette?.length === 11, {
    caRed: ps.caRed?.length,
    caBlue: ps.caBlue?.length,
    vignette: ps.vignette?.length,
  });

  // === 2. default ON; uncheck → bit-exact baseline; one undo per toggle ===
  console.log('verify-lensprofile (default on + toggle):');
  check('profile enabled by default on fresh open', ps.enabled === true, ps.enabled);
  const onMean = await gpuMean();
  const onCpu = await cpuMean();
  check('profile-on render has NO CPU reference (resample active)', onCpu === null, onCpu);
  const onCorner = await page.locator('.canvas-view-canvas').screenshot();

  const pastBeforeOff = await historyPast();
  await histogramAfter(() => setProfileEnabled(false));
  const offMean = await gpuMean();
  const offCpu = await cpuMean();
  check('unchecking restores a CPU-referenceable baseline', offCpu !== null, offCpu);
  check('profile-off is the bit-exact pass-through (GPU = CPU)', meansMatch(offMean, offCpu), { offMean, offCpu });
  check('profile ON and OFF render differently', meanAbsDiff(onMean, offMean) > 1e-4, { onMean, offMean });
  check('one undo entry for the toggle', (await historyPast()) === pastBeforeOff + 1, {
    before: pastBeforeOff,
    after: await historyPast(),
  });
  const offCorner = await page.locator('.canvas-view-canvas').screenshot();
  await histogramAfter(() => setProfileEnabled(true)); // back on for later checks

  // === 6. manual sliders stack on top of the profile ===
  console.log('verify-lensprofile (manual stacks on profile):');
  const profOnlyMean = await gpuMean();
  await histogramAfter(() => setLens({ distortion: 60, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } }));
  const stackedMean = await gpuMean();
  const stackedCpu = await cpuMean();
  check('manual+profile still has no CPU reference', stackedCpu === null, stackedCpu);
  check('manual distortion on top of the profile changes the render further', meanAbsDiff(profOnlyMean, stackedMean) > 1e-4, {
    profOnlyMean,
    stackedMean,
  });
  await setLens({ distortion: 0, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } });

  // === 3. sidecar round-trip ===
  console.log('verify-lensprofile (sidecar round-trip):');
  await setProfileEnabled(true);
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await openImage(ARW_PATH);
  check('saved profile-enabled survives reopen', (await profileState()).enabled === true, await profileState());
  // A v3 sidecar with NO profile key must load enabled:false (older docs).
  const legacySidecar = JSON.stringify({
    schemaVersion: 3,
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 20, y: 60 }, lens: { distortion: 0, caRed: 0, caBlue: 0, vignette: 0 } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [{ id: 'e0', from: 'in', to: 'out' }],
    },
  });
  writeFileSync(SIDECAR, legacySidecar);
  await openImage(ARW_PATH);
  const legacyPs = await profileState();
  check('v3 sidecar without a profile key loads enabled:false', legacyPs.enabled === false, legacyPs.enabled);
  check('…while the image still carries the parsed profile', legacyPs.hasProfile === true, legacyPs.hasProfile);
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

  // === 5. geometry: un-barrel direction + NCC vs the in-camera JPEG ===
  console.log('verify-lensprofile (geometry vs JPEG):');
  // A high-contrast corner probe: with the profile on, corner content is
  // pulled toward center (g/s < 1), so the corrected corner differs from the
  // uncorrected one while the center barely moves — proven above by ON≠OFF.
  const arwOnPatch = await cornerPatch(onCorner);
  const arwOffPatch = await cornerPatch(offCorner);

  // === 4. JPEG open: no profile, checkbox disabled ===
  console.log('verify-lensprofile (JPEG open):');
  await openImage(JPG_PATH);
  const jpgPs = await profileState();
  check('JPEG has no embedded profile', jpgPs.hasProfile === false, jpgPs.hasProfile);
  await page.locator('.react-flow__node[data-id="in"]').click();
  const toggle = page.locator('[data-testid="lens-profile-toggle"]');
  check('profile checkbox is disabled for a JPEG', await toggle.isDisabled(), await toggle.isDisabled());
  const jpgCorner = await page.locator('.canvas-view-canvas').screenshot();
  const jpgPatch = await cornerPatch(jpgCorner);

  const nccOn = ncc(arwOnPatch, jpgPatch);
  const nccOff = ncc(arwOffPatch, jpgPatch);
  console.log(`  info: corner NCC vs in-camera JPEG — corrected ${nccOn.toFixed(4)}, uncorrected ${nccOff.toFixed(4)}`);
  check('profile-corrected corner aligns to the JPEG better than uncorrected', nccOn > nccOff, { nccOn, nccOff });

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

// =============================================================================
// 7. Cross-lens geometry regression guard (FE 50mm F2.5 G) ------------------
//
// Check #5 above proves the m = 1.1/16384 distortion constant (f9616e2)
// un-barrels test.ARW (FE 24mm F2.8 G) correctly, but only at PREVIEW
// resolution and only at one corner — plenty to catch "the correction does
// nothing" but not enough to catch a wrong knot SCALE, which shows up as a
// several-pixel radial offset that a 48×48-downsampled corner patch can't
// resolve. This section re-derives the same evidence on a SECOND lens with
// different distortion characteristics (the FE 50mm F2.5 G), at FULL
// resolution, across all 5 windows (center + 4 corners), against a real
// Lightroom export — the one comparison precise enough to actually measure
// per-window pixel offsets.
//
// Rendering happens through the real headless CLI (`electron --render`),
// not the live app: the running app's preview is capped at a 2560px long
// edge (see verify-ms2-decode-display.mjs), which cannot be compared
// pixel-for-pixel against a 7008×4672 LR export. The CLI renders full
// resolution, exactly as a batch export would — this is verify-cli.mjs's
// own idiom (hardlink the source + write an adjacent `.silverbox.json` +
// `--render --out`), reused here for a second lens.
//
// Why this specific failure mode matters: a wrong knot-scale constant does
// NOT drift subtly — it produces an unmistakable radial fan. Corner offsets
// grow with distance from center and FLIP SIGN corner-to-corner (this is
// exactly the bug f9616e2 fixed, first caught on the 24mm). A healthy
// constant instead shows small, roughly uniform offsets across the whole
// frame — the residual sub-pixel-per-%-radius wiggle inherent to comparing
// against an LR export (its own demosaic/sharpening/JPEG re-encode).
// PASS: every window's |dx| and |dy| <= 4px, AND max(|corner offset| -
// |center offset|) <= 5px — a growing/flipping fan blows well past both of
// these on the very first future change that breaks this constant, on
// EITHER lens, not just the one it was originally calibrated against.
//
// Gated: `ref-green` is a gitignored personal-photo symlink that exists
// only on the primary dev machine (same idiom as the portrait-orientation
// gate in verify-ms2-decode-display.mjs) — skip loudly elsewhere rather
// than fail. One scene only (DSC00148, the cleaner of the two the conductor
// manually validated) to keep wall time sane — this is a geometry guard,
// not a lens-profile-accuracy survey.
console.log('verify-lensprofile (cross-lens geometry, FE 50mm F2.5 G):');
const LENS50_ARW = process.env.SILVERBOX_TEST_LENS50_ARW ?? 'test-assets/ref-green/DSC00148.ARW';
const LENS50_JPG = process.env.SILVERBOX_TEST_LENS50_JPG ?? 'test-assets/ref-green/DSC00148.jpg';
if (!existsSync(LENS50_ARW) || !existsSync(LENS50_JPG)) {
  console.log(`  SKIP  cross-lens geometry check (fixture missing: ${LENS50_ARW})`);
} else {
  const lens50Work = mkdtempSync(join(tmpdir(), 'silverbox-lens50-verify-'));
  const lens50Out = join(lens50Work, 'out');
  mkdirSync(lens50Out, { recursive: true });
  const lens50Linked = join(lens50Work, 'DSC00148.ARW');
  linkSync(LENS50_ARW, lens50Linked);

  // Lens profile ON, nothing else — an identity 'Develop' node (no
  // `develop` payload, so mergeDevelopParams fills identity/no-op values)
  // keeps the fresh-open default-look injection from ever engaging (a
  // sidecar is present), same as verify-cli.mjs's writeSidecar/simpleLook.
  const lens50Sidecar = {
    schemaVersion: 4,
    createdAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'in',
          type: 'input',
          position: { x: 20, y: 60 },
          lens: { distortion: 0, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } },
        },
        { id: 'dev', type: 'Develop', position: { x: 220, y: 60 } },
        { id: 'out', type: 'output', position: { x: 420, y: 60 } },
      ],
      edges: [
        { id: 'e0', from: 'in', to: 'dev' },
        { id: 'e1', from: 'dev', to: 'out' },
      ],
    },
  };
  const lens50SidecarPath = lens50Linked + '.silverbox.json';
  writeFileSync(lens50SidecarPath, JSON.stringify(lens50Sidecar, null, 2) + '\n');

  // Own userData dir (verify-cli.mjs's idiom): reuse the runner's pooled one
  // if this script is running inside the suite, else mint a fresh temp dir —
  // the CLI is a brand-new spawned process either way, not the Playwright
  // app above (which is already closed by this point).
  const lens50UserData = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-lens50-userdata-'));
  const electronBin = join(projectRoot, 'node_modules', '.bin', 'electron');
  const lens50Render = spawnSync(electronBin, [projectRoot, '--render', '--out', lens50Out, lens50Linked], {
    env: { ...process.env, SILVERBOX_USER_DATA: lens50UserData },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const lens50OutJpg = join(lens50Out, 'DSC00148.jpg');
  check('cross-lens render exits 0', lens50Render.status === 0 && existsSync(lens50OutJpg), {
    status: lens50Render.status,
    stderr: lens50Render.stderr,
  });

  if (lens50Render.status === 0 && existsSync(lens50OutJpg)) {
    const luma = async (p) => {
      const { data, info } = await sharp(p).rotate().greyscale().raw().toBuffer({ resolveWithObject: true });
      return { d: data, w: info.width, h: info.height };
    };
    /** NCC of two equal-size SxS windows at independent offsets in two same-shaped rasters. */
    const windowNcc = (a, b, aw, bw, ax, ay, bx, by, S) => {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      const n = S * S;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const va = a[(ay + y) * aw + ax + x];
          const vb = b[(by + y) * bw + bx + x];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const cov = sab - (sa * sb) / n;
      const v1 = saa - (sa * sa) / n;
      const v2 = sbb - (sb * sb) / n;
      return cov / Math.sqrt(v1 * v2 + 1e-9);
    };
    /** Best-NCC (dx, dy) aligning an SxS window of `sv` onto `lr`'s window at (cx, cy), searching ±R px (exhaustive — R is small enough that this stays fast). */
    const bestOffset = (lr, sv, cx, cy, S = 300, R = 12) => {
      let best = { dx: 0, dy: 0, c: -2 };
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const c = windowNcc(lr.d, sv.d, lr.w, sv.w, cx, cy, cx + dx, cy + dy, S);
          if (c > best.c) best = { dx, dy, c };
        }
      }
      return best;
    };

    const lens50Lr = await luma(LENS50_JPG);
    const lens50Sv = await luma(lens50OutJpg);
    check('rendered output matches the LR export dims (else offsets below are meaningless)', lens50Sv.w === lens50Lr.w && lens50Sv.h === lens50Lr.h, {
      lr: { w: lens50Lr.w, h: lens50Lr.h },
      sv: { w: lens50Sv.w, h: lens50Sv.h },
    });

    const S = 300;
    const M = 60; // corner inset margin, clear of the ±12px search radius
    const spots = {
      center: [((lens50Lr.w - S) / 2) | 0, ((lens50Lr.h - S) / 2) | 0],
      TL: [M, M],
      TR: [lens50Lr.w - S - M, M],
      BL: [M, lens50Lr.h - S - M],
      BR: [lens50Lr.w - S - M, lens50Lr.h - S - M],
    };
    const offsets = {};
    for (const [name, [x, y]] of Object.entries(spots)) {
      offsets[name] = bestOffset(lens50Lr, lens50Sv, x, y, S);
      console.log(`  info: ${name.padEnd(6)} dx=${offsets[name].dx} dy=${offsets[name].dy} corr=${offsets[name].c.toFixed(3)}`);
    }

    for (const [name, o] of Object.entries(offsets)) {
      check(`${name} offset within ±4px of the LR export`, Math.abs(o.dx) <= 4 && Math.abs(o.dy) <= 4, o);
    }
    const centerMag = Math.hypot(offsets.center.dx, offsets.center.dy);
    let maxCornerDelta = 0;
    for (const name of ['TL', 'TR', 'BL', 'BR']) {
      const cornerMag = Math.hypot(offsets[name].dx, offsets[name].dy);
      maxCornerDelta = Math.max(maxCornerDelta, Math.abs(cornerMag - centerMag));
    }
    check('no radial fan (max |corner offset − center offset| <= 5px)', maxCornerDelta <= 5, { maxCornerDelta, centerMag });
  }
  if (existsSync(lens50SidecarPath)) unlinkSync(lens50SidecarPath);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
