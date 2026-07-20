# Brief: look-extraction mode 2, stage 1 — signature + tone solve (the spike)

Status: LANDED 2026-07-20 (SUITE 72/72, unit 270; conductor double-check passed — recovery proof real, placeholder honest). NEXT: Italy-set visual validation before stage 2. Parent: docs/brief-bank/look-extraction.md
(Mode 2 + the "Mode 2 solve well-posedness" section — READ BOTH). This
is the design's OWN checkpoint: "worth a spike checkpoint after the
signature + curve-solve land (validate on the Italy set before building
the full solver)." So stage 1 lands ONLY the first freeze stage (luma
tone) end-to-end + the signature module, unit-tested against a KNOWN
injected look. The remaining freeze stages (global chroma → HSL bands →
wheels → grain) are stage 2, gated on this spike's visual validation.

## Scope of stage 1 (decided)

1. **`engine/look/signature.ts`** (new, pure, unit-testable): image set
   → aggregate signature. Stage 1 needs only the LUMA-side components
   the tone solve consumes: the luma percentile vector (p2..p98 at a
   fixed set of percentiles) computed over the decoded, oriented pixels
   of each reference image, aggregated across the set (per-percentile
   median across images — robust to one odd frame). Compute luma with
   the engine's existing luma weights (find them — WORKING_LUMA / the
   B&W mixer's provisional weights; reuse, don't invent). Define the
   full `Signature` TYPE now (all components the parent lists — chroma,
   HSL bands, wheels, grain) but stage 1 only POPULATES + uses the luma
   percentiles; leave the rest as clearly-marked TODO fields the solver
   stage will fill. Pure: takes decoded pixel buffers, returns numbers;
   no file/IO inside the module.
2. **`engine/look/solve.ts`** (new, pure): the tone-curve solve ONLY
   (freeze stage 1 of the well-posedness order). Given the reference
   signature's luma percentiles and the SAME percentiles of a neutral
   baseline (see 3), fit a tone curve that maps baseline→reference by
   percentile matching — REUSE the base-curve fitter's method
   (scripts/fit-base-curve.mjs / engine/color/baseCurve.ts — read how it
   maps percentiles to control points; the same PCHIP control-point
   shape the point ToneCurve uses). Output: a `curves` family
   DevelopParams fragment (the point-curve control points). Do NOT solve
   exposure separately (exposure and a curve lift are the same DOF
   against a percentile vector — the curve absorbs it, per the parent's
   well-posedness note). Emit a report struct: which components were
   solved (tone) vs deferred (everything else), with the residual
   percentile error after fit.
3. **Neutral baseline**: stage 1 uses the SIMPLEST honest baseline —
   the fixed-look decode of the reference images THEMSELVES before the
   solve (i.e. fit the curve that moves the set's own current tone
   toward... nothing yet). WAIT — that's circular. Instead: stage 1's
   baseline is a FIXED reference-corpus percentile constant table. Since
   the bundled-corpus table (parent's design) isn't built yet, stage 1
   ships a PLACEHOLDER baseline = the standard identity/linear-tone
   percentile distribution of a known neutral (document it as
   placeholder, to be replaced by the real bundled-corpus table in
   stage 2). The unit test doesn't depend on the placeholder's realism
   (see Verify): it injects a known curve and checks recovery.
4. **CLI wiring**: extend the existing `--extract-preset` mode (mode 1
   landed as `--extract-look`/consensus — find its cliArgs entry) with
   `--from-references <images…>`. Stage 1 runs signature + tone solve
   headless and writes a preset file (serializePreset) containing only
   the solved `curves` family + a report to stdout (NDJSON under
   `--json`, matching mode 1). Files-only boundary (parent): no network,
   no scraping — folders/globs of local files only.

## Read before writing

look-extraction.md (both the Mode 2 section AND "Mode 2 solve
well-posedness"), engine/color/baseCurve.ts + scripts/fit-base-curve.mjs
(the percentile→control-point method to REUSE), the point ToneCurve op
(control-point shape, PCHIP), engine/graph/presetDoc.ts serializePreset,
the mode-1 extract path in cliArgs.ts + appStore/CLI (how
--extract-look decodes a set and emits a preset — stage 1 mirrors its
plumbing), the luma-weight constant (WORKING_LUMA / bw mixer).

## Verify (new verify-lookextract2.mjs + unit tests)

Unit (vitest, pure — the real correctness proof): take a test image,
apply a KNOWN tone curve to produce a synthetic "reference", extract its
signature, solve, and assert the recovered curve reproduces the known
curve's luma percentile mapping within tolerance (the injected control
points come back within a few /255 at the sampled percentiles).
Signature: percentile monotonicity, median-across-set robustness (one
outlier frame doesn't dominate).
E2E: `--extract-preset --from-references` over 2 synthetic refs (a known
look applied to test renders) emits a preset whose curves family, applied
on a fresh open, moves luma percentiles toward the refs; report NDJSON
parses; solved=tone, deferred=rest. Register verify:lookextract2 in
package.json (+ verify:serial) and run-verify.mjs; SUITE grows to 72.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
SUITE line). NEVER git add/commit. zsh `=` hazard. Engine invariants
(reuse srgb/luma/curve-fit code, never re-derive). If a script mints its
own SILVERBOX_USER_DATA, seed an isolated libraryDir (playbook hazard).
English code; Japanese only in user-facing CLI text if any.

## Report back

Files touched; where each numbered item (1-4) lives (file:line); the
tone-solve method and how it reuses the base-curve fitter; what's
STUBBED for stage 2 (baseline table, the non-tone signature components);
deviations; fragile spots; SUITE line + unit count. Flag clearly that
this is the SPIKE — recommend the Italy-set visual validation before
stage 2 builds the full multi-family solver.
