# Silverbox design philosophy

What Silverbox is, what it refuses to be, and the principles every feature is
measured against. The [README](README.md) describes what the app does today;
this document explains *why* it is built the way it is, so that future
features (and future contributors, human or AI) inherit the same shape.

## Identity

Silverbox is a **RAW developer with a compositor's heart**. It pairs the
everyday Lightroom-style develop workflow — sliders, curves, crop, local
adjustments — with a node graph in which every one of those edits is an
inspectable, rewireable step. The graph is not an expert mode bolted onto a
photo editor; it is the single source of truth that the friendly UI compiles
down to.

The intended user is, first, its author: someone who develops photographs
*and* writes shaders, keeps their work in git, and wants the looks they
build to travel — into Unity, Unreal, OBS, the web — rather than stay locked
inside a catalog. The project is public because the *ideas* are worth
sharing — a photo tool whose documents are code-shaped, whose engine is
machine-verified, and whose development is AI-orchestrated — not because it
competes on feature count.

Developing quality and look-development freedom are not competing goals
here, and neither is allowed to lose: the daily developing experience is
*built out of* composable look-dev primitives, so making the primitives
better is how the photographs get better.

## Principles

### 1. Non-destructive to the bone

The original file is never modified. Every edit — parameters, curves, crop,
masks, spot removal, external image references — lives in a sidecar document
as **data that describes intent**, never as baked pixels:

- curves are control points, not LUT dumps;
- crop/straighten is a normalized rectangle and an angle, re-resampled from
  the source on every render;
- future brush masks will be stored as vector stroke lists (position, radius,
  flow) and rasterized at render time, not as embedded bitmaps;
- spot removal will be a list of source→destination circles;
- compositing with other images stores file references, not copies.

If a feature cannot express its edit as reviewable data, its design is wrong.

### 2. The document is git-native — and therefore AI-native

The sidecar (`<image>.silverbox.json`) is pretty-printed, stably ordered,
schema-versioned JSON. It diffs, branches, merges and reviews like source
code. This is not just a storage choice: a text document with documented
semantics is also an **API surface**. The planned path for AI-assisted
editing is exactly this — watch the sidecar for external changes and
hot-reload it, so that anything able to edit JSON (a human in an editor, a
script, an AI client) can edit the photograph. The app's job is to make
reaching that loop effortless — at minimum a one-click way to open the
user's own terminal (zsh, WSL, whatever runs their AI client and git) at
the document's directory; possibly an embedded pane someday — but it will
not grow its own chat UI or a built-in assistant: each user's existing
tools should compose with Silverbox for free.

### 3. The engine is verified, not trusted

Rendering correctness is enforced by invariants, and the invariants are
enforced by machines:

- **Identity is bit-exact.** A node at default parameters emits no GPU pass
  at all. Untouched means untouched.
- **Every per-pixel color op ships as a matched pair**: a WGSL pass and a CPU
  mirror with numerically identical formulas (same constants, same operation
  order). GPU and CPU renders of the same plan must agree within 1/255.
  Position-dependent ops (vignette, grain) are mirrored too; only genuinely
  spatial ops (blur kernels, resampling) are exempt, and the plan says so.
- **Every feature lands with a verify script** — a Playwright run against the
  real app, real ARW files and real on-screen pixels — and the full suite
  must be green before every commit.
- Internally the chain is linear light in `rgba16float`; the exact piecewise
  sRGB transfer functions exist in one place (plus their WGSL twins) and
  nowhere else.

### 4. The graph is the truth; the friendly UI is sugar

Lightroom-style controls (the inspector, "+ Local Adjustment", crop mode)
are conveniences that build or edit graph structure the user could have
wired by hand. Consequences:

- there are no special node classes for "primary" vs "secondary" grading —
  a secondary is just a Develop node with a mask plugged into its blend;
- "virtual copies" are not a separate concept either: a graph may hold
  several named output nodes (compositor-style), each a look that shares
  whatever upstream structure it wants — previewable and exportable
  per-output;
- anything the UI can do, the document can express, and vice versa; the
  same holds for the command line — batch rendering a folder against a
  document is a first-class, UI-free operation;
- power users may open the node editor and rewire what a one-click helper
  created; the helper never hides structure.

### 5. Reference-calibrated, not invented in a vacuum

Response curves and parameter feels are calibrated against references with
ground truth, not tuned by gut:

- **Lightroom** is the behavioral reference for develop controls (ranges,
  defaults, perceived strength). Tunable strengths live as named constants
  flagged for side-by-side calibration sessions.
- **The camera's own JPEG** is the ground truth for lens corrections: Sony
  ARW files embed per-shot distortion/CA/vignetting splines, and the
  in-camera JPEG shows what "corrected" is supposed to look like.
- Where a spec exists (the original raw-compositor rebuild spec), recorded
  verification values — like the as-shot white balance of the reference
  image — are reproduced exactly.

### 6. Scene-referred color, output-referred late

Working color is linear and **wide**: a RAW editor that clips camera gamut
at decode time has thrown away data no slider can recover, which sits badly
with a tool that calls itself a RAW developer. The engine works in **linear
Rec.2020** — one fixed working space, defined in a single module the whole
engine imports from. Display and export convert to the destination late
(sRGB today; print/HDR targets become possible later precisely because the
working space is wider than any of them). Effects that
model display behavior (tone curve, grading) operate on encoded values by
design — but encoded *working-space* values, never a clipped copy. The
full decision record, including what histograms and scopes measure and
why, is in [COLOR.md](COLOR.md).

### 7. Looks are exportable artifacts

A look built in Silverbox should not be trapped in Silverbox. Baking the
color chain into portable LUTs (.cube for OBS/Resolve, strip textures for
Unity/Unreal/WebGL) is a first-class feature, with an honest UI about what
does and does not bake (spatial and position-dependent ops do not).

### 8. Boring portability

macOS is the development platform; Windows is an intended target. Every
dependency in the stack (WebGPU, libraw-wasm, sharp, Electron) is chosen to
be portable, paths and keyboard shortcuts are abstracted as they are
written, and platform-specific behavior is isolated in the main process.

### 9. Documents outlive versions

Two compatibility promises, kept forever:

- **Old sidecars always load.** Every schema bump ships with sanitizers
  that read every previous version; a photograph edited today opens
  correctly in every future Silverbox.
- **Unknown data survives round-trips.** An older Silverbox that opens a
  newer document must carry fields it doesn't understand through
  load→save untouched, instead of silently deleting a future feature's
  data. Not knowing what something means is no excuse for destroying it.

### 10. Performance model: display-resolution editing, honest pixels on demand

Editing runs the GPU chain at display-appropriate resolution so sliders
respond instantly; exports render at full resolution. True 100% inspection
is planned as on-demand tile rendering of the visible region at full
resolution (the Lightroom/darktable model) — keeping full-resolution
textures in the interactive chain at all times would trade responsiveness
and VRAM for accuracy nobody is looking at.

And the **UI thread is sacred**: interaction responsiveness must never be
hostage to rendering load. Decode already lives in a worker; the direction
of travel is a worker-owned renderer (OffscreenCanvas) that receives
documents and returns compact results, with heavy per-pixel analysis
(histograms, scopes) moving into compute shaders — so the main thread's
only jobs are the UI and the document.

## Non-goals (deliberate, revisitable)

- **No catalog/DAM** for now. Silverbox develops one image at a time;
  becoming a library manager is a different product with different gravity.
  Revisit only after the developing experience is complete.
- **No built-in chat UI or assistant.** AI integration goes through the
  document (see principle 2); at most the app hosts the user's own terminal.
- **No raster mask data** in the sidecar. Vector strokes only, when brush
  masks arrive.
- **No ACES pipeline, no ICC-managed working space.** One working space,
  chosen once (principle 6), revisited only if printing/HDR demands more.
- **No cloud anything.**

## Process notes

Development runs as an orchestrated flow: a conductor session owns design
briefs, reviews, verification runs and commits; implementation agents work
from written briefs and never commit. One feature = one verify script = one
commit, and the whole suite runs green before anything lands. The repo's
history is meant to read as a sequence of complete, verified features.

## The color model — DaVinci's structure, Lightroom's controls (decided 2026-07-13)

Color correction has exactly three layers, each with ONE job; new color
features must name their layer or be rejected:

1. **Profile** (upstream of everything): the camera's character — the
   fitted base curve today, the fitted color transform (profile fit)
   next. Applied as visible default-look state, never hidden.
2. **Primary** = the Develop node's interior, deliberately shaped like
   Lightroom's right panel (tone, curves, HSL mixer, grading wheels,
   saturation/vibrance). This surface is FROZEN — LR-refugees' muscle
   memory is the spec; no new global color tools.
3. **Secondary** = mask+blend rigs (radial/linear/ColorKey — ColorKey IS
   the HSL qualifier). Targeted color work belongs here, and is MORE
   capable than panel-side alternatives (a rig applies any Develop
   adjustment, not just hue/sat/lum). Consequence: LR's Point Color is
   deliberately NOT adopted — the investment goes into making ColorKey
   rig creation as fluid as Point Color's gesture instead.

Adjacent guards from the same review: scopes beyond the histogram
(waveform/parade/vectorscope) are maintenance-only (no further
investment; collapse under "advanced" at the next UI pass); the custom
WGSL node is load-bearing for the looks-as-code thesis but
expansion-frozen (expert feature); when the wipe compare lands, one
compare mechanism becomes primary rather than accreting two.

## The catalog line (explicit slope guard)

Views may FILTER, nothing may PERSIST view state as photo metadata
beyond the sidecar, and search/collections/keywords do not exist. The
filmstrip rating filter sits exactly ON the line — anything past it
(saved filters, smart groups, cross-folder queries) is the catalog
slope and gets rejected by default.

## Visible path to every result (decided 2026-07-13)

Every achievable RESULT must have a discoverable, clickable path.
Keyboard shortcuts, modifier keys, and gestures are ACCELERATORS
layered on top — never the only way to a result. The refinement that
keeps this from bloating the UI: distinguish OPERATIONS from
ACCELERATORS —
- Operations (delete a node, create a mask, export, rate, toggle a
  view) get visible controls.
- An accelerator that merely speeds up an already-reachable result
  (⌥-drag = center resize, reachable by dragging opposite edges;
  wheel = brush radius, reachable by the slider) needs an inline HINT
  (control-strip text / tooltip), not a button.
- New-feature briefs must state, per interaction: which results it
  adds, their clickable path, and which gestures are accelerators with
  what hint. A `?` shortcuts overlay is the eventual single
  discoverability net (docs/ui-architecture.md).

Audit at adoption: one violation existed — copy/paste develop settings
was ⌘⇧C/V-only; fixed by adding Copy/Paste entries to the Presets menu
(the persistent cousin of the same concept).
