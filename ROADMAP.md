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
Spot removal (v1, manual clone circles): a `spots` node holds a non-destructive
list (up to 32) of dst/src circle pairs, drag-created on the canvas in "Spots"
tool mode and auto-inserted right after the input node (retouch before color);
spatial (no CPU mirror, like Detail), excluded from LUT export same as a
masked local adjustment.
Sidecar hot-reload on external change (the AI-editing loop): while an image
is open, main watches its sidecar's containing directory (fs.watch on the
file alone loses the inode across the atomic write-temp-then-rename every
writer, ours included, uses) and pushes a debounced (~150ms) event to the
renderer whenever the sidecar's basename is touched. A clean session
(no unsaved edits) auto-reloads the new content as ONE undo entry with a
transient toolbar notice; a dirty session never auto-clobbers — it shows a
persistent notice with an inline Reload button instead, so even an AI
editing the JSON mid-session can't silently discard in-progress work.
Content unreadable on disk (a mid-write snapshot, a bad edit) leaves the
in-app graph untouched with a warning, and saving over it is still allowed
(the in-app document is the good copy). Self-writes (⌘S, autosave) are
suppressed by comparing disk content against what this session last wrote,
not against the live in-memory graph — so an edit made between save and the
watcher's echo never gets misread as an external change.
Masks: Radial and Linear mask nodes, a mask port on blend, and "+ Local
Adjustment" (one click builds a Develop + Mask + Blend rig wired to the
active output); ColorKey (secondary) mask node for hue/sat/lum keying with
per-axis smoothstep falloff. Sidecar schemaVersion 3/4 (ports on edges,
unknown-field passthrough, named multiple outputs, anchor-space mask/spot
coordinates so a mask stays pinned to its image content across crop/rotate).
Headless CLI renderer (batch export against sidecars/presets): `electron .
--render <images…>` (also `npm run render --` and the `bin/silverbox-render`
wrapper) is an argv mode of the same app — no bundled node-only renderer,
since the develop pipeline is WebGPU inside the renderer process. A hidden
window (the same windowless machinery the verify suite runs on, forced on
even without SILVERBOX_TEST) opens each image via its own sidecar, or the
same fresh-open default look the app itself shows (baseline exposure + base
curve + embedded lens profile), or a named/path preset applied like the UI's
"Apply preset" on a fresh open; renders one or every named output
(`--output`); writes JPEG/PNG with the usual quality/max-dim/metadata/
color-space controls; reports progress as it goes (NDJSON under `--json`).
Continues past a single file's failure (exit 1, each error reported)
rather than aborting the whole batch.
Golden renders (`silverbox-render --check`, extends the CLI renderer above):
a photo archive that owns its own regression suite. `--check --update`
commits a small reference render (`<image>.silverbox.golden.png`, 512px
long edge, sRGB — a real, `git diff`-by-eye PNG) next to each image/sidecar
through the exact same pipeline `--render` uses; a later `--check` re-renders
and reports drift as CIE76 ΔE in Lab (mean + p95 + max), pass = mean ≤
`--threshold` (default 1.0) AND p95 ≤ 3×that. A missing golden is always a
FAILURE unless `--update` (never silently skips an unprotected photo); a
dimension mismatch (the image's aspect ratio changed — a crop edit since the
golden was made) is also a FAILURE (`dims-changed`), never resampled to
force a comparison. Engine updates become detectable choices instead of
silent drift in a photo's rendered look.
Embedded-preview-first opening (the Lightroom trick): a fresh ARW open shows
the camera's own embedded full-size JPEG (Sony's "JpgFromRaw" tag — a sliced
byte range, no decode) as a canvas overlay the instant it's extracted, while
the real libraw decode + GPU render runs behind it; the overlay swaps out the
moment the real image reaches 'ready'. JPEG opens skip the whole path (they
decode fast enough that a preview would itself be the delay).
Folder filmstrip (browse a folder, NOT a catalog): open a folder — via a
folder drop (a dropped item is tried as a folder first, falling back to a
regular file open if it isn't one) or the toolbar's "Open…▾" → "Open
Folder…" — and a horizontal, lazily-thumbnailed strip appears below the
canvas, listing that folder's images (no recursion) sorted by filename; click
a cell, or ←/→, to switch. Thumbnails reuse the Sony embedded-preview
extractor with a new size preference (the smallest embedded JPEG at least
160px on its long edge — the a7C II's own IFD1 thumb, not the full-frame
preview) for a RAW, or a decode-time `createImageBitmap` resize for a JPEG;
loaded lazily (IntersectionObserver) through a small concurrency-limited
queue, cached as blob: URLs per path with no on-disk cache (that stays
catalog territory) and revoked on every folder switch. A single-file open
(dialog, drop, or the verify harness's own open hook) always exits
folder-browsing and shows no strip, matching today's exact experience.
Ratings persisted in the sidecar (so they stay git-native) are explicit
future work, not v1.
Shared looks (共通ルック — the linked-look / material-instance system):
a shared look is a preset-format file inside the project
(`<project>/shared-looks/<slug>.json`); a photo's Develop node carries an
additive `link` (which look, which adjustment groups it follows, and a
`materializedFrom` hash) — one linked Develop per chain, added Develops
are local tweak layers. Editing a followed group forks it local
(「この写真だけ個別調整中」badge); revert per-group or reset-all resumes
following. Publish writes the open photo's chosen groups into the shared
look and re-materializes every follower (one ⌘Z reverts the whole
fan-out, look file included). Photo files stay FULLY MATERIALIZED — the
link is additive sync metadata, so the CLI and any older reader render a
linked photo correctly with the field ignored; deleting a shared look
leaves every follower's rendering untouched and independent. External
edits to a shared-look file (an AI, a git pull) re-materialize followers
through the same path, with a clean/dirty guard and drift detection at
project open; a follower whose followed values were edited externally
forks rather than being clobbered. A visible library at
`~/Silverbox/Library/` (one-time migration of the old
`<userData>/presets`, dual-location reads) is where looks/presets live to
travel between projects and machines — vendor-in copies a library look
into a project, publish-to-library copies one out, and dropping a file in
the folder IS the import. Apply-preset-to-selection stamps a saved preset
onto the whole filmstrip selection as one undoable batch. Repair sheets
(ゴミ取りセット): a dust-spot set stored in PHYSICAL SENSOR PIXELS
(`<project>/repair-sheets/`), stamped one-shot onto a RAW selection
through each frame's own readout-window∘orientation transform (spots
outside a frame drop; a target over the 32-spot cap is refused loudly,
never truncated); applied spots become ordinary editable photo-local
spots. The old Sync button and Auto Sync toggle are removed — fully
subsumed by apply-preset-to-selection and repair sheets.

## In flight / agreed order

Nothing currently in flight — every previously agreed item above has
shipped, including linked looks (共通ルック) A-G. See "Nice to have"
below for what's next; Image node (composite with / mask by another
file) and Denoise both moved there, unstarted.

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

- **Ratings** for the folder filmstrip (Implemented above): a per-image
  rating, stored in that image's OWN sidecar (not a database, not a
  catalog-wide index) so it stays git-native like everything else here —
  deliberately deferred out of the filmstrip's v1.
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
- Image node: composite with / mask by another file (path reference) — a
  second image feeding a node graph the way a mask node feeds a shape today
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
