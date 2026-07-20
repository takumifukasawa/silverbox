# Brief: shared-look hot-reload & drift detection (linked-looks stage D)

Status: LANDED 2026-07-20 (SUITE 70/70, unit 243). Reuses
PublishUndoEntry's 'publish' kind (no new type). Deviations accepted:
ensureActiveProject (quick-project path) also arms the watch + drift
scan; watch re-arms after createSharedLook (dir may not exist at first
arm); drift-at-open passes lookTextBefore===lookTextAfter (the app
never wrote the file — an external actor did before open, so only
follower graphs are the recoverable undo payload); missing-look =
graceful no-op + notice (stage B/C guards already present), not
reactive button-disable.
Parent spec: docs/brief-bank/linked-looks.md §4.4 (external-edit
bullet), §4.5, §9-5/9-6. Builds on stages B (3cf7bae) and C (0fb8068)
— read publishToSharedLook, PublishUndoEntry + undo/redo cases, the
sharedLooks IPC, and main/index.ts's existing sidecar fs.watch
machinery FIRST. Scope guard: no library (stage E), no repair sheets
(F), no Sync/Auto Sync changes (G).

## The one mechanism (decided)

External changes to `<project>/shared-looks/*.json` — an AI editing
the file, a git pull, a checkout — propagate to followers through ONE
re-materialization path, the same fan-out shape publish uses. «共通
ルックを編集したら変わるのは当然…そういうプリセット/マテリアルだから»
(user): declared followers following the look body IS the link's
contract; principle 4's explicitness governs the photo→look direction
only.

## Decided semantics (not options)

1. **Watch**: main process watches the active project's shared-looks/
   dir (same debounced fs.watch-on-dir pattern as the sidecar watch in
   main/index.ts — rename-safe) and pushes a payload-free
   `sharedLookChanged` to the renderer.
2. **Baseline cache / self-write suppression**: the store keeps a
   per-slug last-seen-text cache (`sharedLookTexts`), updated on every
   app-side read/write/publish/materialization — the per-slug analog
   of lastSidecarText. On `sharedLookChanged`, re-read each known
   look; content equal to the cache = echo, ignore. This cache is
   also what provides `lookTextBefore` for the undo entry below.
3. **Re-materialization on genuine change**: for each changed look
   with followers — same fan-out as publish (rewrite follows ∩
   offered values per follower, bump materializedFrom everywhere),
   one typed undo entry. REUSE PublishUndoEntry (kind stays distinct:
   'look-external' or reuse 'publish' with a label prefix — implement
   whichever is cleaner, but undo must restore the look FILE
   (verbatim cache text) + all follower graphs, file-first order,
   exactly like publish undo). Notice: 「共通ルック〇〇が変更されまし
   た — N枚に反映 (⌘Zで取り消し)」 shape (Japanese display, English
   code).
4. **Clean/dirty guard (parent §4.4)**: if the OPEN photo is a
   follower of the changed look AND the session is dirty
   (graphDirty), DEFER the whole fan-out behind a notice with a
   reflect button (the photo-sidecar 'pending' posture); clean →
   automatic. Autosave-ON makes dirty windows transient, so deferral
   is the rare path. One undo entry either way (pushed when the
   fan-out actually runs).
5. **Drift detection at open** (parent §4.5 — the git pull scenario):
   on project open (and on photo open as a belt), compare each linked
   look file's hash against followers' materializedFrom; mismatch →
   the same re-materialization path as (3), same notice/undo. A
   publish commit pulled from another machine produces NO drift
   (followers' files came with matching markers) — verify asserts
   this no-op.
6. **Value-drift-implies-fork (parent §9-6)**: when a FOLLOWER's file
   was changed externally — its followed-group values differ from the
   look body while its materializedFrom MATCHES the current look hash
   — those groups FORK (unlisted from `follows`, notice), never get
   clobbered by the next re-materialization. Check this during photo
   load/hot-reload of the photo sidecar (the existing per-photo
   external-edit path) and during (3)/(5)'s fan-out before rewriting.
   The documented contract stays: external editors SHOULD unlist what
   they edit; the sanitizer forgives the omission in this direction
   only.
7. **Missing look file** (parent §9-6): a link whose slug has no
   backing file at load → keep the metadata (a later pull may restore
   it), stage B's quiet UI degradation stands, plus ONE non-error
   notice naming the look («共通ルック〇〇が見つかりません — リンクは
   保持されます»). Never auto-strip, never crash. App-side delete
   (stage B) is unchanged — it strips explicitly.
8. **sidecar-spec.md §4.5**: document the drift contract (marker
   comparison, value-drift-implies-fork, missing-file posture).

## Read before writing

main/index.ts sidecar watch (lines ~247-270) + IPC.watchSidecar;
appStore handleExternalSidecarChange (clean/dirty precedent);
publishToSharedLook + its undo/redo; sharedLooks.ts;
stage B's materializedFrom hash helper; graphDoc.ts sanitizeDevelopLink.

## Verify (new script verify-linkedlooks3.mjs)

Setup: look L (basic-tone+wb), photos 1-3 linked as in stage C's
script.
1. External edit: rewrite shared-looks/L.json on disk (changed
   basic-tone value, atomic rename) while the app is open+clean →
   followers re-materialize (files show the new value; wb-forked
   photo untouched in wb), notice fired, materializedFrom = new hash
   everywhere; ONE ⌘Z restores the look file byte-identical + all
   followers; redo re-applies.
2. Echo suppression: an app-side publish does NOT trigger a second
   fan-out from its own fs-watch echo (undo stack gains exactly one
   entry).
3. Drift at open: close the project/app context, rewrite L.json on
   disk, reopen the project → fan-out runs at open (same asserts as
   1). Then: a no-drift reopen (markers match) runs NO fan-out.
4. Value-drift-implies-fork: externally rewrite photo 3's look file
   changing a followed group's values (keep materializedFrom), reopen
   photo 3 → that group is unlisted from follows (forked), values
   preserved; a subsequent external look edit does NOT clobber it.
5. Missing file: remove L.json on disk, reopen → notice, links kept,
   UI degraded (publish/revert unavailable), no crash.
Register in package.json (verify:linkedlooks3 + verify:serial) and
run-verify.mjs; SUITE grows to 70.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
capture the SUITE line). NEVER git add/commit. zsh bare `=` hazard.
Engine invariants (identity pass-skip; GPU/CPU 1/255; sanitizers
accept all prior versions; unknown-field passthrough). UX: notices
for anything batch; one undo per gesture; Japanese display
vocabulary, English code/comments. Verify scripts: never wait on
stale-satisfiable conditions; compound waits.

## Report back

Files touched; where each numbered semantic (1-8) lives (file:line);
deviations + reasons; fragile spots; SUITE line + unit count.
