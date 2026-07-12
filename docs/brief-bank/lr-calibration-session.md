# LR calibration session — procedure

> **STATUS 2026-07-12: rounds 1-2 EXECUTED** (commits bfa2dd4, b11e2d7,
> 1ff41b1, 15ce6bd, 48c7222): base curve refit to LR Classic, dehaze/
> clarity/texture/vignette constants calibrated, sharpen scale aligned
> (DETAIL_SHARPEN_GAIN 2.4) + default RAW sharpening 40/1.0/0 seeded,
> crop-angle UI sign flipped to LR's. REMAINING below: item 2's grain
> quality (formula upgrade), item 4 vignetting divisor (needs a
> flat-field shot), and the color "profile fit" (Adobe Color's
> hue-dependent character — see COLOR.md's Default rendering section).
> The procedure is kept for future cameras / re-calibration.

The user runs Lightroom side-by-side with Silverbox; the conductor drives,
measures, and lands constant changes. Budget 30–60 min of the user's time.
Everything here is conductor work (no implementer agent needed) except the
final threshold retunes, which follow the normal gate flow.

## Preparation (conductor, before the user sits down)

1. Pick 3 images: the test ARW (DSC02993, ISO 5000 indoor), one Italy
   sunset (DSC07349 — saturated/wide-gamut), one architecture (DSC03298 —
   straight lines, blue hour). Copy them to a scratch folder so LR's own
   sidecars/catalog edits never touch the originals.
2. Have the user import them into LR with DEFAULT settings (Adobe Color).
3. Screens: Silverbox left, LR right, same image, both at Fit.

## Items, in order

### 1. Default brightness (baseline exposure + base curve)
- Current state: baselineExposureEV 0.5 + a camera-JPEG-fitted base curve
  (engine/color/baseCurve.ts, `npm run fit:basecurve <arw> <jpg>` refits).
  COLOR.md "Default rendering" has the full story.
- Question to settle: match the CAMERA JPEG (current) or match LR's default
  rendering? Ask the user which they prefer looking at the A/B.
- If LR wins: export LR's default render of the test ARW as JPEG (quality
  100, full size, sRGB), then refit: `npm run fit:basecurve <arw> <that
  LR export>` — the fitter doesn't care that the reference came from LR
  instead of the camera. Ship the new points the same way (baseCurve.ts,
  provenance comment, verify-basecurve expected points update).

### 2. Effects constants (FX_* in developNode.ts)
For each of Dehaze / Clarity / Texture / Vignette / Grain:
- Set the SAME slider value in both apps (e.g. +50), screenshot both,
  compare strength and character. Note LR side effects we intentionally
  mirror (dehaze shifts saturation/WB slightly; clarity has sat side
  effects).
- Tune the named constants only (never formula shape mid-session; if the
  shape is wrong, note it for a dedicated follow-up).
- Grain quality: LR's grain has roughness + finer structure. If ours reads
  as "digital noise" next to LR's, queue the "grain quality pass"
  (gaussian, band-limited, roughness control) as its own brief.

### 3. Crop-angle sign
- In LR: crop tool, drag to rotate clockwise, note which way the IMAGE
  turns and what the angle readout shows. Ours: +angle = CCW on screen
  (RESAMPLE_SHADER doc comment). If LR's readout sign is opposite, flip
  ONLY the UI-facing display/slider sign — never the shader convention
  (verify-crop pins it).

### 4. Vignetting divisor (only if the flat-field shot exists)
- Needs a flat-field frame (even wall/sky) from the 24mm. Fit per
  scripts/analyze-vignette-divisor.mjs but against the flat field; if a
  clean power-of-two emerges, set LENS_PROFILE_VIGNETTE_DIVISOR, flip
  LENS_PROFILE_VIGNETTE_ON (graphRenderer.ts), extend verify-lensprofile.

## Landing rules

- Every constant change: one commit per concern, verify suite green, note
  old→new values in the commit body.
- Update the silverbox-lightroom-reference memory with outcomes; anything
  deferred gets an explicit note (don't let items evaporate).
- Retune brightness-sensitive verify thresholds ONCE if the base curve
  changes; never loosen GPU/CPU parity tolerances.
