# Color management in Silverbox

The concrete decisions behind [DESIGN.md](DESIGN.md) principle 6
("scene-referred color, output-referred late"), recorded with their
rationale so they don't get relitigated by accident. Status: decided
2026-07; the working-space migration to linear Rec.2020 is COMPLETE
(engine/color/workingSpace.ts is the single definition point; decode uses
libraw outputColor 8 with noAutoBright pinned; the exit encode applies
WORK_TO_SRGB then the sRGB curve; verify:cst guards it).

## The two axes, and where we stand

"RAW-like editing" decomposes into two independent axes:

1. **Transfer (linear vs encoded)** — Silverbox has been linear from day
   one: passes exchange linear-light `rgba16float`, highlights above 1.0
   survive the whole chain, and gamma exists only at the display/export
   encode. Nothing changes here.
2. **Primaries (how wide the RGB triangle is)** — this is what changes.
   Decoding converts the camera's native color to a standard space, and
   that target used to be sRGB: any color outside sRGB's small triangle
   was clamped at the door, before editing even began. A RAW developer
   should not do that.

## Decisions

### Working space: linear Rec.2020, fixed

- **Rec.2020** covers nearly everything a camera sensor records, uses
  physically real primaries (unlike ProPhoto, whose imaginary primaries
  make the math legal but the values non-colors), converts to every
  practical output with one 3×3 matrix, and is the primaries set of the
  HDR standards (Rec.2100 PQ/HLG). darktable's scene-referred pipeline
  made the same choice.
- **Fixed, not configurable.** A selectable working space would make the
  same sidecar render differently per machine (breaking "the document is
  the truth"), multiply the GPU/CPU-mirror verification matrix, and change
  the meaning of `shade(color, uv)` for custom shaders. Resolve needs
  configurability because Hollywood interchange demands it; Silverbox
  doesn't.
- **No ACES.** ACES is an interchange *system* (IDTs + RRT/ODT output
  rendering) whose imposed filmic look conflicts with Silverbox's
  calibration philosophy (Lightroom and the in-camera JPEG as references),
  and whose working space (ACEScg/AP1) is practically the same size as
  Rec.2020 anyway. For sRGB-and-print photography it buys nothing.
- **AdobeRGB is an export target, not a working space.** sRGB ⊂ AdobeRGB ⊂
  Rec.2020; a Rec.2020 working space serves print by conversion at export.

### JPEG sources live in the same working space

A JPEG is linearized and converted through `SRGB_TO_WORK` at ingest, so
RAW and JPEG edits mean exactly the same thing — one sidecar, one preset,
one behavior. Nothing is lost or stretched: sRGB sits entirely inside
Rec.2020, and the ingest matrix cancels against the exit matrix, so an
untouched JPEG round-trips to itself (to float precision, orders of
magnitude below 1/255). The gain is headroom: saturation pushed on a JPEG
now survives to the exit instead of clipping against the working space
mid-chain. This mirrors what Lightroom and darktable do with non-RAW
sources.

### Ops keep their own internal encodes

Storage between passes is linear Rec.2020; each op is free to encode
internally for perceptual behavior (tone curve, HSL, grading operate on
encoded values today) — but the encode is applied to *working-space*
values, never to a gamut-clipped copy. If color-wheel feel ever wants a
log curve, that is a per-op change, not a pipeline change.

### Display and scopes stay output-referred

- **Preview** converts working → display at the final encode (sRGB today;
  a `display-p3` canvas on capable monitors is a natural later upgrade
  that needs no pipeline change).
- **Histogram, waveform, parade, vectorscope and the clipping badges keep
  measuring the encoded output**, because the question they answer —
  "will my export clip?" — is an output-space question, and video scopes
  are display-referred by convention. This is also exactly what the code
  already does.
- A future **gamut warning** overlay (pixels clipped by the gamut
  conversion rather than by exposure, LR-style) becomes meaningful once
  the working space is wider than the display.

### Exits multiply later, losslessly

Because the working space is wider than every target: sRGB export (today),
AdobeRGB / Display P3 with ICC tags (print, when needed), HDR (PQ or
gain-map JPEG/AVIF — same primaries as the working space). LUT bakes
remain display-space→display-space transforms of the color chain.

### Default rendering (baseline exposure + base curve)

A neutral scene-referred RAW decode carries no display intent, so a fresh ARW
renders darker than the camera's own JPEG — measuring DSC02993.ARW against its
in-camera JPEG (percentile-matched encoded luma) put the camera about **+1.45
EV brighter at p50**, but roughly flat (±0.1 EV) at the p10/p90 tails, so a flat
exposure push would clip what the camera's curve rolls off. Silverbox matches
Lightroom's **2-stage** default look:

1. **Baseline exposure** — a fixed linear gain (`settings.baselineExposureEV`,
   default 0.5 EV) applied at decode time to RAW only (see `shared/ipc.ts`).
2. **Base curve** — a display TONE CURVE fitted from a reference rendering
   (`engine/color/baseCurve.ts`), seeded as VISIBLE, editable, deletable points
   into the Develop node's `toneCurve.rgb` on a fresh ARW open (no sidecar).
   It is NOT hidden decode magic: the points appear in the tone-curve editor,
   Reset removes them, and JPEG opens / restored sidecars are never seeded.
3. **Default sharpening** — fresh RAW opens also seed `detail.sharpen`
   40/1.0/0 (Lightroom's RAW-import default; JPEG opens stay 0 because
   in-camera JPEGs are pre-sharpened), visible in the Detail section like
   every other piece of the default look.

**Calibrated 2026-07-12 against Lightroom Classic** (the user's decision: LR's
default rendering is the reference, not the in-camera JPEG). The shipped curve
is the LR fit (RMS 1.12/255; luma matches LR within ±2/255 at every percentile
band), per camera model (`ILCE-7CM2` today; that curve doubles as the fallback
for other bodies). Refit with `npm run fit:basecurve <arw> <reference.jpg>` —
the reference can be a camera JPEG or any exported rendering. The Effects and
sharpen slider scales were calibrated in the same session (see the
LR-calibration constants' doc comments in `developNode.ts`). KNOWN residual
vs LR: Adobe Color's hue-dependent color character (cleaner neutrals, ~+5%
chroma on colors) — not reachable with global sliders; the "profile fit" (a
small fitted 3D color transform) is the structural answer, now shipped (round
6). See "Calibration state" below for where both fits stand and what's
still open.

## Calibration state (updated 2026-07-17)

Two independent fitted pieces make up the default look (both keyed off
`ILCE-7CM2` today, both editable/deletable like any other develop state —
see DESIGN.md's Profile layer):

- **Base curve** (`engine/color/baseCurve.ts`): still the ORIGINAL round-1/2
  single-scene fit (DSC02993.ARW vs its Lightroom Classic default export).
  Two later multi-scene candidates were tried and REJECTED, both by the
  user's eye rather than by their own numbers — an objective/perception
  mismatch worth remembering before trusting a whole-frame metric again:
  round 3 (14 scenes, unweighted whole-frame percentile matching) *won* the
  headline metric (mean |Δp50| 9.30 → 2.95/255) but lost on subject crops,
  because unweighted whole-frame pixels are dominated by whatever fills the
  frame (sky, out-of-focus background) rather than what a viewer looks at;
  round 4 (the same 14 scenes with a center- and midtone-weighted saliency
  fix) improved whole-frame agreement on 13/14 scenes but still only won
  2/5 subject crops. Both attempts and their fit data are preserved
  (`scripts/fit-base-curve.mjs`'s doc comment, `scripts/base-curve.fit.json`)
  for the next attempt; the shipped curve is round-1/2.
- **Profile fit** (`engine/color/profileFit.ts`): the round-6 LUMINANCE-AWARE
  lattice, shipped. A luma-neutral model form (rounds 1-4) never beat identity
  on held-out data across four attempts; round 5 lifted the luma-neutral
  projection and beat identity for the first time but failed its own
  whole-frame luma percentile gate (a flat cap over-brightened shadows);
  round 6 made the cap position-dependent (zero in shadows, ramping to a
  small ceiling by the midtones — `PROFILE_LUMA_CAP_SHADOW_L`/
  `PROFILE_LUMA_CAP_MIDTONE_L`/`PROFILE_LUMA_CAP_L_STAR`), gated on held-out
  ΔE2000 (must beat both identity and the previously-shipped lattice) plus
  three safety invariants (bounded residual, far-hull near-identity,
  shadow-safe cap). It is the first round in this history to ship a
  measurable win: held-out ΔE2000 mean 3.80 (identity) → 3.61.
- **Geometric-contamination lesson**: every profile-fit round through the
  first round-4 attempt rendered its own side of the comparison with the
  embedded Sony lens profile OFF, and separately, before `raw_inset_crops`
  landed, against a decode frame that was off-center from the camera's. Once
  both geometry fixes shipped and a round was re-run lens-ON, the *baseline*
  identity-vs-LR chroma disagreement nearly halved on its own (dEab 6.55 →
  3.91) — most of what earlier rounds were measuring as "Adobe's color
  character" was actually uncorrected geometry. Any future re-fit MUST run
  with the lens profile on and the current decode frame, or its numbers are
  not comparable to round 6's.
- **Remaining honest gap**: ~3.6 ΔE2000 between Silverbox's shipped default
  look and Lightroom Classic's, even after the base curve, round-6 profile
  fit, and both geometry fixes. This residual is read as Adobe Color's house
  look proper — the part of "what LR does to a RAW" that isn't tone, isn't
  gross hue/chroma, and isn't a geometry bug, just Adobe's own per-camera
  color science. Closing it further with a static fitted lattice has
  repeatedly hit diminishing returns (round 6 is the ceiling of what the
  luma-aware lattice form can do without new training data or a richer model
  shape); the next lever is a live, interactive user calibration session
  (side-by-side against Lightroom, per the Lightroom-reference decision)
  rather than another offline refit round.
- **DCP camera-profile route** (`docs/brief-bank/dcp-profile.md`) — the
  structural alternative to another statistical refit round: execute the
  user's own Adobe DCP directly instead of imitating its output. Stage 1
  (parser + DNG §6 pipeline) shipped 2026-07-18; Stage 2 (2026-07-18) fixed
  Stage 1's camera-native RGB reconstruction, which had been inverting the
  wrong (unnormalized, WB-blind) matrix and rendered real Adobe DCPs with a
  severe green cast — now exact (inverts libraw's own `rgb_cam`). A smoke
  measurement against the real Sony ILCE-7CM2 Adobe Standard DCP (see
  dcp-profile.md's status block for the full numbers/methodology) confirms
  the green cast is gone and DCP mode now lands ON PAR with identity/round-6
  in that (cruder-than-this-harness) measurement — not yet the clear win
  over ~3.6 this route is expected to eventually deliver; the remaining gap
  is Stage 1's OTHER documented simplifications (CameraCalibration/
  AnalogBalance, illuminant interpolation, tone-curve domain), not this
  pass's reconstruction fix. Not the default (`profile.source` stays
  `'builtin'`) pending a rigorous same-harness re-measurement.

## Migration plan

1. **Spike** — decode the reference ARW at `outputColor` sRGB vs Rec.2020
   (libraw-wasm passes LibRaw's `-o`; 8 = Rec.2020, linear via `gamm`),
   quantify out-of-gamut pixels, produce visual evidence. Judge on real
   photographs before committing to the churn.
2. **Migration** — decode to linear Rec.2020; add the Rec.2020→sRGB matrix
   to the display/export encode (WGSL + CPU, matched as always); decide
   luma coefficients (Rec.2020's vs keeping Rec.709's as an aesthetic
   choice) once, in one place; re-verify every numeric check that assumed
   sRGB primaries (as-shot WB reproduction, HSL direction thresholds,
   GPU/CPU tolerances).
3. Sidecars record no working-space data today; the schema is unaffected.
   Existing sidecars keep loading; renders of gamut-rich photos will
   differ slightly — that difference is the point.
