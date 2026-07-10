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
EXIF/ICC, drag & drop, linear wide-gamut working space (Rec.2020).

## In flight / agreed order

1. Masks: Radial/Linear nodes + mask port on blend + "+ Local Adjustment"
   (sidecar schemaVersion 3, ports on edges, unknown-field passthrough,
   named multiple outputs ride the same bump)
2. ColorKey (secondary) mask node
3. Spot removal (clone circles, non-destructive list)
4. Image node (composite with / mask by another file, path reference)
5. Presets (JSON files, app dir + git-shareable)
6. Sidecar hot-reload on external change (the AI-editing loop)
7. LUT export: .cube + Unity URP strip + UE 256×16 + WebGL snippet
8. Sony embedded lens profile auto-correction (validated against the
   in-camera JPEG)
9. AI denoise (ONNX/WebGPU)
10. Headless CLI renderer (batch export against sidecars/presets)

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

## Nice to have

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
- Embedded terminal pane (the user's own shell/AI client)
- AI subject/sky selection → mask output (after masks + AI denoise)

## Not planned

See DESIGN.md non-goals: no catalog/DAM (for now), no built-in
chat/assistant UI, no raster masks in documents, no ACES / configurable
working space, no cloud.
