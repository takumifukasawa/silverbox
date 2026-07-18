# Brief: DCP camera-profile loading (the direct route to Adobe Color)

Status: DESIGNED 2026-07-18 (conductor, from the user's own insight:
"adobecolorが公開されてたら全く同じようには理論的にはできるよね" —
and it effectively IS available locally). Not yet scheduled.
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
