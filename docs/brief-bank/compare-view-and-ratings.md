# Briefs: compare view / sidecar ratings (two small packs)

## Compare view (side-by-side)

Status: ready to dispatch (Sonnet). Prereq: CanvasView render flow
(showBefore already renders an alternate state — read how \\ works),
the outputs selector, viewport fit math.

Decided semantics:
- Toolbar "Compare" toggle (and shortcut `C`, isTextEntry-guarded):
  splits the canvas into two synced panes. Mode A (default): CURRENT vs
  BEFORE (the unedited decode — same source showBefore uses). Mode B
  (when the doc has 2+ outputs): active output vs a second output picked
  from a small dropdown in the compare strip.
- Both panes share ONE viewport (pan/zoom applies to both — LR behavior);
  render cost: two render targets per frame; reuse the worker's existing
  showBefore machinery for Mode A (it already renders the before state)
  and a second render call with outputId for Mode B. If per-frame double
  render is too slow at full preview res, drop compare panes to
  renderScale 0.5 and document.
- Escape/toolbar exits; crop/spot/mask modal tools are mutually exclusive
  with compare (deactivateOtherTools gains 'compare').
- verify-compare.mjs: toggle shows two canvases with synced view
  transforms (pan one, both move), Mode A panes differ after an edit
  (means), Mode B renders two outputs' means matching their solo renders,
  tool exclusivity, Escape exits.

## Ratings (sidecar-resident, git-native)

Status: ready to dispatch (Sonnet) AFTER user confirms wanting it.
Decided design (from ROADMAP note):
- `rating: 0..5` on the sidecar WRAPPER (not the graph — it's metadata
  about the photo, not the look; sits next to createdAt), unknown-field
  passthrough untouched. schemaVersion stays 4 (additive).
- UI: 1-5 keys set, 0 clears (isTextEntry-guarded, image ready); stars
  shown in the toolbar info area + on filmstrip cells (tiny). Setting a
  rating marks the doc dirty (it saves with the sidecar; autosave
  handles persistence) but does NOT push develop history (ratings are
  not undoable look edits — document this deliberate divergence).
- Filmstrip filter: a small "★n+" dropdown filters visible cells
  (view-only state, not persisted).
- CLI: `--min-rating n` filters batch inputs (reads each sidecar's
  wrapper cheaply).
- verify-ratings.mjs: key sets rating, survives save/reload + hot-reload
  external edit, filmstrip stars + filter, CLI filter skips low-rated,
  history length unchanged by rating edits.
