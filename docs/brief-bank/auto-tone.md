# Brief: Auto tone — one-button histogram-anchored starting point

Status: DESIGN-READY (Fable, 2026-07-20) — dispatchable. FEEL-HEAVY:
land it, then flag for hand-test rather than chaining onward (the
numbers can be right and the result still read wrong — same gate as any
look-affecting feature).

## What it is

A single toolbar button (「自動トーン」) that sets a STARTING POINT for
the tonal sliders from the image's own histogram — LR's "Auto" in
spirit, but defined transparently (no black box), and expressed as
ordinary Develop param values the user then refines. It writes to the
existing basic-tone family only; it is not a new op.

## Decided design (percentile-anchored, not ML)

Reuse the percentile machinery the base-curve fitter and (incoming)
look-extraction already use — this is the same family of tool:

1. Compute the luma percentile vector of the CURRENT render (post-
   profile, pre-basic-tone — i.e. the neutral starting image), using
   the engine's luma weights.
2. **Black/white points** (blacks/whites sliders): set so a small fixed
   fraction of pixels clips at each end (e.g. p0.5 → black point,
   p99.5 → white point — tunable named constants, LR-calibration
   candidates). Never hard-clip; nudge toward the anchors.
3. **Exposure**: shift so the MEDIAN luma lands at a target midtone
   (a named constant near mid-grey in the working space — calibrate
   against LR Auto's midtone placement). This is the dominant DOF; keep
   it and the curve/contrast from fighting (do exposure here, leave
   contrast to step 4).
4. **Highlights/shadows**: recover toward the target percentile shape —
   pull highlights down if p90+ is crushed against the white point,
   lift shadows if p10− is crushed against black. Bounded moves.
5. Contrast, whites-vs-highlights interplay: keep MINIMAL in v1 — the
   four moves above are the honest core. Do NOT also drive the tone
   curve (exposure+black/white already cover the percentile match;
   adding curve control is the degeneracy the look-extraction
   well-posedness note warns about).

All constants are named + flagged for a side-by-side LR-Auto
calibration session (DESIGN.md principle 5). v1 ships defensible
defaults; the calibration tightens them.

## Interaction (visible-path)

- Toolbar button = the operation (a visible control, not an
  accelerator). One click applies; it's a normal param edit, so ONE
  undo entry reverts it, and the user tweaks the sliders afterward.
- Optional accelerator later (a key) needs the visible button first
  (DESIGN.md "visible path to every result").
- Applies to the OPEN photo. A selection/batch form is
  apply-to-selection territory — out of scope here (v1 = single photo;
  note the batch path as future, it composes with the stage-A batch
  shape).

## Read before writing

engine/color/baseCurve.ts + scripts/fit-base-curve.mjs (percentile
computation to reuse), the basic-tone DevelopParams shape + its slider
ranges (exposure/blacks/whites/highlights/shadows), the luma-weight
constant, appStore's develop-param mutators (write through the same
path a slider edit uses → automatic undo + fork-on-touch for linked
photos), Toolbar.tsx (button placement).

## Verify (new verify-autotone.mjs)

1. A deliberately dark test render → auto tone raises exposure (median
   luma moves toward the midtone target); a bright one → lowers it.
2. Black/white points land the extreme percentiles near the clip
   anchors without hard-clipping (no fully-black/white blowout beyond
   the fraction).
3. It's ONE undo entry (⌘Z fully reverts to pre-auto sliders).
4. On a LINKED photo (shared look), applying auto tone forks basic-tone
   to 個別調整 (it's a param edit — the fork-on-touch path must fire).
Register verify:autotone (+ verify:serial + run-verify.mjs); SUITE +1.

## Standing rules

Gate loop foreground; NEVER git add/commit; zsh `=` hazard; engine
invariants; named constants for every threshold (LR-calibration
flagged); Japanese display text (自動トーン), English code. FEEL-HEAVY:
declare a hand-test stop after landing (per [[silverbox-autonomy]]).

## Report back

Files touched; where each of the 5 solve steps lives (file:line); the
named constants + their provisional values (for the calibration
session); deviations; SUITE line + unit count; a note that this needs
LR-Auto side-by-side calibration.
