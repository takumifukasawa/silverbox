# DRAFT — libraw-wasm / LibRaw upstream bug report (APS-C crop-mode developable area)

**Status: DRAFT. Not filed anywhere. Do not post this to any issue tracker
without the repository owner's explicit review and approval.** It is kept
here as a prepared, evidence-backed report so that approval, once given, is
a copy/paste away rather than a research task.

## Summary

For ILCE-7CM2 (Sony a7C II) ARW files shot in the camera's APS-C
(Super 35mm-equivalent) crop mode, this libraw-wasm build's reported
developable area (`imgdata.sizes.iwidth` / `iheight`) is smaller than the
camera's own recommended-crop rectangle for the same file
(`imgdata.sizes.raw_inset_crops[0]`) by a **uniform 28 columns / 22 rows**.
The missing pixels are not an artifact of a bad crop request — they are
never demosaiced at all, through any of this library's exposed decode
paths — yet the same sensor data is present and rendered by the camera's
own in-camera JPEG for the identical file. The shortfall is exactly
reproducible across every APS-C crop-mode file tested and completely
absent from every full-frame file tested on the same camera body.

## Environment

- **libraw-wasm**: 1.6.0 (npm), the only version tested. The underlying
  LibRaw core version pinned by this build was not independently confirmed
  from the published npm package (the build/compile script that pins it is
  excluded from the npm distribution) — happy to confirm separately if that
  detail matters upstream.
- **Camera**: Sony ILCE-7CM2 (a7C II), shooting in-camera APS-C
  (Super 35mm-equivalent) crop mode. Full-frame files from the same body,
  same firmware, show no shortfall (see below) — this appears specific to
  the APS-C crop mode's sensor readout, not the body in general.
- **Decode settings used**: `useCameraWb: true`, `outputBps: 16`,
  `outputColor: 8` (linear Rec.2020 via LibRaw's `-o`/`gamm` output color
  path), `noAutoBright: true`. The shortfall is unrelated to any of these —
  it is visible directly in `metadata(true)`'s reported `sizes` block before
  any color/tone processing.

## Reproduction

For an APS-C crop-mode ARW:

1. `open(bytes, { useCameraWb: true, outputBps: 16, outputColor: 8, noAutoBright: true })`
2. `const meta = await raw.metadata(true)`
3. Compare `meta.sizes.raw_inset_crops[0]` (Sony's own recommended develop
   crop, straight from the file's maker-note data) against
   `meta.sizes.iwidth` / `meta.sizes.iheight` (this library's own reported
   developable frame size).

Observed on the reference file used in this project's test suite:

| Field | Value |
|---|---|
| `iwidth` × `iheight` (developable area this build reports) | 4624 × 3080 |
| `raw_inset_crops[0]` — `cleft`, `ctop` | 44, 30 |
| `raw_inset_crops[0]` — `cwidth` × `cheight` | 4608 × 3072 |
| `cleft + cwidth` vs `iwidth` | 4652 vs 4624 → **28 px short** |
| `ctop + cheight` vs `iheight` | 3102 vs 3080 → **22 px short** |

Requesting `raw.open(bytes, { ...settings, cropbox: [44, 30, 4608, 3072] })`
and re-reading `metadata(true)` / calling `imageData()` does not recover the
missing 28 columns / 22 rows — the returned image is clamped to the same
`iwidth`×`iheight`-bounded area. The same result was obtained requesting a
`cropbox` spanning the full `raw_width`×`raw_height` (i.e. asking for
everything, not just the recommended crop) and reading `rawImageData()`
directly: the shortfall persists through every decode path this library
exposes, not just the convenience crop parameter. The missing pixels are
not corrupt or blanked in the source file — the camera's own in-camera JPEG
for the same exposure renders content across the full
`raw_inset_crops` rectangle with no visible defect at those edges, so the
sensor data exists; it is specifically this library's computed active/
developable area that stops short of it.

## Scope of the shortfall (batch survey)

A batch check across a set of real-world ARW files from this camera body
found the shortfall to be:

- **Present, and numerically identical (28 cols / 22 rows), on every
  APS-C crop-mode file tested: 15 / 15.**
- **Absent on every full-frame file tested: 63 / 63** — full-frame files'
  `raw_inset_crops` rectangle fits entirely inside `iwidth`×`iheight` with
  margin to spare, and the recommended crop applies with no clamping
  needed.

The uniformity (exactly 28/22 on every affected file, zero on every
unaffected file) suggests a fixed, mode-specific miscalculation rather than
a per-file or noise-dependent issue — most likely something in how the
active-area / developable-size computation handles this camera's APS-C
sensor-crop readout mode specifically (as opposed to its full-frame
readout), given that the same computation is exactly correct for the
full-frame case on the identical body/firmware.

## Impact on downstream software

Software that trusts `iwidth`/`iheight` as "the decodable frame" and then
tries to apply the file's own embedded recommended crop (`raw_inset_crops`)
on top of it has no way to fully honor that crop for APS-C-mode files from
this body: the crop rectangle legitimately extends 28/22 px past what this
library will ever hand back, through any API surface. A consumer either
has to clamp the requested crop (losing a small amount of the intended
frame, and needing to decide how to distribute the loss so the visible
frame doesn't also drift off-center) or accept a decoded frame that
doesn't match the crop the camera itself recommends and that the in-camera
JPEG actually shows.

## Question for maintainers

Is `iwidth`/`iheight` (the reported developable/active area) expected to
always fully contain a Sony file's own `raw_inset_crops` rectangle, or is
a small shortfall in APS-C crop-readout modes a known consequence of how
the active area is computed for that readout path (e.g. a margin trimmed
for CFA-pattern or black-frame alignment that isn't trimmed the same way
for full-frame readout)? If the latter, is the intended-crop-to-active-area
relationship documented anywhere so downstream tools can distinguish "we
chose to clamp" from "we should be able to get the rest of this by asking
differently"? Happy to share the batch-survey methodology and file list
(camera-only, no personal identifying content) if useful for reproducing
this on your own test corpus.
