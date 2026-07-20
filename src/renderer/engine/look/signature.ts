/**
 * Look extraction, mode 2 — reference-set aggregate SIGNATURE (docs/brief-bank/
 * look-extraction.md §"Mode 2" + §"Mode 2 solve well-posedness"). A reference
 * set (film scans, a downloaded Pinterest board, another shooter's JPEGs) HAS
 * a look; there is no pairing with our own photos, so the only handle on the
 * look is a STATISTICAL signature of the set, which a staged, well-posed solve
 * (solve.ts) then reproduces with our Develop params.
 *
 * STAGE 1 (the spike — docs/brief-bank/look-extraction-mode2-stage1.md) lands
 * ONLY the first freeze stage, luma TONE. So this module defines the FULL
 * Signature type (every component the parent lists — global chroma, HSL bands,
 * grading-wheel chroma vectors, grain) but POPULATES only the luma-side pieces
 * the tone solve consumes: the encoded-luma percentile vector (p2..p98) and the
 * contrast proxy (p90−p10, a free derivative of that vector). Every non-luma
 * field is declared with a clear STAGE-2 TODO and left `null` until the color/
 * grain freeze stages land — the type is complete now so the solver stage can
 * fill them without a type change.
 *
 * PURE: takes decoded pixel buffers (working-linear Rec.2020 RGBA, exactly a
 * PreparedImage's `data`), returns numbers. No file/IO, no DOM, no GPU — the
 * CLI orchestration (decode each reference, aggregate, solve, serializePreset)
 * lives in appStore.ts's runCliExtractReferences, mirroring runCliExtractLook.
 *
 * LUMA SPACE: percentiles are measured on DISPLAY-ENCODED luma (0..255), the
 * exact space the tone curve operates in (toneCurve.ts: "the curve is APPLIED
 * IN DISPLAY (sRGB-encoded) SPACE"). The working-linear pixel is taken through
 * the engine's own exit transform — WORK_TO_SRGB then the shared srgbEncode
 * OETF — and the shared WORKING_LUMA weights, the identical math the base-curve
 * fitter (scripts/fit-base-curve.mjs `encodedLuma255`) samples in, so the
 * signature lives in the same units the reused percentile→control-point solve
 * expects. Reuses the engine helpers, re-derives nothing (engine invariant).
 */
import { srgbEncode } from '../color/srgb';
import { WORK_TO_SRGB, WORKING_LUMA } from '../color/workingSpace';

/**
 * The fixed percentiles (fractions of 1) the luma signature stores, spanning
 * p2..p98 (the parent's "luma percentile vector (p2..p98)"). A superset of
 * TONE_CONTROL_PERCENTILES (the tone solve's interior control points) plus the
 * p10/p90 the contrast proxy reads and the p50 median — so the solve and the
 * report both index straight into ONE vector with no re-sampling.
 */
export const SIGNATURE_PERCENTILES: readonly number[] = [
  0.02, 0.05, 0.1, 0.15, 0.3, 0.45, 0.5, 0.6, 0.75, 0.9, 0.95, 0.98,
];

/**
 * Which SIGNATURE_PERCENTILES entries become the tone curve's INTERIOR control
 * points (solve.ts) — the same interior quantile set the base-curve fitter
 * pairs into control points (scripts/fit-base-curve.mjs `CTRL_Q`), reused so
 * the two percentile→control-point fits share one shape. Every entry here is a
 * member of SIGNATURE_PERCENTILES by construction (asserted in the unit test).
 */
export const TONE_CONTROL_PERCENTILES: readonly number[] = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];

/** Stride cap for the per-image luma sort — a representative spread without paying to sort every pixel of a full-res frame (matches fit-base-curve.mjs's own cap discipline). */
export const DEFAULT_MAX_SAMPLES = 2_000_000;

/** A decoded reference frame: working-linear Rec.2020 RGBA float pixels (a PreparedImage's `data`), orientation already applied. */
export interface DecodedImage {
  /** RGBA float, 4 per pixel, alpha ignored — working-linear (the decode/develop working space). */
  data: Float32Array;
  width: number;
  height: number;
}

/** a*b* chroma vector (CIELAB-style), the grading-wheel signal — STAGE 2. */
export interface ChromaVector {
  a: number;
  b: number;
}

/** One HSL band's residual signal — STAGE 2. */
export interface HslBandStat {
  /** hue centroid shift for this band, degrees. */
  hueCentroidShiftDeg: number;
  /** mean saturation within this band. */
  meanSat: number;
}

/**
 * The reference set's aggregate signature. STAGE 1 populates only the luma
 * pieces (`lumaPercentiles`, `contrastProxy`, `imageCount`); every other field
 * is a STAGE-2 TODO left `null` (declared now so the type is complete and the
 * color/grain freeze stages fill it without a type change — see this module's
 * doc comment and the parent's freeze order 2–5).
 */
export interface Signature {
  /**
   * STAGE 1 — POPULATED. Display-encoded luma (0..255) at each
   * SIGNATURE_PERCENTILES entry, INDEX-ALIGNED to it. Aggregated across the
   * set as the PER-PERCENTILE MEDIAN across images (robust to one odd frame —
   * see aggregateSignature).
   */
  lumaPercentiles: number[];
  /**
   * STAGE 1 — POPULATED. p90 − p10 of the encoded-luma vector (the parent's
   * "contrast proxy (p90−p10)"). A free derivative of `lumaPercentiles`, so it
   * ships with the luma stage; not otherwise consumed by the tone solve yet.
   */
  contrastProxy: number;
  /** STAGE 1 — POPULATED. How many reference frames the per-percentile median aggregated over. */
  imageCount: number;

  // --- STAGE 2 TODO: the CHROMA / GRAIN freeze stages (parent's order 2–5).
  //     Declared now so the Signature TYPE is complete; `null` until the
  //     solver stage measures and fills them. ---

  /** STAGE 2 (freeze 2) — global chroma distribution: median (→ saturation) + skew (→ vibrance). */
  globalChroma: { median: number; skew: number } | null;
  /** STAGE 2 (freeze 3) — per-HSL-band hue-centroid shift + mean saturation (8 bands). */
  hslBands: HslBandStat[] | null;
  /** STAGE 2 (freeze 4) — a*b* mean below luma p25: the shadow grading-wheel direction. */
  shadowChroma: ChromaVector | null;
  /** STAGE 2 (freeze 4) — a*b* mean above luma p75: the highlight grading-wheel direction. */
  highlightChroma: ChromaVector | null;
  /** STAGE 2 (freeze 4) — residual midtone a*b* the shadow/highlight zones didn't explain: the midtone wheel. */
  midtoneChroma: ChromaVector | null;
  /** STAGE 2 (freeze 5) — band-limited high-frequency energy: the grain amount. */
  grainEnergy: number | null;
}

/**
 * Working-linear Rec.2020 pixel → DISPLAY-ENCODED luma in 0..255 — the exit
 * transform (WORK_TO_SRGB → shared srgbEncode OETF) and the shared WORKING_LUMA
 * weights, identical to scripts/fit-base-curve.mjs `encodedLuma255` (which the
 * shipped base curve was fitted against) so the signature and the reused tone
 * solve share one luma space. srgbEncode already clamps to [0,1].
 */
export function encodedLuma255(r: number, g: number, b: number): number {
  const sr = WORK_TO_SRGB[0][0] * r + WORK_TO_SRGB[0][1] * g + WORK_TO_SRGB[0][2] * b;
  const sg = WORK_TO_SRGB[1][0] * r + WORK_TO_SRGB[1][1] * g + WORK_TO_SRGB[1][2] * b;
  const sb = WORK_TO_SRGB[2][0] * r + WORK_TO_SRGB[2][1] * g + WORK_TO_SRGB[2][2] * b;
  return (WORKING_LUMA[0] * srgbEncode(sr) + WORKING_LUMA[1] * srgbEncode(sg) + WORKING_LUMA[2] * srgbEncode(sb)) * 255;
}

/** q-quantile (0..1) of a pre-sorted Float64Array, linear interpolation — same shape as fit-base-curve.mjs `quantile`. */
function quantileSorted(sorted: Float64Array, q: number): number {
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Median of a numeric list (robust center — same helper shape consensus.ts uses). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * One frame's encoded-luma percentile vector, INDEX-ALIGNED to
 * SIGNATURE_PERCENTILES. Strided down to at most `maxSamples` pixels before the
 * sort (a full-res frame's exact percentiles don't need every pixel), the same
 * cap-then-sort the base-curve fitter uses.
 */
export function imageLumaPercentiles(img: DecodedImage, maxSamples: number = DEFAULT_MAX_SAMPLES): number[] {
  const { data, width, height } = img;
  const total = width * height;
  if (total <= 0) throw new Error('imageLumaPercentiles: empty image');
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const count = Math.floor((total - 1) / stride) + 1;
  const luma = new Float64Array(count);
  for (let i = 0, j = 0; i < total; i += stride, j++) {
    const o = i * 4;
    luma[j] = encodedLuma255(data[o]!, data[o + 1]!, data[o + 2]!);
  }
  luma.sort();
  return SIGNATURE_PERCENTILES.map((q) => quantileSorted(luma, q));
}

/** Index of a percentile in SIGNATURE_PERCENTILES (throws if absent — a programming error, not user input). */
export function percentileIndex(p: number): number {
  const idx = SIGNATURE_PERCENTILES.indexOf(p);
  if (idx < 0) throw new Error(`percentile ${p} is not one of SIGNATURE_PERCENTILES`);
  return idx;
}

/**
 * Aggregate a reference set into a Signature. Each frame's luma percentile
 * vector is computed independently, then aggregated as the PER-PERCENTILE
 * MEDIAN across frames — one odd frame (a mis-exposed shot, a title card) can
 * shift at most one input per percentile and never dominates the center. STAGE
 * 1: only the luma fields are filled; the rest stay `null` (STAGE-2 TODO).
 */
export function aggregateSignature(images: DecodedImage[], maxSamples: number = DEFAULT_MAX_SAMPLES): Signature {
  if (images.length === 0) throw new Error('aggregateSignature needs at least one image');
  const perImage = images.map((img) => imageLumaPercentiles(img, maxSamples));
  const lumaPercentiles = SIGNATURE_PERCENTILES.map((_, k) => median(perImage.map((v) => v[k]!)));
  const p10 = lumaPercentiles[percentileIndex(0.1)]!;
  const p90 = lumaPercentiles[percentileIndex(0.9)]!;
  return {
    lumaPercentiles,
    contrastProxy: p90 - p10,
    imageCount: images.length,
    globalChroma: null,
    hslBands: null,
    shadowChroma: null,
    highlightChroma: null,
    midtoneChroma: null,
    grainEnergy: null,
  };
}
