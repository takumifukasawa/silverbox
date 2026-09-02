#!/usr/bin/env node
/**
 * Generates the E1/E2/E4/E5/E6 synthetic test-image sets from
 * docs/research/local-adaptive-tone.md §5 ("識別実験の設計") — the priority
 * subset the conductor picked for the first LR-characterization pass (E3/E7/
 * E8 are lower priority per that doc's own "実験の優先順位" table and are
 * NOT generated here). Every image is a demosaiced, linear, ACHROMATIC
 * (R=G=B) Linear DNG written via gen-linear-dng.mjs's writeLinearDng — see
 * that file's header comment for the DNG tag/color-matrix rationale.
 *
 * Deterministic: every generator below is a pure function of (x, y) and the
 * experiment's own numeric parameters — no randomness anywhere, so no seed
 * is needed.
 *
 * Usage: node scripts/gen-tone-experiments.mjs [outDir]
 *   outDir defaults to ./tone-experiments-out (gitignored — see .gitignore;
 *   the caller is expected to point this OUTSIDE the repo for a real LR run).
 *
 * Output: <outDir>/{e1,e2,e4,e5,e6}/*.dng + <outDir>/manifest.json (one
 * record per generated file: experiment, id, file, width, height, params).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLinearDng } from './gen-linear-dng.mjs';

const outDir = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'tone-experiments-out');

const manifest = [];
function record(experiment, id, relPath, width, height, params, notes) {
  manifest.push({ experiment, id, file: relPath, width, height, params, ...(notes ? { notes } : {}) });
}
function write(experiment, id, relPath, width, height, generator, params, notes) {
  const abs = join(outDir, relPath);
  writeLinearDng(abs, { width, height, generator });
  record(experiment, id, relPath, width, height, params, notes);
}

// Abramowitz & Stegun 7.1.26 erf approximation, max abs error 1.5e-7 — more
// than enough precision for a 16-bit-quantized target (worst case ~0.01 LSB).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

// === E1 — local-adaptation existence proof (patch on uniform surrounds) ===
// docs/research/local-adaptive-tone.md §"E1": 18% gray 64px patch centered
// in a 1024² field of uniform background, 6 background levels.
{
  const SIZE = 1024;
  const PATCH = 64;
  const PATCH_VALUE = 0.18;
  const BACKGROUNDS_PCT = [0.5, 2, 8, 18, 50, 90];
  const p0 = (SIZE - PATCH) / 2;
  const p1 = p0 + PATCH;
  for (const bgPct of BACKGROUNDS_PCT) {
    const bg = bgPct / 100;
    const id = `e1_bg${bgPct}`;
    const gen = (x, y) => (x >= p0 && x < p1 && y >= p0 && y < p1 ? PATCH_VALUE : bg);
    write('E1', id, `e1/${id}.dng`, SIZE, SIZE, gen, { size: SIZE, patchPx: PATCH, patchValue: PATCH_VALUE, backgroundValue: bg, backgroundPct: bgPct });
  }
}

// === E2 — spatial scale of the adaptation (bar gratings, 2 resolutions) ===
// docs/research/local-adaptive-tone.md §"E2": light/dark (18%/1.8%) vertical
// bar gratings, periods 4..1024px (8 octaves), at 1000px and 4000px long
// edge — the resolution pair is the decisive test for whether the pyramid is
// built to full image size (LLF) or truncated at a fixed pixel radius.
// Short edge: elongated rectangle (not square) to keep the 4000px files a
// reasonable size, since content is uniform along y — clamp(res/4, 64, 512).
{
  const LIGHT = 0.18;
  const DARK = 0.018;
  const PERIODS = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const RESOLUTIONS = [1000, 4000];
  for (const res of RESOLUTIONS) {
    const height = Math.max(64, Math.min(512, Math.round(res / 4)));
    for (const period of PERIODS) {
      const half = period / 2;
      const id = `e2_p${period}_r${res}`;
      const gen = (x) => (Math.floor(x / half) % 2 === 0 ? LIGHT : DARK);
      write('E2', id, `e2/${id}.dng`, res, height, gen, { period, resolution: res, width: res, height, lightValue: LIGHT, darkValue: DARK });
    }
  }
}

// === E4 — hard-edge halo behavior & σr estimate (+ E5's absolute-luminance reuse) ===
// docs/research/local-adaptive-tone.md §"E4": contrast {1,2,3,5,7,10} stops ×
// sharpness {hard, σ=4px, σ=16px} × center-luminance {1,5,20,60}%. Full cross
// is 6×3×4=72 images; pruned to 36 (≤40 per the brief) as follows:
//   - FULL 6×3 contrast×sharpness sweep at ONE representative center
//     luminance (20% — mid-range, avoids both blacks- and whites-side
//     clipping for the full contrast range) = 18 images. This alone answers
//     E4's own question (halo shape/width vs. contrast and vs. sharpness).
//   - For the OTHER 3 center luminances (1%, 5%, 60%), only the HARD-edge
//     contrast sweep (6 images each = 18) — sharpness×luminance interaction
//     isn't what E4/E5 are testing; only "does the σr crossover / halo
//     shape shift with absolute luminance" (E5 method B) is, and hard edges
//     isolate that most cleanly.
//   Total: 18 + 18 = 36 images.
// Clip avoidance (constraint: nothing clips above 95%): each (stops, centerPct)
// pair is placed geometrically around its center (dark = center/sqrt(ratio),
// light = center*sqrt(ratio)); if that would put `light` above 0.95, BOTH
// sides are scaled down together (preserving the exact stop ratio, shifting
// the realized center darker) so light lands exactly at 0.95. The realized
// (possibly shifted) center/dark/light are recorded in the manifest per file
// — always use those, not the nominal centerPct, for any log-domain fit.
{
  const SIZE = 1024;
  const EDGE_X = SIZE / 2;
  const CONTRASTS_STOPS = [1, 2, 3, 5, 7, 10];
  const SHARPNESS = [
    { id: 'hard', sigma: null },
    { id: 's4', sigma: 4 },
    { id: 's16', sigma: 16 },
  ];
  const BASELINE_LUM_PCT = 20;
  const OTHER_LUM_PCT = [1, 5, 60];

  function edgeLevels(stops, centerPct) {
    const ratio = 2 ** stops;
    const centerFrac = centerPct / 100;
    let dark = centerFrac / Math.sqrt(ratio);
    let light = centerFrac * Math.sqrt(ratio);
    if (light > 0.95) {
      const scale = 0.95 / light;
      dark *= scale;
      light *= scale;
    }
    return { dark, light, realizedCenter: Math.sqrt(dark * light) };
  }
  function edgeGenerator(dark, light, sigma) {
    if (sigma === null) return (x) => (x < EDGE_X ? dark : light);
    return (x) => dark + (light - dark) * 0.5 * (1 + erf((x - EDGE_X) / (sigma * Math.SQRT2)));
  }

  const e4Combos = [];
  for (const { id: sharpId, sigma } of SHARPNESS) {
    for (const stops of CONTRASTS_STOPS) {
      e4Combos.push({ stops, sharpId, sigma, lumPct: BASELINE_LUM_PCT });
    }
  }
  for (const lumPct of OTHER_LUM_PCT) {
    for (const stops of CONTRASTS_STOPS) {
      e4Combos.push({ stops, sharpId: 'hard', sigma: null, lumPct });
    }
  }

  for (const combo of e4Combos) {
    const { dark, light, realizedCenter } = edgeLevels(combo.stops, combo.lumPct);
    const id = `e4_c${combo.stops}_${combo.sharpId}_l${combo.lumPct}`;
    const gen = edgeGenerator(dark, light, combo.sigma);
    write('E4', id, `e4/${id}.dng`, SIZE, SIZE, gen, {
      size: SIZE,
      edgeXPx: EDGE_X,
      contrastStops: combo.stops,
      sharpness: combo.sharpId,
      sigmaPx: combo.sigma,
      nominalCenterPct: combo.lumPct,
      dark,
      light,
      realizedCenter,
      clipAdjusted: realizedCenter !== combo.lumPct / 100,
    });
  }
}

// === E5 — working space (exposure-invariance pair) ===
// docs/research/local-adaptive-tone.md §"E5": method A compares `Shadows=+50`
// alone against `Exposure2012=+1.0 -> Shadows=+50` (with the linear result
// then halved back down) on the SAME scene. Per the brief ("reuses E4 set,
// no new images, + one pair"): the BASE of that pair is exactly the E4 file
// `e4_c1_hard_l20` (contrast=1 stop, hard edge, nominal center 20% — chosen
// because doubling its brightest value stays clear of the 95% clip ceiling:
// light ≈ 0.283, ×2 = 0.566), so it is NOT regenerated here — only the ×2
// "pre-exposed" companion is a genuinely new file. Compare LR's
// `Shadows=+50` on e4_c1_hard_l20 against LR's `Shadows=+50` on
// e5_exposure_2x with every decoded value divided by 2 — no reliance on
// LR's own Exposure2012 slider math (E5's whole point is to test whether
// scaling commutes with Shadows, so the ×2 has to be applied OUTSIDE LR).
{
  const SIZE = 1024;
  const EDGE_X = SIZE / 2;
  const BASE_STOPS = 1;
  const BASE_LUM_PCT = 20;
  const ratio = 2 ** BASE_STOPS;
  const centerFrac = BASE_LUM_PCT / 100;
  const baseDark = centerFrac / Math.sqrt(ratio);
  const baseLight = centerFrac * Math.sqrt(ratio);
  const scaledDark = baseDark * 2;
  const scaledLight = baseLight * 2;
  if (scaledLight > 0.95) throw new Error(`gen-tone-experiments: E5 ×2 companion would clip (${scaledLight})`);
  const gen = (x) => (x < EDGE_X ? scaledDark : scaledLight);
  write('E5', 'e5_exposure_2x', 'e5/e5_exposure_2x.dng', SIZE, SIZE, gen, {
    size: SIZE,
    edgeXPx: EDGE_X,
    pairsWithFile: 'e4/e4_c1_hard_l20.dng',
    pairsWithId: 'e4_c1_hard_l20',
    exposureFactor: 2,
    dark: scaledDark,
    light: scaledLight,
  });
}

// === E6 — global-histogram-dependent range expansion ===
// docs/research/local-adaptive-tone.md §"E6": IDENTICAL center content
// (E1-style 64px 18%-gray patch on a 50% background, in a fixed 512px
// center block) across all 3 images; only the region OUTSIDE that block
// varies. Canvas 2048² so the center block's nearest edge sits 768px from
// every image edge (> width/4 = 512px, the brief's own minimum separation).
//  (a) full-range:  outer region in checkerboard quadrants, ~0.1% / 95%
//  (b) low-contrast (fog): outer region UNIFORM at 40% — within ~0.3 stop
//      of the fixed center background (50%); can't be tightened further
//      without touching the (intentionally fixed) center content itself.
//  (c) high-contrast (HDR): outer region in checkerboard quadrants spanning
//      12 stops (0.90 and 0.90/2^12 ≈ 0.00022) — 0.90 keeps clear of the
//      95% ceiling since brief gives no explicit numbers for this variant.
{
  const SIZE = 2048;
  const CENTER_BLOCK = 512;
  const PATCH = 64;
  const PATCH_VALUE = 0.18;
  const CENTER_BG = 0.5;
  const cb0 = (SIZE - CENTER_BLOCK) / 2;
  const cb1 = cb0 + CENTER_BLOCK;
  const p0 = (SIZE - PATCH) / 2;
  const p1 = p0 + PATCH;
  const half = SIZE / 2;

  function centerContent(x, y) {
    if (x >= p0 && x < p1 && y >= p0 && y < p1) return PATCH_VALUE;
    return CENTER_BG;
  }
  function inCenterBlock(x, y) {
    return x >= cb0 && x < cb1 && y >= cb0 && y < cb1;
  }
  function quadrantValue(x, y, valTLBR, valTRBL) {
    const isTLorBR = (x < half) === (y < half);
    return isTLorBR ? valTLBR : valTRBL;
  }

  const variants = [
    { id: 'e6_fullrange', outer: (x, y) => quadrantValue(x, y, 0.001, 0.95), outerDesc: { kind: 'checkerboard', darkQuadrants: 0.001, lightQuadrants: 0.95 } },
    { id: 'e6_lowcontrast', outer: () => 0.4, outerDesc: { kind: 'uniform', value: 0.4 } },
    { id: 'e6_highcontrast', outer: (x, y) => quadrantValue(x, y, 0.9 / 4096, 0.9), outerDesc: { kind: 'checkerboard', darkQuadrants: 0.9 / 4096, lightQuadrants: 0.9, stopsSpread: 12 } },
  ];
  for (const v of variants) {
    const gen = (x, y) => (inCenterBlock(x, y) ? centerContent(x, y) : v.outer(x, y));
    write('E6', v.id, `e6/${v.id}.dng`, SIZE, SIZE, gen, {
      size: SIZE,
      centerBlockPx: CENTER_BLOCK,
      patchPx: PATCH,
      patchValue: PATCH_VALUE,
      centerBackground: CENTER_BG,
      outer: v.outerDesc,
    });
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      researchDoc: 'docs/research/local-adaptive-tone.md §5',
      experiments: ['E1', 'E2', 'E4', 'E5', 'E6'],
      files: manifest,
    },
    null,
    2
  )
);

const counts = manifest.reduce((acc, m) => ((acc[m.experiment] = (acc[m.experiment] ?? 0) + 1), acc), {});
console.log(`wrote ${manifest.length} images to ${outDir}`);
for (const exp of ['E1', 'E2', 'E4', 'E5', 'E6']) console.log(`  ${exp}: ${counts[exp] ?? 0}`);
console.log(`manifest: ${join(outDir, 'manifest.json')}`);
