# Brief: manual noise reduction — LR-style sub-sliders + the missing default

Status: DECIDED (user, 2026-07-12), queued after the denoise hook node.
Complements — does not replace — the external denoise hook (that is LR's
"AI Denoise" analogue; this is the Manual Noise Reduction panel).

## The two decisions

1. **Sub-sliders**: extend Detail's noise controls to LR Classic's six-knob
   shape by exposing the bilateral implementation's existing degrees of
   freedom (no algorithm swap):
   - `noiseLuminance.detail` (0–100, default 50) → luma RANGE sigma:
     higher = smaller sigma = more structure counts as edge and survives.
   - `noiseLuminance.contrast` (0–100, default 0) → high-frequency
     contrast re-injection after smoothing (fights the plastic look).
   - `noiseColor.detail` (0–100, default 50) → chroma range sigma.
   - `noiseColor.smoothness` (0–100, default 50) → chroma SPATIAL sigma
     scale (how large a color blotch gets averaged away).
   Mapping formulas are the implementer's to derive from the existing
   bilateral pass (read the Detail WGSL + pack functions); each mapping
   must be a named constant (LR-calibration candidate), identity-preserving
   (amount 0 ⇒ pass not emitted regardless of sub-slider values), and
   sub-slider defaults must reproduce today's render for any given amount
   (back-compat: sidecars without the new fields sanitize to the defaults
   and render byte-identically to before this pack).
2. **Default color NR**: LR Classic seeds RAW imports with **Color 25**
   (Detail 50 / Smoothness 50; Luminance 0). Add `noiseColor.amount: 25`
   (+ new-field defaults) to the fresh-RAW default-look seeding in
   appStore.openImageByPath (same gate/flags as the base curve + default
   sharpening; JPEG opens stay 0; restored sidecars untouched).

## Verify sketch (extend verify-detail.mjs + verify-basecurve.mjs)

- Sub-sliders change the render in the documented direction (detail↑ ⇒
  sharpness metric ↑ at fixed amount; smoothness↑ ⇒ chroma variance ↓).
- Defaults reproduce the pre-pack render byte-comparably (open a sidecar
  written before the fields existed — inline fixture — assert readback
  equality with a doc carrying explicit defaults).
- Fresh RAW open seeds color 25 (default-look script); JPEG stays 0.
- Sidecar round-trip; sanitizer accepts absent fields.

## LR calibration round 3 (banked)

The mappings' STRENGTHS vs LR (what LR's Detail 0→100 actually does at
ISO 5000) need an LR session round: exports of the ISO 5000 test ARW at
Luminance 40 × Detail {0,50,100} etc. Procedure joins
docs/brief-bank/lr-calibration-session.md's remaining items.
