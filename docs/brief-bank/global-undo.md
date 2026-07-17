# Brief: global undo — one timeline for everything

Status: DESIGNED 2026-07-17 (conductor), semantics decisions listed
below NEED USER SIGN-OFF before implementation. Prerequisite for
multi-select sync (multi-select-sync.md) and for converting the
auto-layout prototype into an undoable Arrange command
(node-editor-ux.md). User requirement, verbatim (2026-07-17): "基本、
undo-redoは全部を戻したり復帰するようにしたい。ここはユーザビリティ的
にもそうだと思う。じゃないとプロシージャルの意味がないから" — and the
completion-notice-Undo-button compromise was explicitly REJECTED
("2,3個さらに作業が進んでから戻したい、とかもあるから").
Prereq reading: appStore's history machinery (pushHistory / undo /
redo — per-open-photo graph snapshots today), the autosave flush +
OpenSession epoch work (f5ddf64), setFlag/setRating's explicit-look-
path seam, docs/sidecar-spec.md.

## The model (proposed — decide before implementing)

ONE global LIFO timeline of OPERATIONS, shared by every photo and
every batch action. An entry is:

```
{ seq, at, kind, label,               // e.g. "Exposure +0.3 (DSC001)"
  target: photoPath | photoPaths[],   // which look(s) it touched
  before, after }                     // enough state to apply either way
```

- Photo edits (today's per-photo snapshots) become entries tagged with
  their photo. The CURRENT in-memory history mechanism is subsumed —
  one stack, not two.
- Batch ops (sync) carry per-target before/after look contents.
- Rating/flag changes, relink, legacy-sidecar import: entries too.
- Node-editor Arrange (the auto-layout successor): an entry whose
  before/after are the stored positions — this is what makes "ON→OFF
  restores positions" become "Arrange, then ⌘Z if you regret it",
  matching the user's stated instinct.
- Redo is symmetric; a new operation truncates the redo branch
  (standard timeline semantics).
- Session-scoped in v1 (no persistence across restarts); bounded
  (~200 entries, oldest dropped).

## Semantics decisions — USER MUST CONFIRM these five

1. **⌘Z on an entry belonging to a DIFFERENT photo (not open):**
   PROPOSED: undo it IN PLACE — write the restored look straight to
   disk (same seam setFlag uses), do NOT switch the visible photo;
   show a transient notice "Undid: Exposure +0.3 on DSC001". Rationale:
   switching photos under the user's feet is disorienting; the
   git-native model means a look file write IS the undo. ALTERNATIVE
   (LR-ish): jump to that photo first. どちらが好みか。
2. **Scope of "everything":** PROPOSED v1 includes graph edits, WB/
   curve/spot/mask edits, rating/flag, sync batches, Arrange, preset
   apply, develop reset, reset-all. EXCLUDES file-system operations
   (save-as-project move, import-sidecars copy, relink) — these are
   reversible only by inverse file operations with real failure modes;
   they get their own inverse actions later if wanted. OK?
3. **Undo of an edit on a photo that was edited AGAIN later:** strict
   LIFO means you must undo the later entries first (that's what makes
   "2,3個進んでから戻す" safe — no stale-overwrite is possible). No
   cherry-picking individual entries out of order in v1. OK?
4. **Interaction with autosave:** undoing an open-photo edit restores
   the in-memory graph and rides the normal dirty→autosave path;
   undoing another photo's entry writes its look directly (fingerprint/
   photo fields preserved). Both are just writes — no special cases.
   (Statement of behavior, not really a choice — listed for
   transparency.)
5. **UI surface:** ⌘Z / ⇧⌘Z stay the only bindings; the Edit-menu
   labels show what WILL be undone ("Undo Sync to 4 looks"). No
   visible history panel in v1 (LR's per-photo History panel is a
   separate later feature if ever). OK?

## Implementation sketch (one implementer run after sign-off, medium)

- appStore: replace `history`/`future` with the global stack; adapter
  keeps the exact current behavior for open-photo edits (snapshot
  granularity, drag coalescing session keys) so the feel doesn't
  change; per-entry apply/revert dispatch by kind.
- Batch-entry apply/revert uses the explicit-look-path write seam;
  conflict impossibility is structural (strict LIFO, point 3).
- The OpenSession epoch guard pattern (f5ddf64) covers the async
  bookkeeping the same way saves do.
- verify-undo.mjs: cross-photo undo writes the right file without
  switching; LIFO ordering enforced; sync batch round trip; redo;
  truncation on new op; Arrange round trip once that lands; bounded
  depth. Unit tests for the pure stack.

## Explicitly deferred

Persistence across restarts; per-photo History panel; selective/
out-of-order undo; file-op inverses (move/copy/relink); multi-window.
