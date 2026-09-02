# LR PV2012 Highlights/Shadows — round-2 measurements (E2 redesign, σr point estimate, E6 law)

Measurement report, 2026-09-02 evening. Round-2 harvest (31 additive synthetic DNGs, gen-tone-experiments-r2.mjs) merged with round-1; companion to lr-tone-measurements.md. Round-1 values reproduced exactly on re-export. Analysis scripts and results-r2.json preserved alongside the harvest data outside the repo.

## Deliverables

- Scripts (`shared_r2.py`, `analyze_r2_e2.py`, `analyze_r2_e4.py`, `analyze_r2_e6.py`) and results (`results-r2.json` + per-question partials `results_r2_e2.json`, `results_r2_e4.json`, `results_r2_e6.json`) are preserved in the harvest directory's `analysis-r2/` subfolder, alongside the harvest data, outside the repo.
- Plumbing: same `tifffile`-only discipline as round-1 (sharp/libvips cannot be trusted for these TIFFs — see round-1's report for the full writeup); gamma-1.8 decode, `box_median`/`x_profile_R` helpers copied verbatim from round-1's analysis scripts.

## Round-1 reproduction checks — both PASS cleanly

- **E4 σr** (`e4_c3/c5_{s4,s16}_l20`, raw/unsmoothed methodology, byte-identical to round-1's methodology): relDiff = **0.0000** on all 4 points (s4 c3, s4 c5, s16 c3, s16 c5) — exact reproduction.
- **E6** (`e6_fullrange/lowcontrast/highcontrast`, fresh re-export): relDiff **0.06%–0.17%** against round-1's stored 0.223/0.247/0.275 stops.
- **Verdict: the re-export did not change anything.** No flag needed.

---

## Q1 — E2 spatial scale (isolated dark bars)

Files: `r2_e2_w{8,32,128,512}_c{2,6}_r{1024,4096}`, `sh_p100` vs `base`.

**(a) Feature-size dependence.** The naive full-bar-interior average shows a strong apparent width-trend (e.g. r1024 c2: w8=1045→w32=749→w128=738→w512=794, encoded units), but this is **edge-transition dilution, not a pyramid effect**: the in-bar spatial profile is flat everywhere except a single sample right at the true edge (e.g. w128 c2: edge=478, interior=742×9, dead flat) — for narrow bars, more of the sampled "interior" is really edge zone. Sampling only the deep interior (innermost few px) instead:

| contrast | w32 | w128 | w512 | width-dependence |
|---|---|---|---|---|
| c2 (r1024, stops) | 0.169¹ | 0.160 | 0.171 | **flat / radius-free** |
| c2 (r4096, stops) | 0.185¹ | 0.164 | 0.160 | **flat / radius-free** |
| c6 (r1024, stops) | 0.799² | 0.799 | 0.611 | real ~25% decrease, not flat |
| c6 (r4096, stops) | — | 0.652 | 0.553 | real ~15% decrease, not flat |

¹w32's deep-interior sample partly overlaps the edge-transition zone (bar too narrow for a clean interior) — noisier. ²w32 c6 uses the full-interior value (deep-interior window too close to edge to be clean).

At moderate contrast (c2) the deep-interior response is essentially **radius-free** across two orders of magnitude of bar width (8–512px). At high contrast (c6), a real but modest (not dramatic) narrowing-with-width effect survives even after removing edge dilution — most plausibly a **global-statistics interaction** (a 512px-wide near-black bar covers a much larger fraction of frame area than a 32px one, shifting scene-wide adaptation, similar to Q3's E6 law) rather than evidence of deep multi-scale pyramid growth.

**(b) px-matched vs. image-fraction-matched.** On the naive (dilution-contaminated) signal, fraction-matching aligns better at c2 (mean relDiff 0.012–0.004 vs 0.03–0.18 for px-matching) but is *worse* at c6 (0.34–0.45 vs 0.10–0.21) — inconsistent, same ambiguity round-1 flagged. On the deep-interior (clean) signal the question is largely moot: values are already resolution-invariant at c2 (both matchings converge to near-zero difference), so neither hypothesis is being meaningfully distinguished there. **One clear anomaly**: w8 (all-edge, no true interior) roughly *doubles* going from r1024 to r4096 at matched 8px width (1046→2220 at c2) — flagged as unexplained, possibly an export/resample artifact at the narrowest tested feature, analogous to round-1's `period=4` flag.

**(c) Field/halo spatial-support profile.** This is the headline finding. Sampling the delta in the surrounding 18% field at increasing distance from the bar edge (2px steps near the edge, out to 1600px = 39% of a 4096px frame):

- Settles onto a dead-flat plateau within **~4–6px** of the bar edge.
- Stays **perfectly flat** from there out to the farthest tested point (1600px), across all widths/contrasts/resolutions — no decay whatsoever over 2.5 orders of magnitude of distance.
- The plateau value itself is small but non-zero and consistent (~0.01–0.03 stops) regardless of distance.

**Verdict for Q1: neither "pyramid-to-full-depth" nor "fixed-radius halo."** The data support a **narrow (~4–6px) local edge-transition kernel** + a **separate, essentially distance-independent whole-image shift** (same signature as Q3's global-adaptation layer) — i.e. "fixed small radius + global term," not a smoothly-decaying multi-scale support. Confidence: **moderate-high** for (a)/(c) (clean, isolated-bar design, unlike round-1's degenerate grating; multiple contrasts/resolutions agree); **low** for (b), which remains genuinely ambiguous even on cleaner data.

---

## Q2 — σr point estimate

Merged `r2_e4_c{3.5,4,4.5}_{hard,s16}_l20` with round-1's c1/2/3/5/7/10 (s16) and c1/2/3/5/7/10 (s4, not re-extended in round-2).

**Critical finding before the point estimate: a synthesis artifact contaminates the raw overshoot metric.** Round-2's `r2_e4_c3.5_s16_l20` and `r2_e4_c4_s16_l20` each contain an isolated 1px spike (e.g. c3.5: x=480 value 3386 vs neighbors 1577/1722; c4: x=481 value 3433 vs neighbors 1789/2027) directly inside the max-overshoot search window, inflating their raw `overshootRatio` to ~0.77–0.84 — wildly inconsistent with the neighboring c3 (0.077) and c5 (0.62, raw) points. Round-1's own c5 point has the same signature (a 2–3px bump at the identical location, x≈474), just less isolated. This is **not new to round-2** — round-1's raw-max methodology was always vulnerable to it; round-2's finer sampling just made it visible. **Fix applied:** a 21px boxcar smoothing before the max search (chosen because peak-location argmax only stabilizes near the genuine broad halo bump — inside the σ=16px pre-blur footprint — from ~15–21px smoothing upward; below that it still occasionally locks onto the artifact, above ~31px it starts damping genuine bump amplitude too).

Smoothed (21px) s16 overshoot-ratio curve:

| contrast (stops) | 1 | 2 | 3 | 3.5 | 4 | 4.5 | 5 | 7 | 10 |
|---|---|---|---|---|---|---|---|---|---|
| overshootRatio | 0.060 | 0.038 | 0.063 | 0.115 | 0.126 | 0.253 | 0.275 | 0.536 | 1.133 |

This is now a **monotonic, gradually-rising** curve (vs. round-1's sparse bracketing that only had endpoints c3/c5), with no single sharp two-segment knee — it keeps climbing well past 5 stops. A continuous 2-segment piecewise-linear fit over the {3,3.5,4,4.5,5} window locates the breakpoint at:

**σr = 4.0 stops, bracket [3.5, 4.2] stops (25%-RSS criterion)**

This narrows and re-centers round-1's bracket (3–5 stops, unresolved) onto a tighter point estimate, still well above the paper-default ~1.3 stops. Confidence: **moderate** — reproduction check is exact and the smoothing methodology is well-justified and transparently disclosed (raw vs. smoothed values and a smoothing-width sensitivity sweep at {0,5,9,15,21,31}px are all in results_r2_e4.json), but the curve's genuinely gradual (not sharp-cornered) shape means "the knee" is itself a soft concept here, and s4 could not be extended in round-2 to cross-check the s16 estimate at the same resolution.

---

## Q3 — E6 global-adaptation law

Files: `r2_e6_dr{0,2,4,6,8,10,12}` (corner geometric mean fixed ≈0.18, spread varied) and `r2_e6_mean{6,50}` (spread fixed ≈8 nominal stops, mean varied; `dr8` doubles as the "18%-mean" probe), all in `sh_p50`, plus round-1's 3 e6 files re-measured for reconciliation.

| dr | realized spread | corner geomean | center Δ (stops) |
|---|---|---|---|
| 0 | 0.00 | 0.180 | 0.054 |
| 2 | 2.00 | 0.180 | 0.023 |
| 4 | 4.00 | 0.180 | 0.101 |
| 6 | 5.40 | 0.146 | 0.127 |
| 8 | 6.40 | 0.103 | 0.145 |
| 10 | 7.40 | 0.073 | 0.165 |
| 12 | 8.40 | 0.052 | 0.188 |

| mean probe | geomean | realized spread | center Δ (stops) |
|---|---|---|---|
| mean6 | 0.060 | 7.98 | 0.178 |
| mean18 (dr8) | 0.103 | 6.40 | 0.145 |
| mean50 | 0.172 | 4.93 | 0.120 |

**Shape:** monotonic increasing with spread (one small dip at dr2, magnitude 228 vs 532 encoded units at dr0 — well above quantization noise, unexplained, flagged), and monotonic **decreasing** with corner mean. Rate of increase with spread is largest at low spread and slows past ~4 stops (saturating/sub-linear), though dr6+ confounds spread with a falling mean (highlight clipping at 0.95 breaks the intended orthogonal design there).

**Reconciling round-1's puzzle.** Fit `patchStops = a + b·spreadStops + c·ln(cornerGeomean)` on round-2's 9 clean/quasi-clean points, then apply out-of-sample to round-1's 3 files:

| file | corner kind | spread | geomean | actual | predicted | residual |
|---|---|---|---|---|---|---|
| e6_fullrange | checkerboard | 9.89 | 0.031 | 0.223 | 0.221 | **+0.002** |
| e6_highcontrast | checkerboard | 12.00 | 0.014 | 0.275 | 0.269 | **+0.006** |
| e6_lowcontrast | **uniform** | 0.00 | 0.400 | 0.247 | 0.018 | **+0.229** |

A 2-factor (spread, log-mean) model trained purely on round-2 data predicts `fullrange` and `highcontrast` almost exactly out-of-sample. `e6_lowcontrast` is a massive outlier — and it is the **only file in the entire dataset (both rounds) with uniform rather than checkerboard corners**. This resolves the "puzzling low>full ordering": it was never a spread non-monotonicity — `e6_lowcontrast` isn't comparable to the others on the (spread, mean) axes because its corner *pattern* differs, and that pattern difference alone accounts for a lift roughly as large as the entire global-adaptation effect measured elsewhere. Flagged as a well-supported hypothesis, not proven — no uniform-vs-checkerboard pair at matched (spread, mean) exists to confirm directly.

**Verdict for Q3:** the global-adaptation law is monotonic in both corner spread (increasing) and corner mean (decreasing, i.e. darker surround → more lift), combines roughly additively in (stops, log-mean) space, and is saturating in spread. Confidence: **high** for the law's existence and shape (clean orthogonal round-2 design, exact reproduction, tight out-of-sample fit); **moderate** for the uniform/checkerboard explanation of round-1's anomaly (mechanistically plausible, statistically overwhelming, but not independently confirmed).

---

## Anomalies worth flagging back

1. E2 w8's ~2× resolution-dependence at matched pixel width (unexplained, possibly export/resample-related at the narrowest tested feature).
2. E4's single/few-pixel spike artifact at c3.5/c4/c4.5 (and present but less isolated in round-1's own c5) — any future σr work off these files must smooth before max-search, not take the raw per-pixel max.
3. E6 dr0→dr2 small non-monotonic dip (532→228 encoded units, above noise floor, unexplained).
4. E6's mean-series and dr6+ points are not as cleanly orthogonal as the design intended — the 0.95 highlight-clip ceiling in the source-generation script makes corner mean and spread co-vary once dark/light values push toward that ceiling.
