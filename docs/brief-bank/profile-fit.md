# Brief: profile fit — the fitted color transform (Adobe-Color-character match)

Status: ready to dispatch (Opus — numerically delicate). The structural
answer to the LR-calibration residual recorded in COLOR.md: after the
base-curve refit, luminance matches LR within ±2/255 everywhere, but
Adobe Color's HUE-DEPENDENT character remains — cleaner neutrals
(chroma ×0.86 at c25) with boosted colors (+5% at c50–c90). No global
slider can express that; a fitted per-camera color TRANSFORM can.

## Decided design

**What is fitted**: a residual 3D transform T: working-space RGB →
working-space RGB such that `render_ours(x) ∘ T ≈ render_LR(x)` for the
default look. T is stored as a small lattice (17³ is enough for a
smooth residual; it is NOT a creative LUT) in a per-camera constant
module (`engine/color/profileFit.ts`), shipped exactly like the base
curve (A7C2_* constant + per-model lookup + fallback + provenance
comment + refit command).

**Where it applies**: as an optional FIRST color step inside the default
look — a new Develop sub-block `profile: { enabled: boolean }` on the
input? NO — keep it out of the sidecar entirely at v1: apply it inside
the RESAMPLE→develop seam as part of the DEFAULT look would hide magic.
DECISION: it is a new op INSIDE the Develop node's fixed order (before
WB? after?) — concretely: a `develop.profile: { amount: 0..100 }` section
(default 100 for fresh RAW opens under the default-look gate, 0 for
JPEG/restored docs — the seeding pattern of sharpening 40/Color 25),
applied FIRST in the Develop chain (it replaces what Adobe bakes into
the camera profile before any user slider). `amount` interpolates
identity→T so users can dial the Adobe-ness. Identity invariant: amount
0 ⇒ no pass. WGSL: 3D texture or 17³ f16 buffer + trilinear manual
fetch — MUST have an exact CPU mirror (trilinear in plain math; the
GPU/CPU 1/255 parity applies, so implement trilinear identically, no
hardware sampler).

**The fitter** (`scripts/fit-profile.mjs`, `npm run fit:profile <arw>
<lr-export.jpg> [...more pairs]`):
1. Render ours at the CURRENT default look (base curve + EV; NR/sharpen
   OFF for the fit — spatial ops corrupt per-pixel pairing) at preview
   res; decode the LR export; downsample both to a common ~1024px.
2. ALIGN: the pair differs by lens-crop overscan — align by center crop
   to common dims (the base-curve fitter's percentile method didn't
   need alignment; this one pairs PIXELS). Verify alignment quality by
   local NCC on a grid; reject pairs/tiles under a threshold (motion,
   demosaic edges).
3. For every accepted pixel pair (ours_i → lr_i), both mapped into
   working-space linear (invert our exit transform on our render;
   ingest the LR JPEG through SRGB_TO_WORK), accumulate into the 17³
   lattice: scatter lr_i into the cell containing ours_i (trilinear
   splat), count-weighted.
4. Regularize: cells with support < N inherit blended neighbors
   (iterative diffusion toward identity at the hull); the transform is
   BLENDED toward identity by confidence so unseen colors pass through
   untouched (CRITICAL: extrapolation must be identity, never a lattice
   edge clamp — wild colors outside the scene's gamut must not shift).
5. Emit the lattice + fit report (per-cell support histogram, residual
   ΔE mean/p95 on a held-out 20% of pairs). Multiple input pairs
   accumulate into one lattice (the 3 calibration scenes give decent
   hue coverage; report which hue sectors are unsupported).

**Verify sketch** (verify-profilefit.mjs + unit tests): trilinear CPU
mirror exactness at lattice points and midpoints; identity lattice ⇒
bit-exact no-op at amount 100; fitted lattice at amount 100 moves the
test render's Lab chroma stats toward LR's measured targets (c25 ratio
→ ~0.86·ours, c50 → ~1.05); amount 50 lands between; seeding
gates/JPEG/restored-doc rules mirror the base curve's checks; GPU/CPU
parity 1/255.

**Out of scope v1**: per-illuminant duals (Adobe uses 2 tables +
interpolation by WB), hue-twist decomposition, fitting from more than a
handful of pairs.

## Why lattice-residual instead of matrix/curves

A 3×3 matrix + curves cannot express "protect neutrals, boost mids'
chroma, per-hue" simultaneously; a residual lattice with
identity-extrapolation is the smallest structure that can, and the
existing LUT machinery (trilinear eval, .cube experience) derisks it.
