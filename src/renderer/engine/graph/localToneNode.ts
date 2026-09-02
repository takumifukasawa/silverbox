/**
 * Local-adaptive tone node (docs/research/local-adaptive-tone.md,
 * docs/research/lr-tone-measurements.md / -r2.md): a Fast Local Laplacian
 * Filter (Aubry/Paris/Hasinoff/Kautz/Durand 2014, MIT-licensed algorithm —
 * implemented from the published papers, no GPL/GPL-adjacent source read or
 * copied) operating on WORKING_LUMA log2 luminance only, restoring color by
 * the RATIO method (research doc §1.2 'lum'): process log2(luma), then scale
 * the ORIGINAL rgb by 2^(processedLog - originalLog) so hue/chroma ratios are
 * preserved exactly (Ir/Ii, Ig/Ii, Ib/Ii unchanged).
 *
 * Doc-shape module only (params/sanitizer/CPU pyramid reference used by unit
 * tests), same split as denoiseNode.ts/lutNode.ts — the actual GPU pyramid
 * (many small fragment passes over r32float textures at shrinking
 * resolutions) lives in graphRenderer.ts, since it needs per-level render
 * targets the generic 'passes' one-texture-per-step pipeline can't express.
 *
 * SPATIAL CLASS, NO CPU MIRROR (same exemption as Detail/fx-spatial in
 * developNode.ts, and 'external'/'denoise'/'image' steps in graphDoc.ts): a
 * Laplacian pyramid's coefficients depend on the WHOLE image, not a
 * per-pixel neighborhood a JS reference could feasibly mirror. buildPlan
 * emits PlanStep 'localtone' with no `cpu` field; cpuEvalPlan/
 * stepHasCpuMirror/stripNoCpuMirrorSteps treat it exactly like 'external'/
 * 'denoise' (see graphDoc.ts).
 *
 * STAGE 1 SCOPE (docs/research/local-adaptive-tone.md §7's route (b)):
 * per-pixel/local remap only. The doc's "mechanism B" — Eric Chan's
 * measured global scene-statistics range auto-expansion (E6, ~0.05-stop /
 * ~20% relative effect, confirmed a SEPARATE layer on top of the local
 * operator) — is explicitly OUT OF SCOPE here. The seam for it: `amount`
 * and the two β (tail-compression) computations below are the ONLY places
 * a future global-statistics term would multiply in; see STAGE2_GLOBAL_LAW
 * SEAM comment on packLocalToneUniforms.
 *
 * STAGE 1b (this revision — see the implementer report for the full
 * before/after numbers): stage 1 keyed the remap's tail slope β to the
 * SIGN of the per-pixel offset (i - gamma) — shadows compressed the d<0
 * tail, highlights the d>0 tail, of the SAME per-level remap curve. A
 * from-scratch CPU pyramid simulation (this repo's own math) confirmed
 * that design injects a genuine, K-independent cross-talk into the shared
 * Laplacian pyramid (LOCALTONE_BETA_FLOOR's doc comment has the original
 * writeup) and reproduced neither E1's Shadows sign structure nor E4's
 * no-halo requirement.
 *
 * The conductor's stage-1b hypothesis — key β to the discretization
 * REFERENCE LEVEL gammaJ instead (dark gammaJ -> shadows β, bright gammaJ
 * -> highlights β, SYMMETRIC in offset at every level, tent-blended
 * smoothly between the two) — was simulated first and did NOT reproduce
 * LR's E1 sign structure either (patch delta stayed ~0 or wrong-signed at
 * every background); a from-scratch CPU sim mechanistic read: for a small
 * patch on a big background, the tent-weighted reconstruction concentrates
 * on gammaJ close to the SURROUND's own value at coarse pyramid levels, so
 * a bright surround pulls weight toward BRIGHT gammaJ — meaning "dark
 * gammaJ -> shadows β" starves exactly the case (bright surround, Shadows
 * slider) LR's own data shows the STRONGEST effect for.
 *
 * What DID measurably help in the same sim (both E1's sign check and E4's
 * overshoot, vs the stage-1 baseline, though neither clears the acceptance
 * bar outright): the SAME level-keyed, symmetric-per-level remap shape,
 * with the mapping INVERTED — bright gammaJ -> shadows β, dark gammaJ ->
 * highlights β (betaForLevel below). This is the shipped stage-1b design.
 * Both this and the swapped mapping are exercised in the sim as documented
 * in the implementer report; see betaForLevel's own doc comment for the
 * exact rationale and LOCALTONE_LEVEL_MID_LOG2/
 * LOCALTONE_LEVEL_TRANSITION_STOPS for the new named constants.
 */

export const LOCALTONE_KIND = 'localtone';

export interface LocalToneParams {
  /** 0..100. Lifts pixels whose log2-luma sits BELOW the local (per-pyramid-level) coarse reference by more than sigmaR stops — i.e. pixels that read as "locally dark" relative to their surround (E1: patch=18% gray lifts MORE on a BRIGHT background, since the coarse reference there is bright and the patch reads as a relative shadow). 0 = no effect. */
  shadows: number;
  /** -100..0. Crushes pixels whose log2-luma sits ABOVE the local coarse reference by more than sigmaR stops — pixels reading as "locally bright" (E1: patch crushes hardest on a DARK background). Negative-only (LR's own Highlights sign convention: negative = recover/darken); 0 = no effect. */
  highlights: number;
  /** 0..100. RESERVED for stage 2 (band-limited micro-contrast on the |d|<sigmaR detail zone) — carried through params/sidecar/UI but INERT (no shader reads it) in stage 1, per the brief. */
  clarity: number;
  /**
   * Stops (log2), splits the pyramid's per-level remap curve into a
   * pass-through DETAIL zone (|d| <= sigmaR) and a compressed TONE-TAIL zone
   * (|d| > sigmaR) — see remapLog2 below.
   *
   * LR-CALIBRATION CONSTANT (docs/research/lr-tone-measurements-r2.md, Q2):
   * measured via E4's overshoot-ratio knee on Shadows+100 hard/pre-blurred
   * step edges (round-2, 21px-boxcar-smoothed, {contrast, s16} sweep) —
   * **σr = 4.0 stops, bracket [3.5, 4.2]** (25%-RSS piecewise-linear
   * breakpoint fit). This is ~3x the original Local Laplacian Filters paper's
   * own default (σr = ln(2.5) ≈ 1.32 stops) — a genuine LR-specific
   * recalibration, not a units slip: Silverbox works directly in log2
   * (stops) rather than the papers' natural log, so this constant needs no
   * ln(2) conversion anywhere downstream.
   */
  sigmaR: number;
  /** 0..1 master mix vs identity, like the LUT node's amount / blend's uniform.x. 0 = IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through). */
  amount: number;
}

export function defaultLocalToneParams(): LocalToneParams {
  return { shadows: 0, highlights: 0, clarity: 0, sigmaR: LOCALTONE_SIGMA_R_DEFAULT, amount: 1 };
}

/** LR-CALIBRATION CONSTANT — see LocalToneParams.sigmaR's doc comment. */
export const LOCALTONE_SIGMA_R_DEFAULT = 4.0;

/**
 * amount<=0 (bit-exact pass-through) OR shadows===0 && highlights===0 (the
 * pyramid would still run but reduce to a near-identity — see the module doc
 * comment's numerical-identity note) both count as IDENTITY, so a freshly
 * added node (shadows=0, highlights=0, amount=1 default) never emits a pass
 * — the engine invariant "default params ⇒ pass NOT emitted ⇒ bit-exact
 * pass-through" (buildPlan resolves identity nodes away).
 */
export function isIdentityLocalTone(p: LocalToneParams): boolean {
  return p.amount <= 0 || (p.shadows === 0 && p.highlights === 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Normalize an untrusted localTone payload; NEVER throws (imageNode.ts/lutNode.ts convention — a bad param must never take an otherwise-good sidecar down with it). */
export function sanitizeLocalToneParams(raw: unknown, _nodeId: string): LocalToneParams {
  const base = defaultLocalToneParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { shadows?: unknown; highlights?: unknown; clarity?: unknown; sigmaR?: unknown; amount?: unknown };
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    shadows: clamp(num(src.shadows, base.shadows), 0, 100),
    highlights: clamp(num(src.highlights, base.highlights), -100, 0),
    clarity: clamp(num(src.clarity, base.clarity), 0, 100),
    // Floor > 0 avoids a degenerate zero-width detail zone; ceiling is a
    // generous headroom over the calibrated bracket, not itself calibrated.
    sigmaR: clamp(num(src.sigmaR, base.sigmaR), 0.5, 10),
    amount: clamp(num(src.amount, base.amount), 0, 1),
  };
}

// --- Shared discretization/algorithm constants (GPU shader + CPU reference) -

/**
 * K discretization levels (Fast LLF's "sample the luminance range at K fixed
 * references, tent-interpolate per pixel/per level" trick — research doc
 * §1.3/§4.4 item 3). 8-16 recommended by the doc; darktable's 6 is
 * documented to band. 12 is the doc's own suggested middle value — an
 * ENGINEERING choice (quality/perf tradeoff), not an LR-calibrated constant.
 */
export const LOCALTONE_K_LEVELS = 12;

/**
 * Fixed log2-luma discretization span (stops) the K references sample across
 * — NOT dynamically fit to each image's actual histogram (that adaptive
 * range-fitting is exactly Eric Chan's "mechanism B" / E6's global-statistics
 * layer, explicitly out of stage-1 scope — see the module doc comment's
 * STAGE2_GLOBAL_LAW seam). Generous fixed bounds covering RAW scene-referred
 * linear data from the noise floor to several stops of highlight headroom.
 */
export const LOCALTONE_LOG2_LO = -20;
export const LOCALTONE_LOG2_HI = 4;

/** log2(luma) floor to avoid log2(0) — matches LOCALTONE_LOG2_LO (2^-20). */
export const LOCALTONE_LUMA_EPS = 2 ** LOCALTONE_LOG2_LO;

/**
 * Band-limits the remap curve's knee at |d|=sigmaR (research doc §4.4 item 2:
 * "区分線形の折れは Fast 版でエイリアシングを起こす…中央部を微分ガウシアン、
 * 両端を直線、接続を二次ベジエで" — a hard piecewise-linear kink aliases
 * under the K-level discretization). This implementation was NOT derived
 * from any GPL source (darktable's actual curve was neither read nor
 * copied) — it is an independently-constructed C1-continuous blend: a
 * smoothstep-weighted mix between the identity line (slope 1, the "detail"
 * zone) and the compressed tail line (slope beta, the "tone" zone), over a
 * window of width `2 * LOCALTONE_KNEE_SOFTEN_FRAC * sigmaR` centered on
 * |d|=sigmaR. Because smoothstep's derivative is exactly 0 at both window
 * edges, the blended curve's slope matches its neighbor's slope exactly at
 * each edge (no kink) while still asymptoting to the same two lines the
 * papers' hard-piecewise formula uses. 0.35 is an ENGINEERING choice (not
 * LR-calibrated) — wide enough to visibly soften the knee, narrow enough
 * that sigmaR still reads as "the" edge/detail threshold in the E4 σr
 * measurement sense.
 */
export const LOCALTONE_KNEE_SOFTEN_FRAC = 0.35;

/** exp2(processedLog - originalLog) ratio clamp — a numerical-safety guard against runaway HDR ratios near-black, NOT an LR-calibrated constant. */
export const LOCALTONE_RATIO_CLAMP_MAX = 16;

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Per-level remap curve (research doc §1.2's rd/re shape, band-limited per
 * LOCALTONE_KNEE_SOFTEN_FRAC above): identity in the DETAIL zone (|d| <=
 * sigmaR, alpha=1 — stage 1 does not implement Clarity's detail boost, see
 * LocalToneParams.clarity), a compressed TONE TAIL beyond it, SYMMETRIC in
 * offset (the paper's own tone form fe(a) = beta*a on both sides — STAGE
 * 1b: a single `beta` per invocation, no longer split by sign(d), see the
 * module doc comment's STAGE 1b section for why the sign-keyed split was
 * dropped). beta=1 ⇒ untouched (identity); beta=LOCALTONE_BETA_FLOOR ⇒ that
 * level's tail maximally compresses toward the reference value `gamma`.
 * This is the CPU twin of graphRenderer.ts's REMAP_SHADER — kept
 * numerically identical (same constants, same operation order) even though
 * this spatial op has no per-pixel CPU MIRROR requirement (the shared
 * shape is what pyramid.test.ts's unit tests exercise). Which `beta` a
 * given discretization level gets is betaForLevel's job, not this
 * function's — remapLog2 itself is now shadows/highlights-agnostic.
 */
export function remapLog2(x: number, gamma: number, sigmaR: number, beta: number): number {
  const d = x - gamma;
  const ad = Math.abs(d);
  const sd = Math.sign(d);
  const w = LOCALTONE_KNEE_SOFTEN_FRAC * sigmaR;
  const t = smoothstepJs(sigmaR - w, sigmaR + w, ad);
  const idOut = d;
  const tailOut = sd * (sigmaR + beta * (ad - sigmaR));
  const f = idOut + (tailOut - idOut) * t;
  return gamma + f;
}

/**
 * FLOOR on beta (never fully 0) — an ENGINEERING MITIGATION, not an
 * LR-calibrated constant. STAGE 1b HISTORY: this was originally introduced
 * to bound a cross-talk artifact from stage 1's SIGN-keyed asymmetric beta
 * (a heavily-compressed d<0 region's shrunken Laplacian coefficients
 * measurably perturbing an adjacent, untouched-beta d>0 region through the
 * shared pyramid — confirmed via a from-scratch CPU simulation, K-
 * independent, present even at beta=0.5). Stage 1b's redesign (betaForLevel
 * below: beta keyed to the discretization level gammaJ, symmetric per
 * level) removes that SPECIFIC sign-boundary cross-talk mechanism, but a
 * related, still K-independent leakage persists across the gammaJ
 * TRANSITION band (see betaForLevel's own doc comment and the implementer
 * report's E1/E4 numbers) — so the floor is kept as the same kind of
 * worst-case-bound mitigation, not a full fix.
 */
export const LOCALTONE_BETA_FLOOR = 0.75;

/** shadows(0..100) -> beta(1..LOCALTONE_BETA_FLOOR): the compression slope betaForLevel uses for gammaJ levels in the "shadows" (bright-reference) regime. */
export function shadowsToBeta(shadows: number): number {
  return clamp(1 - (shadows / 100) * (1 - LOCALTONE_BETA_FLOOR), LOCALTONE_BETA_FLOOR, 1);
}

/** highlights(-100..0) -> beta(1..LOCALTONE_BETA_FLOOR): the compression slope betaForLevel uses for gammaJ levels in the "highlights" (dark-reference) regime. */
export function highlightsToBeta(highlights: number): number {
  return clamp(1 + (highlights / 100) * (1 - LOCALTONE_BETA_FLOOR), LOCALTONE_BETA_FLOOR, 1);
}

/**
 * LR-CALIBRATION-ADJACENT CONSTANT (STAGE 1b): the log2-luma value
 * betaForLevel's smooth shadows<->highlights transition is CENTERED on —
 * "18% gray", the same self-colored reference E1's own headline table
 * zeroes out at (patch==background==18% -> exactly 0.000 stops for both
 * sliders). Not independently re-derived from a dedicated LR measurement
 * the way sigmaR was; chosen because it is the one physically-motivated
 * anchor point the existing E1 data already pins down exactly.
 */
export const LOCALTONE_LEVEL_MID_LOG2 = Math.log2(0.18);

/**
 * ENGINEERING CONSTANT (STAGE 1b, CPU-sim-tuned then confirmed against the
 * real GPU renderer via verify:localtone, NOT LR-calibrated): width, in
 * stops, of the smooth shadows<->highlights blend across
 * LOCALTONE_LEVEL_MID_LOG2 — see betaForLevel. Swept in the implementer
 * report's CPU simulation (4/8/16/24 stops) and cross-checked at 16 vs 24
 * on the real 1024px E4 render: wider consistently reduces BOTH E4's
 * hard-edge overshoot ratio (0.32 at 16 stops -> 0.26 at 24 stops,
 * measured) AND its transition width (21px -> 14px), at the cost of a
 * slightly LARGER E1 dark-background (bg<18%) sign error (-0.119 -> -0.150
 * stops at bg=0.5%, measured) — neither check flips from fail to pass at
 * either width, so 24 (the widest swept) was kept as the better-on-net
 * choice. 24 stops spans the full [LOCALTONE_LOG2_LO, LOCALTONE_LOG2_HI]
 * range, i.e. betaForLevel's blend never fully saturates to a pure
 * single-slider beta anywhere in the working range — see the implementer
 * report for the full sweep and the honest characterization of what's
 * still failing (E1 sign-positive-somewhere for Shadows, E4 transition
 * width and overshoot) even at this value.
 */
export const LOCALTONE_LEVEL_TRANSITION_STOPS = 24;

/**
 * betaForLevel: the discretization level gammaJ's OWN, single, symmetric
 * compression slope (STAGE 1b's redesign — see the module doc comment).
 * w=0 (gammaJ deep in the LOCALTONE_LEVEL_MID_LOG2-centered dark side) ->
 * the HIGHLIGHTS beta; w=1 (gammaJ deep on the bright side) -> the SHADOWS
 * beta — this mapping is the OPPOSITE of the conductor's literal hypothesis
 * (dark gammaJ -> shadows, bright gammaJ -> highlights), which the
 * implementer report's CPU sim showed does NOT reproduce LR's E1 sign
 * structure. Mechanistic reason (confirmed in sim, see the report): for a
 * small patch embedded in a large background, the Fast-LLF tent-weighted
 * reconstruction at COARSE pyramid levels (where the patch/background
 * Laplacian edge energy actually concentrates) draws its gammaJ weight
 * from the SURROUND's own value, not the patch's — so a BRIGHT surround
 * pulls reconstruction weight toward BRIGHT gammaJ levels. For Shadows
 * (which should lift a patch that reads as "locally dark against a bright
 * surround," LR's own strongest E1 signal) to have any effect there at
 * all, it is the BRIGHT gammaJ levels that must carry the shadows-driven
 * beta, not the dark ones.
 */
export function betaForLevel(gammaJ: number, shadows: number, highlights: number): number {
  const betaShadow = shadowsToBeta(shadows);
  const betaHighlight = highlightsToBeta(highlights);
  const half = LOCALTONE_LEVEL_TRANSITION_STOPS / 2;
  const w = smoothstepJs(LOCALTONE_LEVEL_MID_LOG2 - half, LOCALTONE_LEVEL_MID_LOG2 + half, gammaJ);
  return betaHighlight * (1 - w) + betaShadow * w;
}

/** Tent (triangle) interpolation weight for discretization reference `gammaJ`, spacing `step` — the Fast LLF blend weight (research doc §1.3). Zero outside [gammaJ-step, gammaJ+step]; weights across consecutive references sum to exactly 1 for any g inside [LOCALTONE_LOG2_LO, LOCALTONE_LOG2_HI]. */
export function tentWeight(g: number, gammaJ: number, step: number): number {
  return Math.max(0, 1 - Math.abs(g - gammaJ) / step);
}

/** The K discretization reference values gamma_0..gamma_{K-1}, evenly spaced across [LOCALTONE_LOG2_LO, LOCALTONE_LOG2_HI]. */
export function discretizationLevels(k: number = LOCALTONE_K_LEVELS): number[] {
  const step = (LOCALTONE_LOG2_HI - LOCALTONE_LOG2_LO) / (k - 1);
  return Array.from({ length: k }, (_, j) => LOCALTONE_LOG2_LO + j * step);
}

// --- CPU pyramid reference (unit tests only — collapse(build(x)) ≈ x mandate,
// docs/research/local-adaptive-tone.md §4.3) -----------------------------
//
// This is a tiny, deliberately non-optimized reference of the SAME
// Burt-Adelson 5-tap kernel graphRenderer.ts's REDUCE_SHADER/
// EXPAND-and-combine shader use, operating on a flat Float32Array + (w,h) —
// used ONLY by localToneNode.test.ts to prove the reduce/expand pyramid
// construction itself round-trips within the doc's mandated 1e-3 tolerance.
// This is NOT a per-pixel CPU mirror of the GPU node (see the module doc
// comment's "spatial class, no CPU mirror" section) — the node has no
// buildPlan `cpu` callback at all.

/** Burt-Adelson 5-tap kernel (research doc §1.2/§4.3: "ピラミッドは Burt–Adelson 5×5 カーネル"), normalized to sum 1. */
export const PYRAMID_KERNEL_5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export interface GrayImage {
  data: Float32Array;
  w: number;
  h: number;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** REDUCE: 5x5 (separable-equivalent, applied as a 2D outer product for a single non-separable pass — see graphRenderer.ts's REDUCE_SHADER doc comment for why) blur + decimate by 2, clamp-to-edge. Matches the GPU kernel exactly. */
export function reduceGray(src: GrayImage): GrayImage {
  const dw = Math.max(1, Math.ceil(src.w / 2));
  const dh = Math.max(1, Math.ceil(src.h / 2));
  const out = new Float32Array(dw * dh);
  for (let oy = 0; oy < dh; oy++) {
    for (let ox = 0; ox < dw; ox++) {
      let sum = 0;
      const cx = ox * 2;
      const cy = oy * 2;
      for (let dy = -2; dy <= 2; dy++) {
        const sy = clampi(cy + dy, 0, src.h - 1);
        const ky = PYRAMID_KERNEL_5[dy + 2]!;
        for (let dx = -2; dx <= 2; dx++) {
          const sx = clampi(cx + dx, 0, src.w - 1);
          sum += PYRAMID_KERNEL_5[dx + 2]! * ky * src.data[sy * src.w + sx]!;
        }
      }
      out[oy * dw + ox] = sum;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** EXPAND: upsample `coarse` to exactly (dstW, dstH) via the interpolating Burt-Adelson filter (same kernel as reduceGray, energy-normalized x4) — matches graphRenderer.ts's expand-and-combine shader's expand() term exactly. */
export function expandGray(coarse: GrayImage, dstW: number, dstH: number): GrayImage {
  const out = new Float32Array(dstW * dstH);
  for (let oy = 0; oy < dstH; oy++) {
    for (let ox = 0; ox < dstW; ox++) {
      let sum = 0;
      for (let m = -2; m <= 2; m++) {
        const oxm = ox - m;
        if ((oxm & 1) !== 0) continue;
        const cxr = oxm / 2;
        const cx = clampi(cxr, 0, coarse.w - 1);
        const km = PYRAMID_KERNEL_5[m + 2]!;
        for (let n = -2; n <= 2; n++) {
          const oyn = oy - n;
          if ((oyn & 1) !== 0) continue;
          const cyr = oyn / 2;
          const cy = clampi(cyr, 0, coarse.h - 1);
          sum += km * PYRAMID_KERNEL_5[n + 2]! * coarse.data[cy * coarse.w + cx]!;
        }
      }
      out[oy * dstW + ox] = 4 * sum;
    }
  }
  return { data: out, w: dstW, h: dstH };
}

/** Full-depth level-dims sequence, halving (ceil) until 1x1 — same formula graphRenderer.ts's pyramid setup uses (research doc §4.4 item 4: "H/S用途ではピラミッドを最上位まで構築する"). */
export function pyramidLevelDims(w: number, h: number): { w: number; h: number }[] {
  const levels: { w: number; h: number }[] = [{ w, h }];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    if (prev.w <= 1 && prev.h <= 1) break;
    levels.push({ w: Math.max(1, Math.ceil(prev.w / 2)), h: Math.max(1, Math.ceil(prev.h / 2)) });
  }
  return levels;
}

/** Build a full-depth Gaussian pyramid (level 0 = `img` itself). */
export function buildGaussianPyramid(img: GrayImage): GrayImage[] {
  const levels: GrayImage[] = [img];
  let cur = img;
  while (cur.w > 1 || cur.h > 1) {
    cur = reduceGray(cur);
    levels.push(cur);
  }
  return levels;
}

/** Build the matching Laplacian pyramid: L[l] = G[l] - expand(G[l+1]) for l < top, L[top] = G[top] (standard Burt-Adelson convention — the residual/DC level needs no further transform). */
export function buildLaplacianPyramid(gaussian: GrayImage[]): GrayImage[] {
  const n = gaussian.length;
  const laplacian: GrayImage[] = [];
  for (let l = 0; l < n - 1; l++) {
    const fine = gaussian[l]!;
    const expanded = expandGray(gaussian[l + 1]!, fine.w, fine.h);
    const data = new Float32Array(fine.w * fine.h);
    for (let i = 0; i < data.length; i++) data[i] = fine.data[i]! - expanded.data[i]!;
    laplacian.push({ data, w: fine.w, h: fine.h });
  }
  laplacian.push(gaussian[n - 1]!);
  return laplacian;
}

/** Reconstruct the full-res image from a Laplacian pyramid: recon[top] = L[top], recon[l] = L[l] + expand(recon[l+1]). collapseLaplacianPyramid(buildLaplacianPyramid(buildGaussianPyramid(x))) ≈ x is the doc-mandated unit test (§4.3). */
export function collapseLaplacianPyramid(laplacian: GrayImage[]): GrayImage {
  let recon = laplacian[laplacian.length - 1]!;
  for (let l = laplacian.length - 2; l >= 0; l--) {
    const lvl = laplacian[l]!;
    const expanded = expandGray(recon, lvl.w, lvl.h);
    const data = new Float32Array(lvl.w * lvl.h);
    for (let i = 0; i < data.length; i++) data[i] = lvl.data[i]! + expanded.data[i]!;
    recon = { data, w: lvl.w, h: lvl.h };
  }
  return recon;
}
