# Brief: repair sheets / ゴミ取りセット (linked-looks stage F)

Status: LANDED 2026-07-20 (SUITE 72/72 (1 known project flake), unit
255 incl. 12 transform tests). Deviations accepted: readoutOrigin is
present for EVERY RAW decode (0,0 when computeCropbox returns null —
the honest full-active-area origin, makes "has readout window" a clean
RAW-only gate); apply includes the open primary as a target (stage A
batch shape). Conductor verified the orientation math self-consistency
(forward∘inverse = identity for flip 3/5/6) and the SPOTS_CAP pre-write
refusal. Fragile spot carried forward: only flip-0 is E2E-exercised;
90°/180° rest on unit tests + derivation.
Parent spec: docs/brief-bank/linked-looks.md §5 (all of it — the
GO-time obligations are BINDING), §2 taxonomy row 2, §9-4. Scope
guard: no Sync/Auto Sync changes (G). Project-local only — NO library
integration (parent §5: no library, deliberately).

## Decided semantics (not options)

1. **Data**: a repair sheet = a named set of spots in PHYSICAL SENSOR
   pixels, stored at `<project>/repair-sheets/<slug>.json` (own tiny
   schema: name, createdAt, cameraModel, sensor-space spot list —
   dx/dy/sx/sy/radius/feather in sensor px). Project-local, no
   library, ever.
2. **Readout-window origin retention (parent §9-4, the ⚠️)**:
   DecodedImage gains an additive optional field carrying the
   camera-recommended crop origin computeCropbox already computes
   (librawDecoder.ts — the rgbCam stage-2 additive pattern; thread
   through the worker/IPC boundary). JPEG decodes leave it absent.
3. **Coordinate contract** (unit-tested, both directions):
   sensor px = readoutOrigin + orientation⁻¹(anchor-space normalized
   × oriented dims). Creating a sheet maps the photo's anchor-space
   spots → sensor; applying maps sensor → each target's anchor space
   through THAT target's own readout window ∘ orientation. Spots
   whose mapped position falls outside the target's frame are DROPPED
   silently for that target (parent §5: dust outside the APS-C window
   maps away — correct, it isn't in that frame). Radius/feather scale
   by the same axis factor the anchor-space conversions use.
4. **Create** («ゴミ取りセットを保存»): from the open photo's current
   spots (all of them; needs ≥1 spot and a RAW photo with the
   readout-window field — else notice). UI near the spot tool /
   SharedLookMenu's pattern.
5. **Apply** («ゴミ取りセットを適用», one-shot, per-frame opt-in):
   applies to the filmstrip selection (stage A's batch shape: batch
   undo entry, completion notice, per-target skip reporting).
   RAW-only v1: non-RAW targets are SKIPPED with a loud per-target
   notice line (parent §5 obligation 2 — no camera-JPEG fallback
   assumptions). Applied spots become ORDINARY photo-local spots
   (editable/deletable afterward, parent §5) — merged into the
   target's spots node via the existing machinery.
6. **SPOTS_CAP obligation (parent §5 obligation 1, BINDING)**: before
   writing a target, if existing spots + mapped sheet spots >
   SPOTS_CAP (32), REFUSE that target loudly (skip + explicit notice
   naming the photo and the count) — never truncate. The
   sanitizeSpotsParams silent slice(0,32) must never be what trims a
   sheet application.
7. **Targets need decode**: a non-open RAW target's readout window +
   orientation come from decoding it (the seed path stage A/B use
   already decodes absent-look targets; reuse; cache per apply run).
8. **Sheet management**: list + delete in the same small UI (delete =
   file delete, notice, no undo — sheets are make-and-discard, parent
   §5; the apply itself IS undoable via its batch entry).

## Read before writing

spotsNode.ts (SPOTS_CAP, sanitizer, Spot shape), anchorSpace.ts (the
conversion conventions + its doc comment's geometry map),
librawDecoder.ts computeCropbox + decode flow, RawDecoder.ts
DecodedImage, the worker decode IPC path, stage A's
applyPresetToSelection batch shape, sharedLooks.ts (file-module
pattern for the new repairSheets.ts).

## Verify (new script verify-repairsheet.mjs + unit tests)

Unit (vitest, pure math): sensor↔anchor round-trip identity; synthetic
orientation (90°) and readout-offset cases; outside-window drop;
radius scaling.
E2E:
1. Photo 1: place 2 spots, save sheet → repair-sheets/<slug>.json
   exists with sensor-px coords.
2. Apply to selection (photos 2+3, same ARW): both gain 2 ordinary
   spots at the correct anchor coords (same file ⇒ same mapping);
   batch undo removes from both; redo restores.
3. Cap refusal: pre-seed photo 2 with 31 spots → apply → photo 2
   SKIPPED with loud notice, file untouched (31 spots intact);
   photo 3 still applied.
4. JPEG target: select the .JPG → skipped with notice, never written.
5. Applied spots are ordinary: delete one on photo 3 via the spot
   tool afterward.
Register (verify:repairsheet + verify:serial + run-verify.mjs); SUITE
grows by 1.

## Standing rules

Gate loop foreground before reporting; NEVER git add/commit; zsh `=`
hazard; engine invariants (anchor-space storage for any
position-carrying data — this feature's sensor space is a CREATE/
APPLY-time transform, photo files still store anchor-space spots
only); Japanese display vocabulary; notices for batch ops; one undo
per gesture.

## Report back

Files touched; where each numbered semantic (1-8) lives (file:line);
deviations + reasons; fragile spots; SUITE line + unit count.
