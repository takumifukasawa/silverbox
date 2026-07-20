# Brief: remove Sync + Auto Sync (linked-looks stage G)

Status: LANDED 2026-07-20 (the FINAL linked-looks stage; SUITE 70/70
(1 known project flake), unit 255). grep-clean confirmed (no
autoSync/syncSelection/Auto Sync/flushPendingAutoSync in src/);
SyncUndoEntry/applySyncEntryGraphs/kind:'sync' preserved and still
referenced (21 in appStore, 6 in undoStack). verify-sync.mjs +
verify-autosync.mjs deleted, suite 72→70.
Parent spec: docs/brief-bank/linked-looks.md §6 (Sync removal + Auto
Sync removal, both USER-DECIDED) and §10. The same-release ordering
constraint is already satisfied — apply-preset-to-selection (stage A,
63503ac) and repair sheets (stage F, 0890bac) are the batch vehicles
that replace Sync, and they have landed. This stage removes the now-
redundant surface.

## What to remove

1. **Filmstrip.tsx**: the `Sync…` button AND the `Auto Sync` toggle
   (the whole `filmstrip-autosync-toggle` control), plus their now-
   unused local selectors (`syncSelection`, `autoSyncEnabled`, the
   FamilyScopeDialog wiring that ONLY served the Sync button — check
   whether FamilyScopeDialog is still used elsewhere in this file
   before removing its import).
2. **appStore.ts**: the `syncSelection` action; the module-level
   auto-sync machinery (`autoSyncTimer`, `runAutoSyncNow`,
   `flushPendingAutoSync`, and whatever schedules it — the edit-path
   trigger that enqueues a fan-out after a gesture); every
   `flushPendingAutoSync()` call site (openImageByPath, the project-
   switch paths, removeFromProject, the selection-dissolve path — grep
   confirms ~6). Removing the scheduler makes those calls dead; delete
   them, do not leave no-op stubs.
3. **settings**: remove `autoSyncEnabled` from `DEFAULT_SETTINGS`
   (shared/ipc.ts) and its Settings type field. The settings sanitizer
   must STILL load an old settings.json that contains `autoSyncEnabled`
   without error (unknown-field tolerance — verify the sanitizer drops
   unknown keys rather than throwing; if it's a strict allowlist, an
   old key is simply ignored, which is fine — just confirm no crash).
4. **CanvasView.tsx `__debug`**: remove the `syncSelection` hook and
   any auto-sync debug hooks (`autoSyncEnabled` reads etc.).
5. **Verify scripts**: DELETE `scripts/verify-sync.mjs` and
   `scripts/verify-autosync.mjs`; remove `verify:sync`/`verify:autosync`
   from package.json (both the individual entries and the `verify:serial`
   chain) and from `scripts/run-verify.mjs` ALL_SCRIPTS. SUITE drops
   72 → 70.

## What to KEEP (critical — shared infrastructure, do NOT remove)

- **`SyncUndoEntry` (kind 'sync') and `applySyncEntryGraphs`** — these
  are now REUSED by apply-preset-to-selection (stage A), publish (stage
  C), and hot-reload/drift (stage D). They are no longer Sync's private
  machinery. Leave the type, the undo/redo `'sync'` cases, and
  applySyncEntryGraphs entirely intact.
- `mergeFamiliesWithSkipDetection`, `chainScope`, `restrictToChain`,
  `insertSpotsIntoChain` — all shared, keep.
- FamilyScopeDialog — still used by preset save/scoping, publish, and
  apply-preset-to-selection. Keep the component; only remove the
  Filmstrip Sync usage of it.

## Verify

No new script. The suite proves nothing regressed: the batch vehicles
that replace Sync have their own scripts (verify-preset-selection,
verify-repairsheet) which must stay green, and verify-linkedlooks{,2,3}
exercise the publish/drift paths that share SyncUndoEntry. Confirm
those specific scripts pass. Full suite must be green at 70/70.

Grep-clean check before reporting: `grep -rn "autoSync\|syncSelection\|
Auto Sync\|flushPendingAutoSync" src/` returns NOTHING in src/ except,
if anything, an incidental substring in an unrelated comment (call it
out if so). `SyncUndoEntry`/`applySyncEntryGraphs`/`kind: 'sync'` SHOULD
still appear — those stay.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
capture the SUITE line — expect 70/70). NEVER git add/commit. zsh `=`
hazard. Engine invariants. Japanese display vocabulary, English code.

## Report back

Files touched; confirmation each KEEP item is untouched (SyncUndoEntry/
applySyncEntryGraphs still present and referenced); the grep-clean
result; deviations; SUITE line + unit count.
