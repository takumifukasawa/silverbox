# Roadmap and gap analysis

What exists, what a credible RAW developer still owes its users (measured
against Lightroom and DaVinci Resolve), and what is deliberately out of
scope. Priorities follow [DESIGN.md](DESIGN.md); color decisions live in
[COLOR.md](COLOR.md).

## Implemented (verified by the suite)

Decode (ARW via libraw-wasm, JPEG), Kelvin/Tint white balance with as-shot
estimation, exposure/contrast/highlights/shadows/whites/blacks,
saturation/vibrance, parametric + point tone curves (PCHIP, per-channel),
8-band HSL, 3-way color grading (+global wheels, blending/balance), detail
(bilateral luma/chroma NR, masked sharpening), effects (dehaze, clarity,
texture, grain, vignette), crop/straighten (±45°), manual lens corrections
(distortion, CA, vignetting recovery), custom WGSL shader nodes with GUI
params, atomic op nodes with DAG branching and blend, histogram + waveform
+ RGB parade + vectorscope with clipping badges, before/after and
grayscale check views, zoom/fit/100%, coalesced undo/redo, JSON sidecars
(schemaVersion 2, atomic writes), full-resolution JPEG/PNG export with
EXIF/ICC, drag & drop, linear wide-gamut working space (Rec.2020), LUT export
(.cube + Unity/Unreal strip PNGs + WebGL snippet, capturing the active
output's color pipeline with spatial/masked/custom ops reported as excluded).
Develop presets: whole-look JSON files under the app data dir
(`<userData>/presets/<slug>.json`), git-shareable like the sidecars —
save/apply/delete a named look from the toolbar, sharing the develop
clipboard's exact capture/merge semantics (geometry stays per-photo, so
applying a preset never carries another image's crop).
Sony embedded lens-profile auto-correction: every ARW carries per-shot
distortion/CA/vignetting splines for whatever E-mount lens took it (the file
IS the profile — no lens database), parsed straight from the makernote tags
and applied in the same resample pass as crop/lens, stacking on top of the
manual sliders (LR-style). Scope: distortion + chromatic aberration ship
(validated against the in-camera JPEG — corner NCC 0.67 corrected vs 0.06
uncorrected); vignetting is parsed but held OFF because its knot-scale divisor
would not fit the JPEG radial falloff cleanly (the camera's creative tone
curve dominates the residual). On by default for a fresh ARW open, off for a
JPEG/non-Sony image; the DNG-opcode path for other makers stays future work.

## In flight / agreed order

1. Masks: Radial/Linear nodes + mask port on blend + "+ Local Adjustment"
   (sidecar schemaVersion 3, ports on edges, unknown-field passthrough,
   named multiple outputs ride the same bump)
2. ColorKey (secondary) mask node
3. Spot removal (clone circles, non-destructive list)
4. Image node (composite with / mask by another file, path reference)
5. Sidecar hot-reload on external change (the AI-editing loop)
6. Denoise for high ISO (external-tool hook node first — see nice-to-have
   notes; bundled inference only if that proves insufficient)
7. Headless CLI renderer (batch export against sidecars/presets)

Other-maker lens correction (DNG opcodes — the semi-universal path — then
per-maker parsing on demand; contactless/vintage glass keeps the manual
sliders) follows from the Sony embedded-profile work now in Implemented.

## Should have (credibility gaps vs Lightroom/Resolve, mostly small)

- **WB eyedropper** — click a neutral to solve temp/tint; both references
  have it, ours is sliders-only.
- **Crop aspect-ratio lock and presets** (1:1, 3:2, 16:9…) — crop is
  currently free-form only.
- **Rotate 90° / flip** — geometry stops at ±45° straighten today.
- **Copy/paste develop settings between photos** — cheap with sidecars;
  partially covered by presets/CLI, still wants a one-key gesture.
- **Sidecar overwrite guard** — never save over a document that failed to
  parse (promise 9 enforcement).

## Export pipeline (current: quality 1–100, long-edge resize without
enlargement, JPEG/PNG, sRGB ICC, EXIF carry-over)

Should have: **metadata control** (all / minimal / none, GPS stripping —
privacy for social export), **export color space** (AdobeRGB / Display P3
with ICC tags), **export presets** (named bundles of these options).
Nice: 16-bit TIFF (print/interchange), output sharpening (post-resize,
screen/print), short-edge/megapixel resize modes, WebP/AVIF, DPI metadata,
watermark; file-naming templates belong to the CLI.

## App settings

None exist today. The vehicle: a schema-versioned `settings.json` in the
app data directory — file first, preferences UI later, same text-first
philosophy as the sidecars (and where UI theme tokens will live). Initial
contents: export defaults, preview-resolution cap, sidecar autosave
(decided: on by default, debounced, disable-able), baseline-exposure
offset (value decided in the Lightroom calibration session).

## Nice to have

- **Embedded-preview-first opening**: show the ARW's embedded JPEG within
  ~100ms while the real decode runs, then swap — the Lightroom trick;
  near-zero perceived load time
- **Folder filmstrip** (NOT a catalog): open a folder, thumbnail strip from
  embedded previews, click to switch images; no database — and ratings, if
  they come, live in the sidecar so they stay git-native
- **Per-node preview** (UE-material-editor style): inspect any node's
  output in the preview / as node thumbnails — the renderer already keeps
  per-step textures
- Side-by-side compare view (current vs before, or two outputs two-up)
- "Open terminal here" button (spawns the user's own terminal at the
  document's directory — the cheap honest version of an embedded pane)
- Denoise for high-ISO work: preferred shape is an **external-tool hook
  node** (pipe through a user-configured command, cache keyed by input
  hash — stays intent-data, no bundled ML runtime); in-app ONNX only if
  that proves insufficient
- **Golden renders** (`silverbox check`): commit a thumbnail/hash next to
  each sidecar and let the CLI re-render and report ΔE — a photo archive
  that owns a regression test suite; engine updates become detectable
  choices instead of silent drift
- Unit-test tier (vitest) for pure engine math (matrices, splines,
  solvers, sanitizers) under the E2E suite — F3b's Sony-spline decoding
  should be written test-first against in-camera-JPEG-derived values
- Look-history replay (render a sidecar's git history as a timelapse)
- Learn-a-preset from a set of looks (distill shared parameters from
  chosen sidecars; exploratory)
- Camera-JPEG look match (one-click starting point that resembles the
  in-camera rendering; the baseline-exposure subset comes first via the
  LR calibration)
- Read-only browser viewer / slideshow for photo+sidecar repos
- LUT **import** node (film-sim .cube packs inside the graph)
- B&W mixer (per-band gray conversion, LR's B&W tab)
- Auto tone (one-button histogram-based starting point)
- Gamut warning overlay + Display P3 preview (enabled by Rec.2020)
- HDR export (PQ / gain-map)
- AdobeRGB / Display P3 export with ICC tags (print)
- Perspective correction (keystone / LR Upright)
- Grain quality pass (gaussian, band-limited, roughness control)
- Navigator panel; EXIF info panel
- UI theming via design tokens (vim-colorscheme-style shareable JSON)
- AI subject/sky selection → mask output (after masks; needs an inference
  story, same constraints as denoise)

## Not planned

See DESIGN.md non-goals: no catalog/DAM (for now), no built-in
chat/assistant UI, no raster masks in documents, no ACES / configurable
working space, no cloud.
