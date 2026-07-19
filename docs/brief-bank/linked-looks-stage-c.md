# Brief: publish to the shared look (linked-looks stage C)

Status: LANDED 2026-07-19 (SUITE 69/69, unit 243). Deviations
accepted: undo label says "N photos" (brief wording slip); follower
files verified at materialized-field granularity rather than
byte-identical (serializeGraphDoc stamps updatedAt on every write —
the shared-look file itself IS restored byte-for-byte).
Parent spec: docs/brief-bank/linked-looks.md §4.3/§4.4/§6, §9-1/9-2.
Builds directly on stage B (commit 3cf7bae — read its appStore
actions, DeleteSharedLookUndoEntry, SharedLookMenu, and
verify-linkedlooks.mjs first). Scope guard: publish ONLY. No
hot-reload/drift (stage D — you UPDATE materializedFrom, never react
to it), no library (stage E), no Sync/Auto Sync changes.

## Decided semantics (not options)

1. **Publish gesture** («この写真の調整を共通ルックに反映», parent
   vocabulary table): available on the open photo when its active
   chain has a linked Develop. UI in SharedLookMenu next to the
   existing link controls. Group choice = FamilyScopeDialog reuse
   (own settingsKey), develop families only, DEFAULT CHECKED = the
   look's current `includes`; checking a family the look doesn't yet
   offer EXTENDS the look (its `includes` grows). Unchecking merely
   omits it from this publish (never removes it from the look).
2. **Publish reads ONLY the linked node's groups** (parent §4.3): the
   published values come from the linked Develop node of the active
   chain — never from added local tweak Develops.
3. **Write ordering** (parent §9-2): flush the open photo's own
   pending autosave state FIRST (saveGraph / the flush-on-switch
   discipline), then write the shared-look file (atomic, via the
   stage-B IPC), then fan out.
4. **Fan-out = re-materialization** of every follower in the project
   (playlist scan, deleteSharedLook's pattern): for each follower,
   rewrite the values of (that follower's `follows` ∩ published
   families) from the new look body. CRITICAL DETAIL: update
   `materializedFrom` (sha256 of the new look file's canonical bytes,
   stage B's helper) on EVERY follower of this look — including
   followers whose value intersection was empty — otherwise stage D's
   drift detection would later misread them as stale. Follower files
   whose bytes would not change at all still get the new
   materializedFrom (that IS a byte change). The open photo, if a
   follower, updates live + flushes.
5. **The publisher re-follows what it published**: after publish, the
   published families' values on the publisher equal the look's by
   construction — those families re-enter the publisher's `follows`
   (a forked family you publish is no longer individual; that's what
   publishing it means). Families NOT published keep their current
   follow/fork state.
6. **Publish undo** (parent §9-1): ONE ⌘Z reverts everything — new
   typed PublishUndoEntry {projectDir, slug, lookTextBefore,
   lookTextAfter, targets, before, after} following stage B's
   DeleteSharedLookUndoEntry pattern exactly (file first on undo:
   restore lookTextBefore, then follower graphs; mirror order on
   redo; project-dir guard; blocked-not-partial). The publisher's own
   follows change rides in its before/after graphs.
7. **Notices**: completion notice reports follower count (e.g.
   applied to N photos) + errors; the undo label is typed and
   readable (Publish "<name>" → N looks).
8. **No-op guards**: no linked Develop in the active chain, no
   project, unreadable look file (stage B's quiet-degradation
   posture) — notice, never crash.

## Read before writing

Stage B's landed code (3cf7bae): createSharedLook / linkPhotosToLook
/ revertFamilyToLook / deleteSharedLook / applySyncEntryGraphs /
sharedLookHash-or-equivalent (however stage B computes
materializedFrom — REUSE it), DeleteSharedLookUndoEntry + its
undo/redo cases, SharedLookMenu, FamilyScopeDialog, sidecar-spec.md
§4.5 (update it: publish semantics + materializedFrom maintenance
belong in the documented contract).

## Verify (new script verify-linkedlooks2.mjs)

Setup: shared look L (basic-tone + wb) from photo 1; photos 2,3
linked (photo 2 pre-edited wb → follows basic-tone only; photo 3
follows both).
1. Fork basic-tone on photo 1 (edit exposure), publish basic-tone:
   shared-look file carries the new value; photo 3's file
   re-materialized with it; photo 2's basic-tone updated too (it
   follows basic-tone), photo 2's wb untouched; ALL THREE files'
   materializedFrom equal the new look hash; photo 1's basic-tone is
   back in `follows`.
2. Add a second (unlinked) Develop to photo 1's chain with a
   different exposure; publish again → the published value is the
   LINKED node's, not the tweak layer's.
3. One ⌘Z: shared-look file byte-identical to before, all three
   photo files byte-identical to before; redo re-applies all.
4. Publish with a family newly checked (not in the look's includes):
   look's includes grows; existing followers do NOT start following
   it (their follows unchanged).
5. CLI render of a follower after publish reflects the new values
   (materialization, no CLI code changes).
Register in package.json (verify:linkedlooks2 + verify:serial) and
run-verify.mjs; SUITE count grows to 69.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
capture the SUITE line). NEVER git add/commit. zsh bare `=` hazard.
Engine invariants (identity pass-skip; GPU/CPU 1/255; sanitizers
accept all prior versions; unknown-field passthrough). UX: hit
targets ≥20px/36px, Escape cancels, one undo per gesture, notices for
batch ops. Japanese display vocabulary; English code/comments.

## Report back

Files touched; where each numbered semantic lives (file:line);
deviations + reasons; fragile spots; SUITE line + unit count.
