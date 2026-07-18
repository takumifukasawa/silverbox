# Brief: DCP camera-profile loading (the direct route to Adobe Color)

Status: STAGE 2 LANDED 2026-07-18 (exact camera-native reconstruction;
see below). STAGE 1 LANDED 2026-07-18 (parser + DNG §6 pipeline +
`profile.source: 'dcp'` + verify-dcp fixture suite + minimal UI; the
DCP result is baked into the SAME 17³ residual-lattice shape the
builtin profile uses, so GPU/CPU parity is inherited).

STAGE 2 (root cause + fix): Stage 1's `cameraNativeFromWorking`
inverted the decoded working-space pixel through `camXyz` (the raw
XYZ→camera matrix) — no per-channel WB scaling, and the wrong
row-normalization convention — which is NOT the matrix libraw actually
applies. Per LibRaw's own `cam_xyz_coeff` (`src/utils/utils_dcraw.cpp`,
read from the public LibRaw GitHub source — no LibRaw code copied),
libraw builds `cam_rgb = cam_xyz · xyz_rgb` (camera-from-sRGB D65),
row-normalizes it (implicitly folding in the as-shot WB — that
normalization factor IS `pre_mul`), then sets `rgb_cam =
pseudoinverse(cam_rgb_normalized)` — i.e. `rgb_cam` maps the ALREADY
WB'd, demosaiced camera-native RGB to linear sRGB D65, and
`convert_to_rgb()` composes it with the output-colorspace table
(`out_cam = out_rgb[outputColor-1] · rgb_cam`) before applying it per
pixel. libraw-wasm exposes this exact `rgb_cam` matrix via
`color_data.rgb_cam` (typed as always-present, but empirically
`undefined` for at least this decode path — the code treats it as
optional and falls back cleanly). Threading it through (decoder →
`CameraColorInfo.rgbCam` → `WbModel.rgbCam` → DCP pipeline's new
`exactCameraFromWorkingMatrix`, which inverts `rgb_cam` composed with
the known sRGB↔Rec.2020 boundary matrices) recovers the EXACT
camera-native, as-shot-WB'd RGB libraw's own pipeline produced — not a
second approximating model. `camXyz`-based reconstruction
(`approxCameraFromWorkingMatrix`) is kept as the fallback for when the
decoder doesn't expose `rgb_cam`.

BUG CAUGHT DURING VALIDATION (fixed same pass): the first
implementation wired `rgbCam` through `RawDecoder`/`whiteBalance.ts`
correctly but missed ONE call site — `appStore.ts`'s `seedDefaultLook`
built its own `WbMeta` object literal (`{camMul, camXyz}`) instead of
passing `image.color` through, silently dropping `rgbCam` and making
Stage 2 always fall back to the Stage-1 approximation. Caught by a
real-DCP smoke render showing Stage 1 and Stage 2 producing
BIT-IDENTICAL output (impossible if the exact path were engaged);
traced with a temporary console probe (removed before landing) and
fixed by passing `rgbCam: image.color?.rgbCam` through.

SMOKE RESULT against the real, locally-installed Sony ILCE-7CM2 Adobe
Standard DCP (test-assets/test.ARW vs test-assets/lr-calib/DSC02993.jpg,
NCC-gated center-crop ΔE2000, base curve + lens correction seeded on
both sides — see the render report for full methodology): the green
cast is GONE (Stage 1 meanΔE2000 20.6, systematically green/blue-starved
RGB≈44/84/12 in the crude whole-crop check; Stage 2 meanΔE2000 7.8,
RGB≈85/77/32 — R/G balanced). Stage 2's 7.8 lands statistically ON PAR
with identity (7.6) and the shipped builtin round-6 lattice (7.8) in
THIS measurement — a dramatic fix (Stage 1 was ~2.7x WORSE than doing
nothing), but NOT the hoped-for "well under 2" dramatic win over
identity; all three numbers here also sit well above COLOR.md's
harness-measured ~3.8/~3.6 (this script's own methodology — JPEG-domain
comparison, no true sub-pixel registration, single coarse NCC gate — is
cruder than fit-profile.mjs's held-out/sub-pixel-aligned harness, and
the offset looks roughly CONSTANT across identity/builtin/dcp, so the
RELATIVE finding — reconstruction fix closes the gap to our own
baseline — is the reliable takeaway, not the absolute number). The
remaining gap to a possible sub-identity DCP result is attributable to
Stage 1's OTHER documented simplifications (ColorMatrix/
CameraCalibration+AnalogBalance composition, 2-point linear illuminant
interpolation, ProfileToneCurve's piecewise-linear/sRGB-domain
approximation) — unchanged by this pass, still open work. A rerun of
the REAL fit-profile.mjs-style harness (developedForFit, held-out
split, true NCC sub-pixel alignment) against DCP mode is the natural
follow-up for a citable headline number.
(Originally DESIGNED 2026-07-18, from the user's own insight:
"adobecolorが公開されてたら全く同じようには理論的にはできるよね" —
and it effectively IS available locally.)
Prereq reading: COLOR.md "Calibration state" (the statistical route
plateaued at ~3.6 dE2000 after six rounds — this brief is the
structural alternative), profileFit.ts history, the DNG 1.7 spec's
camera-profile chapter, RawTherapee/dcamprof source as open
implementations of the same pipeline.

## The idea

Adobe Color is not a secret: it ships as a per-camera **DCP file**
(DNG Camera Profile) inside every Lightroom/ACR install, and the DCP
format is publicly documented in the DNG specification. Instead of
statistically imitating Adobe Color's OUTPUT (rounds 1-6), read the
user's own DCP and execute the SAME DEFINITION:

- ForwardMatrix / ColorMatrix (illuminant-interpolated)
- HueSatDelta tables (the 2.5D hue/sat/value LUTs — the "house look")
- the profile's embedded ToneCurve
- LookTable where present

## Legal line (bright and simple)

- READING the user's locally installed DCP for their own rendering:
  fine (their license, their machine — same as using their fonts).
- BUNDLING/redistributing any Adobe DCP with silverbox: never.
- The feature is therefore "point silverbox at a .dcp" (with an
  auto-discovery convenience for the standard CameraRaw profile
  directories), not "ships with Adobe Color".

## Shape

- New profile source option in the color pipeline's profile stage:
  `profile: { source: 'builtin' | 'dcp', dcpPath?, amount }` — builtin
  = today's base-curve + round-6 lattice; dcp = the DCP execution
  path. Sidecar additive; docs/sidecar-spec.md update.
- DCP parser (TIFF-tag container — small, self-contained) + the
  DNG-spec color pipeline mapped onto our linear Rec.2020 working
  space (the spec operates in linear ProPhoto-ish coordinates —
  conversion at the boundaries, exact matrices, doc-commented).
- GPU path: HueSatDelta as a 3D texture lookup; CPU mirror per the
  develop-op invariant.
- Verify: a hand-built MINIMAL fixture DCP (tiny tables, known
  values) checked into scripts/fixtures (spec-conformant, ours, no
  Adobe content); golden math tests against dcamprof-derived
  reference values for the pipeline stages; app-level render check.
- Amount slider blends dcp-rendered vs neutral (same trick as the
  lattice's amount).

## Why this beats round 7+

Six fitting rounds bought 4.565→3.61 dE2000 against identity's 3.80.
The DCP route executes the target's own definition — expected residual
falls to demosaic/WB-scaling differences (likely well under 1 dE2000).
It also generalizes: ANY DCP works (camera-matching profiles, film
emulations people own), not just Adobe Color.

## Layering decision (user discussion 2026-07-18)

In DCP mode the profile's embedded tone curve applies INSIDE the
profile stage (hidden, LR-identical layering — the user's visible
tone curve starts flat on top), because the DCP curve is defined in
a specific space and surfacing it as editable points would break
exact reproduction. Builtin mode keeps today's visible seeded curve.
The user connected the dots himself: "profileの中にトーンカーブを
埋め込めば構造的には同じ". Geometry counterpart noted: Adobe also
ships LCP (Lens Correction Profile) files — if an "LR-geometry mode"
is ever wanted, reading the LCP is the principled route (not scaling
our spline); camera-faithful stays the default regardless.
LCP EXPERIMENT RESULT (2026-07-18, scratchpad-only, adoption
deferred per user): executing the 24mm LCP's radial polynomial
(k1=-0.190667 k2=0.070143 k3=-0.018779; radius normalized to the
FULL diagonal so the frame corner sits at r=0.5; ScaleFactor is
metadata, not pixel math) on a lens-OFF render reproduces ~85% of
LR's correction (51px uncorrected -> 6-9px vs LR, direction/sign
exact; LR's own export floor is 2.24px). Hypothesis largely
confirmed: LR's stronger-than-camera geometry IS its LCP.

## Open questions for the user

1. Priority vs the live calibration session (this likely SUPERSEDES
   it for the Adobe-match goal; the session stays useful for taste
   tuning on top).
2. Auto-discovery of the LR install's profile dir: opt-in prompt or
   manual-path-only in v1 (privacy posture says manual-first).

## Explicitly deferred

Writing/exporting DCPs; DCP illuminant dual-matrix white-point
interpolation beyond the two standard illuminants; LookTable+
HueSatDelta simultaneous stacking if a profile omits one (follow the
spec's precedence rules, implement what the Adobe Color profile for
the user's bodies actually contains first).
