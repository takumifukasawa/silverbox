# Brief: linked-look core (linked-looks stage B)

Status: LANDED 2026-07-19 (SUITE 68/68, unit 242). Conductor review
added one fix in-flight: deleteSharedLook undo restores the FILE too
(typed DeleteSharedLookUndoEntry — the deletePreset analogy doesn't
hold because links reference the look). Two documented deviations:
createSharedLook links directly (fresh-seed comparison is a category
error for the creator); Inspector's Basic section shows one combined
badge for basic-tone+wb.
Parent spec: docs/brief-bank/linked-looks.md (GO given 2026-07-19).
Read the parent spec §2, §4 (all of it), §6, and the UI vocabulary
table BEFORE writing anything. This stage builds the link itself; NO
publish yet (stage C), NO hot-reload/drift (stage D), NO library
(stage E). Do not touch Sync/Auto Sync.

## Conductor schema decisions (settled here, per parent §9-3)

- **Shared look file** = the EXISTING preset file format
  (presetDoc.ts parse/serialize — name + includes + look graph),
  stored at `<projectDir>/shared-looks/<slug>.json`. One format for
  presets and shared looks makes stage E's vendor-in/publish-to-
  library a literal file copy. The `includes` list of the shared look
  = the set of adjustment groups the look OFFERS (develop families
  only in v1 — structural families are never offered by a shared
  look, parent §1 level ①; refuse/ignore them at create time).
- **Link metadata** = ONE additive optional field on the DEVELOP
  node in the photo's graph doc (parent §4.3 — the link is a property
  of the Develop node):
  `link?: { look: string; follows: PresetFamilyId[]; materializedFrom: string }`
  where `look` is the shared-look slug, `follows` lists the currently
  FOLLOWED develop families (fork = remove from this list), and
  `materializedFrom` is the sha256 of the shared-look file's
  canonical serialized bytes at the last materialization (stage D's
  drift detection reads it; stage B only writes/maintains it).
  Sanitizers must accept its absence (all prior versions) and
  UNKNOWN-FIELD-PASSTHROUGH must carry it through old readers —
  verify the node-level passthrough actually preserves an unknown
  node field before relying on it; if node-level unknown fields are
  dropped today, that passthrough fix is IN SCOPE for this stage
  (compat rule 9, sidecar-spec.md).
- Schema version: additive — bump only if the sanitizer structure
  requires it; prefer no bump (pure additive optional field).

## Decided semantics (from the parent spec — not options)

1. **Create shared look**: from the open photo — capture the
   currently-checked develop families (FamilyScopeDialog reuse, same
   component preset save uses, settingsKey of its own) into
   `<projectDir>/shared-looks/<slug>.json`, then LINK the open photo
   to it (creating a look you don't follow yourself is meaningless).
   UI: a 共通ルック section (natural home: near PresetsMenu in the
   toolbar; display vocabulary from the parent table — 共通ルック,
   共通ルックを使う, etc. Japanese display names, English code).
2. **Link photo(s)** («共通ルックを使う»): works on the current
   filmstrip selection (1..N photos, primary included — batch shape
   and target iteration copied from applyPresetToSelection/stage A).
   Per photo, per offered family: if that family in the target
   differs from the target's own FRESH-SEED DEFAULTS (seed via the
   same decode+seedDefaultLook path syncSelection/stage A use for
   absent looks), it is "already edited" → stays 個別調整 (NOT in
   `follows`); untouched families → the look's values are WRITTEN
   into the photo (materialization) and the family enters `follows`.
   No dialog (parent §4.2 link-time default). One batch undo entry
   (SyncUndoEntry shape) for the whole gesture + completion notice
   reporting per-photo followed/individual counts (parent §9-8: this
   notice is the only feedback the no-dialog default gets).
3. **Constraints, structurally enforced at link time**: at most one
   linked Develop per chain; every linked Develop in one photo links
   to the same look (v1 photos have one Develop per chain in
   practice — enforce by refusing with a notice, never silently).
4. **Fork on touch** (parent §4.2): any edit to a param inside a
   followed family removes that family from `follows` (values are
   already local — fork is a metadata-only change, same undo entry as
   the edit itself). Inspector shows a 「この写真だけ個別調整中」
   badge on that family's section header while forked AND the link
   exists.
5. **Revert family to look** («共通ルックに合わせる», per family):
   re-write that family's values from the shared look, re-add to
   `follows`. Undoable. Also the all-families form («共通ルックに
   リセット», parent §6 force-overwrite case 2) — one button, all
   offered families re-follow.
6. **Unlink** («共通ルックから外す»): strip the `link` field, values
   untouched — 見た目は変わらない (parent vocabulary table). Undoable.
7. **Look deletion** («ルックがなかったら全部ローカル化», parent
   §4.4): deleting a shared look from the 共通ルック UI strips the
   link field from every follower (their values were already
   materialized — render never changes). One batch undo entry.
8. **Node editor visibility** (parent §9-8): a linked Develop node
   shows a small badge/label (「共通ルック」+ look name) in the graph
   view. Keep it subtle but visible; no new node class — it is still
   a plain Develop node (DESIGN.md principle 4).
9. **CLI/back-compat invariant** (parent §4.1): every photo look file
   remains fully materialized — the CLI and old readers render it
   correctly with the `link` field ignored. No CLI changes in this
   stage.

## Read before writing

- Parent spec §4 (the contract), stage A's landed code:
  applyPresetToSelection + mergeFamiliesWithSkipDetection +
  applySyncEntryGraphs (batch shapes to reuse), FamilyScopeDialog,
  presetDoc.ts, graphDoc.ts sanitizers + unknown-field passthrough,
  undoStack.ts entry kinds (a new typed entry kind for link/unlink
  metadata ops is acceptable if SyncUndoEntry's graph-pair shape
  doesn't fit metadata-only changes cleanly).

## Verify (new script verify-linkedlooks.mjs)

1. Create shared look from photo 1 (basic-tone + wb checked) → file
   exists under shared-looks/, photo 1's Develop carries link
   {look, follows:[basic-tone,wb], materializedFrom}.
2. Link photos 2+3 (photo 2 pre-edited in wb): photo 2 follows
   basic-tone only (wb individual, badge state queryable via
   __debug), photo 3 follows both; both files carry the look's
   basic-tone values materialized; batch undo reverts all.
3. Edit exposure (basic-tone) on photo 1 → follows loses basic-tone;
   revert-to-look restores the look's value and re-adds it.
4. Unlink photo 3 → link field gone, values byte-identical.
5. Delete the shared look → photos 1+2 lose link fields, values
   unchanged; undo restores.
6. Old-reader/CLI guard: render (CLI --project) a linked photo →
   output identical to pre-link render of the same materialized
   values; a look file round-tripped through load→save keeps the
   link field (passthrough).
Register in package.json (verify:linkedlooks + verify:serial) and
run-verify.mjs; SUITE count +1.

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
capture SUITE line). NEVER git add/commit. zsh bare `=` hazard.
Engine invariants (identity pass-skip; GPU/CPU 1/255; sanitizers
accept all prior versions; unknown-field passthrough). UX: hit
targets ≥20px/36px, Escape cancels, one undo per gesture, notices
for batch ops. Japanese display vocabulary from the parent table;
code/comments English.

## Report back

Files touched; where each numbered semantic lives (file:line);
whether node-level unknown-field passthrough needed the fix;
deviations + reasons; fragile spots; SUITE line + unit count.
