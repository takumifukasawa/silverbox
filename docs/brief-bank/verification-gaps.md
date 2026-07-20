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
RESOLVED (Fable, follow-up audit): bw.enabled IS the only boolean leaf
that flows through mergeSection. The other boolean field near
DevelopParams — GraphNode.disabled (the 'm'-key node bypass) — is a
NODE-level field, not a DevelopParams section leaf: it has its own
parse/serialize path (graphDoc.ts KNOWN_NODE_KEYS + the node-level
`n.disabled = n.disabled ? true : undefined` sanitize, single writer
toggleNodeDisabled), never touches mergeSection, and round-trips
correctly on its own. So no other leaf shares bw.enabled's bug class
today.
GAP: the fix is verified for bw.enabled, but the next boolean leaf
added to a DevelopParams SECTION would be the first to exercise the new
mergeSection branch — nothing pins the general behavior.
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
VERIFIED CORRECT BY CODE INSPECTION (Fable, this audit): cpuEvalPlan
(graphDoc.ts) THROWS `Error("step … has no CPU reference")` for any
step with null `cpu` — spatial ops, image, custom-shader, external/
denoise (explicit throw sites, documented contract). getDevelopAware-
Thumbnail's try/catch catches exactly this and returns null → plain-
preview fallback. So the fallback works by the throw contract; no bug.
TEST TO ADD: a verify-develop-thumbnails check that a look with a
Detail/spots node yields the plain-preview bytes (not a blank cell) —
guards against a future refactor where cpuEvalPlan throws a DIFFERENT
error class the catch still swallows but the intent changed.

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
VERIFIED CORRECT BY CODE INSPECTION (Fable, this audit):
checkSharedLookDriftAtOpen (appStore.ts:3927) re-materializes only when
`link.materializedFrom !== hash` — a follower already carrying the
current look hash (the pulled-publish case) fails the condition and
triggers nothing; the cache is primed either way to suppress the first
watch echo. So the no-op holds by construction; no bug.
TEST TO ADD: an explicit assertion that opening a project whose
followers' materializedFrom already matches the look hash pushes ZERO
undo entries and rewrites ZERO files — pins the negative against a
future refactor.

## 6. Library migration idempotency + collision

verify-library covers the one-time migration + dual-location reads.
VERIFIED GUARDED BY CODE INSPECTION (Fable, this audit,
migrateLegacyPresetsIfNeeded in main/presets.ts:66): idempotency is
guarded TWICE — (1) `if (pathExists(MIGRATION_MARKER)) return` so a
second launch re-copies nothing; (2) even absent the marker,
`if (pathExists(dest)) continue` never overwrites an existing library
file. A divergent-content collision (same slug in both, different
bytes) resolves by construction: migration skips the existing library
file → the library copy is authoritative, which is exactly the
dual-location "library wins on read" rule stage E verified, and
deletePreset removes both copies. So both concerns are structurally
handled — a COVERAGE gap, not a risk.
TEST TO ADD (optional): an explicit second-launch assertion (marker
present → zero copies) to pin the guard against a future refactor.

## 7. Publish undo across a photo the user closed mid-session

Publish/DeleteSharedLook/re-materialize undo entries carry follower
graphs and (for publish/delete) the look-file text. Global undo JUMPS
to a different photo when reverting its entry (DESIGN.md global-undo).
VERIFIED CORRECT BY CODE INSPECTION (Fable, this audit): the publish
undo case (appStore.ts:5865) restores the look file (lookTextBefore),
applySyncEntryGraphs reverts ALL targets in place, and reopens the open
photo ONLY `if (entry.targets.includes(openPath))` — navigated away to
a non-follower ⇒ no jump, just file reverts + playlist refresh, exactly
the global-undo batch rule (DESIGN.md). No bug.
GAP: an E2E that publishes, NAVIGATES AWAY to a non-follower photo,
then ⌘Z — pins the in-place batch revert + byte-identical look-file
restore against a refactor.

## Spec conformance spot-audit (linked-looks.md ↔ code, Fable direct)

Traced load-bearing DECIDED clauses to their implementation — each
CONFIRMED matching, no spec drift:

- **Link-time default (§4.2)** — linkPhotosToLook (appStore.ts:6837)
  computes a fresh-seed baseline per target and, per offered family,
  `developFamilyUntouched(currentDevelop, freshDevelop, fam) ? follows
  : individual`; then `pickDevelopFamilies(lookDevelop, currentDevelop,
  follows)` writes the look's values ONLY for followed families. Edited
  groups stay 個別調整, untouched groups follow — exactly as decided.
- **Constraint 3, ≤1 linked Develop (§4.3)** — `if (devNode.link) {
  alreadyLinkedCount++; continue; }`: a chain whose Develop is already
  linked is skipped + reported, never silently double-linked or
  re-pointed. (The photo-level "all linked Develops share one look"
  invariant is maintained by duplicateOutput's clone, audited in §4.)
- **Publish reads only the linked node (§4.3)** — activeLinkedDevelop-
  Node + publishToSharedLook filter on `chainScope(activeOutputId)` AND
  `!!n.link`; a tweak-layer Develop is never read (confirmed stage-C
  review).
- **Materialization (§4.1)** — every link write carries the full
  resolved develop set + `materializedFrom`; sanitizeDevelopLink never
  throws, absent ⇒ not-linked (graphDoc.ts) — standalone render holds.
- **Unlink keeps values (§6)** — unlinkLook applies stripDevelopLink,
  which deletes ONLY the `link` key; develop values untouched
  (見た目は変わらない).
- **Revert per family (§4.2/§6)** — revertFamilyToLook rewrites ONLY
  that family from the look (`pickDevelopFamilies(lookDevelop, current,
  {family})`), re-adds it to `follows`, refreshes materializedFrom; if
  the look no longer offers the family, it notices and leaves the fork
  (orphaned-override rule §4.2). resetAllFamiliesToLook is the all-
  families form.
- **Delete localizes all (§4.4)** — deleteSharedLook strips the link
  from every follower; values were already materialized, so no
  follower's render changes (verified stage-B; the undo restores the
  FILE too via DeleteSharedLookUndoEntry).
- **Vendor-in copies, never references (§6, principle 5)** —
  vendorPresetIntoProject reads the library file's text and
  sharedLookWrite's a COPY into `<project>/shared-looks/` (auto-suffix
  on slug collision); linking happens against the project-local copy,
  so following never crosses the project boundary.

## Geometry / seeded-default sibling audit (Fable direct, 2026-07-20)

Hunted for siblings of the DCP double-tone bug (class: "a seeded
default not reset when a related MODE changes → double/stale apply"):

- **Lens-profile seed — NOT a sibling (clean).** seedDefaultLook seeds
  `lens.profile.enabled = true` on the input node (appStore.ts:2168) —
  a plain on/off flag (graphDoc.ts:637), NOT a value seed, and there is
  NO lens "source mode" toggle analogous to profile.source that should
  reset it. Manual lens sliders are a separate input-node param that
  stacks LR-style (intended). No mode-switch double-apply path exists.
- **DCP double-tone mechanism triple-confirmed** at the compile site:
  graphDoc.ts:1468 `profileSource(params.profile) === 'dcp' ?
  ctx.dcpLattice : profileForModel(...)` — the profile stage swaps to
  the DCP lattice, while toneCurve (carrying the seeded base curve)
  is a SEPARATE downstream stage, so it is applied in ADDITION to the
  DCP lattice's baked tone. See dcp-profile.md's finding.
- **Repair-sheet anchor-space composition — verified** (earlier):
  sensorSpotToAnchor normalizes against orientedWidth/Height
  (= fullWidth/fullHeight = the anchor frame anchorSpace.ts uses), so
  applied spots ride the existing anchor→output conversion correctly
  under crop/rotate.

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
