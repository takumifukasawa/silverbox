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
chroma on colors) — not reachable with global sliders; the banked "profile
fit" (a small fitted 3D color transform) is the structural answer.

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
