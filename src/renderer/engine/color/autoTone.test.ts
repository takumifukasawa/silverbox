import { describe, expect, it } from 'vitest';
import {
  autoToneQuantile,
  neutralLumaSample,
  solveAutoTone,
  AUTO_TONE_EV_MIN,
  AUTO_TONE_EV_MAX,
  AUTO_TONE_EV_SHADOW_TARGET_LINEAR,
} from './autoTone';
import type { PreparedImage } from '../decoder/decodeWorker';
import { defaultDevelopParams } from '../graph/developNode';

describe('autoToneQuantile', () => {
  it('linear-interpolates a sorted array (mirrors fit-base-curve.mjs quantile())', () => {
    const sorted = Float64Array.from([0, 1, 2, 3, 4]);
    expect(autoToneQuantile(sorted, 0)).toBe(0);
    expect(autoToneQuantile(sorted, 1)).toBe(4);
    expect(autoToneQuantile(sorted, 0.5)).toBe(2);
    expect(autoToneQuantile(sorted, 0.25)).toBe(1);
  });

  it('empty input is 0, not NaN/throw', () => {
    expect(autoToneQuantile(new Float64Array(0), 0.5)).toBe(0);
  });
});

/** A minimal flat-gray PreparedImage at a given linear luma value. */
function grayImage(linearLuma: number, width = 8, height = 8): PreparedImage {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = linearLuma;
    data[i * 4 + 1] = linearLuma;
    data[i * 4 + 2] = linearLuma;
    data[i * 4 + 3] = 1;
  }
  return { data, width, height, fullWidth: width, fullHeight: height, flip: 0, decodeMs: 0 };
}

describe('neutralLumaSample + solveAutoTone', () => {
  const identityProfile = defaultDevelopParams().profile; // amount 0 — isIdentityProfile() true, profile step a no-op
  const unityWb: [number, number, number] = [1, 1, 1];

  // v2's EV term is driven by the SHADOW-region percentile (p10) against a
  // deliberately DARK pivot (AUTO_TONE_EV_SHADOW_TARGET_LINEAR ≈ 0.0077
  // linear — see autoTone.ts's const doc), not the OLD median-vs-mid-gray
  // target. A flat image only counts as "dark" relative to THAT pivot, so
  // the illustrative dark/bright values below sit well on either side of it
  // (unlike v1's 0.02/0.8, which were calibrated against the old ~0.45
  // encoded mid-gray target and straddle the new pivot ambiguously).
  it('a dark flat image raises exposure (positive ev); a bright one lowers it', () => {
    const dark = neutralLumaSample(grayImage(1e-4), identityProfile, null, unityWb);
    const bright = neutralLumaSample(grayImage(0.3), identityProfile, null, unityWb);
    const evDark = solveAutoTone(dark).ev;
    const evBright = solveAutoTone(bright).ev;
    expect(evDark).toBeGreaterThan(0);
    expect(evBright).toBeLessThan(0);
    expect(evDark).toBeGreaterThan(evBright);
  });

  it('ev is clamped to its (now tight, EV-is-a-nudge-not-a-lift) auto-tone range', () => {
    const veryDark = neutralLumaSample(grayImage(1e-5), identityProfile, null, unityWb);
    const veryBright = neutralLumaSample(grayImage(0.999), identityProfile, null, unityWb);
    expect(solveAutoTone(veryDark).ev).toBeLessThanOrEqual(AUTO_TONE_EV_MAX);
    expect(solveAutoTone(veryBright).ev).toBeGreaterThanOrEqual(AUTO_TONE_EV_MIN);
  });

  it('every returned slider value stays within ±100 (bounded, never a runaway)', () => {
    for (const luma of [1e-6, 0.001, 0.01, 0.1, 0.5, 0.9, 0.999]) {
      const patch = solveAutoTone(neutralLumaSample(grayImage(luma), identityProfile, null, unityWb));
      expect(patch.contrast).toBeGreaterThanOrEqual(-100);
      expect(patch.contrast).toBeLessThanOrEqual(100);
      expect(patch.blacks).toBeGreaterThanOrEqual(-100);
      expect(patch.blacks).toBeLessThanOrEqual(100);
      expect(patch.whites).toBeGreaterThanOrEqual(-100);
      expect(patch.whites).toBeLessThanOrEqual(100);
      expect(patch.highlights).toBeGreaterThanOrEqual(-100);
      expect(patch.highlights).toBeLessThanOrEqual(0); // recovery only pulls DOWN
      expect(patch.shadows).toBeGreaterThanOrEqual(0); // recovery only lifts UP
      expect(patch.shadows).toBeLessThanOrEqual(100);
    }
  });

  // A flat image AT the shadow-EV pivot itself needs ~zero exposure
  // correction (the v2 analogue of v1's "already-midtone-centered" test —
  // the pivot moved from the median/mid-gray to p10/shadow-dark, see the
  // dark/bright test's comment above).
  it('a flat image sitting exactly at the EV shadow pivot needs ~zero exposure correction', () => {
    const sample = neutralLumaSample(grayImage(AUTO_TONE_EV_SHADOW_TARGET_LINEAR), identityProfile, null, unityWb);
    expect(Math.abs(solveAutoTone(sample).ev)).toBeLessThan(0.01);
  });

  it('empty sample (degenerate image) returns all-zero, not NaN/throw', () => {
    const empty = neutralLumaSample(grayImage(0.5, 0, 0), identityProfile, null, unityWb);
    const patch = solveAutoTone(empty);
    expect(patch).toEqual({ ev: 0, contrast: 0, blacks: 0, whites: 0, highlights: 0, shadows: 0 });
  });

  it('stride-subsamples toward AUTO_TONE_SAMPLE_TARGET rather than reading every pixel on a huge image', () => {
    const huge = grayImage(0.3, 2000, 2000); // 4,000,000 px — over the sample target
    const sample = neutralLumaSample(huge, identityProfile, null, unityWb);
    expect(sample.length).toBeLessThan(2000 * 2000);
    expect(sample.length).toBeGreaterThan(0);
  });
});

/**
 * v2 allocation-model fit table: LR Classic 15.2.1's own "Auto" applied to 5
 * real ARW scenes (test-assets/italy/, gitignored — not checked in; scene
 * IDs only, per repo convention of never committing personal paths), values
 * read from the exported XMP. This is the reference the recalibration brief
 * (2026-09-01) fit autoTone.ts's v2 constants against — see autoTone.ts's
 * file header for the allocation-model note.
 *
 * ACHIEVED is what solveAutoTone() produces from that scene's OWN
 * histogram (p0.5/p10/p90/p99.5 of the working-linear luma, sampled the
 * same way neutralLumaSample() does, no profile/WB — see the implementer
 * report for the full derivation). Recorded here as a comment (not an
 * executable per-scene assertion — the fixture ARWs aren't in the repo, so
 * this table can't be driven from a unit test) for the ordering/magnitude
 * check the brief asked for. "Exact equality is not required" (brief) —
 * Whites is the weakest fit of the six (LR itself calls it "either sign").
 *
 *   scene      | LR EV  ACH EV | LR Con ACH | LR High ACH  | LR Shad ACH | LR White ACH | LR Black ACH
 *   -----------|---------------|------------|--------------|-------------|--------------|-------------
 *   DSC03298   | +0.68  +0.68  |  +7   +6   | -76   -71.3  | +68   +67.2 | -35   -15.2  | -18    -8.4
 *   (night blue-hour canal — darkest shadow mass of the set: highest EV+shadows)
 *   DSC04260   | +0.65  +0.56  |  +5   +6   | -82   -77.0  | +67   +64.9 | +21   +12.4  | -13    -9.5
 *   (dusk silhouette — second-deepest shadow mass)
 *   DSC06787   | +0.14  +0.12  |  +6   +6   | -74   -77.0  | +49   +49.1 |  +9   +19.3  | -21   -15.0
 *   (day scene)
 *   DSC07349   | +0.13  +0.00  |  +5   +6   | -72   -71.9  | +51   +43.4 | +19    -7.1  | -34   -15.0
 *   (sea sunset — the model's weakest scene: near-zero EV/shadows since its
 *   p10 sits almost exactly at the shadow-mass pivots; LR reads more lift
 *   here than a single p10 statistic captures)
 *   DSC09305   | +0.08  +0.08  |  +7   +6   | -59   -74.3  | +38   +47.5 | +14   +15.9  | -25   -13.5
 *   (dark church interior — mildest LR highlight cut of the set, but its
 *   p90 doesn't distinguish it from the brighter scenes, so ACH overshoots;
 *   the model's second-weakest fit)
 *
 * Reading the table: EV/Contrast/Shadows land close on 4/5 scenes and the
 * ORDERING the brief asked for holds (night/dusk get the top EV+shadows,
 * highlights are always cut hard, contrast is a near-constant +6). Whites
 * is the loosest fit (sign matches LR on 4/5 scenes; DSC07349 disagrees) —
 * expected, since even a 2-parameter linear regression against p99.5 alone
 * couldn't do better on this 5-point set (see the implementer report).
 *
 * Blacks UNDERSHOOTS LR's magnitude on every scene (AUTO_TONE_BLACK_GAIN
 * deliberately capped low, ceiling ~-15 vs LR's up to -34) — a SAFETY
 * trade-off, not a fit miss: blacks is an ADDITIVE linear offset
 * (cpuDevelopTone), and the repo's own stress fixture (test-assets/test.ARW,
 * ~13% of pixels already at literal 0) blew the verify script's
 * shadow-clip-budget check at the per-scene-regressed ceiling (~-27) —
 * see scripts/verify-autotone.mjs's widened shadow-clip-budget comment.
 * Capping the gain low keeps every real photo's literal-black clip
 * bounded, at the cost of under-matching LR's more aggressive blacks on
 * the fit scenes themselves.
 */
