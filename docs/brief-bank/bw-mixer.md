# Brief: B&W conversion + channel mixer

Status: LANDED 2026-07-16 (54ab624) — K_BW=0.6 and the WORKING_LUMA
choice (pipeline-consistent Rec.709 weights, not literal Rec.2020) are
both flagged provisional pending an LR side-by-side; verify-bw.mjs
covers behavior. Original design notes below.
Prereq reading: the 8-band HSL implementation end-to-end (band
definitions, chroma mask, GPU pass + CPU mirror, InspectorPanel tab
UI), developNode param conventions + identity pass-skip invariant,
COLOR.md, the [[silverbox-lightroom-reference]] calibration workflow.

## Decided semantics (don't relitigate)

- **Data**: `develop.bw = { enabled: boolean, mix: number[8] }` —
  same 8 hue bands as HSL (red orange yellow green aqua blue purple
  magenta), each −100..+100, all-zero = the neutral conversion.
  Identity = `enabled: false` (pass skipped entirely per the
  invariant; `mix` values are preserved but inert while disabled —
  toggling B&W off/on round-trips the mix). Sidecar additive; update
  docs/sidecar-spec.md's develop summary line in the same landing.
- **Pipeline position**: inside the Develop aggregate, after HSL and
  before the grading stage (LR's B&W treatment replaces the color
  panel but grading still applies to the mono image — split-toning a
  B&W is THE classic use). When enabled, downstream develop stages see
  the mono image; saturation/vibrance/HSL become inert on it naturally
  (their inputs are neutral) — do NOT hard-disable their UI, LR keeps
  them visible; just the image stops responding, which is correct.
- **Formula (LR-shaped, constants provisional)**: per-pixel luminance
  L = Rec.2020 luma of the linear input. Each band b contributes a
  weight w_b(hue, chroma) — REUSE the exact HSL band mask (hue ramp ×
  chroma gate) so band boundaries feel identical to the HSL tabs.
  Output mono value = L × (1 + Σ_b mask_b × mix_b/100 × K_BW), then
  the mono value replaces all three channels while still linear.
  K_BW is the single global strength constant — start at 0.6 and mark
  it `// LR-CALIBRATION: provisional` like the effects constants were.
  Negative mix darkens that hue's contribution (deep-red-sky trick),
  positive lightens (bright foliage). Clamp the multiplier at 0 (a
  −100 on a fully-in-band hue must floor at black, not invert).
- **UI**: a "B&W" section in the Develop inspector between HSL and
  Grading: an enable toggle + the 8 sliders in the HSL tab's visual
  style (same band swatch colors, shown desaturated-tinted). When
  disabled the sliders are collapsed (section header only). No
  auto-mix ("Auto" button) in v1.
- **CPU mirror**: required (develop op) — same YCbCr/whatever-domain
  choices as the GPU pass, exact same constants, follow the HSL
  op's mirror precedent. cpuReferenceMean must stay meaningful.
- **Interplay notes**: WB still matters (it shifts hues before the
  band masks — LR-consistent and useful). The scopes/histogram show
  the mono image (no special-casing). Presets/sync treat `bw` as its
  own family (add it to the family list the preset-scoping and
  multi-select briefs share).

## Verify sketch (verify-bw.mjs)

(1) enabled with all-zero mix ⇒ pixel-wise gray (R==G==B) and mean
matches the luma of the input region (CPU vs GPU within 1/255);
(2) disabled ⇒ bit-exact passthrough (pass-skip invariant); (3) red
mix −100 darkens a red patch's mono value, +100 lightens it, green
patch unmoved (build patches via the existing fixture-image machinery
the HSL verify uses); (4) grading after B&W still tints; (5) sidecar
round-trip incl. mix preservation while disabled; (6) preset family
inclusion once the family dialog exists (skip cleanly if it doesn't
yet).

## Explicitly deferred

Auto-mix; film-stock emulation presets (that's the preset system's
job); toned-B&W shortcuts (grading already does it); per-band
luminance vs the fancier scene-referred mixers (revisit only if the
LR calibration session says the feel is wrong).
