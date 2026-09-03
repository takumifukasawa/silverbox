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
