# Brief: apply preset to selection (linked-looks stage A)

Status: DISPATCHED 2026-07-19 (linked-looks GO given; this is the
REQUIRED prerequisite for the Sync-button removal — see
linked-looks.md §6 ordering constraint).

## Intent

「写真を複数選択してプリセットを一気に適用できる、という機能は必要。
ルックやゴミとり系などどっちも」(user, 2026-07-19, promoted REQUIRED).
One gesture applies a saved preset to EVERY photo in the filmstrip
selection — the one-shot no-asset batch case of linked-looks.md §6.
This also embodies the "force overwrite" semantics the user asked
for: the preset's checked adjustment groups replace the targets'
wholesale (linked-looks.md §6 "Force overwrite decomposes").

## Decided semantics (not options)

- **Targets**: the current filmstrip selection (primary + secondary),
  same membership rule syncSelection uses. With no secondary
  selection, applying a preset behaves exactly as today (open photo
  only) — no behavior change for the 1-photo case.
- **Scope**: the preset file's OWN saved includes list governs (save-
  time scoping, 2e2cd0b). NO apply-time dialog — apply is one click.
  Develop families merge via mergeScopedLook; structural families
  (spots — the ゴミ取り batch path; masks; custom-nodes) graft via the
  same machinery applyPreset already uses. Per-target active-chain
  scoping and the unambiguous-single-Develop fallback (e0b8387) apply
  per photo, same as syncSelection.
- **Undo**: ONE global-undo batch entry for the whole gesture
  (SyncUndoEntry precedent): all targets revert in place + completion
  notice, no cherry-picking. Redo symmetric.
- **Persistence**: targets' look files are written through the same
  path syncSelection uses (flush discipline included). The open
  photo's graph updates live.
- **Visible path** (DESIGN.md rule): the preset list's existing
  per-preset UI gains an "apply to selection" affordance when 2+
  photos are selected (natural spot: the same preset row/menu that
  applies to one photo today — label it with the target count, e.g.
  「選択中の3枚に適用」). No new modifier-key-only path.
- **Do NOT touch the Sync button or Auto Sync** — their removal is
  stage G, a separate landing.

## Read before writing

- docs/brief-bank/linked-looks.md §6 (the operations table this
  implements one row of), §1 (what stage A is inside).
- appStore.ts: syncSelection (~6022) — target iteration, per-target
  scope, batch undo entry, look-file writes; applyPreset (~5233) —
  preset parse + includes + mergeScopedLook/graft path. The new
  action is the composition of these two; SHARE their helpers, do not
  duplicate merge logic (two entry points, one implementation —
  conductor review hunts exactly this class).
- presetFamilies.ts: mergeScopedLook / graftStructuralFamily.
- The preset menu / preset panel component that lists presets (find
  via applyPreset call sites).

## Verify (new script verify-preset-selection.mjs)

1. Open a test project with 3 photos; save a preset from photo 1 with
   develop families checked; select all 3; apply-to-selection; assert
   all 3 look files carry the preset's values; assert a family NOT in
   the preset's includes survives untouched on a target that had it
   edited.
2. Structural case: preset with spots included (default-unchecked —
   check it at save); apply to a target with NO spots node; assert the
   node was grafted (spots present in the target's look file).
3. One ⌘Z: all 3 targets restored byte-identically; redo re-applies.
4. 1-photo selection: behavior identical to today's applyPreset (no
   batch entry regression).
Register in package.json (verify:preset-selection + verify:serial) and
scripts/run-verify.mjs; expected SUITE count grows by 1.

## Standing rules (non-negotiable)

- Gate loop before reporting: `npm run typecheck` && `npm run
  test:unit` && `npm run verify` (FOREGROUND, capture the SUITE line).
- NEVER `git add`/`git commit` — the conductor lands.
- zsh: quote/avoid bare `=`/`==` in command arguments.
- Engine invariants: identity ⇒ no pass ⇒ bit-exact; GPU/CPU mirrors
  1/255; sidecar sanitizers accept all prior versions; unknown-field
  passthrough.
- UX: hit targets ≥20px visible/36px hitbox; Escape cancels; one undo
  per gesture; notices for anything batch.

## Report back

Files touched; where each decided semantic lives (file:line); any
deviation + reason; fragile spots; root causes of anything
surprising; the SUITE line and unit count.
