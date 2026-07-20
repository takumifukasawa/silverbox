# Audit: verification gaps in the 2026-07-20 landings

Status: AUDIT (Fable, 2026-07-20). A Fable-direct scrutiny of what the
72-script suite + 270 unit tests do NOT cover across this session's
landings (linked looks A-G, develop-aware thumbnails, the bw.enabled
fix, look-extraction mode-2 stage-1). Each item is a KNOWN GAP with a
concrete test to close it — none is a known bug (where a bug was found
it was fixed and cited). Grounded findings note where Fable verified
the behavior by hand vs where only coverage is missing. For the next
conductor (Opus) to burn down when convenient; not blocking.

## 1. Repair-sheet orientation: correct, but only flip-0 has an E2E ⚠️coverage

VERIFIED CORRECT BY HAND (Fable, this audit): repairSheetTransform's
orientForward/orientInverse are not just self-consistent (round-trip
identity, which alone could hide a shared-direction error) — they are
DIRECTIONALLY correct. Ground-truth check: flip 6 (90° CW) maps the
pre-orientation raster's top-left → oriented top-right and bottom-left
→ top-left (exactly a 90° CW rotation); flip 5 (90° CCW) maps top-left
→ bottom-left. Round-trip identity holds for all of {0,3,5,6}.
GAP: verify-repairsheet.mjs only exercises flip-0 (the test ARW is
landscape). No E2E stamps a sheet made from a PORTRAIT frame onto
another frame of the same body.
TEST TO ADD: a portrait ARW fixture (flip 5 or 6) — create a sheet
from it, apply to a second portrait frame; assert the applied spots
land at the correct anchor coords. If no portrait ARW is available,
a unit test that runs anchorSpotToSensor→sensorSpotToAnchor through a
synthetic flip-6 ReadoutWindow and asserts the landscape/portrait dims
swap correctly (the unit suite has the round-trip but assert the
absolute mapping against the hand-computed values above).

## 2. bw.enabled fix: the ONLY boolean develop leaf — guard the next one

FIXED this session (e3a4ed7): mergeSection had no boolean branch, so
any boolean develop leaf silently reset to its default on sidecar
reparse. bw.enabled was the only such leaf and reopened as color.
GAP: the fix is verified for bw.enabled, but the next boolean leaf
added to DevelopParams would be the first to exercise the new branch —
and nothing pins the general behavior.
TEST TO ADD: a unit test on mergeDevelopParams that sets a boolean leaf
to the NON-default value, round-trips through serialize→parseGraphDoc,
and asserts it survives — written generically enough that a future
boolean leaf is covered by construction. verify-bw only ever saved
enabled:false (= default), which is exactly why the bug hid for so
long; the new test must save the non-default.

## 3. Develop-aware thumbnails: the spatial-op fallback path is untested

The thumbnail CPU pass falls back to the plain preview whenever the
active chain has any spatial/out-of-process step (Detail, spots,
mask-consuming blend, custom WGSL, external/denoise) — cpuEvalPlan
throws, caught, returns null. This is COMMON in production (Detail
sharpening is part of the real default RAW look outside the test
suite's suppression flags), so the fallback is a main path, not an
edge.
TEST TO ADD: verify-develop-thumbnails check that a look containing a
Detail/spots node yields the plain-preview bytes (not a threw/blank
cell) — assert the cell equals the plain preview AND no exception
surfaced. Without it, a regression that makes cpuEvalPlan throw a
DIFFERENT error (not the spatial-op contract) would silently blank
those cells instead of falling back.

## 4. Linked looks × virtual copies: the interaction is specified, lightly tested

linked-looks.md §4.3: duplicating an output clones the Develop WITH its
link state, and each chain then independently keeps following or
detaches. The link actions scope by chainScope(activeOutputId) (Fable
verified this in the stage-C/G reviews — no wrong-copy leak). GAP: no
E2E takes a LINKED photo, duplicates its output (virtual copy), and
asserts (a) both chains carry the link, (b) editing one chain's
followed family forks only that chain, (c) publish from one chain reads
only that chain's linked node.
VERIFIED CORRECT BY CODE INSPECTION (Fable, this audit): duplicateOutput
(appStore.ts:5038) clones each upstream node via structuredClone,
overriding only id + position — so a Develop's `link` field rides into
the clone intact (a). Fork-on-touch mutators map by node id → editing
the clone's followed family forks only its own link.follows (b).
Publish scopes by chainScope(activeOutputId) → reads the linked node in
that chain only (c). Two linked Develops in one photo following the
SAME look, one per chain, is exactly what §4.3 allows. This is a
COVERAGE gap, NOT a bug.
TEST TO ADD: extend verify-virtualcopy.mjs or verify-linkedlooks.mjs
with a duplicate-output-of-a-linked-photo scenario covering (a)-(c)
end-to-end.

## 5. Cross-machine drift no-op: assert the NEGATIVE

verify-linkedlooks3 covers drift-at-open re-materialization and
value-drift-implies-fork. The design also promises a NO-OP: a publish
commit pulled from another machine (followers already carry the new
materializedFrom) must NOT trigger a spurious fan-out at open.
CONFIRM/ADD: an explicit assertion that opening a project whose
followers' materializedFrom already matches the look hash pushes ZERO
undo entries and rewrites ZERO files. The positive (drift detected)
is tested; the negative (no false-positive drift) is the one that
guards against an annoying every-open re-materialize.

## 6. Library migration idempotency + collision

verify-library covers the one-time migration + dual-location reads.
GAP: (a) the migration marker's idempotency across TWO app launches
(second launch must not re-copy or clobber a library file the user
edited between launches — the "never overwrite an existing library
file" guard); (b) a slug that exists in BOTH legacy and library with
DIFFERENT content (library must win on read; delete removes both).
TEST TO ADD: a second-launch check (marker present → no re-copy) and a
divergent-content collision check.

## 7. Publish undo across a photo the user closed mid-session

Publish/DeleteSharedLook/re-materialize undo entries carry follower
graphs and (for publish/delete) the look-file text. Global undo JUMPS
to a different photo when reverting its entry (DESIGN.md global-undo).
GAP: an E2E that publishes, NAVIGATES AWAY to a non-follower photo,
then ⌘Z — asserting the fan-out reverts in place (batch entries revert
all targets without a single-photo jump, per the global-undo batch
rule) and the shared-look file is restored byte-identical.

## Not gaps (checked, clean)

- SyncUndoEntry producers after the Sync removal: all 7 belong to live
  actions (Fable verified in the /double-check); no dangling
  syncSelection.
- Materialized-render invariant: sanitizeDevelopLink never throws,
  absent/malformed → not-linked, CLI/old-reader render correctly with
  the link ignored (verified).
- Repair-sheet SPOTS_CAP pre-write refusal: insertSpotsIntoChain checks
  the cap before writing; sanitizeSpotsParams' silent slice never trims
  a sheet apply (verified).
