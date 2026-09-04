# LR-vs-silverbox BASE-render gap — measurement report

Measurement report, 2026-09-03. All prior LR calibration (lr-tone-measurements.md,
lr-tone-measurements-r2.md) measured **delta over silverbox's own base** —
i.e. how much Shadows/Highlights move a silverbox render relative to itself.
None of that work quantified the gap between the two BASE renders themselves.
The user eyeballed the localtone comparison page and correctly flagged that
silverbox's BASE already looks visibly different from LR's BASE before any
slider moves — this report measures and decomposes that gap.

No repo/engine changes were made while producing these measurements.
Analysis scripts, JSON results and 3 plots are preserved in
`scratchpad/base-gap/` (this session's scratchpad — outside the repo,
matching the lr-tone-measurements precedent). `common.py` holds the shared
sRGB-decode / CIE-Lab helpers; `step1`–`step5` run in that order.

## Data

- **LR-base**: 5 real Sony ARW scenes (`DSC03298/04260/06787/07349/09305`),
  Lightroom Classic default develop settings (all sliders 0, Adobe Color
  profile, WB=As Shot), sRGB quality-high JPEG export, long edge 2048.
- **silverbox-base**: the SAME 5 ARWs, rendered through
  `scratchpad/localtone-compare/render.mjs` with
  `SILVERBOX_TEST_BASE_CURVE_DEFAULT=1` — this is the important flag: it
  reproduces a genuine fresh-RAW-open default look (fitted camera profile at
  `amount=100`, the fitted base curve seeded into `toneCurve.rgb`, default RAW
  sharpen/color-NR — see `appStore.ts`'s `seedDefaultLook`), not a bare
  identity chain. `SILVERBOX_TEST_LENS_PROFILE_DEFAULT` was **not** set, so
  the Sony embedded lens-correction spline (distortion/vignetting) is **off**
  in these renders — relevant to the vignetting attribution below. Same
  export path, long edge 2048, sRGB JPEG.
- Existing calibration history worth knowing going in:
  `engine/color/baseCurve.ts`'s `A7C2_BASE_CURVE` was fit from **one** scene
  (`DSC02993`, not in this 5-scene set) against LR. `engine/color/profileFit.ts`'s
  chroma lattice was fit from **3** scenes — `DSC02993` + **`DSC03298`** +
  **`DSC07349`**, i.e. 2 of this report's 5 scenes were literally in the
  profile's own training set. profileFit.ts's own doc comment already flags
  "the two Italy scenes render darker than LR" and that its fit deliberately
  projects out the luminance component, leaving that to the base curve.

## Method summary

Both renders are 8-bit sRGB JPEGs. Decoded with the exact sRGB EOTF
(mirrors `engine/color/srgb.ts`), no `tifffile` dependency needed here (that
was specific to the 16-bit TIFF harness in lr-tone-measurements — these are
plain 8-bit sRGB files on both sides). Luma = Rec.709 linear luma, expressed
in log2 stops. Color: CIE Lab (D65) from linear sRGB primaries.

## 1. Geometry check — PASS, per-pixel comparison is valid

| scene | dims (sb=lr) | zero-shift NCC | best-shift NCC | best shift (256px-grid) |
|---|---|---|---|---|
| DSC03298 | 2048×1365, match | 0.970 | 0.975 | (0,+1) |
| DSC04260 | 2048×1365, match | 0.957 | 0.957 | (0,0) |
| DSC06787 | 2048×1365, match | 0.943 | 0.945 | (0,+1) |
| DSC07349 | 2048×1365, match | 0.980 | 0.983 | (−1,0) |
| DSC09305 | 2048×1365, match | 0.846 | 0.846 | (0,0) |

Exact dims match on all 5, and cross-correlation peaks at (0,0) or ±1px in a
256px-long-edge downsampled grid (i.e. sub-8px at full 2048 resolution) —
no crop/scale offset from LR auto-applying lens-distortion correction (LR
evidently did not, matching that silverbox's own lens-profile-default flag
was also off here). **Per-pixel comparison is valid**; no need to fall back
to quantile-quantile matching. DSC09305's lower zero-shift NCC (0.85) is a
genuine luma/color gap (confirmed below — it's the largest-gap scene), not
misregistration — its best-shift search still lands at (0,0).

## 2. Luma transfer function — verdict: **scene-adaptive, not a static-curve gap**, moderate-high confidence

Per-scene log2(silverbox-luma) → log2(LR-luma), binned (48 bins, ≥200px per
bin required). Overlaid in `plot1_luma_transfer_overlay.png`. Headline
numbers (whole-frame delta = LR − silverbox, stops, positive = LR brighter):

| scene | mean Δ | median Δ | p10 Δ | p90 Δ |
|---|---|---|---|---|
| DSC03298 | +0.40 | +0.45 | −0.56 | +1.16 |
| DSC04260 | +0.77 | +0.80 | −0.12 | +1.60 |
| DSC06787 | +0.73 | +0.74 | +0.07 | +1.45 |
| DSC07349 | **+0.16** | +0.11 | −0.22 | +0.68 |
| DSC09305 | **+1.27** | +1.23 | −0.66 | +3.23 |

Every scene is biased the same direction (LR brighter almost everywhere —
`plot1` shows all 5 curves sitting above the identity line), but the
**magnitude varies 8×** across scenes (+0.16 to +1.27 stops mean). This
alone is suggestive; the decisive test is whether a single BEST-POSSIBLE
static curve can absorb that variance.

**Static-curve test** (`step2b_static_vs_adaptive.py`): fit one n-weighted
global curve across all 5 scenes' pooled data, restricted to the
well-populated, least-quantization-noisy range (−6..−1 stops of silverbox
luma — deep shadow bins below −8 stops have too few distinct 8-bit JPEG code
values on both sides to trust). Residual (scene's own curve − global fit):

| scene | mean resid | RMS resid | range |
|---|---|---|---|
| DSC03298 | −0.23 | 0.56 | [−1.43, +0.74] |
| DSC04260 | +0.26 | 0.50 | [−0.28, +1.25] |
| DSC06787 | +0.19 | 0.25 | [−0.01, +0.53] |
| DSC07349 | −0.57 | 0.61 | [−0.89, −0.11] |
| DSC09305 | +0.35 | 0.46 | [+0.02, +0.98] |

**Overall RMS residual after the best possible single static curve: 0.49
stops.** That's not small — it's ~75% as large as the pooled mean gap itself
(0.66 stops). And it is not just a per-scene constant offset: subtracting
each scene's own mean residual still leaves ≈0.4-0.5 stops of RMS *shape*
variation within a scene's own tone range (e.g. DSC03298 swings −1.43 to
+0.74, a 2.2-stop range, even after best global centering). **Verdict: the
gap is genuinely scene-adaptive, not explainable by re-fitting one static
tone curve better.** A base-curve refit across more scenes (the "recommended
follow-up" already flagged in `baseCurve.ts`'s doc comment) would likely
shrink the *pooled mean* gap and probably help every scene somewhat, but the
measured 0.49-stop residual is a hard floor a static curve cannot close —
confidence moderate-high (clean geometry, large well-populated sample per
bin, but only 5 scenes, so the residual's exact magnitude could shift with a
larger corpus).

Note: DSC07349 and DSC03298 (the 2 scenes in the *existing* profile-fit
training set) are **not** the best-residual scenes — DSC07349 has the
*largest* RMS residual (0.61) of all 5 despite having the smallest raw mean
gap. Being "in the fit set" clearly did not immunize these scenes from
tone-curve divergence, consistent with `baseCurve.ts` having been fit to
`DSC02993` alone (not these two) and `profileFit.ts` deliberately not
touching luminance at all.

## 3. Color decomposition

Method (`step3_color.py`): for each scene, "luma-correct" silverbox by
scaling each pixel's linear RGB by a single per-pixel scalar so its luma
matches that scene's own step-2 fitted curve prediction (a uniform gain
preserves chromaticity ratios in linear RGB, so it isolates color from tone).
Then compare the luma-corrected silverbox pixel against the actual LR pixel.

### 3a. White-balance cast (near-neutral proxy)

Two variants: whole-frame R/G, B/G (contaminated by real scene chroma, e.g.
a blue-sky-heavy frame) and a near-neutral proxy (Lab C\* < 6 pixels only —
the standard way to isolate a WB gain error from scene content). Near-neutral
channel-ratio, LR/silverbox (1.0 = perfect match):

| scene | R/G ratio | B/G ratio | neutral px (n) | WB metadata |
|---|---|---|---|---|
| DSC03298 | **1.281** | **0.601** | 30,884 | Auto WB, EC −1.3 |
| DSC04260 | 1.043 | 0.996 | 107,252 | Auto WB, EC 0 |
| DSC06787 | 1.008 | 1.005 | 965,077 | Daylight WB, EC −0.3 |
| DSC07349 | **0.322** | **1.439** | 590,633 | Daylight WB, EC −0.7 |
| DSC09305 | 1.064 | 0.972 | 416,028 | Daylight WB, EC −0.3 |

3 of 5 scenes (04260, 06787, 09305) match within ±7% on both channels — a
genuinely small WB gap. **2 of 5 (03298, 07349) are large and in OPPOSITE
directions**: DSC03298's near-neutral pixels are 28% too red / 40% too blue
in LR-relative terms (silverbox too green/blue-cast for this scene);
DSC07349's are 68% too little red / 44% too much blue (silverbox too
red/warm for this scene). WB mode (Auto vs Daylight) in the EXIF does not
cleanly predict which scenes diverge — DSC07349 used the fixed Daylight
preset (same as the 3 clean scenes) yet has the single worst cast measured
here.

**This rules out "add one static color-cast correction" as a fix for the WB
component**: a fixed additive/multiplicative RGB gain cannot simultaneously
correct a too-blue cast on one scene and a too-red cast on another. Whatever
is driving this (candidates: libraw's `AsShotNeutral`/cam_mul interpretation
vs Adobe's, or genuine per-scene neutral-detection disagreement on tricky
lighting) is intrinsically per-shot, not a fixed profile residual.

### 3b. Hue/sat-table residual (WB-clean scenes only)

Repeating the hue-sector × L\*-band table with DSC03298/DSC07349 excluded
(to avoid the WB-cast finding above bleeding into a hue-table read) — 8 hue
sectors (Lab hue angle, 45° each) × 3 L\* bands (shadow <35, mid 35–70,
highlight ≥70), n-weighted across the 3 clean scenes, min 300px/cell
(`plot3_hue_sector_wheel.png`):

| sector (deg) | shadow ΔHue° | mid ΔHue° | hi ΔHue° | shadow Csat | mid Csat | hi Csat |
|---|---|---|---|---|---|---|
| 0 | +15.9 | +9.2 | +9.6 | 0.85 | 0.98 | 0.99 |
| 45 | −2.0 | −7.1 | −8.4 | 0.85 | 0.95 | 0.85 |
| 90 | −6.7 | −13.9 | −15.9 | 1.02 | 0.97 | 0.85 |
| 135 | −18.2 | −25.2 | −32.9 | 0.83 | 0.99 | 0.67 |
| 180 | −29.0 | −31.5 | +5.5 | 0.98 | 0.88 | 0.74 |
| 225 | −10.3 | −9.3 | +2.6 | 0.98 | 0.80 | 0.81 |
| 270 | −17.7 | −8.4 | +27.1 | 0.85 | 0.85 | 0.84 |
| 315 | +40.9 | +23.5 | — | 0.69 | 1.09 | — |

(Csat = LR chroma / silverbox chroma; "—" = <300px in that cell across all 3
clean scenes.)

The key structural finding: **within a given hue sector, the hue shift's
sign and rough magnitude are stable across shadow→mid→highlight** (e.g.
sector 90° is −7°/−14°/−16° across the three bands; sector 135° is
−18°/−25°/−33°) even though the raw luma gap (§2) varies hugely by scene and
tone. That stability-across-luma-bands is exactly the signature a
LUT-indexed-by-hue camera-profile residual (Adobe's hue/sat table) would
produce, as opposed to a tone-curve or exposure artifact. Chroma ratios sit
mostly in the 0.67–1.02 range (silverbox typically 0–35% MORE saturated than
LR), with one exception (sector 315 mid, 1.09) — magnitude and pooled
mean |ΔHue| across the 24 cells is **16.1°**, chroma ratio mean **0.883**.
Confidence: moderate — real, structured, stable-across-luma signal, but only
3 scenes and several cells still have single-digit-scene support (n_scenes
column in the raw JSON), so per-sector precision is loose.

## 4. Magnitude summary

- Pooled mean luma gap across the 5 scenes: **+0.66 stops** (LR brighter),
  range **+0.16 to +1.27 stops** by scene.
- Static-curve-irreducible RMS residual: **0.49 stops** (§2) — i.e. even a
  perfectly-refit universal curve leaves a scene-to-scene spread bigger than
  half the average gap itself.
- Near-neutral WB cast: **0 on 3/5 scenes, up to 68%/44% channel-ratio error
  on 2/5**, in opposite directions.
- Hue/sat-table residual (WB-clean scenes): mean |hue shift| **16°**
  (range −33° to +41° by sector), mean chroma ratio **0.88** (silverbox
  more saturated), consistent across luma bands within a sector.

In plain terms: this is not a subtle mismatch. A +0.66-stop average
brightness gap is visually obvious (roughly half a stop is already a
noticeable exposure difference), it varies scene to scene by up to 8×, one
in three scene-pairs carries a real color cast a viewer would call "off
white balance," and even in the cleanest scenes there's a structured ~16°
average hue rotation with reduced saturation. This fully explains why the
user's eyeball comparison read as "結構違う" (quite different) even before
any Shadows/Highlights slider moved.

## 5. Attribution analysis

**(a) Tone-curve shape (mid-tone contrast / toe / shoulder).** Confirmed
real and dominant. The base curve was fit to one scene; §2 shows it
generalizes poorly (0.49-stop irreducible RMS residual even under a
best-possible universal refit). This is the largest, most directly
actionable contributor.

**(b) Color profile (hue/sat table).** Confirmed real on the WB-clean
subset (§3b): a structured, luma-band-stable ~16°-mean hue rotation +
~12%-mean desaturation. Smaller in absolute visual weight than (a) but
systematic, and the existing `profileFit.ts` chroma lattice (fit on only
3 scenes, including 2 of this report's WB-outlier scenes) is a plausible
but unconfirmed explanation for why it isn't already closed.

**(c) White balance.** Confirmed real, and NOT explainable by (a) or (b) —
it is specifically a near-neutral (Lab C\*<6) channel-gain divergence, large
(28-68% relative) on 2 of 5 scenes and near-zero on the other 3, in
*opposite* directions between the two divergent scenes. A single static
color transform structurally cannot fix an effect that flips sign by scene;
this needs a per-shot fix (matching however LR resolves As-Shot WB from the
raw metadata) not a profile tweak.

**(d) Rec.709-vs-sRGB decode-path mismatch** (the suspicion flagged in
`scripts/verify-lineardng.mjs`'s header: `decodeWorker.ts`'s `linearizeRgb16`
assumes libraw's 16-bit RAW output is sRGB-gamma-encoded, but a synthetic
Linear-DNG test measured it as classic Rec.709-gamma instead). This
hypothesis predicts a SPECIFIC, scene-independent shape: `srgbDecode(rec709Encode(v))`
vs `v` is a **flat −1.52-stop plateau below linear v≈0.01 (log2 v ≈ −6.6),
then tapers smoothly to near-zero by v≈0.9** (computed directly from the two
transfer functions — see `step` outputs below):

| linear v | predicted decode-bug shift |
|---|---|
| ≤0.01 (≤−6.6 stops) | flat **−1.52 stops** |
| 0.06 (−4.1 stops) | −0.71 |
| 0.18 (−2.5 stops) | −0.37 |
| 0.5 (−1.0 stop) | −0.13 |
| 0.9 (−0.15 stops) | −0.02 |

The MEASURED aggregate (n-weighted across-scene mean) gap curve does **not**
match this shape: it stays roughly flat at **+0.6 to +1.0 stops from −10
stops all the way to about −2.5 stops**, only tapering in the final ~2
stops before white (down to +0.15 at −0.4 stops) — a much broader, flatter
curve than the bug's narrow shadow-only taper, and it doesn't even show the
predicted plateau in the deepest, most bug-diagnostic shadow region. **This
measurement finds no positive evidence the decode-path mismatch is a visible
contributor to today's BASE gap** — the shapes don't line up. Two caveats
keep this from being a clean refutation: the existing base curve was fit
*through* this same decode path on `DSC02993`, so if the bug is real and
scene-independent, the curve fit may have already partly absorbed it there
(muddying a clean shape test); and this report's own §2 finding — that the
gap is strongly scene-*dependent* — is itself hard to square with a
per-value-only bug (a fixed `f(value)` transform, even imperfectly absorbed,
predicts a shared/scene-independent residual, not the 8× scene-to-scene
spread measured here). Net: **not ruled out, but not supported by this
measurement either; lower priority than (a)/(b)/(c) given no positive
signal.**

**(e) Lens vignetting-correction difference.** Real render-pipeline
asymmetry exists: these silverbox exports had `SILVERBOX_TEST_LENS_PROFILE_DEFAULT`
off (no distortion/vignetting correction), and LR's default state for these
scenes is unknown but plausibly on for some/all. Radial residual profile
(`step4_radial.py`, `plot2_radial_residual.png`: log2-luma residual after
removing each scene's own 1D tone-curve fit, restricted to a midtone band,
binned by normalized radius 0=center→1=corner):

| scene | center (r<0.2) | corner (r>0.8) | corner−center |
|---|---|---|---|
| DSC03298 | −0.36 | +0.09 | +0.46 |
| DSC04260 | −0.51 | +0.11 | +0.62 |
| DSC06787 | −0.24 | −0.38 | **−0.14** |
| DSC07349 | −0.06 | +0.62 | **+0.67** |
| DSC09305 | −0.17 | −0.30 | **−0.13** |

3/5 scenes (03298, 04260, 07349) show corners relatively brighter in LR than
silverbox, and DSC04260/DSC07349's full radial profiles (see
`radial.json`) are close to monotonically increasing — the qualitative
signature a vignetting-correction difference would produce. But 2/5
(06787, 09305) show the opposite (corners relatively *darker* in LR), and
none of the profiles are clean/monotonic throughout (real photos have real
content at every radius, which confounds a true flat-field vignetting
signature). **Verdict: suggestive on 3/5 scenes, contradicted on 2/5 —
directionally plausible secondary contributor, not confirmed.** A flat-field
or uniform-target capture would be needed to isolate this cleanly from
scene-content confounds.

## Summary verdicts

| Question | Verdict | Confidence |
|---|---|---|
| Geometry aligned? | Yes, sub-8px at full res, per-pixel methods valid | High |
| Static curve vs scene-adaptive? | **Scene-adaptive** — 0.49-stop irreducible RMS residual after best possible universal refit | Moderate-high |
| WB cast present? | Yes, large (28-68%) on 2/5 scenes, opposite signs, near-zero on 3/5 | High |
| Hue/sat-table gap present? | Yes, structured ~16° mean hue shift, ~0.88 mean chroma ratio, stable across luma bands (WB-clean scenes) | Moderate |
| (d) Rec.709/sRGB decode-bug a major contributor? | No positive shape evidence; not ruled out | Low-moderate (against) |
| (e) Vignetting-correction difference a contributor? | Suggestive on 3/5 scenes, contradicted on 2/5 | Low-moderate |

## Remediation options

**Option 1 — base-curve refit only (multi-scene).** What it would close:
most of the *pooled mean* +0.66-stop luma gap, since the curve is currently
fit to one scene. What it would NOT close: the measured 0.49-stop
irreducible RMS residual (§2) — by construction, one curve cannot fit 5
diverging scenes to zero residual — nor any of the WB or hue/sat-table
findings (§3). Implementation surface: `engine/color/baseCurve.ts` +
`npm run fit:basecurve`, refit across a larger, more representative scene
set (the file's own doc comment already recommends this). Low engineering
risk (same mechanism, more training data), but this measurement shows it is
a **partial** fix, not a complete one — expect a visibly smaller but still
real BASE gap afterward, and pin down the pixel-noise-adjusted well-fit-vs-
residual split with a bigger scene corpus before committing to "refit
alone" as the plan.

**Option 2 — + static color transform (WB + profile refit).** A per-camera
hue/sat-table refit (extending `profileFit.ts`'s existing chroma lattice,
ideally across more/different scenes than the current 3, given 2 of those 3
turned out to be this report's WB outliers) would plausibly close most of
§3b's structured hue/sat residual — its stability across luma bands is
exactly what a lattice residual is built to capture. It would **not** close
§3a's WB-cast finding: that's sign-flipping by scene, which no fixed
transform (however fit) can represent. Implementation surface:
`engine/color/profileFit.ts` + `npm run fit:profile`, same architecture,
more/better training scenes. Combined with Option 1, this closes (a) partial
+ (b) fully — still leaves (c) untouched and the 0.49-stop residual from §2
largely in place (since a color transform doesn't touch luma).

**Option 3 — full profile emulation (per-shot WB match + adaptive tone).**
The only option this measurement's evidence points to as *necessary* to
close the WB finding (§3a) and possibly the residual scene-adaptive tone gap
(§2) if its root cause turns out to be per-shot (e.g. AsShotNeutral
interpretation, or an Adobe-side adaptive-highlight/shadow-recovery
component silently active even at "all sliders 0" — this report cannot
distinguish those without LR-internals access, which is out of scope here).
Implementation surface: likely a new stage — either fixing how
`decodeWorker`/`RawDecoder` derive the as-shot WB gain from the ARW's
`AsShotNeutral`/`WhiteBalance` metadata to match Adobe's own reading more
closely (if that's the root cause — unconfirmed), or accepting that some
residual scene-adaptivity is real LR behavior that a static default look
cannot fully replicate and treating "close within N stops on average" as
the target rather than "close exactly." Higher implementation risk/scope;
recommend the metadata-comparison follow-up below before committing
engineering time here.

**Option 4 — decode-path fix first (Rec.709-vs-sRGB linearize).** Per
attribution (d), this measurement found **no positive shape evidence**
supporting this as a contributor to the current gap — the aggregate curve's
shape doesn't match the bug's predicted narrow-shadow-taper signature, and
the strong scene-dependence found here is intrinsically hard to explain with
a per-value-only bug. Recommend **deprioritizing** this relative to Options
1-2 for closing the *base-render* gap specifically, while still treating it
as a separate, real, unresolved finding from `verify-lineardng.mjs` worth
its own follow-up (that investigation's own scope was "does real Bayer ARW
decode hit the same code path as the synthetic Linear DNG," which remains
genuinely unknown and is not something this report's real-photo, no-flat-
field data can answer either).

**Recommended path, in order:** (1) Option 1 (multi-scene base-curve refit)
first — cheapest, addresses the largest single measured number (mean gap),
and the existing code already anticipates it. (2) Option 2 (profile/color
refit) in the same pass if scenes are already being re-shot/re-fit — same
mechanism, closes the second-largest structured finding (§3b). (3) Before
investing in Option 3, run the metadata follow-up below to see whether the
WB-cast finding (§3a) correlates with anything in the ARW's own
`AsShotNeutral`/`WhiteBalance` tags — if libraw and Adobe are reading
different metadata fields or applying different fallback logic, that's a
much narrower, more tractable fix than "full profile emulation." (4) Leave
Option 4 (decode-path fix) as its own separately-scoped investigation,
unblocked by but not gating this remediation.

## What additional data would pin down remaining unknowns

1. **A larger, more representative scene corpus** (10+ scenes, varied
   lighting/WB-mode/ISO) for the base-curve and profile refits — 5 scenes is
   enough to prove scene-adaptivity exists but not enough to characterize
   its shape precisely (several hue-sector cells above have single-digit-
   scene support).
2. **AsShotNeutral/cam_mul metadata comparison**: dump the raw
   `AsShotNeutral` tag from each ARW and compare the WB gain libraw derives
   from it (via `RawDecoder`/`librawDecoder.ts`) against what Adobe's ACR
   is known/measured to compute — would directly test the leading
   §3a/Option-3 hypothesis without needing LR interaction.
3. **A flat-field or uniform gray-card capture** (same lens/body) would
   cleanly separate the vignetting-correction-difference hypothesis (§5e)
   from real-scene-content radial confounds — the single biggest
   methodological gap in this report's attribution work.
4. **LR's actual lens-correction-enabled state** for these 5 files (unknown
   from the exported JPEGs alone) — would resolve whether §5e's "3/5 vs 2/5"
   split correlates with LR having profile corrections on for some scenes
   and not others (e.g. only Sony bodies/lenses with a registered Adobe lens
   profile get auto-corrections), rather than being pure content-confound
   noise.
5. If a decode-path investigation is picked up separately (Option 4): the
   `verify-lineardng.mjs` harness's own unresolved question — whether a
   real Bayer ARW decode hits the SAME libraw code path as its synthetic
   Linear-DNG test — needs a dedicated real-RAW harness (e.g. a flat-field
   RAW shot processed with the base-curve/profile suppressed, mirroring that
   script's neutralization steps) to test directly.

## Post-report addendum (conductor's ISO-correlation check, same day)

Correlating each scene's luma-weighted mean gap against its shot ISO
(exiftool, ILCE-7CM2 across all 5 scenes):

| scene | mean gap (stops, LR−sb) | log2(ISO/100) |
|---|---|---|
| DSC07349 | +0.156 | +1.00 |
| DSC03298 | +0.394 | +1.68 |
| DSC06787 | +0.734 | +1.00 |
| DSC04260 | +0.750 | +2.32 |
| DSC09305 | +1.263 | +3.32 |

corr(gap, log2 ISO) = **0.815**, slope ≈ **0.35 stops per ISO stop** —
consistent with an Adobe per-ISO BaselineExposure(-like) component being a
major driver of the "scene-adaptive" luma gap (n=5, so a lead, not a law).
The two ISO-200 scenes still disagree by 0.58 stops, so at least one
NON-ISO scene factor coexists. Cheap decisive follow-up: export these ARWs
as DNG through LR (the plugin can batch this) or Adobe DNG Converter and
read the `BaselineExposure` tag directly — if it tracks the per-scene gap,
the "adaptive" luma component collapses into a static curve + a per-ISO
metadata term that silverbox can honor exactly.

## CORRECTION (round-1 DCP experiment, same day — supersedes the headline number)

The pooled "+0.66 stops LR-brighter" headline above is **~85% a measurement-
harness artifact**: the render script behind this report's silverbox exports
forced `baselineExposureEV = 0` (borrowed from verify-localtone.mjs's
convention), while the SHIPPED default is 0.5 and `A7C2_BASE_CURVE` was fit
assuming that 0.5 EV is applied at decode (see scripts/fit-base-curve.mjs's
DEFAULT_EV). Re-measured with the shipped default:

| config | pooled mean Δluma (LR−sb) | mean hue err | chroma ratio |
|---|---|---|---|
| harness as in this report (EV=0) | +0.633 | 16.2° | 0.885 |
| shipped default (EV=0.5) | **+0.088** | 18.4° | 0.975 |
| + Adobe Standard DCP applied | −0.119 | 16.3° | 1.080 |

What SURVIVES the correction: the scene-adaptive tone residual (best static
curve still leaves **0.506 stops RMS**, ≈ the 0.49 reported above) and the
ISO correlation (r=0.755, 0.886 excluding the 2 WB-confounded scenes) — the
per-ISO BaselineExposure hypothesis stands. Also unchanged: the WB
divergence on DSC03298/DSC07349 (upstream of profiles, in WB-gain
derivation) and the profile-table color gap.

DCP round-1 findings: the local "Sony ILCE-7CM2 Adobe Standard.dcp" is
TONE-LESS (ForwardMatrix1/2 + HueSatMap 90×30×1 + LookTable 36×8×16, no
ProfileToneCurve, baselineExposureOffset 0) — so DCP application cannot
close the tone axis at all, and on color it is a wash because LR's actual
default is **Adobe Color** = Adobe Standard + a ~106KB `crs:LookTable`
blob in an XMP Look preset (custom Base85-family encoding, ordinals 33–125,
not standard ASCII85; undocumented; not yet decoded).

**Second correction (same day, empirical):** the paragraph originally here
claimed the localtone delta-over-own-base calibration was EV-shift-invariant.
Re-rendering the 20 localtone band measurements at the shipped EV=0.5
FALSIFIED that: 15/20 band ratios moved >0.05 (max 0.17), because the EV
shift passes through the NONLINEAR A7C2 base curve before the localtone
stats are taken — the post-curve histogram (percentile anchors, std
amplitude stat) is not invariant. Net effect on the stage-1e merge gate:
18/20 → 17/20 in [0.7,1.43]; DSC09305 degrades from a shadows-only outlier
(0.55) to 3-of-4 configs out/edge (sh 0.38/0.38, hi−80 0.66). Stage-1e's
amplitude constants were fit against EV=0 renders and need a refit against
shipped-default renders before any merge decision.

## Round-2 attribution (same day, evening): WB verdict + Adobe Color decoded

**WB-gain derivation is CORRECT** — silverbox's cam_mul-derived as-shot
(temp/tint) tracks LR's own resolved As-Shot within 49–124K / 4–7 tint on
the probed scenes, and the three Daylight-preset scenes (06787/07349/09305)
carry bit-identical WB_RGGBLevels → identical silverbox WB, yet only 07349
diverges. The real, confirmed structural bug is the COLOR MATRIX: libraw's
cam_xyz is exactly Adobe's ColorMatrix2 (D65) to float32 precision, used
unconditionally, while Adobe mired-interpolates ColorMatrix1 (StdA,
tungsten) ↔ ColorMatrix2 by shot CCT. At DSC03298's 4100K Adobe weights
D65 only 0.541 — silverbox's forced 1.0 is a large matrix error and the
best-supported cause of that scene's cast (the user's "bridge
brightness/saturation" observation). DSC07349's divergence is NOT
explained by WB or matrix interpolation (fraction ≈ its clean siblings);
leading suspect is profileFit.ts's 3-scene lattice (which was trained ON
this scene) mishandling saturated sunset hues — the Adobe-look route below
supersedes that lattice anyway.

**Adobe Color's LookTable is now fully decodable** (proof: MD5 fingerprint
match + bit-exact re-encode): ACR XMP `crs:Table_<md5>` = DNG SDK
dng_big_table encoding — Z85-variant base85 (custom 85-char alphabet,
little-endian digit order), zlib, then a documented DNG stream
(hueDiv×satDiv×valDiv × 3×float32 HueShift/SatScale/ValScale; Adobe Color
= 36×16×16, encoding Linear). Full look = Adobe Standard DCP (on disk,
per camera) + this table + crs:ToneCurvePV2012. Legal line: reimplement
the decoder from these facts (no DNG SDK code), read the USER'S LOCAL ACR
files at runtime, never commit Adobe table data (tests self-verify via the
embedded MD5). No OSS tool decodes these today (exiftool/darktable/
RawTherapee/dcamprof checked).

**Remediation plan (stage base-2, pending GO):** (1) dual-illuminant
color-matrix interpolation in whiteBalance.ts, matrices runtime-read from
the local Adobe Standard DCP with graceful fallback to libraw's single
matrix; (2) "local Adobe look" profile mode: dng_big_table decoder +
LookTable stage on the existing DCP pipeline + the PV2012 look tone curve,
sourced from the user's ACR install; (3) per-ISO BaselineExposure probe
via LR-plugin DNG export (still the open tone-axis item).

## Round-3 probe: per-ISO BaselineExposure hypothesis REFUTED

LR-plugin DNG export of the 5 ARWs (plugin v2.1.1; v2.1 lesson: extra
LR_DNG_* option keys make every rendition fail SILENTLY — use LR defaults
and iterate rendition:waitForRender so failures are logged): Adobe's
effective BaselineExposure is **0.35 EV, constant across ISO 200–1000**.
The ISO-correlated scene-adaptive tone gap (r=0.755–0.886) therefore has a
DIFFERENT cause — ISO was confounded with something else in these 5 scenes
(plausibly scene brightness/statistics; n=5 cannot separate them). Two
usable facts: (1) silverbox's shipped baselineExposureEV=0.5 vs Adobe's
0.35 is a small static −0.15 EV correction candidate for a future base
refit; (2) the remaining ~0.5-stop RMS scene-adaptive tone component now
points toward LR's PV2012 base being genuinely scene-adaptive (an E6-like
statistics-driven layer active at flat settings) — approximating it would
reuse the scene-statistics machinery localtone already has, but that is a
design decision, not a measurement, and needs its own probe (e.g. one
scene rendered at synthetically varied exposure offsets through LR).
DNGs + log at ~/../lr-calib/lr-dng-20260903/ (outside repo).

**Clarification (consistency audit):** the "−0.15 EV static candidate" above
is NOT a standalone fix — applying it alone would WORSEN the pooled gap to
~+0.24 stops, because A7C2_BASE_CURVE was fit assuming EV 0.5 and has
absorbed the offset. It is a convention-alignment item meaningful only
inside a joint (EV 0.35 + curve) refit. Sanity arithmetic that closes: the
EV=0 vs EV=0.5 pooled gap difference is 0.545 stops vs the 0.500 applied —
the 0.045 excess is the nonlinear base curve acting on the shifted input,
the same nonlinearity that forced the localtone 1e-r refit.

## Data appendix (values from the round-2/3 agent analyses, previously only in session reports)

**Adobe D65-interpolation weights** (mired fraction toward ColorMatrix2/D65
at each scene's LR-resolved As-Shot temperature; silverbox uses 1.0 always):
DSC03298 4100K → **0.541**; DSC06787/DSC09305 5137K → **0.792**;
DSC07349 5250K → **0.813**. (The near-identical 0.792 vs 0.813 is what
rules matrix interpolation OUT as DSC07349's differentiator.)

**Adobe Color LookTable sample entries** (decoded 36×16×16 table, entries
are (HueShift°, SatScale, ValScale); v=8 slice, s=15 max-sat column):
h=0 red (3.331, 0.9938, 0.5427); h=3 orange (8.626, 0.9967, 0.6590);
h=6 yellow (−0.339, 0.9982, 0.7567); h=21 sky (0.183, 0.9984, 0.9758);
h=33 magenta (1.765, 0.9511, 0.5954). ValScale along V for red@s15:
v=0 → 1.000, v=8 → 0.543, v=15 → 0.296. Global ranges: HueShift −180…170°,
SatScale 0…1.060, ValScale 0.296…1.083. (Sample facts recorded for
calibration reasoning; the full table itself is Adobe's and stays out of
the repo — these few coordinates are measurement observations.)

**Per-DNG BaselineExposure readings** (plugin v2.1.1 exports, exiftool):
DSC03298 ISO 320 → 0.35; DSC04260 ISO 500 → 0.35; DSC06787 ISO 200 → 0.35;
DSC07349 ISO 200 → 0.35; DSC09305 ISO 1000 → 0.35.

## Stage base-3: diagnosis of the acrlook/dcp DSC03298 regression

Trigger: stage base-2's own landing note attributed DSC03298's near-neutral
regression (silverbox R/G 1.34→1.90 across builtin→acrlook) to "dcp/
pipeline.ts's Stage-1 simplifications: no CameraCalibration/AnalogBalance
composition" — flagged UNVERIFIED. This pass built a fresh LR-DNG-tag
extraction (Adobe's own `lr-dng-20260903` per-shot DNG conversions,
exiftool) and a from-scratch camera→XYZ→display reference to test that
attribution predictively, per the conductor's diagnose-before-code brief.

### DNG-tag facts (all 5 scenes; `lr-dng-20260903/*.dng`, exiftool)

CameraCalibration1/2 = `1.0037 0 0 / 0 1 0 / 0 0 0.9744` (diagonal,
IDENTICAL across all 5 scenes — a per-camera-model constant, not per-shot).
AnalogBalance = `1 1 1` (true identity) on all 5. ColorMatrix1/2,
ForwardMatrix1/2, CalibrationIlluminant1/2 (17=StdA, 21=D65),
ProfileHueSatMapDims (90×30×1) are also identical across all 5 (profile-
level, as expected). BaselineExposure = 0.35 on all 5 (matches round-3's
earlier finding).

**Decisive fact: the LOCALLY-INSTALLED "Sony ILCE-7CM2 Adobe Standard.dcp"
itself carries NEITHER CameraCalibration1/2 NOR AnalogBalance tags at all**
(verified via `exiftool -a -G1 -s -n` on the .dcp directly — only
ColorMatrix1/2, ForwardMatrix1/2, CalibrationIlluminant1/2,
ProfileHueSatMapDims/ProfileLookTableDims are present; `parser.ts` also
never attempted to parse either tag, matching dcp-profile.md's "explicitly
deferred" note). **The stage-base-2 attribution COLLAPSES**: the non-
identity CameraCalibration seen in Adobe's DNG conversions is NOT sourced
from the profile file our pipeline reads — it is data ACR bakes into every
DNG conversion for this camera model from somewhere else entirely (likely
an Adobe-internal per-model correction not exposed by any locally-installed
file), so "parse CameraCalibration from the DCP" would be a no-op fix: there
is nothing to parse. Its magnitude is also small (≤2.6% diagonal) — even
applied as a hardcoded constant (which would cross dcp-profile.md's own
legal line: reading the user's OWN LR-exported DNGs at runtime is not
something the shipped app can rely on, and hardcoding a number derived from
them is closer to "distributing Adobe's derived calibration data" than
"reading a locally-installed file") it would not have been large enough to
explain the measured regression.

### WB gain and illuminant-fraction validation (both essentially exact)

Dumped `image.color` (camMul/camXyz/rgbCam) for all 5 scenes via a new
`__debug.imageColorForVerify()` hook (CanvasView.tsx — kept; harmless,
additive, test/diagnostic-only surface). `camMul` (libraw's as-shot
multiplier) reciprocal matches each DNG's own `AsShotNeutral` to 4+
significant digits on every scene (e.g. DSC03298: camMul R/G,B/G =
1.92578/1.81738 vs 1/AsShotNeutral = 1.92578/1.81741) — round-2's "WB
derivation is correct" finding is reconfirmed, more precisely: this is
bit-level agreement, not just "within 49-124K", for the reciprocal-neutral
itself. Feeding that camMul through the engine's own Planckian-locus CCT
estimator and `illuminantFraction` gives fractions within ~3% of the
values recorded in this doc's round-2 data appendix (DSC03298: computed
0.526 vs recorded 0.541 at ~4051K vs ~4100K; DSC06787/09305: computed
0.7895 vs recorded 0.792 at ~5126K vs ~5137K). **Both WB gain and
illuminant-interpolation fraction are essentially correct for DSC03298** —
neither explains a regression as large as the one measured.

### fix① re-examined: structurally inapplicable to dcp/acrlook, and its
### builtin-mode test was confounded by profile-fit overfitting

`computeWbColorMatrixCorrection` was re-run numerically against DSC03298's
reconstructed near-neutral camera pixel: it moves the result FURTHER from
LR's target (reproducing the DORMANT-fix's own doc-comment finding). But
`wbCorrection.ts`'s own doc comment already establishes fix① ONLY feeds the
`builtin` profile source (dcp/acrlook already do their own full illuminant-
interpolated reconstruction via ForwardMatrix — applying fix① there would
double-transform); it CANNOT be "woken" for dcp/acrlook at all, by design.
Separately: DSC03298 is one of only 3 scenes `profileFit.ts`'s builtin
lattice was fit on (this doc's own "Data" section, months earlier) — so
testing fix① against builtin-mode DSC03298 tests it against a scene the
STATISTICAL LATTICE has already memorized its own ad-hoc compensation for;
a regression there does not generalize evidence against fix①'s formula.
Net: fix① stays dormant — correctly, but for a different combination of
reasons than the current dormant-doc-comment states (not "wait for
CameraCalibration composition", which is a dead end; rather "inapplicable
to the modes this task targets, and its one negative data point is
confounded"). Doc comment left AS IS pending a cleaner, held-out re-test if
anyone revisits builtin-mode's own tone/color gap later — out of scope here.

### The real mechanism: ProfileHueSatMap/LookTable is numerically unstable on
### DSC03298's abundant DARK near-neutral content, but the shipped lattice
### can't be fixed by damping inside `renderDcpPixel`

Stage-by-stage ablation (bundled `pipeline.ts`, DSC03298's own near-neutral
pixel mean, reconstructed camera-native → XYZ D50 → ProPhoto): reconstruction
+ ForwardMatrix ALONE lands close to LR's target (R/G 0.71 vs LR 0.72, B/G
1.65 vs LR 1.52 — within ~2-8%). Applying the DCP's OWN ProfileHueSatMap on
top moves it sharply AWAY (R/G 0.41, B/G 2.13) — LookTable and the ACR Look
table add little more. The pixel's HSV reading at that point is h≈235°
(blue), s≈0.40 (NOT near-zero) at v≈0.005 — a genuinely dark camera-native
value where plain HSV saturation is well known to be numerically unstable
(tiny absolute R/G/B differences → large relative hue/sat swings), and
DSC03298 (a shadowed stone bridge) has an unusually large fraction of its
frame reading as both dark AND near-neutral (46.5% of pixels at Lab
C*<6 in the 2048px LR export) — exposing this instability far more than
the other 4, generally brighter, scenes.

A candidate fix (damp the HueSatMap/LookTable hue/sat/val correction toward
identity as V→0, named constant `HUESAT_STABILITY_V_FLOOR`) was implemented
in `renderDcpPixel` and its own golden-math check in verify-dcp.mjs, and
DID reproduce the ablation's improvement when tested pixel-by-pixel in
isolation. **It was then reverted** after full-pipeline validation showed
it barely moves the real, shipped render at all (acrlook DSC03298 R/G
0.414→0.409, B/G 1.918→1.993 — net negligibly different, B/G slightly
WORSE): `bakeDcpLattice` bakes the DCP into `profileFit.ts`'s shared,
UNIFORM N³=17³ residual lattice (node spacing 1/16≈0.0625 in working-space
RGB), sampled by GPU/CPU trilinear interpolation — `renderDcpPixel` is only
ever EVALUATED at the 17 discrete grid nodes along each axis, not at real
pixels. Probed directly: the grey-diagonal's node 0 is (working=0, trivial
zero-correction) and node 1 is ALREADY at v≈0.0625 in ProPhoto terms — above
any reasonable near-black damping floor, so damping barely engages even
though real near-neutral pixels in this scene have v as low as 0.001-0.009
(median 0.0039; 99.7% below 0.05). The lattice's own trilinear blend toward
node 0 already provides SOME attenuation purely from working-space
proximity, unrelated to my per-node damping logic, and that geometry-driven
attenuation is what's actually visible in the real render — my damping code
was inert for the pixels that matter. A genuine fix needs either a denser
lattice near black (touches `PROFILE_LATTICE_N`/the shared trilinear
sampler builtin mode also rides — bigger blast radius) or moving the
correction outside the baked lattice entirely (touches the shared
`PROFILE_WGSL`/`profileResidual` CPU/GPU pair) — both real projects, out of
this diagnostic pass's scope. **This is the actionable lead for the next
implementer**, not the collapsed CameraCalibration attribution.

### Corrected 5-scene re-measurement (current shipped code, no engine
### changes landed this pass — methodology below)

Near-neutral proxy corrected from stage base-2's own (unrecovered) ad hoc
script: mask built from Lightroom's OWN base JPEG (`lr-sweep-20260901/base/
<scene>.jpg` — confirmed via XMP: WhiteBalance=As Shot, LookName=Adobe
Color, Exposure2012=0.00, matching this doc's original "Data" section
exactly) at Lab C*<6, THEN sampled at those same pixel coordinates in each
of our own CLI renders (resized to LR's own 1365×2048 dims) — masking an
image against its OWN C* is circular (trivially ≈1) and was step base-2's
likely mistake; this is the non-circular form the original report's whole-
frame methodology implies. Geometry sanity (zero-shift NCC, builtin luma vs
LR luma): 0.93-0.96 on 4/5 scenes; DSC09305 is low (0.67) — its own numbers
below are lower-confidence.

| scene | mode | R/G | B/G | LR target R/G | LR target B/G |
|---|---|---|---|---|---|
| DSC03298 | builtin | 0.679 | 2.227 | 0.723 | 1.518 |
| DSC03298 | dcp | 0.443 | 1.777 | 0.723 | 1.518 |
| DSC03298 | acrlook | 0.414 | 1.918 | 0.723 | 1.518 |
| DSC04260 | builtin/dcp/acrlook | 1.02/1.00/1.00 | 0.93/0.95/0.95 | 0.984 | 1.000 |
| DSC06787 | builtin/dcp/acrlook | 1.02/1.02/1.02 | 1.02/1.03/1.02 | 1.017 | 1.019 |
| DSC07349 | builtin/dcp/acrlook | 1.37/1.28/1.33 | 0.74/0.77/0.75 | 0.982 | 1.013 |
| DSC09305† | builtin/dcp/acrlook | 1.08/1.05/1.06 | 0.91/0.92/0.92 | 1.045 | 0.969 |

† low-NCC scene, lower confidence.

DSC03298 (this task's target scene): every mode is far outside the ~10%
acceptance band on at least one axis (builtin B/G +47%, dcp R/G -39%,
acrlook R/G -43%/B/G +26%) — none is close to clean, and acrlook is not
better than builtin here. DSC07349 independently regresses ~30-40% on R/G
in ALL THREE modes (a pre-existing, still-unresolved finding per round-2 —
untouched by this pass). DSC04260/06787 stay clean (within ~5%) as before.
**Table is NOT clean — the CONDUCTOR HOLD stays in place** (appStore.ts,
~line 4611, comment updated to reflect this pass's corrected findings
rather than the collapsed CameraCalibration attribution).

### Gates

typecheck (tsc, both projects) clean; `npm run test:unit` 357/357 passed;
verify:acrlook, verify:dcp, verify:dcp-doubletone, verify:golden, verify:
develop all "all checks passed" — all run AFTER reverting the ineffective
pipeline.ts change, so these reflect the actual shipped (unchanged) engine.
Only change landed this pass: `CanvasView.tsx`'s `imageColorForVerify()`
debug hook (additive, test-surface only).

## Round-4 probe (2026-09-03): is PV2012 BASE itself scene-adaptive? — REFUTED on the tested axis

Analysis-only probe, no repo/engine changes. Scripts, JSON and 2 plots in
`scratchpad/adaptive-base/` (this session's scratchpad; `common.py` +
`step1`-`step5`, same sRGB-decode conventions as `scratchpad/base-gap/`).
Targets the last unexplained component flagged above: the round-3 probe's
speculation that the residual ~0.5-stop RMS scene-adaptive tone gap (§2 of
the original report) means "LR's PV2012 base being genuinely scene-adaptive
(an E6-like statistics-driven layer active at flat settings)".

### Method

New data: LR default-develop (sliders 0) **and** LR Exposure=+1 renders of
the SAME 5 scenes (`~/Desktop/FFF/lr-calib/lr-sweep-20260901/{base,ev_p1}`,
sRGB JPEG, long edge 2048 — both LR's own output, no silverbox involved).

**Key idea**: if LR's base tone mapping is one fixed monotonic curve `C`
applied to scene-referred linear light, and Exposure is a PRE-curve linear
gain (Adobe's documented Exposure2012 behavior), then `base = C(L)` and
`ev1 = C(2L)`, so `ev1 = C(2 · C⁻¹(base))`. Define `D(x) := C(2·C⁻¹(x))` —
a function of the OBSERVED base-pixel value alone, no need to know `L` or
invert `C` explicitly, **as long as `C` is static (shared across scenes)**.
So: if `C` is static, `delta(x) := D(x) − x` is ONE curve shared by all 5
scenes; if `C` (or something upstream/inside it) is scene-adaptive, `delta`
diverges scene-to-scene. Exact same falsifiable structure as the original
report's §2 static-vs-adaptive test, applied here to LR-base → LR-ev1
(single software, single slider) instead of silverbox-base → LR-base
(cross-renderer, multi-factor).

Per scene: decode both renders to linear Rec.709 log2-luma, exclude
either-side-clipped pixels (any channel ≥ 252/255), bin `delta` by `base`
luma (48 bins, ≥200px/bin, `step2_delta_curve.py`).

**Sanity-checking the Exposure2012-is-pre-curve-gain assumption**: if
Exposure were instead a POST-curve (output-domain) gain, `delta` would be
trivially flat at +1.0 everywhere regardless of `C`'s shape. It is not (see
below — it ranges 0.2 to 1.85 stops) — this by itself rules out a
post-curve-gain model and is consistent with Adobe's documented pre-curve
placement.

### Geometry — PASS

Zero-shift NCC (log2-luma, 8× downsample) 0.988–0.992 on all 5 scenes,
exact dims match — expected, since Exposure alone doesn't move geometry
(`step1_geometry.py`).

### Headline finding: near-perfect cross-scene collapse on the ABSOLUTE luma axis

`plot1_delta_overlay.png`: all 5 scenes' `delta(base_stops)` curves trace
the same shape almost exactly across the whole well-populated range (noisy
scatter only below ≈−9 stops, where 8-bit JPEG quantization dominates on
both sides — same caveat as the original report). The shape itself is
**not** flat — real curvature, consistent with a genuine tone-curve
toe/shoulder: rises from ≈1.05–1.15 stops around −9.5 stops, peaks at
**≈1.79 stops around −6.9 stops** (i.e. one stop of scene-linear gain there
moves LR's output by ~1.8 stops — a lifted-toe/shadow-contrast region),
then falls steadily through the midtones, crossing 1.0 stop around −1.9
stops, down to **≈0.21 stops at −0.15 stops** (strong highlight
compression, as expected approaching the white point).

Mirroring the original report's `step2b` method exactly (n-weighted global
fit per bin + per-scene residual, `step4_static_test.py`, well-populated
range −7.85..−0.95 stops where all 5 scenes have data):

| scene | mean resid | RMS resid | range |
|---|---|---|---|
| DSC03298 | −0.033 | 0.060 | [−0.166, +0.030] |
| DSC04260 | −0.016 | 0.045 | [−0.120, +0.028] |
| DSC06787 | +0.055 | 0.060 | [+0.018, +0.101] |
| DSC07349 | −0.018 | 0.032 | [−0.072, +0.039] |
| DSC09305 | +0.017 | 0.028 | [−0.003, +0.084] |

**Overall RMS residual after the best possible single static curve: 0.047
stops** — about **10× smaller** than the original report's 0.49–0.506-stop
irreducible residual for the silverbox-vs-LR-base static-curve test, and
close to the 8-bit-JPEG-quantization noise floor the original report
already flagged for deep-shadow bins. For reference, the deviation from a
FLAT delta=+1.0 (the naive prediction) over the same range is **mean +0.431,
RMS 0.522 stops** — i.e. the curve has ~10× more real shape-structure than
it has scene-to-scene divergence. In plain terms: **LR's response to the
Exposure slider has a large, real, non-trivial shape (a genuine tone
curve), but that shape is essentially the SAME for every scene tested.**

No correlation of the (tiny) per-scene residual with ISO (r = −0.06, n=5),
frame log2-luma std (r = −0.18 for mean residual, +0.52 for RMS residual —
weak/noisy either way), or frame mean (r = +0.72, but the residual
magnitude itself is inside the quantization-noise band, so this is not
treated as a real effect) — consistent with the residual being measurement
noise rather than a signal.

### Collapse analysis: rules out a hidden percentile-relative (H/S-like) term

The brief's specific alternative hypothesis — a hidden Shadows/Highlights-
style percentile-relative adaptive term baked into the "flat" base curve
(mirroring silverbox's own `localToneNode.ts` scene-adaptive amplitude law,
which keys off frame log2-luma std and p25/p75 percentile anchors) — was
tested directly (`step3_collapse.py`): re-bin `delta` against
`base_stops − anchor` for anchor ∈ {mean, p50, p75, p25} of each scene's
own frame stats, and compare cross-scene collapse quality (n-weighted RMS
std across scenes at matched relative-x) against the absolute-x baseline.

| anchor | n-weighted RMS cross-scene std (stops) |
|---|---|
| **absolute (no shift)** | **0.046** |
| frame mean | 0.217 |
| frame p50 (median) | 0.283 |
| frame p75 | 0.255 |
| frame p25 | 0.224 |

Every frame-relative anchor makes the collapse **worse**, not better
(`plot2_collapse_by_anchor.png`) — the opposite of the H/S-like-term
signature (which would collapse better under a percentile-relative axis,
since that mechanism is by construction invariant to a uniform stop shift
of the whole frame). This is direct evidence the measured curve shape is
the ordinary static parametric tone curve, not a disguised frame-adaptive
Shadows/Highlights-style layer.

### Verdict

**REFUTED, moderate-high confidence, on the specific axis this probe can
test**: LR's response to the Exposure slider (equivalently, the shape of
its base tone-mapping curve `C`, as isolated via the doubling relationship)
shows **no material scene-adaptive component** — residual RMS 0.047 stops,
an order of magnitude below both the original 0.49-stop gap and the ISO-
correlation slope (0.35 stops/stop) found earlier in this document. The
round-3 probe's "E6-like statistics-driven layer" speculation is not
supported by this direct test.

**Important scope limitation** (why this doesn't fully close the question):
this design can only detect scene-adaptivity in the RESPONSE TO the
Exposure slider — i.e. whether `C`'s shape/relative behavior varies by
scene. It CANNOT detect a hidden per-scene constant DC-level term (e.g. an
auto-exposure-like brightness normalization baked into what "0 EV" means
for a given scene) that would apply identically regardless of the Exposure
slider's position, because such a term would appear in BOTH the base and
ev1 renders and cancel out of `delta` by construction. (A back-of-envelope
check: since the measured `delta(x)` curve has real slope away from 1 in
most of its range, a per-scene DC shift `δ` would show up as a combined
horizontal+vertical displacement of that scene's curve in the collapse
test above — and no such displacement is observed, which bounds `δ` for
these 5 scenes to something small relative to the curve's own slope, but
does not rule out a small one, and the falling right-hand segment near
the white point — where the curve is steepest, hence most diagnostic for a
DC-shift test — has the fewest well-populated bins.) That DC-normalization
hypothesis remains the live candidate for the original 0.49-stop residual
and the ISO correlation, and needs the follow-up already proposed in the
round-3 probe: one scene rendered at synthetically varied exposure offsets
through LR, so the SAME frame content sits at deliberately different
absolute brightness while any hidden normalization term is forced to
reveal itself.

### Implications for silverbox

1. **The original static-curve-fit gap (§2, 0.49–0.506 stops RMS) is now
   better explained as a fit-quality problem, not a hidden adaptive
   mechanism.** `A7C2_BASE_CURVE` was fit from ONE scene; this probe shows
   Adobe's actual curve has substantial shape (up to ~1.8 stops of local
   gain near the toe, compressing to ~0.2 near the shoulder) that a
   single-scene fit is unlikely to capture faithfully across the full
   working range. Re-prioritizes Option 1 (multi-scene base-curve refit)
   from "cheapest, partial fix" to "cheapest, LIKELY-COMPLETE fix for the
   luma axis" — the scene-adaptive floor this document worried about
   appears not to exist (on the Exposure-response axis).
2. **A useful, reusable byproduct**: `delta(base_stops)`, being
   scene-independent to within ~0.05 stops, is effectively a direct,
   multi-scene-averaged measurement of `C`'s own local log-log slope (to
   first order, `delta(x) ≈` the local derivative of `C` in stops-per-stop
   at output level `x`, since it is exactly `C`'s response to a 1-stop
   input doubling). This is a cheap, non-LR-interactive way to VALIDATE or
   directly inform a refit of `A7C2_BASE_CURVE`'s shape (particularly its
   toe and shoulder steepness) without needing new LR exports beyond what
   already exists in `~/Desktop/FFF/lr-calib/lr-sweep-20260901/`.
3. **Do not build a "hidden always-on H/S layer" into the base curve** —
   the collapse analysis actively argues against that architecture for
   whatever gap remains; the percentile-relative machinery silverbox
   already has (`localToneNode.ts`) should stay scoped to the explicit
   Shadows/Highlights sliders, not be pressed into modeling the base gap.
4. **Next step, if pursued**: the DC-normalization hypothesis above is the
   most promising remaining lead for the ISO correlation / residual base
   gap. Cheapest test: reuse the existing 5-scene LR sweep infrastructure
   (`SilverboxAutoProbe.lrplugin`, already proven in this session) to
   render ONE scene at several synthetic exposure offsets (e.g. via a
   pre-scaled duplicate DNG, or LR's own Exposure slider swept across a
   wide range while watching for any DEVIATION from the now-confirmed
   static `C`) — if `C` stays static even under large synthetic brightness
   swings of the same content, the DC-normalization hypothesis is
   effectively closed too and the remaining gap must be attributed
   elsewhere (most likely: fit quality, per finding 1 above).

## Stage base-6: DSC07349 (sunset) color divergence — diagnosed, root cause
## upstream of every in-scope surface; STOPPED per brief, no fix landed

Trigger: DSC07349 is the last unexplained per-scene color gap (round-2's own
close: "leading suspect is profileFit.ts's 3-scene lattice... the Adobe-look
route below supersedes that lattice anyway" — never actually re-tested after
the acrlook/DCP route landed). This pass re-diagnosed from scratch per the
conductor's brief, following base-3/4's ablate.mjs / measure-neutral.mjs
idioms, working scenes reused from those passes (`test-assets/italy/`,
`~/Desktop/FFF/lr-calib/lr-sweep-20260901/base/`). No repo/engine changes
were made; scripts, JSON, and JPEG previews are in this session's own
scratchpad (`base6-diag/`), outside the repo, matching precedent. HEAD stayed
at `6204e3c` (tree clean) throughout — verified with `git status`/`git
rev-parse HEAD` after every step.

### 1. Where is the neutral (Lab C\*<6) mask? — NOT the visible sky at all

Rendered the mask as a red overlay on LR's own base JPEG
(`base6-diag/mask-overlay.mjs`, `base6-diag/DSC07349-mask-overlay-small.jpg`):
230,824/2,795,520 px (8.26%, matching the brief's known fact), **centroid
normalized y=0.791, bbox y∈[763,1364] of 1365 — every masked pixel sits in
the BOTTOM 44% of the frame** (row-band histogram: 0% in the top half, rising
from 9.1% at the 50–60% band to 21.5% at 90–100%). Mean L\* of masked pixels:
**28.06** (dark). Visually the mask traces two things: the dark sea surface
(the whole width, near the bottom), and a narrow arc running through the
sky's blue→orange twilight transition band near the horizon — genuinely
near-neutral in Lab terms (two complementary hues meeting), not a gray card.
**The mask has ZERO overlap with the deep saturated blue sky in the upper
frame** — the actual visible symptom the user reported ("LR's rich blue
sunset sky renders purple-gray/desaturated"). This is real and important:
the neutral-ratio metric this scene has been tracked by since round-2 is
measuring the wrong region for the user-visible complaint. It does **not**,
however, mean the neutral number is pure noise (see §4) — the underlying
color error turns out to be the same mechanism in both places.

### 2. Stage ablation (base3-diag/ablate.mjs idiom, fresh bundle — base-4's
### `HUESAT_STABILITY_V_FLOOR` damping included)

Rebuilt `base6-diag/bundle.mjs` from current `HEAD` (not resurrected from an
old session) via esbuild, then ran a bypass (identity-graph) render of
DSC07349, averaged the near-neutral mask over that raw decode+WB pixel, and
pushed the averaged camera-native value through the actual bundled
`renderDcpPixel` stage-by-stage (`base6-diag/ablate.mjs`):

| stage | R/G (display sRGB primaries) | B/G |
|---|---|---|
| **LR target** | **0.982** | **1.013** |
| [A] decode+WB only, no DCP | 1.395 | 0.736 |
| [B] +ForwardMatrix only | 1.252 | 0.841 |
| [C] +HueSatMap | 1.361 | 0.784 |
| [D] +LookTable (="dcp" mode) | 1.327 | 0.804 |
| [E] +ACR Look table+PV2012 (="acrlook" mode) | 1.399 | 0.781 |

**The divergence is already ~40%/~27% off target at Stage A — before any DCP
code runs at all.** ForwardMatrix (B) is the only stage that moves the
result meaningfully toward target (R/G 1.395→1.252); HueSatMap (C) moves it
back AWAY; LookTable (D) and the ACR Look table (E) barely move it net. No
stage gets within even 25% of target on either axis. This reproduces (and
sharpens) `pipeline.ts`'s own doc comment: base-4's V-floor damping "stayed
in the same ~15-20% broken ballpark throughout, never chased" for this
scene — confirmed here to be structurally correct, since the error precedes
the table stages entirely.

**Illuminant-interpolation-input sensitivity (candidate a), quantified and
killed:** re-ran stage D at the shot's own estimated 5126 K vs LR's
independently-resolved 5250 K (both from the brief's "known facts"):
R/G 1.3270→1.3248, B/G 0.80393→0.80395 — **a ~0.2% effect**, three orders of
magnitude too small to explain a 30-40% ratio error. `illuminantFraction`
itself is nearly identical at the two temperatures for this DCP's
calibration-illuminant pair (0.813 vs ~0.81), matching the brief's own
0.792-vs-0.813 sibling-scene note. **Candidate (a) is refuted.**

### 3. The visible deliverable: sky-region hue/sat/luma vs LR, per mode

Rendered real builtin/dcp/acrlook exports via the interactive app
(`base6-diag/render-and-measure.mjs`, same Playwright idiom as
base4-diag/measure-neutral.mjs) and measured the upper-35%-of-frame,
LR-hue-in-blue-sector (180–300°), C\*>8 region — the actual sky, disjoint
from the neutral mask:

| mode | ΔHue (deg) | chroma ratio (ours/LR) | ΔL\* |
|---|---|---|---|
| builtin | +3.4 | **0.587** | +3.9 |
| dcp | −2.2 | **0.449** | +4.6 |
| acrlook | −0.3 | **0.547** | +2.3 |

**Hue is essentially correct in every mode (≤3.4° off) — this is NOT a hue
rotation.** The user-visible "desaturated/purple-gray" symptom is a real,
large **chroma deficit (45–59% of LR's saturation)** plus a **small but
consistent brightness lift (+2.3 to +4.6 L\*)** — a genuine "washed out"
look, matching the report exactly.

Stage-ablated the SAME sky region through `renderDcpPixel`
(`base6-diag/ablate-sky.mjs`) to test candidate (c) directly:

| stage | Lab hue | Lab chroma |
|---|---|---|
| **LR target** | **268.2°** | **24.79** |
| [A] decode+WB only | 271.7° | 9.96 (40% of target) |
| [B] +ForwardMatrix | 269.7° | 6.03 (24% of target) |
| [C] +HueSatMap | 268.9° | 7.05 |
| [D] +LookTable (dcp) | 269.2° | 7.07 |
| [E] +ACR Look (acrlook) | 269.6° | 7.62 |

Hue is within ~3.5° of target at **every** stage, including [A] with zero
DCP code involved. The desaturation is **already 60% closed the wrong way at
Stage A** (before any table), and **[B]'s ForwardMatrix stage makes it
WORSE**, not better (chroma 9.96→6.03); the HueSatMap/LookTable/ACR-look
stages (C–E) each nudge chroma back UP slightly (6.03→7.62), the opposite
direction a "table over-desaturates saturated sunset hues" bug would
predict. **Candidate (c), hue-dependent table application, is refuted** —
the tables are mildly *helping*, not hurting.

Decomposing stage-A's working-space RGB directly: ours = [R 0.0153,
G 0.0187, B **0.0314**] vs LR's own sRGB average mapped into the same
working primaries = [R 0.0145, G 0.0307, B **0.0825**]. **R matches LR
almost exactly (+5%); G is 61% of target; B is only 38% of target** — the
sky is under-blued specifically, not uniformly scaled. This is the same
direction/shape as the neutral-mask finding below (R relatively too high, B
relatively too low vs G), consistent with ONE shared root-cause mechanism
rather than two independent bugs.

### 4. L\*-binned breakdown of the neutral mask — kills the near-black
### hue-instability explanation, confirms a real, broad color cast

Binned the SAME neutral mask by LR's own L\* (`base6-diag/lbin-analysis.mjs`)
to test whether the divergence concentrates in the very darkest pixels (the
DSC03298-style near-black HSV instability base-3/4 diagnosed and fixed) or
spans the whole tonal range (a genuine, broad color-cast bug):

| L\* bin | % of mask | our R/G err (builtin/dcp/acrlook) | our B/G err | our hue (all 3 modes) | LR's own hue |
|---|---|---|---|---|---|
| [15,20) | 1.9% | +34/+29/+38% | −20/−17/−21% | 62–64° | 251° |
| [20,25) | 16.2% | +27/+23/+27% | −18/−15/−19% | 62–66° | 257° |
| [25,30) | 23.1% | +22/+18/+18% | −17/−14/−17% | 63–70° | 271° |
| [30,40) | 20.2% | +18/+16/+14% | −16/−13/−13% | 65–69° | 67° |
| [40,60) | 12.6% | +20/+19/+19% | −16/−14/−14% | 69–71° | 180° |
| [60,100) | 6.4% | +14/+14/+11% | −17/−14/−14% | 71–76° | 30° |

(the darkest bin, L\*<10, 19.5% of the mask, behaves qualitatively
differently — see below.)

Across **every bin from L\*15 to L\*100 — 80% of the mask, spanning deep
shadow through highlight** — our render lands on a **remarkably stable
~62–76° (orange) hue in all three modes**, while LR's own hue at the same
coordinates is scattered/noisy (67° to 271°, as expected for genuinely
near-neutral, low-signal content). A near-black HSV-instability artifact
would produce NOISY divergence concentrated at the darkest few percent and
shrinking fast with L\*; instead this shows a **stable, one-directional
warm cast present at every tonal level tested, whose absolute chroma GROWS
with L\* (from ~7-9 in the darkest usable bins to ~15-19 by L\*60-100)** —
the signature of a fixed *relative* (percentage) R/B gain-ratio error, not a
numerical near-black artifact. **Candidate (d) mask-methodology-artifact is
only PARTIALLY right**: the neutral mask is a poor proxy for the visible sky
(§1, confirmed), but is not measuring pure noise — it is catching a real,
broad, one-directional color cast that also degrades the actual sky (§3).
The darkest bin (L\*<10) is the one place base-3/4's near-black-instability
story does still apply somewhat: LR's own hue reading is erratic there
(R/G=0.325, an implausibly large blue cast even for "neutral" content) while
our renders are comparatively closer to gray — but that bin is only 19.5% of
the mask and is not where the dominant, stable divergence lives.

### 5. Root-cause localization: upstream of every in-scope surface

Stage A (bypass render: no develop node, no `dcp/pipeline.ts`, no
`wbCorrection.ts`, no `whiteBalance.ts` gain — since `gains()` is exact
identity at as-shot by construction, confirmed by reading the source) already
reproduces the dominant share of BOTH the neutral-mask warm cast and the
sky's chroma deficit. Checked `librawDecoder.ts` (the only remaining stage
before Stage A's pixel exists): `OPEN_SETTINGS` is a fixed, scene-independent
config (`useCameraWb: true, outputColor: 8 (Rec.2020), noAutoBright: true`,
no highlight-recovery override) — nothing here is per-scene-tunable from any
in-scope file. `camMul = [2402, 1024, 1681, 1024]` (R needs 2.35× the gain
of B, consistent with a genuinely blue-shifted twilight illuminant) is
libraw's own deterministic function of the WB_RGGBLevels tag, which the
brief's known facts already establish is bit-identical to DSC06787/DSC09305
(both clean) — so the WB gain APPLIED during demosaic must be numerically
identical machinery across all three files; the divergence cannot be a
difference in which gain gets computed, only in something scene-specific
happening deeper in the demosaic/black-level/color-conversion path libraw
runs internally (e.g., real per-shot black-level drift on a long twilight
exposure — plausible, unverified, and not inspectable without instrumenting
libraw-wasm itself).

Checked `wbCorrection.ts`'s dormant fix① (dual-illuminant ColorMatrix
interpolation): structurally inapplicable here regardless (its own doc
comment restricts it to `builtin`-source only; `dcp`/`acrlook` already do a
full illuminant-interpolated ForwardMatrix reconstruction) — and moot
anyway, since §2 already quantified the illuminant-interpolation-fraction
sensitivity at ~0.2%, an order of magnitude too small to be fix①'s target
mechanism for THIS scene (fix① exists to correct exactly a wrong
illuminant-interpolation *fraction*, which round-2 and this pass both show
is essentially correct for 07349's ~0.81 fraction vs siblings' ~0.79).

**Conclusion: none of the three in-scope files (`dcp/pipeline.ts`,
`wbCorrection.ts`, `whiteBalance.ts`) contain the bug.** The dominant,
reproducible, scene-specific divergence is already fully present in the raw
decoder's output (`librawDecoder.ts` / libraw-wasm's own demosaic +
`useCameraWb` + `outputColor` conversion) before any of this task's in-scope
code executes. Per the brief's own acceptance clause ("If the root cause is
out of reach... STOP with the evidence — that is a valid outcome"): **no fix
was attempted**. Editing `librawDecoder.ts` or libraw-wasm's own internals is
explicitly outside this pass's scope, would be a much higher-blast-radius
change (shared by every RAW file, not just this profile path), and the
evidence above only localizes the defect to that boundary — it does not yet
identify the specific mechanism inside libraw's demosaic (black-level drift
on a long twilight exposure is the best-supported remaining hypothesis, not
a confirmed one).

### Gates

No repo files were changed this pass (`git status` clean at `6204e3c`
throughout) — the existing verify/typecheck/vitest gates are unaffected by
construction; not re-run, per the brief (no fix ⇒ nothing to verify against).

### Honest residuals / next steps for whoever picks this up

1. The best-supported remaining hypothesis is a libraw-internal, per-shot
   effect (black-level or demosaic drift specific to a long, dark twilight
   exposure) that a same-tag WB gain cannot reveal on a normally-exposed
   scene — untested, would need libraw-wasm-level instrumentation (e.g.
   dumping `cd.black`/`cd.maximum` per shot, or a synthetic near-black
   flat-field RAW) to confirm.
2. §1's finding stands on its own regardless of the color root cause: the
   round-2-era neutral-mask metric for THIS scene is a poor proxy for the
   thing the user actually complained about (it never samples the visible
   sky at all). Any future work on this scene should track the sky-region
   metric from §3 (or re-derive a brighter, more representative neutral
   patch if one exists in-frame) alongside — or instead of — the legacy
   whole-mask R/G,B/G ratio.
3. This diagnostic made no engine changes, so the base-5 luma-curve/
   color-outlier correlation the brief flagged as blocked on this fix
   remains blocked — the brightness refit still needs either (a) this
   root cause resolved at the decoder level, or (b) a decision to treat
   DSC07349 as a documented, un-fixed-this-round outlier and refit
   brightness on the other 4 scenes only.

## Stage base-7: decode-level diagnosis of DSC07349's divergence —
## mechanism identified (black-level handling), confirmed NOT fixable via
## any libraw-wasm configuration lever; STOPPED per brief, no fix landed

Trigger: base-6 localized the bug to "somewhere in libraw-wasm's own
demosaic/black-level/color-conversion path" but left it unverified,
naming per-file black/white-level handling and highlight-clip handling as
the two leading unverified suspects. This pass instruments both directly.
No repo/engine changes were made (`git status` clean throughout); all
scripts, JSON and the mask derivation live in this session's own
scratchpad (`base7-diag/`), outside the repo, matching precedent. HEAD
stayed at `f168a7f` (branch `wip/localtone-stage1`) throughout.

### 1. Per-scene libraw internals dump — every exposed field is IDENTICAL
### across the three same-WB-preset scenes; two fields the brief wanted
### (`cblack[4]`, `linear_max`) are not exposed by this libraw-wasm build

Dumped `metadata(true).color_data` for all 5 scenes via libraw-wasm
directly (Node + Playwright harness, same server+browser pattern as
`scripts/spike-cst.mjs`, using the exact `OPEN_SETTINGS` from
`librawDecoder.ts`):

| scene | dims (w×h) | cam_mul | black | maximum | data_maximum | fmaximum | fnorm | raw_bps | ISO |
|---|---|---|---|---|---|---|---|---|---|
| DSC03298 | 4688×7028 | [1972,1024,1861,1024] | 512 | 16383 | 0 | 0 | 0 | 14 | 320 |
| DSC04260 | 4688×7028 | [2291,1024,1573,1024] | 512 | 16383 | 0 | 0 | 0 | 14 | 500 |
| DSC06787 | 4688×7028 | [2402,1024,1681,1024] | 512 | 16383 | 0 | 0 | 0 | 14 | 200 |
| DSC07349 | 7028×4688 | [2402,1024,1681,1024] | 512 | 16383 | 0 | 0 | 0 | 14 | 200 |
| DSC09305 | 4688×7028 | [2402,1024,1681,1024] | 512 | 16383 | 0 | 0 | 0 | 14 | 1000 |

`pre_mul`, `cam_xyz`, and `rgb_cam` are also bit-identical across all 5
scenes (camera-model constants, as expected since `useCameraMatrix` is
left at its library default). `data_maximum`/`fmaximum`/`fnorm` read `0`
for every scene through this API — this build's `metadata()` snapshot is
taken before/without the full `dcraw_process()` highlight-scan step that
would populate them, so they carry no signal either way.

Cross-checked against the ARW files directly (exiftool, bypassing libraw
entirely): `BlackLevel` = `512 512 512 512` and `WhiteLevel` = `15360
15360 15360` on **all 5 scenes, DSC07349 included** — the Sony-embedded
per-channel black/white tags are themselves scene-independent constants
for this camera body, not per-shot values. **This directly refutes the
"per-file black/white-level metadata" suspect as literally nothing to
read**: there is no per-shot metadata divergence anywhere in the exposed
surface (libraw's own `color_data` or the raw EXIF tags) that
differentiates DSC07349 from its two bit-identical-`cam_mul` siblings
(DSC06787/DSC09305).

**Tooling limitation worth flagging explicitly**: the brief asked for
`cblack[4]` (libraw's internal per-channel black, typically derived from
optical-black border/margin pixels rather than the metadata tag) and
`linear_max`. Neither is exposed by this project's pinned `libraw-wasm@1.6.0`
build — confirmed by grepping the compiled `.d.ts` (no such fields in
`ColorData`) and `strings`-scanning `dist/libraw.wasm` directly for the
literal field names: `data_maximum`/`fmaximum`/`fnorm` are present in the
binary (matching the typed surface), `cblack`/`linear_max` are **absent**
(only `userCblack`, an *input* setting, appears). So the one piece of data
most likely to directly prove or disprove a per-channel black-level
divergence cannot be read out of this build at all — the sensitivity test
in §3 below is the closest available substitute.

### 2. Clip census — REFUTES the highlight-clipping hypothesis outright

Fraction of demosaiced 16-bit pixels at/near saturation (≥99% of 65535)
per channel, same decode:

| scene | R clip | G clip | B clip | any-channel clip |
|---|---|---|---|---|
| DSC03298 | 0.0007% | 0.0009% | 0.0010% | 0.0013% |
| DSC04260 | 0.0123% | 0.0061% | 0.0032% | 0.0126% |
| DSC06787 | 0.3027% | 0.3212% | 0.7080% | **0.7083%** |
| DSC07349 | 0.0116% | 0.0051% | 0.0030% | **0.0116%** |
| DSC09305 | 0.2701% | 0.2668% | 0.2565% | **0.2802%** |

DSC07349 — the divergent scene — has the **lowest** any-channel clip
fraction of the three same-WB-preset scenes, an order of magnitude below
both "clean" siblings (61× below DSC06787, 24× below DSC09305). If
clipped-pixel desaturation feeding into the neutral-mask/sky statistics
were the mechanism, the clean scenes (far more clipped) should show the
larger divergence, not the broken one. **Candidate refuted directly by
measurement**, no lever test needed — consistent with base-6's own §1/§4
finding that the neutral mask sits in the dark sea/horizon band, nowhere
near the bright sun/sky where clipping actually occurs in this frame.

### 3. Configuration-lever sweep — mechanism found (black-level handling),
### but no scene-independent lever closes it without regressing a clean scene

Method: decode DSC07349 with `OPEN_SETTINGS` plus one changed
setting at a time, resample the 16-bit Rec.2020-linear output onto the
same 231,033-px Lab C\*<6 near-neutral mask used by base-6 (rebuilt here
from LR's own base JPEG, `lr-sweep-20260901/base/DSC07349.jpg` —
reproduces base-6's stated 8.26% mask fraction and its §5 LR-target
ratios (0.982/1.013) exactly, confirming the mask is faithfully
reconstructed), convert Rec.2020-linear → sRGB-linear via the same 3×3
matrix used in `scripts/spike-cst.mjs`, and report R/G, B/G against the
LR target. (Absolute numbers here differ slightly from base-6's own
Stage-A figures — 1.18/0.86 vs base-6's 1.395/0.736 — because this
harness resamples via nearest-neighbor onto the mask grid without
`librawDecoder.ts`'s camera-crop/cropbox pass; the harness is internally
consistent for an A/B lever comparison, which is what it's used for.)

| lever | R/G | B/G |
|---|---|---|
| **LR target** | **0.9820** | **1.0130** |
| baseline (= `OPEN_SETTINGS`) | 1.1838 | 0.8597 |
| `highlight=1` (blend) | 1.2431 | 0.8206 |
| `highlight=9` (reconstruct) | 1.2412 | 0.8194 |
| `adjustMaximumThr=0` | 1.1838 | 0.8597 |
| `adjustMaximumThr=1` | 1.1838 | 0.8597 |
| `useCameraMatrix=1` | 1.1838 | 0.8597 |
| `useCameraMatrix=3` | 1.1838 | 0.8597 |
| `userBlack=512` (explicit, == metadata) | 1.1838 | 0.8597 |
| `userBlack=462` (−50) | 1.3002 | 0.9389 |
| `userBlack=562` (+50) | 1.0751 | 0.7749 |
| `userCblack` R+100 | 0.0833 | 0.1788 |
| `userCblack` B+100 | 0.2565 | 0.0826 |
| `fourColorRgb=true` | 1.1839 | 0.8597 |
| `medPasses=3` | 1.1839 | 0.8598 |
| `userQual=3` (AHD) | 1.1838 | 0.8597 |
| `userQual=0` (linear) | 1.1840 | 0.8595 |
| `noAutoScale=true` (negative control) | 0.2537 | 0.3120 |

**Six levers are inert**: `highlight` mode moves the ratio the *wrong*
direction (further from target); `adjustMaximumThr`, `useCameraMatrix`,
`fourColorRgb`, `medPasses`, and `userQual` (demosaic algorithm choice)
produce **zero measurable change** — bit-identical to baseline to 4
decimal places. These six are cleanly ruled out as the mechanism.

**`userBlack`/`userCblack` are the one lever family with real leverage** —
which is itself informative: it confirms base-6's black-level-handling
hypothesis is mechanically live (the ratio IS sensitive to how the black
point is subtracted, exactly where a per-shot black-level drift would
show up). But two things kill it as an actionable fix:

1. **Wrong shape.** The needed correction is two-axis and
   *oppositely signed* — R/G must come DOWN (1.18→0.98) while B/G must go
   UP (0.86→1.01). A uniform scalar (`userBlack`) moves both R/G AND B/G
   in the SAME direction (both fall as black increases: R/G 1.18→1.08→0.71→0.32,
   B/G 0.86→0.77→0.48→0.22 at +50/+200/+400) — it can be tuned to hit
   R/G≈0.98 around +85..+90, but at that same point B/G has moved to
   roughly 0.70, i.e. **further from its 1.013 target than baseline**, not
   closer. No scalar value closes both axes simultaneously. A
   hand-picked asymmetric `userCblack` (R+100/B−100) was tried as the
   directionally-motivated alternative and overshoots catastrophically
   (R/G 0.06, B/G 0.31) — the lever is far too coarse/nonlinear near
   this scene's low raw signal level to hand-tune usefully.

2. **Disturbs an already-correct scene.** The SAME `userBlack=562` (+50)
   delta was applied to DSC06787 and DSC09305 (near-neutral masks rebuilt
   the same way from their own LR base JPEGs) to test the brief's
   explicit acceptance bar ("must NOT disturb the clean scenes"):

   | scene | lever | R/G | B/G | LR target |
   |---|---|---|---|---|
   | DSC06787 | baseline | 1.0157 | 1.0107 | 1.0168 / 1.0193 |
   | DSC06787 | `userBlack=562` (+50) | **0.9594** | **0.9842** | 1.0168 / 1.0193 |
   | DSC06787 | `userBlack=712` (+200) | 0.8361 | 0.9323 | 1.0168 / 1.0193 |
   | DSC09305 | baseline | 1.0748 | 0.9320 | 1.0448 / 0.9689 |
   | DSC09305 | `userBlack=562` (+50) | 0.9765 | **0.8768** | 1.0448 / 0.9689 |

   DSC06787's baseline is already within ~1-2% of its own LR target on
   both axes (i.e. genuinely clean, matching base-6's framing) — the same
   +50 delta that partially helps DSC07349's R/G axis pushes DSC06787's
   R/G from +0.1% error to **−5.6%** and its B/G from −0.8% to **−3.4%**,
   a real, measurable regression on a scene that needs no fix. DSC09305
   shows a mixed result (R/G improves, B/G worsens further, from −0.9%
   error to −9.5%). **No single fixed, scene-independent `open()` setting
   closes DSC07349's gap without regressing at least one axis of an
   already-clean scene** — the brief's stop condition is met.

### Conclusion

The mechanism is now positively identified — black-level handling, not
highlight/clip handling (§2 refutes that cleanly) and not any per-file
metadata divergence (§1: every readable field, including exiftool's own
raw tag dump, is bit-identical across the three same-WB-preset scenes).
§3 shows the ratio IS mechanically sensitive to how the black point is
subtracted, but the correction DSC07349 needs is inherently **per-shot
and per-channel** (a shape no uniform, scene-independent `open()` setting
can express), and the one field that could confirm or quantify that
per-channel drift directly — `cblack[4]` — is not exposed anywhere in
this project's pinned libraw-wasm build (§1's binary-string check).
Sharper than base-6's "somewhere in libraw internals, unverified": this
pass verifies the mechanism, verifies it is not a metadata or
highlight-handling issue, and verifies no exposed configuration lever can
express the required per-shot/per-channel shape — closing off the
"maybe a lever exists we haven't tried" uncertainty base-6 left open.

Per the brief's own acceptance clause: **no fix was attempted or landed**.
The only ways forward from here are out of this pass's scope: (a) patch
or fork libraw-wasm to expose `cblack[4]` (and ideally `linear_max`) so a
real per-shot correction could at least be *diagnosed* precisely instead
of inferred from ratio sensitivity, which is a build-toolchain change to
a third-party wasm dependency, not a `librawDecoder.ts` configuration
change; or (b) treat DSC07349 as a documented, structurally-out-of-reach
outlier (as base-6 already recommended for the base-5 brightness refit)
and exclude it from any multi-scene calibration work rather than chase a
fix that this pass's evidence says does not exist at the configuration
level.

### Gates

No repo files were changed this pass (`git status` clean at `f168a7f`
throughout) — typecheck/vitest/verify chain unaffected by construction,
not re-run per the brief (no fix ⇒ nothing to verify against).

### Honest residuals / next steps for whoever picks this up

1. The `userBlack=562`/`+712` sweep's monotonic, same-direction R/G AND
   B/G decline as black increases (§3) has a plausible mechanical
   explanation worth recording: `OPEN_SETTINGS` subtracts black BEFORE
   the per-channel `cam_mul` WB gain is applied, and DSC07349's `cam_mul`
   is strongly unequal (R needs 2.35× G's gain, B needs 1.64×) — so an
   error in the shared black point gets amplified unevenly across
   channels post-WB. This is offered as an explanation for the *shape* of
   the sensitivity, not a new lead; it doesn't change the conclusion that
   no scalar lever closes both axes.
2. §1's `cblack[4]`/`linear_max` gap is a genuine tooling limitation, not
   a scope decision — if a future pass has appetite for patching/forking
   libraw-wasm (or shelling out to a locally-installed `dcraw`/`libraw`
   CLI with `-D`/verbose flags as a one-off diagnostic, entirely outside
   the shipped app) to read the actual per-channel black libraw computed
   for DSC07349 vs its siblings, that would either confirm this pass's
   inferred mechanism precisely or redirect it.
3. This diagnostic made no engine changes; the base-5/base-6 status quo
   (DSC07349 remains a documented, unfixed color-divergence outlier) is
   unchanged. Nothing here reopens or narrows any other open item in this
   document.

## Stage base-7b: a fitted COMBINED (dr, db) black-offset DOES converge on
## DSC07349 — base-7's "no scalar/lever closes the gap" conclusion was
## partly an artifact of a `userCblack` semantics bug in its own harness —
## but the fit is confirmed per-shot and underivable from any readable
## metadata; STOPPED per brief, no fix landed

Trigger: base-7 tested `userBlack` scalars and SINGLE-channel `userCblack`
bumps (R+100 alone, B+100 alone) plus one hand-picked combined attempt
(`userCblack=[612,512,412,512]`, "R+100,B−100"), and concluded the lever
"overshoots catastrophically" and is "too coarse/nonlinear near this
scene's low signal level." This pass fits a proper 2-unknown/2-target
combined correction directly. Analysis-only per the brief: no repo/engine
files were touched (`git status` clean at `f569a78` throughout); everything
lives in this session's own scratchpad (`base7-diag/`, extending base-7's
own scripts as instructed).

### 0. Root-caused first: base-7's `userCblack` baseline itself was broken —
### it is a per-channel OFFSET, not an absolute level

`libraw-wasm`'s own typings say it plainly (`index.d.ts:50`, quoted in the
brief): `userCblack?: [number, number, number, number]` — *"Per-channel
black offsets: red, green, blue, green2."* **Offsets**, added on top of the
existing black point — not the four channels' absolute black *values*.
base-7's own levers scripts (`levers.mjs`, `levers2.mjs`) never noticed:
every "unchanged" channel in every one of its `userCblack` tests was filled
with `512` (the metadata black), on the implicit assumption that `512 ==
no-op`. It is not. Verified directly (`verify-offset.mjs`, DSC07349, decode+WB
Rec.2020-linear → sRGB-linear R/G,B/G against the same 231,033-px mask
base-7 built):

| setting | R/G | B/G |
|---|---|---|
| no `userCblack` (true baseline) | 1.1838 | 0.8597 |
| `userCblack=[0,0,0,0]` | **1.1838** | **0.8597** (exact match — confirms 0 = no-op) |
| `userCblack=[512,512,512,512]` | 0.2447 | 0.1803 (base-7's own "R+100" baseline before adding the +100!) |
| `userCblack=[10,0,0,0]` (R offset +10 only) | 1.1383 | 0.8573 |
| `userCblack=[0,0,-10,0]` (B offset −10 only) | 1.1890 | 0.8932 |

So every one of base-7's `userCblack` measurements was silently applying a
**+512 offset to all four channels** before adding its stated per-channel
delta — e.g. "userCblack R+100" (`[612,512,512,512]`) was actually "everything
+512, R additionally +100," not "R+100 alone." That single confound fully
explains base-7's reported "catastrophic overshoot" (rg 0.06–0.26, bg
0.08–0.31) — those numbers describe a +512-black-point image, not a small
per-channel nudge. With the correct zero-offset baseline, the real lever is
smooth, modest, and — critically — has the right sign structure (§1).

### 1. Fit: (dr, db) converges to within ~0.2% of LR's target on both axes

Single-axis sweeps (`fit-axis.mjs`, correct offset semantics,
`userCblack=[dr,0,0,0]` and `[0,0,-db,0]`, dr/db ∈ 0..80) on DSC07349:

| dr (R offset) | R/G | B/G (cross term) |   | db (B offset, subtracted) | B/G | R/G (cross term) |
|---|---|---|---|---|---|---|
| 0 | 1.1838 | 0.8597 |   | 0 | 0.8597 | 1.1838 |
| 10 | 1.1383 | 0.8573 |   | 10 | 0.8932 | 1.1890 |
| 20 | 1.0947 | 0.8549 |   | 20 | 0.9267 | 1.1943 |
| 30 | 1.0543 | 0.8527 |   | 30 | 0.9605 | 1.1996 |
| 40 | 1.0159 | 0.8506 |   | 40 | 0.9944 | 1.2051 |
| 50 | 0.9788 | 0.8486 |   | 50 | 1.0285 | 1.2106 |
| 60 | 0.9428 | 0.8467 |   | 60 | 1.0626 | 1.2160 |
| 80 | 0.8720 | 0.8428 |   | 80 | 1.1313 | 1.2268 |

Both main effects are close to linear (mild concave curvature on the R
axis, essentially linear on the B axis) over the whole 0–80 range — a sharp
contrast with base-7's broken, wildly nonlinear-looking data. Cross terms
exist (touching R nudges B/G slightly, and vice versa) but are an order of
magnitude smaller than the main effects and themselves near-linear. Fit
method: linear system from the local slopes near the target region, one
verification decode, one Newton refinement from a numerical Jacobian
(3 extra decodes), converging in two rounds:

| candidate | dr | db | R/G | B/G |
|---|---|---|---|---|
| linear-model prediction | 61 | 49 | 0.9611 | 1.0091 |
| Newton step 1 | 55 | 50 | **0.9837** | **1.0139** |
| **LR target** | | | **0.9820** | **1.0130** |

**Fitted: `userCblack = [55, 0, −50, 0]`** (R black +55, B black −50, G/G2
untouched). Residuals: R/G +0.17%, B/G +0.09% — both within base-6/base-7's
own "genuinely clean" bar (~1–2%). **Guard check**: the fit never moved G —
it was held at offset 0 throughout, by construction, and a 2-unknown/2-target
solve using only (dr, db) converged cleanly, so there was never a forced-G
signal to report. The model (R up, B down, G fixed) is sufficient for this
scene.

This directly **overturns base-7's headline conclusion** ("no scalar value
closes both axes… the lever is far too coarse/nonlinear to hand-tune
usefully") for the *combined, correctly-zeroed* lever — that conclusion was
correct only for the single-axis and bugged-baseline data base-7 actually
had.

### 2. No-regression check: the fit is sharply, severely per-shot

Same `userCblack=[55,0,-50,0]` applied unchanged to all 5 italy scenes
(`no-regression.mjs`), measured against each scene's own LR-JPEG-derived
near-neutral mask target:

| scene | setting | R/G err% | B/G err% |
|---|---|---|---|
| DSC07349 (fit target) | baseline | +20.55% | −15.13% |
| DSC07349 | **fitted** | **+0.17%** | **+0.08%** |
| DSC06787 (same cam_mul) | baseline | −0.10% | −0.84% |
| DSC06787 | fitted | **−9.44%** | **+4.80%** |
| DSC09305 (same cam_mul) | baseline | +2.87% | −3.81% |
| DSC09305 | fitted | **−13.42%** | **+7.68%** |
| DSC04260 (different WB) | baseline | −3.34% | +0.43% |
| DSC04260 | fitted | **−35.43%** | **+46.34%** |
| DSC03298 (different WB) | baseline | −29.38% | +34.74% |
| DSC03298 | fitted | **−186.76%** (sign-flipped negative mean) | **+241.73%** |

Even the two scenes sharing DSC07349's exact `cam_mul`/WB preset — the
closest possible siblings, already within ~1–4% of their own LR targets at
baseline — regress by 5–16 percentage points on both axes. The two
differently-exposed scenes regress catastrophically (DSC03298's fitted R
mean goes *negative* in sRGB-linear terms — some R pixels are pushed below
zero by the black subtraction and the Rec.2020→sRGB matrix's negative
off-diagonal terms turn that into a net-negative channel mean). **This
answers the brief's diagnostic question directly**: the needed correction
is emphatically per-shot, not a constant miscalibration we could apply
everywhere — Adobe is doing something scene-specific here that a fixed
override cannot reproduce, confirming (not just reproducing) base-7's
qualitative verdict, now on trustworthy data.

### 3. Sky effect: NOT small — this scene's "sky" is itself near-black, so
### the brief's own physics expectation doesn't hold here

Measured (`sky-effect.mjs`) the fitted override's effect on the same sky
mask base6-diag/`ablate-sky.mjs` uses (upper 35% of frame, LR hue
180–300°, C\*>8), decode+WB only (Stage A, no DCP — this script's own
simplified libraw-wasm→3×3-matrix pipeline, not the full Electron bypass
render, so absolute numbers aren't directly comparable to §4 below, but the
baseline-vs-fitted *relative* comparison is apples-to-apples):

| | L | C\* | a, b |
|---|---|---|---|
| baseline | 10.64 | 9.12 | 0.44, −9.11 |
| fitted | 9.65 | 14.50 | −1.03, −14.47 |
| Δ | −0.99 | **+5.38 (+58.97%)** | |

The brief's stated expectation was "black deltas are additive in raw
domain → strong in darks, ~1–2% in bright sky." That assumption presumes
the sky is bright. **It is not, in this frame**: DSC07349's sky-hue mask
(upper 35%, blue/violet twilight afterglow) sits at L≈10–15 in every
pipeline this and base-6 measured it in (§4's LR target for the same mask
is L=19.86 — still very dark, nowhere near a "bright sky"). Because the
sky region is in the *same* near-black brightness regime as the neutral
mask the fit was tuned on, the black-offset override moves it by a
non-trivial +59% relative chroma shift, not the ~1–2% the brief predicted.
**Correction to the brief's framing**: for THIS scene, "dark neutral" and
"sky" are not on opposite ends of the dynamic range — treating the sky
question as safely decoupled from the black-level question would be wrong
for DSC07349 specifically (may not generalize to brighter-sky scenes).

### 4. Sky-chroma confound check: partly a measurement artifact, but a real
### deficit remains even apples-to-apples

Reused base-6's own `ablate-sky.mjs` pipeline verbatim (same sky mask, same
`bypass-cache/DSC07349.jpg` Stage-A render via the real Electron app, same
DCP bundle) and extended it (`confound-check.mjs`) to (a) capture Stage E's
raw working-RGB output instead of just its derived Lab, and (b) apply the
app's *actual* seeded `ACRLOOK_BASE_CURVE`
(`src/renderer/engine/color/baseCurve.ts`) on top — reproducing what the
app truly renders by default (DCP acrlook profile stages **plus** the
separate `toneCurve.rgb` the app seeds on fresh-open, `appStore.ts:2457`,
which `ablate-sky.mjs`'s own Stage E does not include):

| stage | C\* | ratio vs LR (24.79) |
|---|---|---|
| LR target | 24.79 | 1.000 |
| [A] decode+WB only, no curve | 9.96 | 0.402 (60% deficit — base-6's headline number) |
| [A] + `ACRLOOK_BASE_CURVE` only (synthetic) | 16.43 | 0.663 (34% deficit) |
| [E] full DCP acrlook tables, no app curve | 7.62 | 0.307 (69% deficit — *worse* than [A] alone) |
| **[E] + `ACRLOOK_BASE_CURVE`** (= TRUE default full render) | **14.22** | **0.574 (43% deficit)** |

Two findings:

- **The curve-stage measurement artifact is real and sizeable.** Applying
  just the app's own tone curve to Stage A alone (no DCP tables at all)
  recovers 44% of the raw 60%-deficit gap (0.402→0.663 ratio) — an S-curve
  mechanically adds chroma near black, exactly as the brief suspected.
  Comparing a curve-less intermediate stage straight against LR's fully-
  curved final render overstates the "defect" by roughly this much.
- **It does not explain the deficit away.** The apples-to-apples number —
  the app's actual default full render (DCP tables + the real seeded
  curve) against LR's final render — still sits at a 43% chroma deficit.
  Notably, the DCP profile's own HueSatMap/LookTable/PV2012 curve stages
  (Stage E before the app's extra curve) make chroma *worse* than Stage A
  alone here (7.62 vs 9.96) on this specific dark/desaturated sky region —
  it is only Silverbox's own additional `ACRLOOK_BASE_CURVE` that recovers
  most of the gap, and even that doesn't close it.

**Verdict**: the sky-chroma "defect" is genuinely both — about 30
percentage points of the naive 60%-deficit headline number is a
measurement artifact of comparing pre-curve to post-curve renders, but a
real, substantial ~43%-deficit gap remains in the actual default full
render vs LR. It is not fully explained by the curve-stage confound.

### 5. Per-shot derivation: nothing found in readable metadata; corrects
### base-7's "long dark exposure" guess along the way

Full `exiftool -a -G1 -s` dump (all tags, all IFDs, Sony maker notes) for
DSC07349 vs both same-`cam_mul` siblings (DSC06787, DSC09305), diffed
line-by-line. Every tag that differs falls into one of two buckets:
(a) expected per-shot capture parameters with no plausible causal link to
sensor black level (timestamps, GPS/focus/AF-point data, `ShutterCount`,
battery level, preview/thumbnail byte offsets), or (b) lens-geometry
correction-coefficient tables (`DistortionCorrParams`,
`VignettingCorrParams`, `ChromaticAberrationCorrParams` — present in three
separate IFDs) that are keyed by aperture and focus distance, which
legitimately differ because DSC07349 was shot at a very different aperture
(see below) — not evidence of anything sensor-black-related.

`BlackLevel` (both `[SubIFD]` and `[SR2SubIFD]` copies) is `512 512 512
512` identically on all three files, confirming base-7's §1 finding again.
`WB_RGGBLevelsAuto` (the camera's own internal auto-WB *estimate* — not
the as-shot WB actually used, which is confirmed bit-identical camMul
across these three) differs per scene (2529/1024/1024/1585 vs
2424/1024/1024/1657 vs 2185/1024/1024/1818 for 07349/06787/09305) — but
this is a chromaticity estimate over the frame content, not a black-level
tag, and there is no principled way to derive a black *offset* from it.
**Nothing found** connecting any readable tag to a per-channel black
correction, within the 30-minute timebox.

One correction worth recording along the way: base-7 speculated the
mechanism might be "real per-channel black-level drift on a long twilight
exposure." The EXIF data refutes the "long exposure" half of that guess:
DSC07349 is `f/13, 1/160s, ISO 203, LightValue 13.7` — a *fast*,
small-aperture, low-ISO, brighter-metered-than-either-sibling exposure
(DSC06787 is f/3.5 1/1000s LV 12.6; DSC09305 is f/2.8 1/125s LV 6.6).
DSC07349 is not dim or long — it is a heavily stopped-down shot (plausibly
into or near the sun, consistent with the sunstar-prone f/13) producing an
extreme-dynamic-range frame where the *neutral-mask region specifically*
(sea/horizon, in shadow) is dark even though the frame overall is not
underexposed. Whatever mechanism makes libraw's black handling diverge
here, "long dark exposure" is not the right mental model for this file.

### Conclusion

The fitted, correctly-parameterized combined override **does converge**
(§1) — base-7's negative verdict on the `userCblack` lever itself was
partly an artifact of its own harness bug (§0), not a true property of the
lever. But §2 shows just as firmly as base-7 did that the specific
numbers needed are per-shot: the same fitted `(dr,db)` regresses every
other scene tested, mildly on the two closest siblings and catastrophically
on the two differently-exposed ones. §5 found no readable metadata signal
that predicts `(dr,db)` per file. Recommendation: **(a)** — a per-scene
override is possible (§1 proves it, correcting base-7's "no fit exists"),
but it is underivable from anything exposed to this app (§5); a real
auto-fix still requires either forking/patching libraw-wasm to read
`cblack[4]` directly (base-7's own §1 recommendation, unchanged) or an
Adobe-side signal this project has no access to. §3 and §4 are new,
scene-specific caveats for whoever picks this up next: this particular
scene's "sky" is itself dark enough that the black-level question and the
sky-chroma question are NOT independent here, and the sky-chroma deficit
survives a fair curve-stage comparison at roughly 43%, down from the naive
60% headline but still real.

### Gates

No repo files were changed this pass (`git status` clean at `f569a78`
throughout, confirmed before and after) — typecheck/vitest/verify chain
unaffected by construction, not re-run per the brief (analysis-only, no
engine changes, no subagents).

### Honest residuals / next steps for whoever picks this up

1. §0's discovery means base-7's entire §3 lever-sweep table (the
   `userCblack` rows specifically; the `userBlack`/other-lever rows are
   unaffected since `userBlack` is a plain scalar with no offset-vs-absolute
   ambiguity) should be treated as void, not as evidence the lever is
   unusable — this document should be read with that correction in mind if
   anyone revisits base-7's raw numbers directly.
2. §1's fit used a local-linear model plus one Newton step from a 3-point
   numerical Jacobian — good enough for a 0.1–0.2% residual here, but it
   is an empirical fit to ONE scene's ONE mask, not a validated model of
   the underlying mechanism. It says nothing about *why* R needs +55 and B
   needs −50 specifically for this file.
3. §3's sky-effect measurement used a simplified libraw-wasm→matrix
   pipeline (no `baselineExposureEV`, no full color-management chain) for
   speed; the relative (+59%) comparison should hold, but the absolute
   chroma numbers there are not on the same footing as §4's (which used
   the real bypass render). A future pass wanting precise absolute
   sky-chroma-under-override numbers should route the override through
   the real bypass pipeline instead.
4. §5's exiftool diff was manual and time-boxed at 30 minutes; it is
   thorough (every tag, all IFDs) but not exhaustive proof nothing
   correlates — e.g. binary maker-note blobs `exiftool` doesn't decode
   into named tags were not inspected.
5. No repo files were changed; the base-5/base-6/base-7 status quo
   (DSC07349 remains a documented, unfixed color-divergence outlier, now
   with a confirmed-but-underivable fix shape) is unchanged. Nothing here
   reopens or narrows any other open item in this document.

## Stage base-7c: DSC03298's per-shot black offset DOES converge (R/G
## nearly exact, B/G partially closed) but does NOT explain its luma-curve
## incompatibility with the {04260,06787,09305} cluster — two independent
## defects, not one; analysis-only, no fix landed

Trigger: does base-7b's per-shot black-offset mechanism ALSO explain
DSC03298's two remaining documented divergences — its B/G +10.8% gap in
acrlook mode, and its luma transfer curve's incompatibility with the other
three "clean" Italy scenes? Analysis-only per the brief: no repo/engine
files touched, no commits, no subagents; everything lives in this
session's own `base7-diag/` scratchpad, extending base-7b's own
fit-axis/fit-joint plumbing.

### 1. Two-axis (dr, db) fit for DSC03298: converges, but with a much
### coarser achievable floor than DSC07349's — and userCblack turns out to
### be INTEGER-truncated, not continuous

Recomputing the near-neutral (LR Lab C\*<6) mask target with base-7b's
exact method (`mask-generic.mjs`, sRGB-linear R/G,B/G of the pooled LR-JPEG
mask) gives `linRG=0.7230, linBG=1.5180` — matching base-4's earlier
0.723/1.518 essentially exactly, confirming methodological consistency.
Baseline (no override) in the SAME crude-fixed-3×3-matrix pipeline
base-7b's fit-axis.mjs used: `rgLin=0.5106, bgLin=2.0455` — a much larger
gap than DSC07349 ever had (+41.6%/−25.8% vs target, vs DSC07349's
−17%/+17.9%).

A coarse sweep (`fit-axis-03298.mjs`) hit an immediate surprise: `dr=-20`
alone overshot the R/G target by nearly 2× (0.5106→1.3513), and `db=100`
alone crashed B/G through zero into negative territory — DSC03298's masked
region sits much closer to raw black than DSC07349's, so the per-unit
sensitivity is roughly **10× steeper**. A finer sweep (`fit-axis-03298-
fine.mjs`, dr∈[0,−20], db∈[0,50]) found both axes near-linear in that
narrower window, predicting `dr≈−5.3, db≈12.8` by local-slope interpolation.

Attempting a Newton refinement with fractional (dr, db) surfaced a second,
more important discovery: **`userCblack` values are silently truncated
toward zero (`Math.trunc`-style) by the libraw-wasm binding, not rounded**.
Two inputs differing by <0.1 (`dr=-5.993` vs `dr=-6.0`) landed on
*different* integers (−5 vs −6) and produced a ~5%-of-ratio jump in the
result (reproduced 5× identically per input — fully deterministic, just
non-continuous). This invalidates every "fractional" intermediate point in
this pass's own working notes; the real search space is integer-only. A
20-point integer grid (`dr∈{−4,−5,−6,−7}, db∈{12..16}`) was evaluated
directly:

| dr | db | R/G | B/G | R/G err | B/G err |
|---|---|---|---|---|---|
| −6 | 12 | 0.7290 | 1.5690 | +0.83% | +3.36% |
| **−6** | **13** | **0.7272** | **1.5315** | **+0.58%** | **+0.89%** |
| −6 | 14 | 0.7256 | 1.4948 | +0.36% | −1.53% |
| −6 | 15 | 0.7239 | 1.4589 | +0.12% | −3.89% |
| −7 | 14 | 0.7624 | 1.4986 | +5.45% | −1.28% |

**Fitted: `userCblack=[-6, 0, 13, 0]`** — the best joint-L2 point on the
grid, residuals R/G +0.58%, B/G +0.89%. This is coarser than DSC07349's
0.17%/0.09% fit (§1 of base-7b) purely because of the ~10× steeper local
slope combined with integer-only granularity — a real, structural
limitation of this lever for this scene, not a fitting-methodology
weakness. As in base-7b, G was held at offset 0 throughout by construction
(only R and B are touched).

**Reconciling the brief's own aside** ("stage-B ForwardMatrix-only
continuous reference was R/G 0.721/B-G 1.634 vs LR 0.723/1.518"): that
number comes from a *different* pipeline (the real DCP ForwardMatrix, not
this fit's crude fixed-3×3 camera→sRGB matrix), so it is not directly
comparable to this section's baseline (0.5106/2.0455). A supplementary
check (`stagea-mask-check-03298.mjs`) re-measured the SAME mask through
the REAL decode pipeline (libraw `outputColor:8`/Rec.2020 + WB, +
`settings.baselineExposureEV=0.5` gain, mapped to sRGB primaries via
`WORK_TO_SRGB` — no DCP tables yet, i.e. true Stage A) for both baseline
and the fitted override:

| | R/G | B/G |
|---|---|---|
| baseline (real pipeline) | 0.5060 (−30.0%) | 2.2342 (+47.2%) |
| **fitted override, real pipeline** | **0.7127 (−1.4%)** | **1.6817 (+10.8%)** |
| LR target | 0.7230 | 1.5180 |

Two things worth flagging: (a) the crude-matrix pipeline's baseline
(0.5106/2.0455) and the real pipeline's baseline (0.5060/2.2342) turn out
to be close on R/G but quite different on B/G — the brief's cited
"0.721/1.634" figure is a THIRD number again (post-ForwardMatrix, not
post-WB), so all three pipelines disagree on the raw size of the gap, a
real methodological hazard worth remembering next time this file is
touched; (b) applying the SAME integer override fit in the crude pipeline
to the REAL pipeline still helps enormously (R/G closes to within 1.4%,
B/G improves from +47% to +10.8%) but does **not** fully close B/G — and
that residual **+10.8%** figure lands almost exactly on the brief's own
cited "B/G +10.8% in acrlook" number. Direct answer to the brief's framed
question: the remaining B/G gap is **not** smaller than the black-fit can
express — the black-fit demonstrably buys most of the correction (47%→
10.8%) — but it also does not fully close it; some residual B/G defect
survives the best integer (dr,db) this lever can express, whether measured
in the crude matrix or the real pipeline.

### 2. Luma-curve compatibility retest: the override does NOT bring
### DSC03298 into the {04260,06787,09305} cluster — because it can't:
### the curve mismatch and the WB mismatch are different defects

Built a `{04260,06787,09305}` "cluster curve" by running base-5's
`fit-acrlook-curve.mjs fit` with `SCENES_OVERRIDE=DSC04260,DSC06787,
DSC09305` (real official `acrlook-identity-exports`, unmodified pipeline —
these three scenes need no override): joint curve `[[0,0],[9,21],[14,33],
[26,58],[47,95],[65,122],[88,153],[134,205],[255,255]]`, in-sample
residuals mean −0.018/−0.078/+0.093 stops (all well inside the 0.25 gate).

Testing DSC03298 against this curve requires a render of "acrlook profile
+ identity toneCurve.rgb" **with the fitted override baked into the raw
decode** — but the real app has no hook to pass a custom `userCblack` into
its actual decode path (confirmed: `render-acrlook-identity.mjs` drives the
real Electron app end-to-end via Playwright with no such seam; base-7b's
own conclusion — "requires forking/patching libraw-wasm... this project
has no access to" — still holds). Building this analysis-only, without
touching the app, required a standalone reconstruction
(`decode-03298-rec2020.mjs` + `dcp-render-03298.mjs`): real
`librawDecoder.ts` `OPEN_SETTINGS` decode (± `userCblack`) via libraw-wasm
directly, nearest-neighbor downsampled in-browser to LR's own 1365×2048
dims (full 4688×7028 16-bit RGB was too large for a single Playwright
CDP-pipe transfer — confirmed by an actual crash — and isn't needed for a
population-level curve fit), then the real DCP pipeline
(`bundle.mjs`'s `renderDcpPixel`, ForwardMatrix + HueSatMap + AcrLook
LookTable + PV2012 curve, ~36s/2.8M-pixel image) applied per-pixel in
Node, exported as JPEG.

**A first pass of this reconstruction had a large, systematic ~0.63-stop
brightness bug** (sanity-checked against the one REAL official render
available, the baseline-no-override identity export: mean Δ=0.633 stops,
38.4% kept). Root-caused by reading `decodeWorker.ts`/`shared/ipc.ts`
rather than guessed: the reconstruction was missing
`settings.baselineExposureEV`'s shipped default of **0.5** — a linear gain
(`2^EV`) applied at decode, before any DCP processing
(`linearizeRgb16(..., baselineExposureGain(EV))`), which this standalone
script had no reason to know about since it isn't part of the DCP profile
math it was otherwise faithfully replicating. Adding that gain closed
almost the whole gap (mean Δ 0.633→**0.087** stops, RMS 0.833→0.563) —
good enough to trust the reconstruction's differential (baseline vs
fitted) comparison, with the residual ~0.09 stop / 0.56 RMS understood as
coming from the remaining simplifications (no `raw_inset_crops` crop-frame
fix, nearest-neighbor not box-filter downsample) rather than a real
pipeline error.

Cross-applying the cluster curve to both reconstructions vs LR's real
DSC03298.jpg (`cluster-crossapply-03298.mjs`, exact
`fit-acrlook-curve.mjs` methodology: REC.709 stops, exact sRGB EOTF,
LR_STOPS_FLOOR=−8, clipped-pixel exclusion, per-channel curve application):

| | mean (stops) | RMS (stops) | n | verdict (gate ≤0.25) |
|---|---|---|---|---|
| baseline (no override) | −0.646 | 1.015 | 1,486,130 | does NOT join cluster |
| **fitted (`userCblack=[-6,0,13,0]`)** | **−0.641** | 1.011 | 1,486,130 | **does NOT join cluster** |

**THE KEY QUESTION's answer is NO.** The fitted black override moves the
cluster-curve residual by 0.005 stops — noise-level, not a real effect —
while base-4's own historical 5-scene LOSO runs (held-out DSC03298,
`fit-output*.log`) independently put its real-render residual in the same
−0.41 to −0.77 stop range, a useful external consistency check on this
reconstruction's −0.646 baseline number.

**Why this makes sense, not just an empirical dead end**: the (dr,db) fit
holds G at offset 0 by construction (§1, both here and in base-7b) — it
only ever touches R and B. REC.709 luma is G-dominated (0.7152 weight vs
0.2126+0.0722 combined for R+B), so a lever that structurally cannot move
G is structurally limited in how much it can ever move a luma-only metric,
almost regardless of how well it fixes color balance. The WB/chroma defect
(§1, R/G and B/G) and the luma-curve defect (§2) are consistent with being
**two independent problems**: a per-shot black level explains (most of)
the former and is mechanically incapable of explaining the latter. The
brief's original framing — bundling "B/G +10.8%" and "luma-curve
incompatibility" together as possibly-one-cause — turns out to be wrong;
they need separate explanations.

### 3. Refit design recommendation: fallback path, not the clean 4-scene
### plan

Since DSC03298 does NOT join the cluster (§2), base-5r's refit should
follow the brief's option **(b)**: a **3-scene fit** (`{04260,06787,
09305}`, already computed in §2 as the "cluster curve") **with an 03298
guard-constraint**, not a clean 4-scene fit with a black-override
preprocessing step. Concretely:

- The 3-scene cluster curve (§2's `[[0,0],[9,21],[14,33],[26,58],[47,95],
  [65,122],[88,153],[134,205],[255,255]]`) is already a solid candidate on
  its own merits — in-sample LOSO worst |mean| 0.157 stops, comfortably
  inside the 0.25 gate, using only real official renders, no override
  needed.
- DSC03298 (and, per base-7b, DSC07349 — the other documented per-shot
  outlier) should stay **excluded from the fit population** but ideally
  checked as a **guard**: render each under the candidate curve and confirm
  it doesn't regress from wherever it sits today (this pass's own
  −0.646-stop number is now that baseline for DSC03298; base-7b's §2 has
  the equivalent for DSC07349). A guard that only checks "no regression"
  (not "must join") is the honest framing, since neither scene is fixable
  by this curve by design.
- **Per-shot black overrides are NOT a viable in-product preprocessing
  step** for either outlier, restating base-7b's own unresolved
  conclusion once more: the fitted `(dr,db)` is per-shot and underivable
  from any metadata this app can read (base-7b §5's exhaustive EXIF diff
  found nothing), and — new information from this pass — even where a fit
  converges (DSC03298 does, unlike base-7's original despair), it only
  partially closes the real-pipeline B/G gap (§1) and doesn't touch the
  luma-curve gap at all (§2). There is no "per-photo dev setting" or
  "sidecar field" design worth speccing yet, because there is no reliable
  way to populate it automatically, and hand-tuning two more free
  parameters per outlier photo is not a product feature — it's manual
  colorist work LR itself is presumably doing via some internal per-scene
  adaptive process this app has no access to (echoing `baseCurve.ts`'s own
  documented finding that Adobe's PV2012 tone mapping is "internal,
  undocumented, per-scene-adaptive").
- **Net recommendation**: ship the 3-scene cluster curve as
  `ACRLOOK_BASE_CURVE`'s base-5r refit, document DSC03298 and DSC07349 as
  two separate, still-open, still-per-shot-only color/tone outliers (not
  one bundled issue), and do not build any black-level-override plumbing
  into the product from this thread of investigation.

### Gates

No repo files were changed (`git status` clean at `2485033` throughout;
this stage's own scratchpad work lives entirely under this session's
`base7-diag/`) — typecheck/vitest/verify chain unaffected by construction,
not re-run per the brief (analysis-only, no engine changes, no
subagents).

### Honest residuals / caveats for whoever picks this up next

1. §1's fit is calibrated against base-7b's own crude fixed-3×3-matrix
   pipeline (as the brief explicitly asked, "for consistency") — §1's own
   supplementary check shows the SAME override lands differently (still
   helpful, not identical) when run through the real DCP pipeline. Anyone
   refitting numerically should pick ONE pipeline and stay in it; this
   pass deliberately used both and reported both rather than picking a
   winner.
2. §1 discovered `userCblack` truncates to integers — this should be
   treated as a hard constraint on ANY future fit using this lever, on
   any scene, not just DSC03298; base-7b's own DSC07349 fit
   (`dr=55,db=50`) happened to use integers already so is unaffected, but
   its written Newton-refinement narrative implicitly reads as continuous
   and should be read with this correction in mind.
3. §2's standalone DCP reconstruction is a real, substantial piece of
   one-off infrastructure (raw decode + full DCP pipeline in plain Node,
   no app) built for this diagnostic; it is NOT wired into any verify
   script or made reusable, and carries known simplifications (no
   `raw_inset_crops` crop-frame fix, nearest-neighbor downsample, ~0.09
   stop / 0.56 RMS residual fidelity gap even after the EV0.5 fix). Trust
   its DIFFERENTIAL numbers (baseline vs fitted, both built the same way)
   more than either absolute number in isolation.
4. §2's −0.646-stop cluster-residual number for DSC03298 should be treated
   as "in the right ballpark, cross-checked against base-4's independent
   −0.41 to −0.77 range" rather than a precise, reproducible-to-the-mil
   measurement — the reconstruction pipeline was hand-built once for this
   pass and never independently re-verified against a second real render.
5. This pass found NO new avenue for automatically deriving DSC03298's
   black offset (same conclusion as base-7b §5 for DSC07349) and no new
   avenue for the luma-curve gap either. Both outliers remain open,
   unfixed, and now confirmed independent of each other for DSC03298
   specifically.

## Stage base-5r eval: two ACRLOOK_BASE_CURVE refit candidates, evaluated —
## recommendation: candidate A (3-scene cluster fit)

Trigger: base-7c's own design fork left two viable refit shapes on the table
without picking between them — "Curve A" (cluster fit on the 3 known-clean
scenes {DSC04260, DSC06787, DSC09305}) vs "Curve B" (a 4-scene compromise
joint fit adding DSC03298, excluding DSC07349). This pass fits both,
evaluates both on real renders of all 5 scenes with the candidate curve
injected via the `setToneCurvePoints` debug hook (no engine code touched —
analysis/eyeball material only, per the brief), and recommends one.
Everything lives in this session's `scratchpad/base4-diag/` (extending
base-5's own `fit-acrlook-curve.mjs`, which already supports a
`SCENES_OVERRIDE` env var for exactly this kind of scene-subset fit); no
repo/engine files were changed, no commits made, no subagents used.

### 1. Both curves, fit with `fit-acrlook-curve.mjs`'s existing machinery

**Curve A** (`SCENES_OVERRIDE=DSC04260,DSC06787,DSC09305`) reproduces
base-7c's own reported cluster curve exactly (cross-check, not a new fit):

```
[[0,0],[9,21],[14,33],[26,58],[47,95],[65,122],[88,153],[134,205],[255,255]]
```

| held out (LOSO) | mean (stops) | RMS (stops) |
|---|---|---|
| DSC04260 | −0.016 | 0.277 |
| DSC06787 | −0.091 | 0.323 |
| DSC09305 | +0.157 | 0.618 |

Worst \|LOSO mean\| = **0.157** — comfortably inside the 0.25 gate, matching
base-7c's own number.

**Curve B** (`SCENES_OVERRIDE=DSC03298,DSC04260,DSC06787,DSC09305`, joint
4-scene fit, DSC07349 excluded per base-7's decode-level finding that its
divergence is per-shot and underivable):

```
[[0,0],[9,19],[13,27],[21,45],[44,89],[57,105],[80,143],[125,196],[255,255]]
```

In-sample residuals: DSC03298 mean=−0.593 rms=0.727; DSC04260 mean=+0.058
rms=0.271; DSC06787 mean=+0.041 rms=0.260; DSC09305 mean=+0.188 rms=0.607.
**DSC03298 does not pull into line even in its own training fit** — a
−0.593-stop in-sample residual is barely better than curve A's out-of-sample
−0.760 on the same scene (§2 below) — direct, quantitative confirmation of
base-7c's §2 finding that the luma-curve gap and the WB/black-level gap are
independent defects; a joint fit that includes DSC03298's pixels cannot buy
much because no monotonic PCHIP curve can simultaneously satisfy its
outlier transfer function and the other three scenes'.

| held out (LOSO) | mean (stops) | RMS (stops) |
|---|---|---|
| DSC03298 | −0.751 | 0.879 |
| DSC04260 | +0.078 | 0.296 |
| DSC06787 | +0.129 | 0.298 |
| DSC09305 | +0.331 | 0.715 |

Worst \|LOSO mean\| = **0.751** — fails the 0.25 gate badly, entirely driven
by DSC03298 (dropping it: worst is DSC09305 at 0.331, still outside the
gate but far closer). Expected and diagnostic, not a bug: including an
outlier scene in a 4-scene training set both fails to fix that scene AND
measurably degrades LOSO robustness on the three clean scenes relative to
curve A (compare +0.157/−0.091/−0.016 above to +0.331/+0.129/+0.078 here —
every one of the three shared scenes gets a worse LOSO number under curve
B than under curve A).

### 2. Real-render 5-scene evaluation (current shipped curve vs A vs B)

Rendered all 5 scenes through the real interactive app (acrlook profile
source, amount 100, `setToneCurvePoints(id, 'rgb', <candidate>)` injected
after the acrlook bake settles — same idiom as `render-acrlook-identity.mjs`,
new script `render-acrlook-custom-curve.mjs`), 2048px long edge, then
measured with `fit-acrlook-curve.mjs measure` against LR's own base JPEGs
(exact same pixel-paired, clipped-pixel-excluded, `LR_STOPS_FLOOR`-gated
method as every other measurement in this document). "current" reuses the
already-on-disk `acrlook-base-exports/` (shipped `ACRLOOK_BASE_CURVE`,
unchanged this pass):

| scene | current mean (RMS) | A mean (RMS) | B mean (RMS) |
|---|---|---|---|
| DSC03298 | +0.149 (0.364) | **−0.760 (0.880)** | −0.594 (0.720) |
| DSC04260 | +0.576 (0.696) | −0.027 (0.263) | +0.049 (0.256) |
| DSC06787 | +0.676 (0.791) | −0.075 (0.284) | +0.046 (0.257) |
| DSC07349 | −0.278 (0.471) | **−1.049 (1.091)** | −0.959 (1.006) |
| DSC09305 | +0.829 (1.111) | +0.089 (0.535) | +0.186 (0.588) |
| pooled mean | +0.390 | −0.364 | **−0.254** |

(mean = LR − ours, stops; positive = LR brighter than our render.)

Real-render numbers for the 3 cluster scenes track the in-sample fit
residuals from §1 closely (A: −0.027/−0.075/+0.089 here vs −0.018/−0.078/
+0.093 in the analytical fit — sub-0.01-stop agreement, confirming the
`setToneCurvePoints` injection round-trips faithfully through the real
export pipeline). Both candidates are a large, unambiguous improvement over
current on the 3 clean scenes (mean errors drop from +0.58/+0.68/+0.83 to
roughly ±0.03–0.19). **DSC07349 was not merely "unfixed" as the brief
anticipated — it measurably worsens under both candidates**, from −0.278
(current) to −1.049 (A) / −0.959 (B): current's weaker, shallower curve
happens to sit closer to this scene's own (already-too-bright, per base-6/7)
transfer than either steeper refit does; both candidates apply MORE
midtone lift than current, which pushes an already-too-bright scene
further past LR. This is consistent with — not contradicting — base-7's
"per-shot, structurally out of reach" verdict for DSC07349: no curve fit on
the other scenes was ever going to help it, and a curve that fixes the
other 4 better necessarily moves further from whatever accidentally-close
alignment the current shallower curve has with this one outlier.
DSC03298 gets WORSE under both candidates than under current (+0.149 →
−0.760 / −0.594) — expected per base-7c §2 (it never joins the cluster) —
but note current's own +0.149 is itself not "correct", just closer to zero
by coincidence of an under-fit shallow curve; A/B's more accurate curve for
the other 4 scenes necessarily overshoots this one further in the dark
direction (steeper curve ⇒ more midtone lift ⇒ a scene that's already
naturally darker than the cluster gets pushed relatively further dark by
the SAME absolute-input-value curve, since DSC03298's own tonal
distribution sits low — see base-7c's own reconstruction, −0.646 stops
under the cluster curve, cross-checked here at −0.760 via the real render;
same ballpark, different pipeline).

### 3. Color side-effect check — real, measurable, and expected

`toneCurve.rgb` composes the per-channel curve first, then the RGB master
curve, "so the shader does exactly one lookup per channel"
(`developNode.ts:572-573`) — i.e. the master curve is applied to R, G, B
**independently**, not to a derived luma channel (matching Lightroom's own
"RGB" channel point-curve architecture). A monotonic nonlinear per-channel
remap is not ratio-preserving in general, so some near-neutral color drift
between candidates is expected, not a bug. Spot-checked on DSC03298 (the
brief's suggested scene — also the largest WB/color outlier, a useful
stress case), same Lab C\*<6 mask methodology as §3a of this document (mask
built from LR's own base JPEG, 46.5% of frame — cross-checked exactly
against this doc's earlier 46.5%/0.6762/1.5165 numbers):

| render | R/G | B/G |
|---|---|---|
| LR (self, target) | 0.6763 | 1.5164 |
| current (shipped) | 0.6583 | 1.6987 |
| curve A | 0.6713 | 1.5844 |
| curve B | 0.6809 | 1.5866 |

Drift relative to "current" (isolates the curve's own effect, holding the
DCP/profile stages fixed): **curve A: ΔR/G +1.98%, ΔB/G −6.73%. Curve B:
ΔR/G +3.44%, ΔB/G −6.60%.** Real and non-negligible — B/G moves by ~6.7%
purely from swapping the tone curve, on top of whatever the DCP/profile
stages already contribute to this scene's known B/G error. Both candidates
happen to move DSC03298's ratios TOWARD the LR target on both axes here
(R/G 0.658→0.671/0.681 vs target 0.676; B/G 1.699→1.584/1.587 vs target
1.516) — a coincidental partial improvement, not something either curve
was fit to do (both fits are luma-only; the WB/color axis is a completely
separate, unrelated mechanism per base-7c §2's "two independent defects"
finding). Since this is inherent per-channel-curve architecture (LR's own
point curve works the same way), it is not something a future curve fit
should try to "fix" — just something worth remembering when reading
future WB/neutral-ratio regressions: part of any observed shift could be
curve-driven, not DCP/profile-driven.

### 4. Choice-aid artifact

Eyeball comparison strips (LR | current | A | B, full 2048px-long-edge
renders) for DSC03298 (the bridge) and DSC06787 (a clean cluster scene),
plus the 5-scene summary table from §2, published to
`test-artifacts/base5r-choice/index.html` (gitignored; plain static page,
no design system — a working choice aid, not a report). Source images
copied from this session's `scratchpad/base4-diag/{acrlook-base-exports,
curveA-exports,curveB-exports}/` and LR's own
`~/Desktop/FFF/lr-calib/lr-sweep-20260901/base/`.

### Recommendation: candidate A

**Ship curve A** (the 3-scene cluster fit) as `ACRLOOK_BASE_CURVE`'s
base-5r refit, exactly as base-7c's own §3 already recommended before this
pass had real-render evidence to confirm it. Reasoning, weighted toward
"LRの見た目再現" (matching LR's look) for the user's actual most-eyeballed
scene:

- **On the 3 clean scenes, A and B are nearly tied** (both closely track
  the same in-sample fit, since 3 of B's 4 training scenes overlap A's
  entire training set) — B's small use of DSC03298 in its training data buys
  it a slightly better DSC06787 number (+0.046 vs A's −0.075) but a worse
  DSC09305 number (+0.186 vs A's +0.089) and worse LOSO robustness on
  every shared scene (§1). Not a clear win either way on the scenes both
  curves are actually trying to serve.
- **On DSC03298 specifically — the user's most-eyeballed scene — B is only
  marginally less bad than A** (−0.594 vs −0.760, a 0.166-stop difference)
  while accepting real costs elsewhere (worse LOSO robustness on the clean
  scenes, and B's own in-sample DSC03298 residual of −0.593 proves this
  gap is NOT closable by curve-fitting at all — B is not "partially fixing"
  DSC03298, it is spending fit capacity on a scene that structurally
  cannot benefit, at the other three scenes' expense). Base-7c already
  proved (§2, the −0.641 vs −0.646 near-zero-difference finding) that even
  a black-level-corrected DSC03298 doesn't join the cluster; this pass
  independently confirms via real end-to-end renders that a curve fit
  aimed partway at DSC03298 doesn't meaningfully help it either. **The
  0.166-stop gap does not read as a visible difference in the eyeball strip
  at `test-artifacts/base5r-choice/index.html`** — both A and B render
  DSC03298 clearly darker than LR, indistinguishably so to the eye; the
  actual fix for the bridge's gap is not in the curve-fit design space this
  task explores (per base-7c/base-7b: it needs either libraw-level
  `cblack[4]` access or acceptance as a documented outlier).
- **Curve A is the simpler, more principled design**: fit only on scenes
  the curve can actually serve well, document DSC03298/DSC07349 as
  separate open outliers (already this document's standing recommendation
  since base-7c), rather than diluting the fit with an outlier's pixels for
  a marginal, non-visible gain on that outlier and a measurable LOSO-
  robustness cost on the scenes that matter.

Net: **A is not just simpler but strictly better on every scene except a
statistically-noise-level margin on DSC03298 that base-7c already showed
isn't fixable by this mechanism.** Recommend shipping curve A, documenting
DSC03298 and DSC07349 as before (now with fresh real-render numbers: A
regresses DSC03298 to −0.760 and DSC07349 to −1.049 relative to today's
shipped curve — both already-known outliers moving further from LR, an
expected and accepted trade-off of fitting the curve correctly for the
scenes it can serve, not a new problem this pass introduced).

### Gates

No repo/engine files were changed this pass (`git status` clean at
`c5f5b94` throughout, confirmed before and after) — typecheck/vitest/verify
chain unaffected by construction, not re-run per the brief (analysis-only,
curve injected via the test-mode `setToneCurvePoints` debug hook, no
subagents). The two new scratchpad scripts
(`render-acrlook-custom-curve.mjs`, `measure-color-sideeffect.mjs`) are
one-off diagnostics, not wired into any verify script.

### Honest residuals / next steps for whoever picks this up

1. §3's color-side-effect check used only DSC03298 (the brief's suggested
   spot-check scene, also the largest color outlier) — a clean scene
   (e.g. DSC06787) was not spot-checked the same way; the qualitative
   claim ("per-channel curve ⇒ real but small ratio drift, a few percent")
   should generalize since it follows directly from the shared
   `developNode.ts` mechanism, but the exact magnitude on a clean scene is
   unmeasured.
2. §2's real-render pooled-mean numbers (current +0.390, A −0.364, B
   −0.254) are unweighted-per-scene means, matching this document's
   existing convention (`fit-acrlook-curve.mjs measure`'s own pooled-mean
   line) — note this is a DIFFERENT weighting than §1's n-weighted
   pooled-pixel fit itself, consistent with how every other measurement in
   this document reports "pooled mean" (unweighted-per-scene) vs "fit"
   (n-weighted-pixel) separately; don't conflate the two when reading
   across sections.
3. This pass did not re-derive or question base-7c's own decision to
   exclude DSC07349 from curve B's training set ("decode-blocked" per the
   brief) — base-7/base-7b's own findings (color divergence is per-shot,
   underivable, unrelated to luma-curve fitting) are the standing
   justification, unchanged here.
4. The candidate curve is not yet landed in `engine/color/baseCurve.ts` —
   per the brief, that's a follow-up tiny commit after the user picks
   between A and B (or requests a different design entirely) using this
   pass's tables and the `test-artifacts/base5r-choice/index.html` eyeball
   strip.

## Stage base-8 (prevalence): fork NOT justified — the black-level outlier is rare

54 measurable scenes (hstudio_running + ref-green, LR base vs silverbox
builtin decode+WB, base-7b C*<6 mask; 1 unmeasurable <2% mask). Near-
neutral channel-ratio error distribution:

| axis | median | p75 | p90 | max |
|---|---|---|---|---|
| \|R/G\| | 1.1% | 2.0% | 3.9% | 16.4% |
| \|B/G\| | 0.5% | 1.3% | 2.6% | 10.5% |

- **0/54 reach DSC07349's class** (its decode error was R/G +44% / B/G −27%). Nothing in this 54-scene set comes remotely close — the worst single scene (DSC03056) is +16.4%/+10.5%, less than half of 07349's severity.
- Only **1/54 (2%)** exceeds 10% on either axis; **4/54 (7%)** exceed 5%. The bulk sit at ±1-2%, i.e. as clean as the good Italy scenes.
- **VERDICT: do NOT fork/patch libraw-wasm.** The per-shot black-level divergence severe enough to matter is rare (≤2% at a moderate threshold, 0% at 07349's severity) and shows no shootable-condition clustering in this set. DSC07349 stays a documented decode-level outlier; the fork's proven-but-large cost isn't repaid. Revisit only if the user's real editing surfaces it repeatedly on a specific body/condition.

Caveat: this set is a different body than the A7C2 (07349's camera); black-level behavior can be body-specific, so this bounds prevalence for THESE bodies. If the user shoots the 07349 body heavily in high-DR/backlit conditions, a targeted re-measure on that body's shots is the cheap re-check.
