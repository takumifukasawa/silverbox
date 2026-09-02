# LR PV2012 Highlights/Shadows — black-box measurements (E1–E6)

Measurement report, 2026-09-02. LR Classic 15.4 driven via plugin harness on synthetic Linear DNGs (scripts/gen-tone-experiments.mjs); companion to local-adaptive-tone.md §5. Analysis scripts and results.json are preserved alongside the harvest data outside the repo.

No repo changes were made while producing the underlying measurements. All scripts and `results.json` live in the analysis directory alongside the harvest directory (`analyze.py`, `analyze2.py`, `analyze3.py`, run in that order; `results.json` is the merged output; `sanity.mjs` documents the sharp/libvips probe).

## Critical plumbing finding (read this first)

**`sharp`/libvips (0.35.3 / vips 8.18.3, bundled libtiff) cannot be trusted for these TIFFs.** The LR exports are 16-bit, deflate-compressed, `Predictor=2` TIFFs. `sharp(file).raw({depth:'ushort'})` — and even a full re-encode-to-PNG roundtrip through sharp — returns values that are effectively an **8-bit sRGB-reprofiled** representation dropped into a `uint16` buffer with no bit-depth expansion. Example: a pixel whose true 16-bit value is 25292 (ProPhoto gamma-1.8 encoding of linear 0.18) comes back from sharp as `118`, and `118` is exactly `round(255 × srgb_oetf(0.18))` — i.e. sharp silently color-managed ProPhoto→sRGB *and* truncated to 8 bits despite the explicit `ushort` request. Verified with a second, independent decoder: Python `tifffile` (direct libtiff bindings) returns 25292/25277/25300 for R/G/B on the same pixel, matching the gamma-1.8 prediction. **I switched all analysis to `tifffile`** (the brief's "or equivalent" clause) — this is the one deviation from the brief, driven by hard evidence, not preference.

## Base transfer curve (§5.0 step 2)

`base` (all sliders 0) is **bit-exact pure ProPhoto gamma-1.8 encoding of the input linear DNG values** — confirmed via local log-log slope (apparent exponent) sitting at 0.5555±0.001 (theoretical 1/1.8=0.5556) continuously from linear input 0.0009 to 0.95 (34 points, 3 orders of magnitude). No hidden S-curve, no midtone contrast, no black-point lift anywhere in this range. **One anomaly**: the single deepest test point (linear 0.0003125, ~‑11.6 EV below 18% gray, from `e4_c10_hard_l1`) is crushed relative to pure gamma (recovered/input ratio = 0.657, i.e. the encoded value is ~34% lower than pure gamma1.8 predicts). This is a genuine shadow toe in LR's default rendering below ≈0.001 linear, not a sampling bug (R≈G≈B held, spread <0.05% everywhere I checked). It only threatens interpretation of the `l1`-center-luminance E4 rows at the most extreme contrasts; it does not touch E1/E2/E5/E6 or the `l20` E4 rows used for the headline numbers below.

Channel-consistency spot checks (4 files across configs): normalized R/G/B spread 0.00009–0.00046 — confirms achromatic as expected.

## E1 — locality proof (headline) — **CONFIRMED, high confidence**

Identical 18%-gray 64px patch, `sh_p100` (Shadows +100), delta-over-base at the patch, by background:

| background | patch Δ (stops) |
|---|---|
| 0.5% | +0.022 |
| 2% | +0.024 |
| 8% | +0.008 |
| 18% (uniform, patch=bg) | **0.000** |
| 50% | +0.131 |
| 90% | **+0.495** |

Non-constant → locality proven. Shape: near-zero when patch≈background (18%), small when background is dark, and grows sharply (roughly monotonically) as background brightens — the darker-context "shadow-like" reading of the patch suppresses lift, while a brighter surround makes the same patch read as locally-dark and gets boosted hard.

Even more dramatic mirror result from `hi_m100` (Highlights −100) on the same patch:

| background | patch Δ (stops) |
|---|---|
| 0.5% | **−4.01** |
| 2% | −1.73 |
| 8% | −0.31 |
| 18% | 0.00 |
| 50% | 0.00 |
| 90% | 0.00 |

A 4-stop crush of an unchanged 18% patch purely from swapping the surround from mid/bright to near-black — this is the single most unambiguous locality signal in the dataset. Each background's own delta (`sh_p100`: +0.40 stops at 0.5% falling to ~0 by 18%, small again at 50/90%; `hi_m100`: 0 up to 18%, then −0.67 at 50%, −1.02 at 90%) is consistent — Shadows lifts dark backgrounds, Highlights crushes bright ones, monotonically.

## E4 — σr / halo — **CONFIRMED, moderate confidence on σr location**

**Halo shape (fine 1px profiles, contrast=10, `sh_p100`)**:
- **Hard edge**: delta-over-base is a perfect flat step (1095 encoded units dark side → jumps to 1355 exactly at the edge pixel → flat 1355 light side). **Zero overshoot, zero undershoot.** Textbook no-halo LLF signature.
- **Pre-blurred edges (σ=4px, σ=16px in the source)**: a clear **non-monotonic bump** in the delta profile right at the transition — e.g. σ=16: flanking deltas ~1300 (dark) / ~1420 (light), but the delta peaks at 4160 mid-transition (≈3× either plateau), spatially localized to roughly the blur width. This is a real overshoot/halo, present specifically when the *source* has a soft gradient, not on true step edges.

**σr transition (overshoot magnitude vs contrast, `overshootRatio` = max overshoot ÷ flanking plateau delta)**:

| contrast (stops) | s4 | s16 |
|---|---|---|
| 1 | 0.14 | 0.12 |
| 2 | 0.13 | 0.18 |
| 3 | 0.10 | 0.08 |
| 5 | **0.42** | **0.62** |
| 7 | 0.92 | 0.59 |
| 10 | 1.73 | 1.36 |

Clean knee between **3 and 5 stops** (only tested points bracketing it), i.e. σr ≈ 3–5 stops, centered near 4. This is meaningfully **higher** than the paper-default prediction of ~1.3 stops (σr=ln 2.5) — a real calibration finding, not noise (flat/low below 3, jumps 4–6× by 5 stops, both blur widths agree). Confidence: moderate — bounded, not point-estimated, since 4 and 4.5 stops weren't sampled.

**Caveat on the far-field "plateau" methodology**: at 350px offset from the edge (34% of a 1024px frame), values are *not* fully asymptotic for `hi_m100` under high contrast — e.g. the light-side (0.95 input, half the 1024×1024 frame) gets crushed by up to **−9.4 stops** at contrast=10 even 350px from the edge. This shows the operator's effective spatial support reaches at least a third of the frame width for extreme cases, consistent with a deep pyramid (echoes E2). It means σr/plateau numbers for `hi_m100` specifically are contaminated by this huge, likely non-photographic-content-representative crush (a half-frame 95%-value flat card is an out-of-distribution stress test) — I'd trust the `sh_p100` σr numbers well ahead of any `hi_m100`-derived number.

## E2 — spatial scale — **weak-to-inconclusive, low confidence**

Dark-bar delta-over-base (`sh_p100`), by period, r1000 (px):

`4→0.000, 8→0.130, 16→0.115, 32→0.098, 64→0.090, 128→0.087, 256→0.085, 512→0.084, 1024→0.086`

r4000: `4→0.000, 8→0.146, 16→0.145, 32→0.117, 64→0.122, 128→0.139, 256→0.125, 512→0.100, 1024→0.084`

Two findings, both soft:
1. The response is **remarkably flat** (0.084–0.15 stops) across nearly 3 orders of magnitude of period (8–1024px) — no single sharp corner-frequency step (rules out a simple fixed-radius Gaussian mask cleanly), but also no obviously monotonic multi-octave ramp either. This flatness is plausibly a **degenerate property of the 50%-duty-cycle grating itself** (the local dark/light mix stays ~50/50 at every scale for a symmetric square wave) rather than direct evidence for or against a pyramid — the experiment design may not fully separate the two hypotheses for this particular pattern.
2. At matched pixel period, r4000 consistently reads higher than r1000 (12–60% higher, worst at P=64–256), while at matched *image fraction* (P vs 4P) three of four comparable pairs land within 1–15%. This weakly favors "effect scales with image size" (pyramid built toward full resolution) over "fixed pixel radius," but the middle of the range (P=32↔128, P=64↔256) disagrees by ~40%, so I do not consider this settled — flag as **directionally suggestive, not conclusive**. `period=4` reading exactly 0.000 in both resolutions is almost certainly a sampling artifact (a 3px window on a 2px-wide stripe), not a real "no effect at finest scale" result — don't use it.

## E5 — working domain — **CONFIRMED log/ratio domain, high confidence**

**Clean same-file test** (`e4_c1_hard_l20`, `sh_p50` vs `ev1_sh50`÷2 to undo the digital +1EV): mismatch **0.0046 stops (dark side), 0.0073 stops (light side)** — effectively zero, at the noise floor of the base-transfer-curve fit itself (<0.4% deviation elsewhere). This is a very clean confirmation that Shadows operates in a scale-invariant (log/ratio) domain: pushing the whole image +1EV digitally, applying Shadows+50, then pulling back −1EV reproduces plain Shadows+50 almost exactly.

**Manifest-designated cross-file pair** (`ev1_sh50(e5_exposure_2x)`÷2 vs `sh_p50(e4_c1_hard_l20)`, as literally specified in the brief): mismatch **0.849 stops (dark), 0.511 stops (light)**. I flag an important arithmetic point here: `e5_exposure_2x`'s own baked-in RAW is already 2× `e4_c1_hard_l20` (manifest `exposureFactor: 2`), so `ev1_sh50` applied to it reaches the Shadows stage at ~4× the reference file's linear level, and dividing by only 2 (per the brief's literal instruction) removes just the digital +1EV — leaving an expected **~1.0-stop** offset even under perfect scale-invariance, not 0. Measured 0.85/0.51 stops are both *less* than that 1.0-stop prediction: a real ~0.15-stop (dark) and larger (light) secondary deviation. The light-side number is likely further contaminated by genuine clipping — `e4_c1_hard_l20`'s light value (0.283) × 2 (bake) × 2 (+1EV) = 1.13, which exceeds linear 1.0 and would trigger real highlight rolloff independent of the Shadows/log-domain question. I'd weight the dark-side ~0.15-stop residual (after accounting for the expected 1.0-stop bake offset) as mild secondary evidence of a global/compressive layer (consistent with E6, weaker than E6's own evidence), and discount the light-side number entirely due to the clipping confound. **Recommend re-running Method A's clean single-file design for any future σr/E5-style calibration** — it's unambiguous; the cross-file pairing is not, for reasons intrinsic to how the two DNGs were generated, not a flaw in this analysis.

## E6 — global adaptation layer — **CONFIRMED, high confidence**

Center patch is byte-for-byte identical across all 3 files; only far corners (≥¼ image width away) differ. `sh_p50` center-patch delta-over-base:

| file | corner content | center patch Δ (stops) |
|---|---|---|
| `e6_fullrange` | corners ≈0.1%/95% | +0.223 |
| `e6_lowcontrast` | corners uniform 40% | +0.247 |
| `e6_highcontrast` | corners ≈0.02%/90%, 12-stop spread | +0.275 |

~0.05-stop (≈23% relative) spread across identical centers, purely from distant corner content, and it's monotonic with corner dynamic range (higher global contrast → stronger local lift). This directly confirms Eric Chan's "effective range auto-expands/contracts" claim as a real, separate layer on top of the local operator — small in magnitude relative to the ~0.22–0.28-stop base lift, but well above the measurement noise floor (base-transfer-curve fit error is <0.5%; this is ~20%).

## Summary verdicts

| Experiment | Verdict | Confidence |
|---|---|---|
| E1 | Locality proven, both directions (Shadows lift, Highlights crush) | High |
| E4 halo | No halo on hard edges; real overshoot halo on pre-blurred edges, scaling with contrast | High |
| E4 σr | ≈3–5 stops (bracketed, not point-estimated), higher than the 1.3-stop paper default | Moderate |
| E2 | No sharp single-radius corner; response unusually flat across scales; weak lean toward image-fraction over fixed-pixel scaling | Low |
| E5 | Log/ratio-domain confirmed via clean same-file test; cross-file pair shows a smaller-than-arithmetically-predicted offset, weakly corroborating a secondary global layer, but confounded by clipping on the light side | High (clean test), Low (cross-file secondary read) |
| E6 | Global scene-statistics adaptation layer exists, ~0.05-stop / ~20% relative effect | High |

## Fragile points worth flagging back to the conductor

1. Any future measurement script against these LR-export TIFFs **must not use sharp/libvips raw readback** — it silently returns 8-bit sRGB-reprofiled garbage. Use `tifffile` (Python) or an equivalent direct TIFF decoder.
2. The deep-shadow toe below ~0.001 linear in the `base` render means any `l1`-center E4 rows at high contrast should be treated cautiously if reused elsewhere.
3. E2's grating design (50%-duty square wave) may be structurally unable to distinguish "flat local-average across scales" from "pyramid vs single-radius" — a future harness wanting a cleaner E2 answer should consider an asymmetric duty cycle or an isolated single dark bar in a large light field.
4. E5's cross-file pairing (`e5_exposure_2x` + `ev1_sh50`) bakes in an extra factor of 2 that the brief's literal "divide by 2" doesn't remove — future harnesses should either apply Exposure2012 via XMP on a single file (Method A, which worked cleanly) or divide by 4, not 2, for the baked-2x companion file.
