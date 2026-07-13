# Brief: node-editor UX pack (UE material-editor idioms)

Status: DESIGNED (user feedback 2026-07-13, hand-testing rounds A/B).
User's framing: "操作感はUEのmaterialeditorを模倣する" — adopt the
established graph-editor idioms rather than inventing our own.

## Items

1. **Rubber-band selection + group move**: drag on empty canvas selects
   nodes in the marquee; dragging any selected node moves the whole
   selection. React Flow supports this natively (`selectionOnDrag`,
   multi-selection drag) — the work is reconciling it with our current
   pan-on-drag binding (likely: pan moves to space-drag or middle-drag,
   or `panOnDrag={[1,2]}` with left-drag = select, matching UE).
   Selection state must reach the store only where needed (bypass/delete
   on multi-selection is the payoff — check what ⌘D/delete should do
   with N nodes selected).

2. **`F` = frame all** (UE/DCC convention): fit all nodes in view.
   React Flow's `fitView()` — one keybinding + a toolbar button
   (visible-path). Check `f` is unbound in the node editor's key scope
   first. Consider `F` with selection = frame selection (UE behavior).

3. **Drag-from-port quick-add**: releasing a connection drag on empty
   canvas opens the add-node menu filtered to nodes connectable to that
   port; choosing one inserts it AND completes the edge. React Flow's
   `onConnectEnd` gives the release point; reuse the existing add-node
   menu component with a "pending connection" mode.

4. **Reroute node via edge double-click** (UE): double-clicking an edge
   inserts a passthrough/reroute point. Requires either a real no-op
   node kind (engine invariant: identity ⇒ pass not emitted ⇒ free) or
   React Flow edge waypoints. Prefer a real node kind (`reroute`):
   serializes naturally in the sidecar, zero render cost by the
   identity rule. Sidecar spec/sanitizers must accept it
   (schemaVersion bump NOT needed if unknown-kind passthrough already
   covers old readers — verify).

## Sizing / order

Items 1+2 are small (one day-agent together). Item 3 medium. Item 4
touches graphDoc (sanitizers + spec) — medium, do with the sidecar-spec
doc task. Post-Thursday queue; UI-shell reorg stays deferred, but this
pack is editor-local and independent of the shell decision.

## PRIORITY DOWNGRADED (user, 2026-07-13)

The editor's role was clarified as escape hatch + AI-structure review
surface, not a daily driver (DESIGN.md principle 4, procedural
addendum). Do items 1+2 only (frame-all + marquee survive any future
form); HOLD items 3+4 until the presentation-form question (free
canvas vs structured auto-laid-out flow, Houdini-style) is decided —
gesture polish invested in the free canvas may be thrown away by a
move to auto-layout. If the structured-flow idea firms up, THAT
becomes the pack instead.

## Presentation form: decide by prototype (user + conductor, 2026-07-13)

The free-canvas vs structured-auto-layout question will NOT be argued
to a conclusion on paper. Agreed method: add a cheap **auto-layout
toggle** to the existing free canvas (dagre or elkjs — new dependency,
day-scale or less; layout is view-only, stored node positions in the
doc are untouched), hand-test both projections on real machine-built
graphs, then commit to a form. Post-Thursday queue, below the
golden-window main line (project storage → LR calibration → feature
queue). Items 3+4 above stay HELD until the toggle verdict.
