# Brief: the visible library (linked-looks stage E)

Status: LANDED 2026-07-20 (SUITE 71/71, unit 243). Deviations
accepted: deletePreset removes BOTH copies when a slug exists in
library+legacy (prevents legacy resurrection); import slug = picked
file's basename; import shares vendor-in's auto-suffix collision
handling. Conductor verified the agent's real-home cleanup (~/Silverbox
= Quick/ only, userData presets intact). Two hazards recorded in
playbook: the ipc.ts comment-length build bug; the unisolated-userData
verify scripts needing libraryDir seeding.
Parent spec: docs/brief-bank/linked-looks.md §9-7 (RESOLVED,
USER-DECIDED: visible folder), §6 vendor-in / publish-to-library
rows, §4.5 last bullet. Scope guard: no repair sheets (F), no
Sync/Auto Sync changes (G).

## Decided semantics (not options)

1. **Location**: `~/Silverbox/Library/` — a `libraryDir` setting
   (settings.json, text-first), default resolved from homedir the
   same way quickProjectDir is (settings.ts precedent — NOT under
   userData). The app never touches git; the folder being
   git/sync-able is the user's own affair.
2. **One-time migration**: on startup, if the library dir has no
   migration marker (e.g. a `.migrated-presets` sentinel or simply
   "file absent in library"), COPY `<userData>/presets/*.json` into
   the library (old files LEFT IN PLACE; never delete). Reads are
   dual-location forever (compat rule 9): the presets list shows the
   union (library wins on slug collision); writes (save/update/
   delete preset) go to the LIBRARY only. deletePreset on a
   legacy-only slug deletes the legacy file (it's the only copy —
   still "writes go to the new location" in spirit: no new files
   appear in userData).
3. **CLI parity**: cliArgs.ts's preset resolution learns the same
   dual-location read (library first, then `<userData>/presets`).
   Update its doc/help text.
4. **Vendor in** («プロジェクトに取り込む», parent §6): copy a
   library file into `<project>/shared-looks/` (slug collision →
   auto-suffix, notice). It then appears in SharedLookMenu; linking
   happens against the project copy via the existing 共通ルックを使う
   flow. No undo entry (additive file copy, render-neutral) — notice
   only.
5. **Publish to library** («ライブラリに反映», parent §6): copy a
   project shared look OUT to the library, overwriting the template
   if the slug exists (that IS updating the template; never touches
   other projects). Notice; no undo (the visible/git-able folder is
   the safety net, per the §9-7 decision).
6. **Import** («ライブラリに取り込む…»): a menu item opening a file
   picker; implementation = file copy into the library dir. ALSO: the
   library dir gets a debounced fs.watch (stage D's dir-watch
   pattern) so files dropped in externally appear in the presets/
   library list without restart — "putting a file in the folder IS
   the import".
7. **Presets and shared-look templates are the same species** (one
   file format, one folder): the existing PresetsMenu list reads the
   union per (2); no separate "library browser" UI in this stage.
8. **Etiquette guard**: the app creates `~/Silverbox/Library/` on
   first use (mkdir -p, like Quick), writes NOTHING anywhere else new.

## Read before writing

settings.ts (quickProjectDir resolution), main/presets.ts (becomes
dual-location), cliArgs.ts, stage D's library-adjacent watch code,
PresetsMenu.tsx, sharedLooks.ts (vendor-in target IPC exists).

## Verify (new script verify-library.mjs)

1. Fresh userData with 2 seeded legacy presets + fresh libraryDir
   (tmp override via settings pre-seed) → launch → both files COPIED
   into the library, originals intact; presets list shows them once
   each.
2. Save a new preset → file lands in library, NOT userData.
3. Vendor a library look into the project → shared-looks/ gains the
   file; SharedLookMenu lists it.
4. Publish a project shared look to library → library file
   created/updated.
5. Drop a valid preset file directly into the library dir (fs write)
   → list refreshes without restart.
6. CLI: silverbox render --look <library-slug> resolves from the
   library; a legacy-only slug still resolves from userData.
Register (verify:library + verify:serial + run-verify.mjs); SUITE
grows by 1.

## Standing rules

Gate loop foreground before reporting; NEVER git add/commit; zsh `=`
hazard; engine invariants; Japanese display vocabulary, English code;
notices for batch ops. Settings additions need DEFAULT_SETTINGS +
sanitizer updates (settings.ts conventions).

## Report back

Files touched; where each numbered semantic (1-8) lives (file:line);
deviations + reasons; fragile spots; SUITE line + unit count.
