# Silverbox

A node-based, non-destructive RAW/JPEG developer for the desktop.

Silverbox pairs a Lightroom-style develop workflow with a compositor's node
graph: open a Sony ARW (or any libraw-supported RAW, or a JPEG), edit it
through a graph of GPU passes, and export a full-resolution JPEG/PNG. Edits
never touch the original file — the whole graph lives in a plain-JSON sidecar
next to the image, which means your looks diff, branch and review like source
code.

What makes it different:

- **Node compositing on top of developing.** The default `input → Develop →
  output` chain covers the usual workflow, but any node's output can fan out,
  branches recombine through blend nodes, and single-purpose atomic nodes
  (exposure, contrast, white balance, …) can be wired anywhere.
- **Looks you write in code.** A customShader node compiles the body of
  `shade(color, uv) -> vec3f` (WGSL) into the pipeline, with GUI-declared
  float parameters exposed as `P.<name>` sliders. Broken code never breaks
  the preview — the last valid shader keeps rendering while the error is
  shown with editor line numbers.
- **git-native documents.** The sidecar (`<image>.silverbox.json`) is a
  pretty-printed, stable JSON document (schemaVersion 2) carrying the graph,
  its provenance and timestamps.

The principles behind these choices — and what Silverbox deliberately is
not — are written down in [DESIGN.md](DESIGN.md).

## Develop features

- **Basic** — real Kelvin/Tint white balance (as-shot estimated from the
  camera's color metadata via the Planckian locus; as-shot is a bit-exact
  no-op), exposure, contrast, highlights/shadows/whites/blacks,
  saturation/vibrance.
- **Tone Curve** — point curves with PCHIP interpolation, RGB/R/G/B channel
  tabs, endpoint black/white-point control.
- **HSL** — 8 bands × hue/saturation/luminance with smooth band weighting
  and a chroma mask that keeps grays untouched.
- **Color Grading** — 3-way wheels (shadows/midtones/highlights + global)
  with blending and balance controls, zero-luminance chroma handling that
  keeps blacks and whites clean.
- **Detail** — bilateral luminance NR, chroma NR and unsharp-mask sharpening
  with edge masking, computed in a luma/chroma space and scaled so preview
  and full-resolution export agree in look.
- **Effects** — dehaze, clarity, texture, film grain and a post-crop
  vignette with midpoint control.
- **Crop & straighten** — non-destructive normalized crop rectangle with a
  ±45° angle, edited through an on-canvas overlay with rule-of-thirds grid.
- **Lens corrections** — manual distortion, red/blue chromatic aberration
  and vignetting recovery, folded into the same single resample pass as the
  crop.
- **Scopes** — LR-style histogram (RGB + luminance, additive) with clipping
  indicators, plus luma waveform, RGB parade and a vectorscope.
- Before/after compare (`\`) and a grayscale check view (`G`), zoom/pan with
  fit and 1:1 views, undo/redo with gesture coalescing, drag & drop opening.
- **LUT export** — the active output's color pipeline as a standard .cube,
  Unity/Unreal strip PNGs and a WebGL sampling snippet, for bringing a
  Silverbox look into a game engine. Geometry (crop/lens) never applies; any
  spatial op (Detail, clarity/texture), custom WGSL node or masked local
  adjustment can't be captured by a position-independent LUT and is instead
  skipped and reported in the export dialog.
- **Develop presets** — save or apply a whole-look develop graph as a named,
  git-shareable JSON file under the app data dir, with the same
  capture/merge semantics as the develop clipboard (⌘⇧C/⌘⇧V) — a preset
  never carries another photo's crop.

## Engine

Everything internal is **linear Rec.2020** in `rgba16float` textures — a
wide-gamut working space, so saturated colors the camera captured survive
until the sRGB conversion at display/export (see [COLOR.md](COLOR.md)). The
exact piecewise sRGB transfer runs only at the exits (and inside the passes
that deliberately work in display space). The graph compiles into a
topologically ordered plan of WebGPU fullscreen passes; nodes at their
default values are skipped entirely, so an untouched graph is a bit-exact
pass-through of the decode. RAW decoding is libraw-wasm in a worker; export
re-decodes at full resolution, runs the same plan, and encodes through sharp
(JPEG quality, long-edge resize, sRGB ICC profile, EXIF carried over from
the camera metadata).

## Requirements

- macOS with a WebGPU-capable GPU (developed and tested on Apple Silicon).
- Node.js 22+.

## Getting started

```sh
npm install
npm run dev        # develop against the Vite dev server (port 5172)
npm run package    # build an unsigned Silverbox.app into dist/
```

Open an image with the Open… button, ⌘O, or by dropping a file onto the
window. Save the edit sidecar with ⌘S; Export… renders at full resolution.

## Verification

The project is developed against an end-to-end Playwright harness instead of
unit tests: every feature has a `scripts/verify-*.mjs` script that drives the
real app (real RAW file, real GPU) and holds the GPU output to a CPU
reference implementation of the same math, typically within 1/255 per
channel — plus interaction checks through the actual UI.

```sh
npm run verify           # everything (builds, launches, ~30 scripts)
npm run verify:wb        # or any single area
```

The scripts default to a local test image; point them at your own with
`SILVERBOX_TEST_ARW=/path/to/file.ARW` (and `SILVERBOX_TEST_JPG=…`). Note
that dimension-specific assertions assume the default test shot.

## License

[MIT](LICENSE)
