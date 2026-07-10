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

The intended user is someone who develops photographs *and* writes shaders,
keeps their work in git, and wants the looks they build to travel — into
Unity, Unreal, OBS, the web — rather than stay locked inside a catalog.

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
hot-reload, then expose the same operations through an MCP server — rather
than embedding chat panels or terminals into the app. Tools the user already
has (an editor, git, an AI client) should compose with Silverbox for free.

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
- anything the UI can do, the document can express, and vice versa;
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

Working color is linear and wide. The engine started in linear sRGB and is
migrating to **linear Rec.2020** as its working space, because a RAW editor
that clips camera gamut at decode time has thrown away data no slider can
recover. Display and export convert to the destination (sRGB today; wider
print/HDR targets become possible later precisely because the working space
is wider than any of them). Effects that model display behavior (tone curve,
grading) operate on encoded values by design — but encoded *working-space*
values, never a clipped copy.

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

## Non-goals (deliberate, revisitable)

- **No catalog/DAM** for now. Silverbox develops one image at a time;
  becoming a library manager is a different product with different gravity.
  Revisit only after the developing experience is complete.
- **No embedded terminal or chat UI.** AI integration goes through the
  document and MCP (see principle 2).
- **No raster mask data** in the sidecar. Vector strokes only, when brush
  masks arrive.
- **No color spaces beyond the Rec.2020 working space** (no ACES pipeline,
  no ICC-managed working space) unless printing/HDR demands it.
- **No cloud anything.**

## Process notes

Development runs as an orchestrated flow: a conductor session owns design
briefs, reviews, verification runs and commits; implementation agents work
from written briefs and never commit. One feature = one verify script = one
commit, and the whole suite runs green before anything lands. The repo's
history is meant to read as a sequence of complete, verified features.
