# Color management in Silverbox

The concrete decisions behind [DESIGN.md](DESIGN.md) principle 6
("scene-referred color, output-referred late"), recorded with their
rationale so they don't get relitigated by accident. Status: decided
2026-07; the working-space migration is in progress (spike → migration).

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
