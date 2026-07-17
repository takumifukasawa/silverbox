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
