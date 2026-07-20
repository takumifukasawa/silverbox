# Brief: develop-aware filmstrip thumbnails — impl (in-memory (c))

Status: LANDED 2026-07-20 BUT ⚠️ INEFFECTIVE IN PRACTICE — FIX PENDING
(user hand-test 2026-07-21: "サムネに編集が反映されない"). ROOT CAUSE
(Fable-direct, confirmed): the fallback is ALL-OR-NOTHING. getDevelop-
AwareThumbnail runs the FULL plan through cpuEvalPlan, which THROWS on
the first CPU-mirror-less (spatial) step; the catch then falls back to
the plain preview for the WHOLE cell. But a real RAW's default look
ALWAYS seeds Detail (sharpening amount 40, seedDefaultLook) — a spatial
step — so cpuEvalPlan throws and EVERY real RAW cell shows the plain
preview, discarding the exposure/contrast/WB/curve/HSL/grading edits
that ARE mirrorable. FIX: build the thumbnail plan EXCLUDING spatial /
no-CPU-mirror steps (Detail, spots, masks, position-dependent vignette,
external/denoise) and cpuEvalPlan over the color/tone steps only —
sharpening etc. is invisible at 160px anyway; the color DIRECTION (the
whole point) then shows. Wire the exclusion in buildDevelopPlanForLook
(Filmstrip.tsx) or getDevelopAwareThumbnail (thumbnailCache.ts) — NOT
appStore. Update verify-develop-thumbnails: a look with BOTH a tonal
edit AND Detail must show the tonal DIRECTION (not fall back to plain).
The verify passed originally because its test looks were pure tonal/BW
with no Detail — add the Detail-plus-tonal case.

Status: LANDED 2026-07-20 (SUITE 71/71, unit 254; also fixed an independent bw.enabled sidecar-reparse bug, commit e3a4ed7). Implements the conductor recommendation
in docs/brief-bank/develop-aware-thumbnails.md, scoped to the variant
that needs NO user principle-call: (c) hybrid with an sRGB-correct (a)
layer, thumbs held IN MEMORY only (no persistent files — the visible
per-project thumb-file variant (b-on-disk) is a deferred follow-up,
NOT this brief). Read that recommendation + the "problem"/"hard
constraint"/"options" sections first.

## Why now

Linked looks shipped: publish (stage C) fans a look change out to
CLOSED followers' files, and apply-preset-to-selection (stage A) +
repair sheets (stage F) write N closed photos at once. The filmstrip
still shows each cell's camera embedded preview, so those cells now LIE
about the look — exactly the user's hand-test observation
(「変更した見た目がサムネには反映されてないかも？」). This closes that
gap without adding on-disk artifacts.

## Decided semantics (not options)

1. **The approximate layer (a), sRGB-correct.** When a photo's look is
   non-default, render its develop result over the cached 160px
   embedded-preview pixels via the CPU mirror (cpuEvalPlan,
   graphDoc.ts:1617): for each pixel, sRGB-DECODE the preview sample to
   approximate linear (engine works in linear — reuse srgb.ts's exact
   transfer functions, NOT a gamma-2.2 shortcut), run cpuEvalPlan(plan,
   linearPx, x, y, W, H), then sRGB-ENCODE back. This removes the
   double-curve error the naive (a) would have (see the recommendation
   §2). It stays a DIRECTION indicator: geometry (crop/rotate) and
   spatial ops (masks/spots/vignette framing) are NOT applied — the
   preview is already baked and this is per-pixel color only. Document
   that honestly in the code.
2. **Plan source.** Build the RenderPlan from the photo's look file the
   same way the CLI/thumbnail-less paths do (buildPlan over the parsed
   GraphDoc; find how appStore/CLI construct a plan from a look and
   reuse it). Use the look's ACTIVE output chain. A look that fails to
   parse falls back to the plain embedded preview (never throw).
3. **Trigger (the whole point — the OTHER cells).** A cell recomputes
   its develop-aware thumb whenever:
   - it first loads and its look is non-default (initial), and
   - that photo's look FILE changes while the folder is shown — i.e.
     after publish fan-out, apply-preset-to-selection, repair-sheet
     apply, link/revert/unlink, and single-photo autosave. Hook the
     invalidation into the points that already write look files +
     refreshPlaylistStatus; a per-path "look version" counter that the
     Filmstrip cell subscribes to is the clean shape (bump it for every
     path whose look file this session just wrote). Do NOT decode the
     RAW — reuse the already-cached embedded preview pixels; if a cell
     has no cached preview yet, the develop pass simply waits until the
     preview loads (the normal lazy path), then applies.
4. **Cost / no eager work.** ~160×107 CPU-eval per affected cell, zero
   RAW decodes. A publish reaching N followers recomputes N thumbs off
   the already-cached previews. Keep it off the UI thread's critical
   path (the existing thumbnail queue is the model — reuse its
   concurrency limiting); a batch that touches many cells must not
   janks the strip.
5. **In-memory only.** The develop-aware bitmap lives in the same
   in-memory cache shape thumbnailCache.ts already uses (blob URL per
   path, revoked on folder switch). NO file is written anywhere. When
   the look returns to default, the cell reverts to the plain embedded
   preview.
6. **Preview pixels access.** thumbnailCache currently ends at a blob:
   URL for the <img>. You need the raw RGBA pixels to run the CPU
   mirror — decode the cached preview blob once into an OffscreenCanvas
   / ImageData (or restructure the cache to retain the ImageData
   alongside the blob). Keep the plain-preview blob path intact for
   default-look cells (the common case — no CPU work at all).

## Read before writing

thumbnailCache.ts (whole file — the cache shape, the two decode
strategies, revokeAllThumbnails), Filmstrip.tsx (IntersectionObserver
lazy load, key={dir} remount cleanup, how a cell gets its thumb URL),
graphDoc.ts cpuEvalPlan + buildPlan/RenderPlan, engine/color/srgb.ts
(the exact CPU transfer functions — the sRGB decode/encode MUST use
these, engine invariant), appStore.ts refreshPlaylistStatus + the
look-file write points (publishToSharedLook, applyPresetToSelection,
applyRepairSheet, link/revert/unlink, saveGraph) for the invalidation
hook, nodeThumbCache.ts (the per-node preview precedent, canvas-side).

## Verify (new script verify-develop-thumbnails.mjs)

1. Open a folder; a photo with a default look → its thumb bitmap
   equals the plain embedded preview (no CPU pass). Assert NO extra
   LibRaw decode fired for the develop pass.
2. Edit the open photo to a strong exposure/B&W → its cell bitmap
   changes in the expected DIRECTION (mean luma moves; a B&W look drives
   channel convergence on the cell bitmap) with no RAW re-decode.
3. The OTHER-cells case: select 2 closed photos + apply-preset-to-
   selection (or publish a shared look with closed followers) → those
   cells' bitmaps change within the debounce window, again with no RAW
   decode for them.
4. Revert the look to default → the cell returns to the plain embedded
   preview bytes.
5. Folder switch → revocation still leak-free (no blob: URL accumulation
   across switches; reuse revokeAllThumbnails).
Register verify:develop-thumbnails in package.json (+ verify:serial)
and scripts/run-verify.mjs; SUITE grows to 71.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
capture SUITE line). NEVER git add/commit. zsh `=` hazard. Engine
invariants (the sRGB transfer functions live in srgb.ts + WGSL twins —
reuse, never re-derive; GPU/CPU parity is not at stake here since this
is a CPU-only preview, but the sRGB functions must be the shared ones).
UI-thread-is-sacred (DESIGN §10): the CPU pass runs through the
thumbnail queue, never blocking interaction. Japanese display text if
any; English code.

## Report back

Files touched; where each numbered semantic (1-6) lives (file:line);
how the invalidation trigger is wired (which write points bump the
version); deviations + reasons; fragile spots; SUITE line + unit count.
