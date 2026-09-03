/**
 * Local-adaptive tone node verify (docs/research/local-adaptive-tone.md,
 * lr-tone-measurements.md / -r2.md (round-3 addendum), LOCAL-ADAPTIVE TONE
 * STAGE 1c implementer brief): proves the `localtone` Fast Local Laplacian
 * node reproduces LR's measured LOCALITY signatures in-engine, not just
 * "the render changed".
 *
 * STANDALONE — deliberately NOT registered in package.json's `verify`/
 * `verify:serial` chain. A `verify:localtone` npm script IS registered so
 * it can be run by name; run by hand with `npm run verify:localtone`.
 *
 *  1. E1 replication (lr-tone-measurements.md's headline table): a fixed
 *     18%-gray 64px patch on 6 uniform backgrounds (0.5/2/8/18/50/90%).
 *     Shadows=+100 then Highlights=-100, center-patch delta-over-base
 *     (stops). REQUIRED: the patch delta VARIES with background (locality)
 *     with the same SIGN structure LR measured, and magnitude within ~2x
 *     LR's table values (floor-padded so near-zero LR values don't demand
 *     an impossible ratio) — the full LR-vs-silverbox table is printed.
 *  2. R3 curve replication (lr-tone-measurements-r2.md's round-3 addendum,
 *     the STAGE 1c decisive new data): 4 of round-3's own probe geometries
 *     — 64px patch offset from a fixed surround, Shadows+100 at offsets
 *     {1.5, 2.5, 3.5} stops (surround 50%) and Highlights-100 at offset
 *     {2} stops (surround 2%) — center-patch delta within ~30% of the
 *     measured LR value at each point.
 *  3. E4 no-halo (lr-tone-measurements-r2.md's σr=4.0 calibration, on a hard
 *     step edge, contrast=5 stops, center=20%, Shadows+100): the delta
 *     profile across the edge is two flat plateaus, transition confined to
 *     <=8px, overshoot ratio < 0.1.
 *  4. Identity invariants: amount=0 -> bit-exact pass-through (export bytes
 *     identical); shadows=highlights=0 -> delta < 1/255 everywhere sampled;
 *     GPU determinism (two renders of the same state -> identical export
 *     bytes).
 *  5. Sidecar round-trip: schemaVersion stays 4 (additive node kind, same
 *     pattern as lut/denoise); path/params survive a save+reopen.
 *
 * NOT reproduced by stage 1c (expected, out of scope — noted in the printed
 * summary): the E6 global scene-statistics range-expansion layer (Eric
 * Chan's "mechanism B").
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { writeLinearDng } from './gen-linear-dng.mjs';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
ensureTestProjectEnv();

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

// Verify-side math only (mirrors verify-lineardng.mjs's own convention — NOT
// a copy of engine/color/srgb.ts).
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const log2 = Math.log2;

// === generate the E1/E4 synthetic fixtures (gen-linear-dng.mjs's machinery,
// same construction as gen-tone-experiments.mjs's E1/E4 generators — see
// that file's own header comments for the exact rationale) ==================
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-localtone-'));

// --- E1: 18% gray 64px patch on 6 uniform backgrounds (lr-tone-measurements.md's own construction) ---
const E1_SIZE = 1024;
const E1_PATCH = 64;
const E1_PATCH_VALUE = 0.18;
const E1_BACKGROUNDS_PCT = [0.5, 2, 8, 18, 50, 90];
const e1p0 = (E1_SIZE - E1_PATCH) / 2;
const e1p1 = e1p0 + E1_PATCH;
const e1Files = E1_BACKGROUNDS_PCT.map((bgPct) => {
  const bg = bgPct / 100;
  const path = join(workDir, `e1_bg${bgPct}.dng`);
  writeLinearDng(path, {
    width: E1_SIZE,
    height: E1_SIZE,
    generator: (x, y) => (x >= e1p0 && x < e1p1 && y >= e1p0 && y < e1p1 ? E1_PATCH_VALUE : bg),
  });
  return { bgPct, bg, path };
});

// --- R3 probes: 64px patch offset from a fixed surround by signed log2
// stops (lr-tone-measurements-r2.md's round-3 addendum construction,
// gen-tone-experiments-r3.mjs — inlined here the same way E1/E4 are).
// Shadows probe: surround=50%, patch DARKER by `offset` stops. Highlights
// probe: surround=2%, patch BRIGHTER by `offset` stops. ---
const R3_SIZE = 1024;
const R3_PATCH = 64;
const r3p0 = (R3_SIZE - R3_PATCH) / 2;
const r3p1 = r3p0 + R3_PATCH;
const R3_SH_SURROUND = 0.5;
const R3_SH_OFFSETS = [1.5, 2.5, 3.5];
const R3_HI_SURROUND = 0.02;
const R3_HI_OFFSETS = [2];
// LR-measured targets, stops (lr-tone-measurements-r2.md's round-3 addendum table).
const R3_SH_TARGET = { 1.5: 0.141, 2.5: 0.473, 3.5: 0.804 };
const R3_HI_TARGET = { 2: -1.093 };
const r3ShFiles = R3_SH_OFFSETS.map((offset) => {
  const patch = R3_SH_SURROUND / 2 ** offset;
  const path = join(workDir, `r3_sh_o${offset}.dng`);
  writeLinearDng(path, {
    width: R3_SIZE,
    height: R3_SIZE,
    generator: (x, y) => (x >= r3p0 && x < r3p1 && y >= r3p0 && y < r3p1 ? patch : R3_SH_SURROUND),
  });
  return { offset, path };
});
const r3HiFiles = R3_HI_OFFSETS.map((offset) => {
  const patch = R3_HI_SURROUND * 2 ** offset;
  const path = join(workDir, `r3_hi_o${offset}.dng`);
  writeLinearDng(path, {
    width: R3_SIZE,
    height: R3_SIZE,
    generator: (x, y) => (x >= r3p0 && x < r3p1 && y >= r3p0 && y < r3p1 ? patch : R3_HI_SURROUND),
  });
  return { offset, path };
});

// --- E4: hard step edge, contrast=5 stops, center=20% (gen-tone-experiments.mjs's e4_c5_hard_l20 construction, inlined) ---
const E4_SIZE = 1024;
const E4_EDGE_X = E4_SIZE / 2;
const E4_STOPS = 5;
const E4_CENTER_PCT = 20;
{
  // Clip-avoidance rescale — same logic as gen-tone-experiments.mjs's own
  // edgeLevels() (its header comment: "if that would put `light` above
  // 0.95, BOTH sides are scaled down together, preserving the exact stop
  // ratio"). Without this, writeLinearDng's own [0,1] clamp silently caps
  // an out-of-range light value (centerFrac*sqrt(2^5) = 1.131 here),
  // realizing LESS than the nominal 5 stops of contrast.
  const ratio = 2 ** E4_STOPS;
  const centerFrac = E4_CENTER_PCT / 100;
  var E4_DARK = centerFrac / Math.sqrt(ratio);
  var E4_LIGHT = centerFrac * Math.sqrt(ratio);
  if (E4_LIGHT > 0.95) {
    const scale = 0.95 / E4_LIGHT;
    E4_DARK *= scale;
    E4_LIGHT *= scale;
  }
}
const e4Path = join(workDir, 'e4_c5_hard_l20.dng');
writeLinearDng(e4Path, { width: E4_SIZE, height: E4_SIZE, generator: (x) => (x < E4_EDGE_X ? E4_DARK : E4_LIGHT) });

// === launch the app =========================================================
const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-localtone-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReadyOrError = () =>
    page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 60_000 }
    );
  const openImageAndWait = async (path) => {
    // fire-and-forget: never await __openImageByPath itself (ms2's own
    // caution — its execution context can be torn down mid-decode).
    await page.evaluate((p) => void window.__openImageByPath(p), path);
    await waitReadyOrError();
  };
  const imageState = () => page.evaluate(() => window.__debug.imageState());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const encodedCrop = (x0, y0, w, h) => page.evaluate(([x0, y0, w, h]) => window.__debug.encodedCropForVerify(x0, y0, w, h), [x0, y0, w, h]);
  /** Linear-mean over a crop, decoded from the encoded rgba8 readback (matches verify-lineardng.mjs's own encodedCropLinearMean). */
  const cropLinearMean = async (x0, y0, w, h) => {
    const px = await encodedCrop(x0, y0, w, h);
    let r = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += srgbDecode(px[i] / 255);
      n++;
    }
    return r / n;
  };
  const addNode = async (kind) => {
    await page.locator('[data-testid="add-node-button"]').click();
    await page.locator(`[data-testid="add-node-${kind}"]`).click();
    return (await graphState()).nodes.at(-1);
  };
  const setLocalTone = (nodeId, patch) => page.evaluate(([n, p]) => window.__debug.setLocalToneParams(n, p), [nodeId, patch]);
  const localToneState = (nodeId) => page.evaluate((n) => window.__debug.localToneNodeState(n), nodeId ?? null);
  const settle = () => page.waitForTimeout(250); // no async load to await (unlike lut/denoise) — just let the re-render land

  // --- neutralize baselineExposureEV before ANY decode (verify-lineardng.mjs's own step 1) ---
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  await page.evaluate(() => window.__debug.updateSettings({ baselineExposureEV: 0 }));
  check('baselineExposureEV neutralized to 0 before first open', (await page.evaluate(() => window.__debug.settingsState().baselineExposureEV)) === 0);

  // ===========================================================================
  console.log('verify-localtone (setup: open the E4 edge file — has real local contrast, unlike a flat field — add a localtone node, auto-spliced into input→Develop→output):');
  // NOTE: opening a DIFFERENT synthetic image is a DIFFERENT "photo" with no
  // existing sidecar, so it gets the app's fresh-open default graph
  // (input->Develop->output, no localtone node) — the node added below does
  // NOT survive switching to a DIFFERENT file later in this script. The E1
  // loop and the E4 no-halo section each add their OWN fresh node right
  // after their own openImageAndWait for exactly this reason.
  await openImageAndWait(e4Path);
  const dimsCheck = await imageState();
  check('E4 image dims survive undownscaled (1024x1024, well under previewLongEdge default 2560)', dimsCheck.fullWidth === E4_SIZE && dimsCheck.fullHeight === E4_SIZE, dimsCheck);

  const ltNode = await addNode('localtone');
  check(
    'localtone node added with kind "localtone" and identity defaults (shadows=highlights=0, amount=1)',
    ltNode?.kind === 'localtone' && ltNode?.localtone?.shadows === 0 && ltNode?.localtone?.highlights === 0 && ltNode?.localtone?.amount === 1,
    ltNode
  );
  const ltId = ltNode.id;
  const g0 = await graphState();
  check(
    'adding it spliced it directly into the active chain (dev -> localtone -> out), not left disconnected like the image node',
    g0.edges.some((e) => e.target === ltId) && g0.edges.some((e) => e.source === ltId),
    g0.edges
  );

  // ===========================================================================
  console.log('verify-localtone (3a. identity invariants — amount=0 bit-exact, shadows=highlights=0 within 1/255):');
  const EXPORT_OPTS = { quality: 100, maxDim: null, metadata: 'none', colorSpace: 'srgb' };
  const exportAndRead = async (path) => {
    await page.evaluate(([p, o]) => window.__debug.exportImageTo(p, o), [path, EXPORT_OPTS]);
    await page.waitForFunction((p) => window.__debug.exportState().status === 'idle', null, { timeout: 30_000 }).catch(() => {});
    // exportState flips busy->idle; poll for the file's existence as the real signal (mirrors other export-verify scripts' pattern of a short settle).
    for (let i = 0; i < 100; i++) {
      try {
        return readFileSync(path);
      } catch {
        await page.waitForTimeout(100);
      }
    }
    throw new Error(`export never landed at ${path}`);
  };

  const baseExportPath = join(workDir, 'export-base.png');
  const baseBytes = await exportAndRead(baseExportPath);

  // default-added node is already identity (shadows=highlights=0) — confirm bit-exact against a freshly-removed-node baseline isn't needed: the node not yet touched IS the baseline. Set amount=0 explicitly and re-export to prove the "amount<=0 is identity" path specifically.
  await setLocalTone(ltId, { amount: 0 });
  await settle();
  const amount0Path = join(workDir, 'export-amount0.png');
  const amount0Bytes = await exportAndRead(amount0Path);
  check('amount=0 export is BYTE-IDENTICAL to the untouched baseline (bit-exact pass-through, buildPlan skips the pass entirely)', Buffer.compare(baseBytes, amount0Bytes) === 0, {
    baseLen: baseBytes.length,
    amount0Len: amount0Bytes.length,
  });
  await setLocalTone(ltId, { amount: 1 });
  await settle();

  // shadows=highlights=0 is ALSO identity per isIdentityLocalTone (the OR
  // branch, independent of amount<=0's own branch) — buildPlan skips the
  // pass entirely either way, so round-tripping through a genuinely
  // NON-identity state and back to shadows=highlights=0 should land back on
  // the exact same bit-exact baseline (a stronger claim than the brief's
  // "< 1/255", and it actually exercises the OR's second branch, unlike a
  // trivial before/after with no state change in between).
  await setLocalTone(ltId, { shadows: 60, highlights: -60 });
  await settle();
  const nonIdentityPath = join(workDir, 'export-nonidentity.png');
  const nonIdentityBytes = await exportAndRead(nonIdentityPath);
  check('a genuinely non-identity state (shadows=60,highlights=-60) actually changes the export vs baseline (sanity: the node is really doing something)', Buffer.compare(baseBytes, nonIdentityBytes) !== 0, {
    baseLen: baseBytes.length,
    nonIdentityLen: nonIdentityBytes.length,
  });
  await setLocalTone(ltId, { shadows: 0, highlights: 0 });
  await settle();
  const zeroPath = join(workDir, 'export-zero.png');
  const zeroBytes = await exportAndRead(zeroPath);
  check('shadows=highlights=0 export is BYTE-IDENTICAL to the untouched baseline (bit-exact pass-through, isIdentityLocalTone\'s OR branch)', Buffer.compare(baseBytes, zeroBytes) === 0, {
    baseLen: baseBytes.length,
    zeroLen: zeroBytes.length,
  });

  // ===========================================================================
  console.log('verify-localtone (3b. GPU determinism — two renders of the same state produce byte-identical exports):');
  const det1Path = join(workDir, 'export-det1.png');
  const det2Path = join(workDir, 'export-det2.png');
  await setLocalTone(ltId, { shadows: 40, highlights: -20 });
  await settle();
  const det1 = await exportAndRead(det1Path);
  await settle();
  const det2 = await exportAndRead(det2Path);
  check('two exports of the identical graph state are byte-identical', Buffer.compare(det1, det2) === 0, { len1: det1.length, len2: det2.length });
  await setLocalTone(ltId, { shadows: 0, highlights: 0 });
  await settle();

  // ===========================================================================
  console.log('verify-localtone (1. E1 replication — patch delta-over-base VARIES with background, matching LR\'s sign structure; full LR-vs-silverbox table):');
  // LR headline table (lr-tone-measurements.md's E1 section), stops.
  const LR_SHADOWS_P100 = { 0.5: 0.022, 2: 0.024, 8: 0.008, 18: 0.0, 50: 0.131, 90: 0.495 };
  const LR_HIGHLIGHTS_M100 = { 0.5: -4.01, 2: -1.73, 8: -0.31, 18: 0.0, 50: 0.0, 90: 0.0 };
  const PATCH_SAMPLE = 16; // deep-interior window (round-2's methodology), well inside the 64px patch — avoids the edge-transition zone
  const psx = e1p0 + (E1_PATCH - PATCH_SAMPLE) / 2;
  const psy = psx;

  const e1Results = [];
  for (const { bgPct, path } of e1Files) {
    await openImageAndWait(path);
    // A DIFFERENT photo -> a FRESH default doc (see the setup section's own
    // note) -> add this file's own localtone node.
    const node = await addNode('localtone');
    const nodeId = node.id;
    const state0 = await localToneState(nodeId);
    check(`E1 bg=${bgPct}%: freshly added localtone node is at identity before measuring`, state0?.shadows === 0 && state0?.highlights === 0, state0);

    const base = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);

    await setLocalTone(nodeId, { shadows: 100, highlights: 0 });
    await settle();
    const afterShadows = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    const deltaShadows = log2(afterShadows / base);

    await setLocalTone(nodeId, { shadows: 0, highlights: -100 });
    await settle();
    const afterHighlights = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    const deltaHighlights = log2(afterHighlights / base);

    e1Results.push({ bgPct, base, deltaShadows, deltaHighlights, lrShadows: LR_SHADOWS_P100[bgPct], lrHighlights: LR_HIGHLIGHTS_M100[bgPct] });
  }

  console.log('  bg%    | silverbox sh+100 | LR sh+100 | silverbox hi-100 | LR hi-100');
  for (const r of e1Results) {
    console.log(
      `  ${String(r.bgPct).padStart(5)} | ${r.deltaShadows.toFixed(3).padStart(16)} | ${r.lrShadows.toFixed(3).padStart(9)} | ${r.deltaHighlights.toFixed(3).padStart(16)} | ${r.lrHighlights.toFixed(3).padStart(9)}`
    );
  }

  const deltasShadows = e1Results.map((r) => r.deltaShadows);
  const spreadShadows = Math.max(...deltasShadows) - Math.min(...deltasShadows);
  check('E1 (locality): Shadows+100 patch delta VARIES with background (spread > 0.01 stops — not a constant/global effect)', spreadShadows > 0.01, deltasShadows);
  const deltasHighlights = e1Results.map((r) => r.deltaHighlights);
  const spreadHighlights = Math.max(...deltasHighlights) - Math.min(...deltasHighlights);
  check('E1 (locality): Highlights-100 patch delta VARIES with background (spread > 0.01 stops)', spreadHighlights > 0.01, deltasHighlights);

  // Sign structure: Shadows delta at bg=90% must be >= bg=0.5% (brighter surround -> more/equal lift, never less).
  // STAGE 1c: round-3's own no-dead-zone finding means bg=50%/90% (offsets
  // 1.47/2.32 stops from the 18% patch) should now show a real, positive
  // lift, not the sigmaR dead-zone's exact zero stage 1b left behind.
  const sh05 = e1Results.find((r) => r.bgPct === 0.5).deltaShadows;
  const sh90 = e1Results.find((r) => r.bgPct === 90).deltaShadows;
  check('E1 (sign, Shadows): bg=90% lift >= bg=0.5% lift (brighter surround -> more/equal shadow lift, per LR)', sh90 >= sh05, { sh05, sh90 });
  const shPositiveSomewhere = e1Results.some((r) => r.deltaShadows > 0.002);
  check('E1 (sign, Shadows): at least one background shows a clearly positive (correctly-directed) lift', shPositiveSomewhere, deltasShadows);

  // Sign structure: Highlights delta at bg=0.5% must be clearly negative (strong crush) and much more negative than at bg=90% (~0, per LR).
  const hi05 = e1Results.find((r) => r.bgPct === 0.5).deltaHighlights;
  const hi90 = e1Results.find((r) => r.bgPct === 90).deltaHighlights;
  check('E1 (sign, Highlights): bg=0.5% crush is clearly negative', hi05 < -0.002, hi05);
  check('E1 (sign, Highlights): bg=0.5% crush is stronger (more negative) than bg=90%', hi05 < hi90, { hi05, hi90 });

  // Magnitude tolerance (loose — "within ~2x of LR's table values", floor-padded so a near-zero LR value doesn't demand an impossible ratio).
  const MAG_FLOOR = 0.02;
  const magnitudeOk = (silverbox, lr) => Math.abs(silverbox) <= 2 * Math.max(Math.abs(lr), MAG_FLOOR) + MAG_FLOOR;
  for (const r of e1Results) {
    check(`E1 bg=${r.bgPct}%: Shadows+100 magnitude within ~2x of LR's ${r.lrShadows} stops (loose, stage-1 tolerance)`, magnitudeOk(r.deltaShadows, r.lrShadows), r);
  }
  for (const r of e1Results) {
    check(`E1 bg=${r.bgPct}%: Highlights-100 magnitude within ~2x of LR's ${r.lrHighlights} stops (loose, stage-1 tolerance)`, magnitudeOk(r.deltaHighlights, r.lrHighlights), r);
  }

  // ===========================================================================
  console.log('verify-localtone (2. R3 curve replication — round-3\'s own probe geometry, Shadows+100 at offsets {1.5,2.5,3.5} and Highlights-100 at offset {2}, within ~30% of LR):');
  const r3Results = [];
  const r3MagnitudeOk = (silverbox, lr) => Math.abs(silverbox - lr) <= 0.3 * Math.abs(lr);
  for (const { offset, path } of r3ShFiles) {
    await openImageAndWait(path);
    const node = await addNode('localtone');
    const nodeId = node.id;
    const state0 = await localToneState(nodeId);
    check(`R3 sh offset=${offset}: freshly added localtone node is at identity before measuring`, state0?.shadows === 0 && state0?.highlights === 0, state0);
    const base = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    await setLocalTone(nodeId, { shadows: 100, highlights: 0 });
    await settle();
    const after = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    const delta = log2(after / base);
    r3Results.push({ probe: 'sh', offset, delta, target: R3_SH_TARGET[offset] });
  }
  for (const { offset, path } of r3HiFiles) {
    await openImageAndWait(path);
    const node = await addNode('localtone');
    const nodeId = node.id;
    const state0 = await localToneState(nodeId);
    check(`R3 hi offset=${offset}: freshly added localtone node is at identity before measuring`, state0?.shadows === 0 && state0?.highlights === 0, state0);
    const base = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    await setLocalTone(nodeId, { shadows: 0, highlights: -100 });
    await settle();
    const after = await cropLinearMean(psx, psy, PATCH_SAMPLE, PATCH_SAMPLE);
    const delta = log2(after / base);
    r3Results.push({ probe: 'hi', offset, delta, target: R3_HI_TARGET[offset] });
  }
  console.log('  probe | offset | silverbox | LR target | relErr');
  for (const r of r3Results) {
    const relErr = Math.abs(r.delta - r.target) / Math.abs(r.target);
    console.log(`  ${r.probe.padStart(5)} | ${String(r.offset).padStart(6)} | ${r.delta.toFixed(4).padStart(9)} | ${r.target.toFixed(4).padStart(9)} | ${(relErr * 100).toFixed(0).padStart(4)}%`);
  }
  for (const r of r3Results) {
    check(`R3 ${r.probe} offset=${r.offset}: within ~30% of LR's measured ${r.target} stops`, r3MagnitudeOk(r.delta, r.target), r);
  }

  // ===========================================================================
  console.log('verify-localtone (3. E4 no-halo — hard edge, contrast=5 stops, Shadows+100: two flat plateaus, transition <=8px, overshoot ratio < 0.1):');
  // Reopening e4Path (even though it's the SAME file setup already opened
  // once) still resets to a fresh default doc — no sidecar was ever SAVED
  // for it (setup's node lived only in memory), so this is functionally a
  // "new photo" open just like the E1 loop's own files. Add a fresh node.
  await openImageAndWait(e4Path);
  const e4Dims = await imageState();
  check('E4 image dims survive undownscaled', e4Dims.fullWidth === E4_SIZE && e4Dims.fullHeight === E4_SIZE, e4Dims);

  const e4Node = await addNode('localtone');
  const e4NodeId = e4Node.id;
  const state0e4 = await localToneState(e4NodeId);
  check('E4: freshly added localtone node is at identity before measuring', state0e4?.shadows === 0 && state0e4?.highlights === 0, state0e4);

  const E4_Y = E4_SIZE / 2;
  const E4_STRIP_H = 32;
  const E4_OFFSETS = [-300, -200, -100, ...Array.from({ length: 41 }, (_, i) => i - 20), 100, 200, 300];
  const baseProfile = new Map();
  for (const off of E4_OFFSETS) baseProfile.set(off, await cropLinearMean(E4_EDGE_X + off, E4_Y - E4_STRIP_H / 2, 1, E4_STRIP_H));

  await setLocalTone(e4NodeId, { shadows: 100, highlights: 0 });
  await settle();
  const deltaProfile = new Map();
  for (const off of E4_OFFSETS) {
    const after = await cropLinearMean(E4_EDGE_X + off, E4_Y - E4_STRIP_H / 2, 1, E4_STRIP_H);
    deltaProfile.set(off, log2(after / baseProfile.get(off)));
  }

  const farOffsets = [-300, -200, -100];
  const nearOffsets = [100, 200, 300];
  const darkPlateau = farOffsets.reduce((a, o) => a + deltaProfile.get(o), 0) / farOffsets.length;
  const lightPlateau = nearOffsets.reduce((a, o) => a + deltaProfile.get(o), 0) / nearOffsets.length;
  console.log(`  dark-side plateau delta: ${darkPlateau.toFixed(4)} stops, light-side plateau delta: ${lightPlateau.toFixed(4)} stops`);

  // Plateau flatness: the two FAR-offset groups must each be internally flat.
  const darkVals = farOffsets.map((o) => deltaProfile.get(o));
  const lightVals = nearOffsets.map((o) => deltaProfile.get(o));
  const flat = (vals) => Math.max(...vals) - Math.min(...vals) < 0.03;
  check('E4: dark-side far plateau is flat (spread < 0.03 stops across -300/-200/-100px)', flat(darkVals), darkVals);
  check('E4: light-side far plateau is flat (spread < 0.03 stops across +100/+200/+300px)', flat(lightVals), lightVals);

  // Transition width: find the first/last near-edge offset (within +-20px) whose delta already sits within 10% of its OWN side's plateau value — the transition is everything strictly between.
  const plateauSpread = Math.abs(lightPlateau - darkPlateau) || 1e-6;
  const nearEdgeOffsets = Array.from({ length: 41 }, (_, i) => i - 20);
  let transitionPx = 0;
  for (const o of nearEdgeOffsets) {
    const v = deltaProfile.get(o);
    const side = o < 0 ? darkPlateau : lightPlateau;
    if (Math.abs(v - side) > 0.1 * plateauSpread) transitionPx = Math.max(transitionPx, Math.abs(o) + 1);
  }
  // STAGE 1c: levelDamp (localToneNode.ts) fades local-tone response by
  // pyramid LEVEL INDEX (independent of gammaJ/log2-offset), so only the
  // finest few levels — governed by sigmaR via LOCALTONE_HALO_LEVELS_PER_SIGMA_R
  // — carry real response; this is what keeps the far-field plateaus flat.
  check(`E4: transition confined to <=8px of the edge (measured ${transitionPx}px)`, transitionPx <= 8, { transitionPx, deltaProfile: Object.fromEntries(deltaProfile) });

  // Overshoot: the max deviation beyond either plateau within the near-edge window, as a ratio of the plateau spread.
  let overshoot = 0;
  for (const o of nearEdgeOffsets) {
    const v = deltaProfile.get(o);
    if (v < Math.min(darkPlateau, lightPlateau)) overshoot = Math.max(overshoot, Math.min(darkPlateau, lightPlateau) - v);
    if (v > Math.max(darkPlateau, lightPlateau)) overshoot = Math.max(overshoot, v - Math.max(darkPlateau, lightPlateau));
  }
  const overshootRatio = overshoot / plateauSpread;
  check(`E4: overshoot ratio < 0.1 on the hard edge (measured ${overshootRatio.toFixed(3)})`, overshootRatio < 0.1, { overshoot, plateauSpread, overshootRatio });

  // ===========================================================================
  console.log('verify-localtone (4. sidecar round-trip — schemaVersion stays 4, params survive save+reopen):');
  await setLocalTone(e4NodeId, { shadows: 30, highlights: -15, sigmaR: 3.5, amount: 0.8 });
  await settle();
  check('Inspector-visible state reflects the set params before save', JSON.stringify(await localToneState(e4NodeId)) === JSON.stringify({ shadows: 30, highlights: -15, clarity: 0, sigmaR: 3.5, amount: 0.8 }), await localToneState(e4NodeId));

  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const lookPath = await page.evaluate(() => window.__debug.projectState().currentLookPath);
  check('doc with a localtone node saved', typeof lookPath === 'string' && lookPath.length > 0, lookPath);
  const savedJson = JSON.parse(readFileSync(lookPath, 'utf8'));
  check('saved sidecar is STILL schemaVersion 4 (additive node kind, no version bump — same pattern as lut/denoise)', savedJson.schemaVersion === 4, savedJson.schemaVersion);
  const savedNode = savedJson.graph.nodes.find((n) => n.id === e4NodeId);
  check(
    "saved sidecar carries the localtone node's type + params",
    savedNode?.type === 'localtone' && savedNode?.localtone?.shadows === 30 && savedNode?.localtone?.highlights === -15 && savedNode?.localtone?.sigmaR === 3.5 && savedNode?.localtone?.amount === 0.8,
    savedNode
  );

  // Reopening the SAME e4Path now loads the sidecar JUST saved above (unlike
  // every earlier reopen in this script, which hit a fresh default doc).
  await openImageAndWait(e4Path);
  const reloadedGraph = await graphState();
  const reloadedNode = reloadedGraph.nodes.find((n) => n.id === e4NodeId);
  check(
    'reloaded doc preserves the localtone node params exactly',
    reloadedNode?.localtone?.shadows === 30 && reloadedNode?.localtone?.highlights === -15 && reloadedNode?.localtone?.sigmaR === 3.5 && reloadedNode?.localtone?.amount === 0.8,
    reloadedNode
  );

  console.log('');
  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });
}

rmSync(workDir, { recursive: true, force: true });

console.log('\nNOT reproduced by stage 1c (expected, out of scope per the brief):');
console.log('  - E6 global scene-statistics range-expansion layer (Eric Chan\'s "mechanism B") — no code path for it exists yet.');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
