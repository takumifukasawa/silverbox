#!/usr/bin/env node
/**
 * ROUND-2 tone-experiment images — three follow-up sets picked out of
 * docs/research/lr-tone-measurements.md's own analysis of the round-1
 * harvest (scripts/gen-tone-experiments.mjs / manifest.json):
 *
 *  1. E2 redesign — that doc's "Fragile points" #3: round-1's E2 (bar
 *     gratings) couldn't cleanly separate "flat local average at every
 *     scale" from "pyramid vs. fixed-radius", because a 50%-duty-cycle
 *     grating is locally ~50/50 dark/light at every period. This set
 *     replaces the grating with the doc's own suggested fix: an ISOLATED
 *     single dark bar in a large uniform field.
 *  2. σr point-estimate refinement — that doc's E4 section found the
 *     overshoot/halo knee bracketed between 3 and 5 stops (only 1/2/3/5/7/10
 *     were sampled); this set fills the bracket with 3.5/4/4.5-stop points,
 *     hard AND σ=16px, to narrow the estimate.
 *  3. E6 law probe — that doc's E6 section found a real ~0.05-stop global-
 *     adaptation effect from just 3 corner configurations; this set sweeps
 *     corner dynamic range far more finely (7 spreads) plus 2 additional
 *     probes that hold spread fixed and move the corner MEAN, to check
 *     whether the effect tracks corner spread, corner mean, or both.
 *
 * ABSOLUTE CONSTRAINT (per the brief): the output directory already holds
 * round-1 DNGs imported into a live Lightroom catalog BY PATH. This script
 * is ADDITIVE ONLY — every file it writes is prefixed `r2_`, it never
 * touches manifest.json (round-1's own manifest), and every write goes
 * through writeLinearDngOnce (scripts/lib/toneExperimentsR2.mjs), which
 * throws instead of overwriting anything that already exists — round-1
 * output, a stale partial round-2 run, or the r2 manifest itself.
 *
 * Usage: node scripts/gen-tone-experiments-r2.mjs [outDir]
 *   outDir defaults to ./tone-experiments-out (same default as round-1's
 *   generator — this script is meant to be pointed at the SAME directory
 *   round-1 already populated, proving additivity; see this file's own
 *   `npm run`-free CLI, there is no package.json entry, matching round-1's
 *   own generator, which also has none).
 *
 * Output: <outDir>/{e2,e4,e6}/r2_*.dng + <outDir>/manifest-r2.json (never
 * <outDir>/manifest.json — that file belongs to round-1 and is never read
 * or written here).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopsPairClipIndependent, stopsPairClipScaled, writeLinearDngOnce } from './lib/toneExperimentsR2.mjs';

const outDir = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'tone-experiments-out');

const manifest = [];
function record(experiment, id, relPath, width, height, params, notes) {
  manifest.push({ experiment, id, file: relPath, width, height, params, ...(notes ? { notes } : {}) });
}
function write(experiment, id, relPath, width, height, generator, params, notes) {
  const abs = join(outDir, relPath);
  writeLinearDngOnce(abs, { width, height, generator });
  record(experiment, id, relPath, width, height, params, notes);
}

// Abramowitz & Stegun 7.1.26 erf approximation — identical to round-1's own
// copy (scripts/gen-tone-experiments.mjs), duplicated rather than shared
// since round-1 keeps it local to its own file too (no scripts/lib/erf.mjs
// precedent to extend).
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

// === Set 1 — E2 redesign: isolated single dark bar in a large uniform field ===
// docs/research/lr-tone-measurements.md "Fragile points" #3: the round-1
// grating design can't distinguish a pyramid from a fixed-radius mask
// because a 50%-duty grating is ~50/50 locally at every scale. An isolated
// bar (mostly-uniform 18% field, one dark bar) doesn't have that
// degeneracy: a fixed-radius operator's response should plateau once the
// bar's width exceeds ~2x the radius, while a pyramid's response should
// keep changing with bar width across a much wider range.
// Field 18% gray; bar width W in {8,32,128,512}px, vertical, centered; bar
// level 2 stops below field (≈4.5%) and 6 stops below (≈0.28%); at two
// canvas resolutions. "1024²" is a literal square (1024x1024) per the
// brief; "4096-long-edge" reuses round-1 E2's own elongated-rectangle
// convention (content is uniform along y, so a full 4096² canvas would
// just be dead weight) — same `clamp(res/4, 64, 512)` height formula
// round-1 used for its own r4000 files.
{
  const FIELD = 0.18;
  const BAR_WIDTHS = [8, 32, 128, 512];
  const STOPS_BELOW = [2, 6];
  const RESOLUTIONS = [1024, 4096];

  function canvasShape(res) {
    if (res === 1024) return { width: 1024, height: 1024 }; // "1024²" — literal square
    return { width: res, height: Math.max(64, Math.min(512, Math.round(res / 4))) }; // "<res>-long-edge"
  }

  for (const res of RESOLUTIONS) {
    const { width, height } = canvasShape(res);
    for (const stopsBelow of STOPS_BELOW) {
      const barLevel = FIELD / 2 ** stopsBelow;
      for (const W of BAR_WIDTHS) {
        const x0 = Math.round((width - W) / 2);
        const x1 = x0 + W;
        const id = `r2_e2_w${W}_c${stopsBelow}_r${res}`;
        const gen = (x) => (x >= x0 && x < x1 ? barLevel : FIELD);
        write('E2', id, `e2/${id}.dng`, width, height, gen, {
          field: FIELD,
          barWidthPx: W,
          barX0: x0,
          barX1: x1,
          stopsBelowField: stopsBelow,
          barLevel,
          resolution: res,
          width,
          height,
        });
      }
    }
  }
}

// === Set 2 — σr point-estimate refinement (extends round-1 E4) ===
// docs/research/lr-tone-measurements.md's E4 section: overshoot/halo knee
// bracketed between 3 and 5 stops (round-1 sampled 1/2/3/5/7/10, not 4).
// Same geometry/placement conventions as round-1 e4 (SIZE=1024,
// EDGE_X=512, center-luminance 20%) and the same clip-adjust bookkeeping
// (stopsPairClipScaled === round-1's own edgeLevels, generalized — see
// scripts/lib/toneExperimentsR2.mjs). Only hard + σ=16px this time (not
// σ=4px too) — round-1 already showed s4/s16 tracking each other closely at
// the knee (0.42/0.62 at 5 stops, 0.92/0.59 at 7), and σ=16 gave the
// cleaner overshoot signal (bigger, more localized bump) worth spending the
// extra file budget on instead.
{
  const SIZE = 1024;
  const EDGE_X = SIZE / 2;
  const CONTRASTS_STOPS = [3.5, 4, 4.5];
  const CENTER_LUM_PCT = 20;
  const SHARPNESS = [
    { id: 'hard', sigma: null },
    { id: 's16', sigma: 16 },
  ];

  function edgeGenerator(dark, light, sigma) {
    if (sigma === null) return (x) => (x < EDGE_X ? dark : light);
    return (x) => dark + (light - dark) * 0.5 * (1 + erf((x - EDGE_X) / (sigma * Math.SQRT2)));
  }

  for (const { id: sharpId, sigma } of SHARPNESS) {
    for (const stops of CONTRASTS_STOPS) {
      const { dark, light, realizedMean, clipAdjusted } = stopsPairClipScaled(stops, CENTER_LUM_PCT / 100);
      const id = `r2_e4_c${stops}_${sharpId}_l${CENTER_LUM_PCT}`;
      const gen = edgeGenerator(dark, light, sigma);
      write('E4', id, `e4/${id}.dng`, SIZE, SIZE, gen, {
        size: SIZE,
        edgeXPx: EDGE_X,
        contrastStops: stops,
        sharpness: sharpId,
        sigmaPx: sigma,
        nominalCenterPct: CENTER_LUM_PCT,
        dark,
        light,
        realizedCenter: realizedMean,
        clipAdjusted,
      });
    }
  }
}

// === Set 3 — E6 law probe (finer corner-dynamic-range sweep) ===
// docs/research/lr-tone-measurements.md's E6 section: only 3 corner
// configurations were tested; this set replicates round-1 e6's IDENTICAL
// center (byte-for-byte — same SIZE/CENTER_BLOCK/PATCH/PATCH_VALUE/
// CENTER_BG, same placement) across every file, and sweeps corner dynamic
// range far more finely: 7 symmetric spreads around 18%, plus 2 probes that
// hold spread fixed at 8 stops and move the corner MEAN instead (6% and
// 50%) — to separate a "spread" effect from a "mean" effect. Corner pairs
// use stopsPairClipIndependent (NOT the E4-style scaled clip) — see
// scripts/lib/toneExperimentsR2.mjs's header comment for why: the
// scaled-together strategy would collapse the mean6/mean50 probes to
// nearly the same realized corners once light clips (both need
// dark = 0.95 / 2^8 either way), defeating the entire point of that pair.
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

  // Byte-for-byte replica of round-1 e6's centerContent/inCenterBlock/
  // quadrantValue (gen-tone-experiments.mjs) — same constants above,
  // deliberately duplicated (not imported — round-1's generator doesn't
  // export them) so the center is comparable across rounds.
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
  function makeGen(dark, light) {
    return (x, y) => (inCenterBlock(x, y) ? centerContent(x, y) : quadrantValue(x, y, dark, light));
  }
  function baseParams(extra) {
    return {
      size: SIZE,
      centerBlockPx: CENTER_BLOCK,
      patchPx: PATCH,
      patchValue: PATCH_VALUE,
      centerBackground: CENTER_BG,
      ...extra,
    };
  }

  // -- 3a. dynamic-range sweep: symmetric spread around 18%, 7 points ------
  const DR_STOPS = [0, 2, 4, 6, 8, 10, 12];
  const NOMINAL_MEAN = 0.18;
  for (const stops of DR_STOPS) {
    const { dark, light, realizedMean, realizedStops, clipAdjusted } = stopsPairClipIndependent(stops, NOMINAL_MEAN);
    const id = `r2_e6_dr${stops}`;
    write('E6', id, `e6/${id}.dng`, SIZE, SIZE, makeGen(dark, light), baseParams({
      nominalSpreadStops: stops,
      nominalMean: NOMINAL_MEAN,
      dark,
      light,
      realizedMean,
      realizedStops,
      clipAdjusted,
      outer: { kind: 'checkerboard', darkQuadrants: dark, lightQuadrants: light },
    }));
  }

  // -- 3b. mean-shift probes: fixed 8-stop spread, corner mean at 6%/50% ---
  const MEAN_SHIFT_STOPS = 8;
  const MEAN_PCTS = [6, 50];
  for (const pct of MEAN_PCTS) {
    const meanFrac = pct / 100;
    const { dark, light, realizedMean, realizedStops, clipAdjusted } = stopsPairClipIndependent(MEAN_SHIFT_STOPS, meanFrac);
    const id = `r2_e6_mean${pct}`;
    write('E6', id, `e6/${id}.dng`, SIZE, SIZE, makeGen(dark, light), baseParams({
      nominalSpreadStops: MEAN_SHIFT_STOPS,
      nominalMeanPct: pct,
      nominalMean: meanFrac,
      dark,
      light,
      realizedMean,
      realizedStops,
      clipAdjusted,
      outer: { kind: 'checkerboard', darkQuadrants: dark, lightQuadrants: light },
    }));
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'manifest-r2.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      researchDoc: 'docs/research/lr-tone-measurements.md',
      round: 2,
      experiments: ['E2', 'E4', 'E6'],
      files: manifest,
    },
    null,
    2
  )
);

const counts = manifest.reduce((acc, m) => ((acc[m.experiment] = (acc[m.experiment] ?? 0) + 1), acc), {});
console.log(`wrote ${manifest.length} images to ${outDir}`);
for (const exp of ['E2', 'E4', 'E6']) console.log(`  ${exp}: ${counts[exp] ?? 0}`);
console.log(`manifest: ${join(outDir, 'manifest-r2.json')}`);
