# Brief: LUT import node — apply a .cube film-sim inside the graph

Status: DESIGN-READY (Fable, 2026-07-20) — dispatchable. The mirror of
the shipped LUT EXPORT (buildLutExport): where export BAKES our chain
to a .cube, this READS someone else's .cube into the chain as a node.

## What it is

A new node kind `lut` that samples a loaded 3D (or 1D) color LUT. Drop
it in the graph (or via a "+ LUT…" inspector helper) to apply a film
emulation / creative LUT the user owns. It composes with Develop like
any other node — typically placed AFTER Develop (a finishing look on a
corrected image), but the graph lets the user put it anywhere.

## Decided design

1. **Format: Adobe/Iridas `.cube`** — the same format LUT export already
   emits, so the parser and its conventions (DOMAIN_MIN/MAX, LUT_3D_SIZE
   / LUT_1D_SIZE, row-major RGB triplets) are already understood on the
   export side; write the READ counterpart. Support both `LUT_3D_SIZE`
   (the common case, film sims) and `LUT_1D_SIZE` (per-channel tone).
   Reject/skip malformed files with a loud notice, never a silent
   half-load (sanitizer posture).
2. **Where the LUT lives (color space) — the load-bearing decision.**
   A .cube is defined over a SPECIFIC input encoding (almost always
   display-referred sRGB or Rec.709, 0..1). Our working space is linear
   Rec.2020. So the node must: encode working→the LUT's expected space
   at its input, sample the LUT, decode back to working at its output.
   v1 assumption: **the LUT is sRGB-display-referred** (the film-sim
   norm); expose it as the default with a small "input space" selector
   (sRGB / Rec.709) for correctness, documented. Do NOT feed linear
   Rec.2020 values straight into a display-referred LUT — that is the
   classic wrong-look bug. Clamp to [0,1] at the LUT boundary (a display
   LUT is undefined outside its domain); note that this CLIPS highlights
   above the LUT's white — an honest, documented limitation of applying
   a display LUT mid-pipeline (same class as the denoise-node round-trip
   note).
3. **Node payload (sidecar, non-destructive per DESIGN.md principle 1).**
   Store a FILE REFERENCE to the .cube (path, sidecar-relative with
   absolute fallback — same policy as the Image node's file reference),
   NOT the baked table, plus the input-space selector + an amount/mix
   (0..1 blend vs identity, like the develop lattice's amount). The
   table is loaded from the referenced file at render time. A missing
   .cube = placeholder/pass-through + a relink notice (Image-node
   precedent), never a crash.
4. **GPU + CPU mirror (engine invariant).** GPU: upload the 3D LUT as a
   `texture_3d<f32>` and trilinearly sample (the hardware sampler does
   the interpolation); 1D LUT = three `texture_1d` or a small uniform.
   ⚠️ PREMISE CORRECTION (Fable brief-audit 2026-07-20): the engine has
   NO 3D-texture infrastructure today — every current texture binding is
   2D (grep for texture_3d is empty). So the 3D path is NET-NEW plumbing
   (WebGPU 3D texture creation + a `texture_3d<f32>` WGSL binding + a
   sampler), NOT "follow the existing texture-binding pattern" — size the
   GPU side accordingly. Two de-risking options: (a) ship the 1D LUT
   first (a small uniform array, no 3D texture — covers per-channel tone
   .cubes) and add 3D as a follow-up; (b) if 3D-texture support proves
   fiddly on the WebGPU/Electron stack, an interim 3D LUT can be sampled
   from a 2D "tiled" texture (the Unity/Unreal strip layout the LUT
   EXPORT already emits — reuse that packing) with manual trilinear in
   WGSL. The CPU mirror (trilinear in JS) is straightforward either way.
   CPU mirror: matched trilinear (3D) / linear (1D) interpolation with
   the SAME encode/sample/decode order, GPU↔CPU within 1/255 (the op is
   a per-pixel color transform WITH a CPU mirror — unlike blur/resample,
   it is NOT spatial, so it MUST be mirrored). This makes it exportable-
   aware: a chain containing a LUT node CAN bake into an exported LUT
   (compose the tables), unlike spatial ops — a nice property to note.
5. **UI (visible-path).** A "+ LUT…" inspector control (file picker)
   builds the node wired into the active output; the node's inspector
   shows the filename, input-space selector, and amount slider. Reuses
   the Image-node file-reference + relink UI patterns.

## Read before writing

engine/color/lutExport.ts (the .cube CONVENTIONS to mirror — domain,
size, ordering), the Image node (image-node.md + its impl: file
reference storage, sidecar-relative path policy, relink/missing-file
UX), engine/graph/ops.ts (how a matched WGSL+CPU op pair is structured;
the customShader/blend nodes for how non-OPS nodes plug in — a LUT node
is likely its own kind like blend, not an OPS entry), engine/color/
srgb.ts + workingSpace (the encode/decode at the LUT boundary — reuse),
graphRenderer.ts (texture upload for a 3D texture; follow the existing
texture-binding pattern), sidecar schemaVersion + sanitizer (additive
node kind, unknown-field passthrough).

## Verify (new verify-lut.mjs + unit)

Unit: parse a hand-authored tiny `.cube` (2×2×2 and a 1D) fixture
(ours, checked into scripts/fixtures) → correct table values; trilinear
interpolation at known midpoints matches hand-computed values;
malformed .cube rejected without throwing the document.
E2E: an IDENTITY .cube (maps input→input) applied to a render is a
no-op within 1/255 (the round-trip encode/sample/decode is clean); a
known channel-swap or tint .cube produces the expected shift; GPU vs CPU
mirror agree within 1/255 (the standard op-parity check); a missing
.cube → pass-through + relink notice, no crash. Register verify:lut
(+ verify:serial + run-verify.mjs); SUITE +1.

## Standing rules

Gate loop foreground; NEVER git add/commit; zsh `=` hazard; engine
invariants (matched WGSL+CPU within 1/255; the encode/decode at the LUT
boundary uses srgb.ts, never re-derived); non-destructive (file
reference, not baked table); Japanese display text, English code.

## Report back

Files touched; where each numbered item (1-5) lives (file:line); the
input-space encode/decode boundary handling; GPU/CPU parity result;
deviations; fragile spots; SUITE line + unit count.
