# Brief: look-extraction mode 2, stage 2 — the full freeze-order solver

Status: DRAFT — dispatch ONLY after stage 1 lands AND its spike passes
the Italy-set visual validation (the design's own gate — a tone-only
extraction that reads right on real references before the color stages
are built). Parent: docs/brief-bank/look-extraction.md ("Mode 2 solve
well-posedness" is the spec for this stage). Builds on stage 1's
engine/look/signature.ts + solve.ts.

## What stage 2 adds (the remaining freeze stages, IN ORDER)

Stage 1 landed freeze-stage 1 (luma tone). Stage 2 fills the rest of
the well-posedness order, each stage FROZEN before the next so every
sub-solve stays identifiable (parent's core insight — do NOT collapse
into one joint optimizer):

2. **Global chroma (saturation + vibrance)** on the tone-fixed image.
   Populate the signature's chroma distribution (median chroma + its
   SKEW). Solve SATURATION from the median chroma, VIBRANCE from the
   skew (vibrance is a low-chroma-weighted boost — it moves the low
   tail, not the median). Two statistics → two params, identifiable.
3. **Per-band HSL (hue centroid + per-band sat)**: signature's per-HSL-
   band mean saturation and hue-centroid shift; map residuals directly
   onto the 8 HSL bands (global level already removed in stage 2-step-2,
   so bands solve the SHAPE, no cross-band degeneracy).
4. **Grading wheels**: shadow/highlight a*b* means (below p25 / above
   p75) → shadow & highlight color directions; midtone wheel = residual
   global a*b*.
5. **Grain amount**: band-limited high-frequency energy metric → grain
   amount scalar (fully decoupled).

Then the small BOUNDED coordinate-descent polish (cpuEvalPlan against
the full signature distance, ± a fraction of each slider's range so it
polishes without re-entering the degeneracies the staging removed).

## The real neutral baseline (replaces stage 1's placeholder)

Stage 1 shipped a placeholder baseline. Stage 2 builds the real one:
the bundled-corpus percentile/chroma/band CONSTANT table (parent's
design — "the statistical average of a bundled reference corpus...
ship the numbers, not the images"). Generate it ONCE from a few hundred
"natural rendering" images the user provides (a script that emits the
constant table; the images never ship, only the fitted numbers, checked
into engine/look/baselineCorpus.ts with provenance in a doc comment).
If the user can't supply a corpus in time, keep an honest documented
single-reference baseline and mark the corpus table as a follow-up.

## Deliberately NOT solved (report as unsupported, parent's list)

Absolute white balance (a reference set's WB is the SCENE's, not the
look's — solving it bakes the references' lighting into every target);
anything spatial (vignette/masks — no per-image pairing); clarity/
texture/dehaze (signature footprint overlaps contrast+grain too much to
identify from aggregate stats in v1).

## Honesty / report

The emitted report states the solve ORDER and which signature component
fixed each family — a traceable derivation, not just values. Same
epistemic status as an LR preset (a starting point; the preset
hover-preview makes auditioning cheap). No per-image optimality claim.

## Read before writing

Stage 1's signature.ts + solve.ts (extend, don't rewrite), the parent's
well-posedness section (the freeze order is binding), the grading-wheel
op + 8-band HSL op + grain effect op (the DevelopParams each stage
writes), engine/color chroma/lab helpers (a*b* — reuse the CST/color
module's Lab conversion, don't re-derive), cpuEvalPlan for the polish.

## Verify (extend verify-lookextract2.mjs)

Per stage, inject a KNOWN look using that family ONLY and assert
recovery: known saturation+vibrance → recovered within tolerance
(and NOT confused with each other — the identifiability test); a known
per-band hue push → recovered on the right band; known shadow/highlight
wheel hues → recovered within ~15°; known grain amount → recovered.
Then a COMBINED known look (tone+chroma+bands+wheels) → the staged
solver recovers all within tolerance, proving the freeze order actually
decouples them. SUITE +0 (extends the existing script) or +1 if split.

## Standing rules

Gate loop foreground; NEVER git add/commit; zsh `=` hazard; engine
invariants (reuse Lab/luma/curve code); libraryDir seed if the script
mints its own userData. English code.

## Report back

Files touched; where each freeze stage lives (file:line); the
identifiability evidence (the combined-look recovery test result);
whether the real corpus baseline was built or stubbed; deviations;
fragile spots; SUITE line + unit count.
