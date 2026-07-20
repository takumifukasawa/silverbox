/**
 * Look extraction, mode 2 — the STAGED, well-posed solve (docs/brief-bank/
 * look-extraction.md §"Mode 2 solve well-posedness"). The parent's well-
 * posedness note freezes the solve into an ORDER so each sub-solve observes a
 * signature component the earlier stages already fixed: tone → global chroma →
 * HSL bands → grading wheels → grain.
 *
 * STAGE 1 (the spike — docs/brief-bank/look-extraction-mode2-stage1.md) lands
 * ONLY the FIRST freeze stage: luma TONE. Given the reference set's luma
 * percentile vector and the SAME percentiles of a neutral baseline, it fits a
 * tone curve that maps baseline→reference by PERCENTILE MATCHING — the exact
 * method the base-curve fitter uses (scripts/fit-base-curve.mjs steps 4–5 /
 * engine/color/baseCurve.ts): pair x_q = baseline encoded luma at quantile q
 * with y_q = reference encoded luma at q, at the interior control quantiles
 * (TONE_CONTROL_PERCENTILES = the fitter's CTRL_Q), pin (0,0)+(255,255),
 * enforce monotonicity, and let the SAME PCHIP evaluator (toneCurve.ts) the
 * point ToneCurve op uses reproduce the measured transfer. The result is a
 * `curves`-family fragment (the master RGB tone-curve control points).
 *
 * NO separate exposure solve (parent's well-posedness note): exposure and a
 * curve lift are the SAME degree of freedom against a percentile vector — the
 * curve absorbs it. A post-hoc re-expression of the curve's average shift as
 * the exposure slider (presentation, not a second solve) is a STAGE-2 nicety.
 *
 * The color/grain freeze stages (2–5) are STAGE 2 — reported here as DEFERRED
 * so an audit sees which components stage 1 did and did not touch.
 *
 * PURE: signatures in, curve + report out. No DOM/GPU/IO — unit-testable with
 * synthetic signatures (solve.test.ts).
 */
import { curveEvaluator } from '../color/toneCurve';
import { CURVE_MAX, type CurvePoints } from '../graph/developNode';
import { SIGNATURE_PERCENTILES, TONE_CONTROL_PERCENTILES, percentileIndex, type Signature } from './signature';

/** The freeze stages STAGE 1 does NOT solve (parent's order 2–5) — reported as deferred so the derivation is auditable. */
export const DEFERRED_STAGES: readonly string[] = ['global-chroma', 'hsl-bands', 'grading-wheels', 'grain'];

/**
 * PLACEHOLDER neutral baseline (STAGE-2 TODO). The real baseline is the parent
 * design's BUNDLED reference-corpus percentile table — "a fixed constant table
 * derived once from a few hundred 'natural rendering' images". That corpus
 * isn't built yet, so stage 1 ships the SIMPLEST honest placeholder: the
 * identity / linear-tone distribution, where encoded luma at percentile p is
 * exactly p·255 (a flat, unbiased neutral). Documented as a placeholder to be
 * replaced by the corpus-derived table in stage 2; the unit test does NOT
 * depend on its realism — it injects a KNOWN curve and passes an explicit
 * baseline, so correctness is proven independently of this constant.
 */
export const PLACEHOLDER_BASELINE_SIGNATURE: Signature = {
  lumaPercentiles: SIGNATURE_PERCENTILES.map((p) => p * CURVE_MAX),
  contrastProxy: (0.9 - 0.1) * CURVE_MAX,
  imageCount: 0,
  globalChroma: null,
  hslBands: null,
  shadowChroma: null,
  highlightChroma: null,
  midtoneChroma: null,
  grainEnergy: null,
};

/** One percentile's residual after the tone fit (report only — see solveToneCurve). */
export interface ToneResidual {
  /** the SIGNATURE_PERCENTILES entry (fraction of 1). */
  percentile: number;
  /** baseline encoded luma at this percentile (the fit's x). */
  baseline: number;
  /** reference encoded luma at this percentile (the fit's target y). */
  reference: number;
  /** the fitted curve evaluated at `baseline`. */
  fitted: number;
  /** |fitted − reference| — the residual percentile error, in encoded 0..255. */
  error: number;
}

export interface ToneSolveReport {
  /** freeze stages actually solved (STAGE 1: ['tone']). */
  solved: string[];
  /** freeze stages deferred to STAGE 2 (DEFERRED_STAGES). */
  deferred: string[];
  /** the percentiles used as interior control points (TONE_CONTROL_PERCENTILES). */
  controlPercentiles: number[];
  /** per-SIGNATURE_PERCENTILES residual after the fit — ≈0 at the control percentiles (the curve interpolates them), a fit-quality read elsewhere. */
  residuals: ToneResidual[];
  /** max residual across all SIGNATURE_PERCENTILES (encoded 0..255). */
  maxResidual: number;
  /** RMS residual across all SIGNATURE_PERCENTILES (encoded 0..255). */
  rmsResidual: number;
}

export interface ToneSolveResult {
  /** the `curves`-family fragment: the fitted master RGB tone-curve control points (0..255 point space). */
  curve: CurvePoints;
  report: ToneSolveReport;
}

/**
 * Assemble the pinned, strictly-increasing, monotone control-point set from the
 * interior (x,y) pairs — the EXACT assembly the base-curve fitter uses
 * (scripts/fit-base-curve.mjs step 5): round to the point space's integers, pin
 * (0,0)+(255,255), drop a non-increasing x (a collapsed quantile), and clamp y
 * up to keep the curve monotone (a look must never invert tone).
 */
function assembleMonotoneCurve(interior: readonly (readonly [number, number])[]): CurvePoints {
  const raw: [number, number][] = [
    [0, 0],
    ...interior.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]),
    [CURVE_MAX, CURVE_MAX],
  ];
  const points: CurvePoints = [];
  for (const [x, y] of raw) {
    const px = Math.min(CURVE_MAX, Math.max(0, x));
    const py = Math.min(CURVE_MAX, Math.max(0, y));
    if (points.length > 0) {
      const prev = points[points.length - 1]!;
      if (px <= prev[0]!) continue; // drop a non-increasing x (collapsed quantile)
      if (py < prev[1]!) {
        points.push([px, prev[1]!]); // clamp up to keep the curve monotone
        continue;
      }
    }
    points.push([px, py]);
  }
  return points;
}

/**
 * Solve the freeze-stage-1 tone curve: fit the master RGB curve that maps
 * `baseline`'s luma percentiles onto `reference`'s by percentile matching (see
 * this module's doc comment). `baseline` is a parameter, not baked in — the CLI
 * passes PLACEHOLDER_BASELINE_SIGNATURE, the unit test passes the test image's
 * own signature to prove recovery of a known injected curve.
 */
export function solveToneCurve(baseline: Signature, reference: Signature): ToneSolveResult {
  const interior = TONE_CONTROL_PERCENTILES.map((p) => {
    const idx = percentileIndex(p);
    return [baseline.lumaPercentiles[idx]!, reference.lumaPercentiles[idx]!] as [number, number];
  });
  const curve = assembleMonotoneCurve(interior);
  const evalCurve = curveEvaluator(curve);

  const residuals: ToneResidual[] = SIGNATURE_PERCENTILES.map((p, k) => {
    const x = baseline.lumaPercentiles[k]!;
    const y = reference.lumaPercentiles[k]!;
    const fitted = evalCurve(x);
    return { percentile: p, baseline: x, reference: y, fitted, error: Math.abs(fitted - y) };
  });
  const maxResidual = residuals.reduce((m, r) => Math.max(m, r.error), 0);
  const rmsResidual = Math.sqrt(residuals.reduce((s, r) => s + r.error * r.error, 0) / residuals.length);

  return {
    curve,
    report: {
      solved: ['tone'],
      deferred: [...DEFERRED_STAGES],
      controlPercentiles: [...TONE_CONTROL_PERCENTILES],
      residuals,
      maxResidual,
      rmsResidual,
    },
  };
}

/** Human-readable tone-solve report lines (the CLI's "fit report" — same restraint consensus.ts's formatConsensusReport uses: no raw point dump). */
export function formatToneSolveReport(report: ToneSolveReport, imageCount: number): string[] {
  const lines: string[] = [];
  lines.push(`solved: ${report.solved.join(', ')}`);
  lines.push(`deferred (stage 2): ${report.deferred.join(', ')}`);
  lines.push(`tone fit over ${imageCount} reference image(s), baseline = PLACEHOLDER neutral (stage-2 TODO: bundled corpus)`);
  lines.push(`residual percentile error: max ${report.maxResidual.toFixed(2)}/255, rms ${report.rmsResidual.toFixed(2)}/255`);
  for (const r of report.residuals) {
    lines.push(
      `  p${(r.percentile * 100).toFixed(0).padStart(2)}: baseline ${r.baseline.toFixed(1)} → reference ${r.reference.toFixed(1)}  fitted ${r.fitted.toFixed(1)} (Δ${r.error.toFixed(2)})`
    );
  }
  return lines;
}
