/**
 * Shared helpers for scripts/gen-tone-experiments-r2.mjs — the ROUND-2
 * follow-up generator (docs/research/lr-tone-measurements.md's "Fragile
 * points worth flagging back to the conductor" #3 and #4, plus the E4 σr
 * bracket in that same doc's E4 section). Split into scripts/lib/ (rather
 * than kept inline in the generator, like round-1's gen-tone-experiments.mjs
 * does for its own small helpers) purely so these two pure functions land
 * under vitest.config.ts's `scripts/lib/**\/*.test.mjs` include glob — see
 * scripts/lib/tiffWriter.mjs/.test.mjs for the precedent this follows.
 *
 * Two distinct "clip a symmetric-around-a-mean stop pair into range"
 * strategies, because round-2 needs both, for different reasons:
 *
 * - `stopsPairClipScaled` — round-1's own E4 `edgeLevels` algorithm
 *   (gen-tone-experiments.mjs), generalized to take a mean FRACTION instead
 *   of a center PERCENT. Used for the r2 E4/σr set, which the brief asks to
 *   "reuse its clip-adjust bookkeeping approach": when the light side would
 *   exceed `hi`, BOTH sides are scaled down together, preserving the exact
 *   stop ratio (the thing σr calibration cares about) and shifting the
 *   realized mean darker instead.
 *
 * - `stopsPairClipIndependent` — a different strategy for the r2 E6 corner
 *   sweep, clamping each side independently into [lo, hi]. This one is
 *   deliberately NOT the scaled-together strategy: two of that set's files
 *   (the "mean-shift probes", `r2_e6_mean6`/`r2_e6_mean50`) exist
 *   specifically to separate a "spread" effect from a "mean" effect at a
 *   FIXED nominal 8-stop spread. `mean50` at 8 stops needs a corner pair of
 *   roughly [3.1%, 800%] — the light side is wildly outside [0,1] and must
 *   clip hard no matter what. Under the scaled-together strategy, the
 *   preserved-ratio rescue drags the (otherwise perfectly representable)
 *   dark side down to `hi / 2^stops` too — for stops=8 that lands the dark
 *   side at the SAME 0.00371 both `mean6` and `mean50` end up with,
 *   collapsing the two probes to nearly-identical realized corners and
 *   defeating the entire point of the pair (see this module's test file for
 *   the worked numbers). Independent clamping keeps whichever side ISN'T
 *   clipped at its true, mean-anchored value, so `mean6` and `mean50` stay
 *   distinguishable even though both hit the ceiling on their light side.
 *   `realizedStops` in the return value reports the ACTUAL (possibly
 *   shrunk) spread post-clamp for exactly this reason — use it, not the
 *   nominal `stops`, for any downstream fit.
 */
import { existsSync } from 'node:fs';
import { writeLinearDng } from '../gen-linear-dng.mjs';

/**
 * E4-style: dark/light placed at `meanFrac / sqrt(2^stops)` and
 * `meanFrac * sqrt(2^stops)`; if `light` would exceed `hi`, both sides are
 * scaled down together (ratio preserved exactly, mean shifts darker).
 * Mirrors gen-tone-experiments.mjs's E4 `edgeLevels`, generalized to a mean
 * fraction (not a center percent) and a caller-supplied `hi` ceiling.
 */
export function stopsPairClipScaled(stops, meanFrac, hi = 0.95) {
  const ratio = 2 ** stops;
  let dark = meanFrac / Math.sqrt(ratio);
  let light = meanFrac * Math.sqrt(ratio);
  let clipAdjusted = false;
  if (light > hi) {
    const scale = hi / light;
    dark *= scale;
    light *= scale;
    clipAdjusted = true;
  }
  return { dark, light, realizedMean: Math.sqrt(dark * light), clipAdjusted };
}

/**
 * E6-style: dark/light placed the same way, then EACH SIDE independently
 * clamped into [lo, hi] (no ratio preservation) — see this module's header
 * comment for why. Also reports `realizedStops` (the actual post-clamp
 * spread, `log2(light/dark)`) since it can differ substantially from the
 * nominal `stops` once clamping bites.
 */
export function stopsPairClipIndependent(stops, meanFrac, { lo = 0.002, hi = 0.95 } = {}) {
  const ratio = 2 ** stops;
  const rawDark = meanFrac / Math.sqrt(ratio);
  const rawLight = meanFrac * Math.sqrt(ratio);
  const dark = Math.min(hi, Math.max(lo, rawDark));
  const light = Math.min(hi, Math.max(lo, rawLight));
  const clipAdjusted = dark !== rawDark || light !== rawLight;
  return { dark, light, realizedMean: Math.sqrt(dark * light), realizedStops: Math.log2(light / dark), clipAdjusted };
}

/**
 * The round-2 brief's ABSOLUTE CONSTRAINT: the output directory already
 * holds round-1 DNGs that are imported into a live Lightroom catalog by
 * path, so this generator must never rewrite or delete an existing file.
 * `writeLinearDng` itself (gen-linear-dng.mjs) has no such guard — it just
 * `writeFileSync`s — so every round-2 write goes through this wrapper
 * instead, which throws before touching anything if the target already
 * exists (round-1 output, a previous partial round-2 run, anything).
 */
export function writeLinearDngOnce(filePath, opts) {
  if (existsSync(filePath)) {
    throw new Error(`writeLinearDngOnce: refusing to overwrite existing file: ${filePath}`);
  }
  return writeLinearDng(filePath, opts);
}
