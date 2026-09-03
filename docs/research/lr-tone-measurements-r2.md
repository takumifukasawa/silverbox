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

---

## Round-3 addendum (2026-09-03): the sub-σr response curve — the dead zone does not exist

18 additive probes (`gen-tone-experiments-r3.mjs`): a 64px patch offset from a fixed surround by 0.5–5 stops (shadows probe: surround 50%, patch darker; highlights probe: surround 2%, patch brighter). Patch-center delta-over-base, stops:

| \|offset\| | sh_p100 (surround 50%) | sh_p50 | hi_m100 (surround 2%) |
|---|---|---|---|
| 0.5 | +0.002 | +0.001 | −0.016 |
| 1 | +0.016 | +0.008 | −0.529 |
| 1.5 | +0.141 | +0.070 | −0.767 |
| 2 | +0.298 | +0.149 | −1.093 |
| 2.5 | +0.473 | +0.236 | −1.371 |
| 3 | +0.620 | +0.310 | −1.621 |
| 3.5 | +0.804 | +0.402 | −1.890 |
| 4 | +0.831 | +0.415 | −1.978 |
| 5 | +1.054 | +0.527 | −3.893 |

Findings:
1. **No dead zone.** The response onsets smoothly around ~0.5–1.5 stops of offset and grows quasi-linearly (≈0.30 stops/stop for Shadows+100 through 3.5 stops; ≈0.55 for Highlights−100 through 4). σr ≈ 4 stops (round-2) governs the OVERSHOOT/halo knee only, not tone-response onset — the fe-tail-only remap formulation (identity inside σr) is wrong.
2. **Slider strength is linear**: sh_p50 = sh_p100 / 2 at every offset (max deviation < 0.002 stops).
3. **The curve retro-predicts round-1's E1 table**: bg=50% (offset 1.47) → 0.13 vs measured +0.131; bg=90% (2.32) → ~0.41 vs +0.495; bg=0.5% (patch +5.2 above surround) → +0.02 vs +0.022. E1 is explained by a pure signed-offset response — no global layer required for it (E6 remains a separate, smaller effect).
4. Cross-terms: hi_m100 also darkens a patch only 0.5 stops below a bright surround (−0.218) — absolute-level dependence coexists with the offset response; the hi_m100 point at offset 5 (−3.89) matches E1's bg0.5 crush (−4.01) at its 5.17-stop offset.

Analysis: patch-center medians via tifffile, gamma-1.8 linearized; results in the harvest directory's analysis-r2/r3-results.json.

---

## Round-4 addendum (2026-09-03): DR-spread amplitude law — a real but small percentile-relative term for Shadows, a bigger and noisier one for Highlights, and neither reproduces the real-photo secant

9 additive frame-filling scenes (`gen-tone-experiments-r4.mjs`): 1024² canvas split left/right into dark/bright halves so p25=dark, p75=bright exactly and realized p90−p10 = nominal spread S (confirmed numerically to 3 decimals — probe patches are too small, ~0.4%/patch, to move frame percentiles). Two sets: `b050` (bright=0.5, S∈{0,2,4,6,8,10}) and `b0125` (bright=0.125, S∈{0,4,8}, the absolute-vs-relative disambiguator). Probes: 64px squares, `sh` band in the bright half at offsets {1,2,3,4} stops below p75, `hi` band in the dark half at offsets {1,2,3,4} stops above p25 (clip-skipped past 0.9). Metric: delta-over-own-base = log2(configLinLuma/baseLinLuma), central 32px of each patch, tifffile + gamma-1.8 linearize (same discipline as rounds 1–3; base readback matched declared patch values to <0.1% everywhere, confirming patch placement/decode correctness).

**sh_p100 delta vs S, b050 (stops):**

| offset | S=0 | S=2 | S=4 | S=6 | S=8 | S=10 |
|---|---|---|---|---|---|---|
| 1 | 0.266 | 0.208 | 0.104 | 0.119 | 0.149 | 0.182 |
| 2 | 0.327 | 0.355 | 0.183 | 0.209 | 0.260 | 0.318 |
| 3 | 1.021 | 0.785 | 0.261 | 0.298 | 0.372 | 0.455 |
| 4 | 1.126 | 0.964 | 0.305 | 0.388 | 0.483 | 0.591 |

**hi_m100 delta vs S, b050 (stops):**

| offset | S=2 | S=4 | S=6 | S=8 | S=10 |
|---|---|---|---|---|---|
| 1 | −0.928 | −0.825 | −0.841 | −0.393 | −0.272 |
| 2 | −1.293 | −1.553 | −1.331 | −0.788 | −0.621 |
| 3 | — | −2.262 | −2.142 | −1.475 | −0.968 |
| 4 | — | −2.337 | −3.186 | −2.505 | −1.234 |

**1. ceiling_sh(DRspread) is U-shaped, not monotonic — and only the S≥4 arm is a clean law.** All four offsets peak at S=0, fall sharply to a minimum at S=4, then rise **linearly** from S=4→S=10 (least-squares fit, R²=0.97–0.997): `delta_sh(offset, S) ≈ intercept(offset) + slope(offset)·S` for S∈[4,10], with slope growing roughly proportionally to offset — slope₁=0.0131, slope₂=0.0229, slope₃=0.0327, slope₄=0.0478 stop/stop (≈0.012×offset). The S=0→S=4 falling arm is NOT a clean law (see finding 4 — it's a measurement-design artifact, not physical DR-dependence) and should not be used for fitting. **Curve shape changes with S, then converges**: normalized to offset=4, the offset1:2:3:4 ratio is knee-shaped at S=0/2 (0.24:0.29:0.91:1.0 / 0.22:0.37:0.81:1.0 — weak until offset≈2.5–3, then jumps) but settles onto a **stable, S-independent shape for S≥6**: 0.307:0.538:0.769:1.0 identical to 3 decimals at S=6, 8, and 10.

**2. Highlights DR dependence: real, refutes "none" — but noisier and non-monotonic.** hi_m100 shows a clear trend with S over the reliable S≥4 range (weakening crush magnitude as S grows), confirmed NOT to be an absolute-value artifact by the b0125 cross-check (finding 3). Linear fits over available S: offset1 slope=0.087 (R²=0.86), offset2 slope=0.106 (R²=0.72), offset3 slope=0.228 (R²=0.94), offset4 slope=0.199 but R²=0.41 — offset4 has a genuine hump (deepest crush at S=6, −3.186, not at the extremes), breaking monotonicity outright. So: DR-dependence is real for Highlights, larger in magnitude than Shadows' (0.09–0.23 vs 0.01–0.05 stop/stop), but the law is not as clean — flagged, not resolved.

**3. Anchor test: strongly percentile-relative, small residual absolute term at S=0.** `b0125` (bright=0.125) vs `b050` (bright=0.5) at matched offset and S, despite probe absolute values differing by 4× throughout:

| offset | S=4 sh_p100 (b050 / b0125) | S=8 sh_p100 (b050 / b0125) | S=0 sh_p100 (b050 / b0125) |
|---|---|---|---|
| 1 | 0.104 / 0.101 | 0.149 / 0.143 | 0.266 / 0.199 |
| 2 | 0.183 / 0.180 | 0.260 / 0.254 | 0.327 / 0.311 |
| 3 | 0.261 / 0.258 | 0.372 / 0.366 | 1.021 / 0.913 |
| 4 | 0.305 / 0.303 | 0.483 / 0.477 | 1.126 / 1.053 |

hi_m100 shows the same pattern (e.g. offset3 S=4: −2.262 vs −2.252; offset2 S=8: −0.788 vs −0.794). At S=4 and S=8 the two brightness sets agree to within ~0.006 stops (sub-2% relative) — essentially exact. At S=0 a real but modest gap opens (7–25% relative, larger at low offsets) — a small absolute-level term coexisting with the dominant percentile-relative mechanism, consistent with round-3's finding #4 (cross-terms exist) but clearly secondary here. **Verdict: percentile-relative anchoring, confirmed with high confidence** (S≥4); the S=0 residual is noted, not fully explained.

**4. Low-DR continuity: FAILS to reproduce round-3 — flagged loudly.** `r4_b050_s0` sh_p100 vs round-3's addendum table (same surround=0.5, same offsets 1–4):

| offset | r4 s0 | r3 | abs diff | ratio |
|---|---|---|---|---|
| 1 | 0.266 | 0.016 | +0.250 | 16.6× |
| 2 | 0.327 | 0.298 | +0.029 | 1.10× |
| 3 | 1.021 | 0.620 | +0.401 | 1.65× |
| 4 | 1.126 | 0.831 | +0.294 | 1.35× |

Does not reproduce within noise at any offset (offset 1 is a dramatic outlier; 2–4 are all elevated by 10–65%). **Root-cause hypothesis (not independently confirmed): a real design confound, not an LR/catalog-state drift.** Round-3 placed exactly ONE 64px patch per file on an otherwise perfectly uniform frame; round-4's S=0 file packs FOUR probe patches (offsets 1–4 simultaneously) into the same frame. The frame-percentile check (p10/p90 both pinned to the 0.5 background) rules out a simple "percentile shift" explanation — the patches are too small to move p10/p90 — so if the multi-probe design is the cause, the mechanism must be something other than global percentile position (a genuine local/whole-image adaptivity to the mere presence of additional shadow-valued content elsewhere in frame, echoing Q3/E6's "more dark content → more lift" but operating far below E6's percentile-moving threshold). **Practical consequence: round-4's absolute S=0 values should not be trusted as a zero-DR baseline or reconciled against r3 at all** — only the internal S-trend within round-4's own (constant multi-probe) design is usable for law-fitting, which is why finding 1 restricts the clean fit to S≥4.

**5. Slider law under DR: linear, no DR-dependent nonlinearity.** sh_p50 / sh_p100 = **0.500 ± 0.0004** at every single (offset, S) combination tested (24 points, b050 set) — the slider halves the effect identically regardless of scene dynamic range. This extends round-3's finding #2 (slider linearity at fixed surround) cleanly into the DR-varying regime: no evidence the "DR term" from the real-photo diagnosis's 1.9–2.35 slider-ratio deviations enters through the slider itself; it must live in the ceiling/amplitude term instead.

**6. Reconciliation with the real-photo secant — does NOT retro-predict it, and favors "different mechanism" over "E6 doesn't move percentiles."** The stage-1e real-photo diagnosis estimated ≈0.35 stop/stop (Shadows, offset 3, real-photo DR 4.4→7.6). Interpolating round-4's clean S≥4 law to the same window: offset 3 secant = **0.0277 stop/stop** (least-squares slope over S=4..10: 0.0327) — **12–13× smaller** than the diagnosis's estimate. For comparison, round-2's E6 corner-patch law (Q3) gives a similar-magnitude slope, ≈0.02 stop/stop (dr4→dr12, realized spread 4.0→8.4, confounded with falling corner mean). **Round-4's half-frame design genuinely moves frame percentiles by exactly S stops (verified numerically) yet still produces a slope in the same small ballpark as E6's corner patches, which do NOT move percentiles.** This is evidence AGAINST the brief's "E6's corner geometry just doesn't move the frame percentiles" hypothesis — if percentile-movement were the missing ingredient, round-4 should have shown a much larger slope than E6, and it did not. The ~150–350× gap to the real-photo secant is therefore more likely a **different mechanism entirely** — most plausibly something that only a continuous, structured real-photo histogram (or genuine spatial/textural local-adaptivity) can trigger, which these two-flat-region synthetic scenes cannot recreate by construction. Notably, **Highlights comes much closer**: hi_m100's offset-3 secant over the same window is 0.197–0.228 stop/stop (finding 2), only 1.5–1.8× short of 0.35 — raising the possibility that the real-photo diagnosis's ~0.35 stop/stop figure, attributed to Shadows, may have partly reflected a Highlights-band or cross-band effect, or that Shadows and Highlights genuinely have very different DR-sensitivity magnitudes that the diagnosis's real-photo sample (limited scenes) didn't separate cleanly.

**ev1_sh50 cross-check (kept minimal per scope):** `ev1_sh50` (Exposure+1 combined with Shadows+50) delta ≈ `sh_p50 delta + 1.0` almost exactly at every unclipped probe (e.g. offset4 sh: 1.1522 vs sh_p50+1=1.1523; offset3 hi: 1.1306 vs 1.1306 exact), consistent with roughly additive composition of Exposure and Shadows in log2 space; the one large miss (hi4: 0.598 vs 1.013) is a highlight-clipping case (dark-half hi4 pushed to ~1.0 linear by the +1 EV before Shadows is even applied). No further exploration attempted — matches the brief's scope note.

**Confidence:** **high** for the S≥4 shadows law's shape and slope-vs-offset relationship (R²=0.97–0.997, cross-confirmed by the b0125 percentile-relative match to <2%); **high** for percentile-relative anchoring (finding 3); **high but unresolved** for the r3 non-reproduction (the measurement itself is solid — the *explanation* is a plausible, not confirmed, hypothesis); **moderate** for the highlights law (real, but noisier, R² as low as 0.41, non-monotonic at offset 4); **moderate** for the reconciliation verdict in finding 6 — it rules out one specific brief hypothesis with reasonably strong evidence but does not identify the true mechanism behind the real-photo secant.

Analysis: scripts, `results-r4.json`, `results-r4-raw.json`, `results-r4-percentiles.json`, and 3 plots (`plot1-delta-vs-S.png`, `plot2-b050-vs-b0125.png`, `plot3-s0-vs-r3-continuity.png`) are in the harvest directory's `analysis-r4/` subfolder.
