# Brief: filmstrip multi-select + settings sync

Status: DESIGNED 2026-07-16 (conductor, golden window; feature-queue
head per user 2026-07-13 "一旦それで"). Ready to dispatch AFTER the
user's project-storage hand-test clears the filmstrip (this feature
builds directly on the playlist filmstrip landed in 65aaa68).
Prereq reading: Filmstrip.tsx (playlist cells, ★n+ filter, missing
cells), appStore's project/playlist state + saveGraph + applyLook,
docs/brief-bank/preset-scoping-and-export-overrides.md §1 (the family-
checkbox mechanism this feature REUSES), docs/sidecar-spec.md.

## Decided semantics (don't relitigate)

- **Selection model** (LR muscle memory): plain click = single select +
  open (today's behavior, unchanged). ⌘-click toggles a cell in/out of
  the selection. ⇧-click extends a range from the last plain-clicked
  cell. The photo open in the canvas is the PRIMARY (LR's "most
  selected"); its cell renders brighter than secondaries. Selection is
  session state, never persisted. Esc / plain click collapses to single.
- **Sync = explicit, never live.** A "Sync…" toolbar button (enabled
  when 2+ selected) opens the SAME family-checkbox dialog preset save
  will use (one shared component — if preset scoping lands first, reuse
  its dialog; if this lands first, build the dialog here and preset
  scoping reuses it. Coordinate via the conductor). Checked families
  are copied FROM the primary TO every secondary. Auto-Sync (live
  propagation of every edit) is explicitly OUT — deferred until real
  demand; it's the LR feature users fear.
- **Family list**: the preset families (Basic tone / WB / Curves / HSL /
  Color grading / Effects / Detail / B&W when it exists). Geometry
  (crop/straighten), spots, masks, and custom/external/image/blend
  node STRUCTURE default OFF and are listed under a "rarely what you
  want" divider (LR precedent: possible but opt-in). Structure sync v1:
  the three GRAPH-SHAPED families (spots, masks, crop) copy their
  params onto the target's matching develop/spots nodes only when the
  target has a structurally compatible default chain; otherwise that
  family is skipped for that photo and counted in the report notice.
  No node-graph surgery on targets in v1.
- **Mechanism**: for each secondary, load its look from the project
  (or the seeded default when absent — same seeding as a fresh open of
  that photo), apply the checked families from the primary's live
  graph (reuse the applyLook/preset merge machinery — no new merge
  code), write the look back (photo/fingerprint fields preserved per
  sidecar-spec). Targets are NOT opened; the canvas photo re-renders
  only if it was itself a sync target (it isn't — it's the source).
- **Undo**: NOT undoable in v1. The confirm dialog says exactly what
  will happen ("Write <checked families> from DSC001.ARW to N other
  looks — this cannot be undone from the app"). Rationale: our history
  is per-open-document; cross-look batch undo is a real feature, not a
  checkbox. The git-native answer (user diffs/reverts look files) is
  the documented mitigation. Revisit only if hand-testing shows pain.
- **Rating/flag keys act on the whole selection** when 2+ selected
  (1-5, 0, and the reject/pick keys once that feature lands): write
  each selected look's wrapper field directly. This IS cheap and ships
  with this feature.
- **Batch export of the selection: OUT of this brief** — it belongs to
  the export dialog and rides the CLI batch machinery; queue as its own
  small brief after this lands.

## UI notes

- Secondary-selected cell: existing selection style at reduced
  intensity; primary keeps the full style. Count badge in the toolbar
  ("3 selected") next to the Sync… button.
- The Sync dialog lists target count and per-family checkboxes,
  remembers last-used checks in settings (`syncFamilies`), and reports
  a completion notice ("synced 3 families to 4 looks; skipped masks on
  1 (incompatible chain)").

## Verify sketch (verify-sync.mjs)

Drive selection via __debug hooks (add `setFilmstripSelection(paths)`
+ `syncSelection(families)` thin wrappers). (1) sync Basic tone from
primary to two targets: their look files gain the primary's ev, their
OTHER families untouched (byte-compare unrelated sections); (2) target
without a look gets seeded defaults + synced family (not a bare
default doc); (3) unchecked family never moves; (4) skipped-family
counting for a structurally incompatible target; (5) rating key with
multi-select writes every selected look's rating; (6) photo/fingerprint
fields survive the rewrite; (7) selection collapses on plain click.

## Explicitly deferred

Auto-Sync; batch export of selection; cross-look undo; sync of
node-graph structure; copy/paste-settings between single photos (the
develop clipboard already covers the 1:1 case).
