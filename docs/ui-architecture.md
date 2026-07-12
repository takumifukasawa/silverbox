# UI architecture — the shell reorganization

Written 2026-07-13 (Fable conductor). The feature set has outgrown the
milestone-1 shell (one toolbar row owning every entry point; one right
inspector; a bottom node editor; a filmstrip bolted under the canvas).
This is the decided target layout and the staged packs to get there —
LRC's panel discipline and Resolve's page discipline, adapted to a
single-window, non-catalog tool.

## Target layout

```
┌──────────────────────────────────────────────────────────────┐
│ Toolbar (slim: file/view actions + mode switch + notices)    │
├────────┬──────────────────────────────────────┬──────────────┤
│ LEFT   │            CANVAS                    │ RIGHT        │
│ panel  │  (compare/inspect/crop/spot          │ inspector    │
│        │   overlays live here, unchanged)     │ (collapsible │
│ Presets│                                      │  sections)   │
│ Snap-  ├──────────────────────────────────────┤              │
│ shots  │            NODE EDITOR               │              │
│ History│  (resizable split with canvas)       │              │
├────────┴──────────────────────────────────────┴──────────────┤
│ FILMSTRIP (folder context only, as today)                    │
└──────────────────────────────────────────────────────────────┘
```

- **Left panel** (new, collapsible, ~240px): tabbed **Presets /
  Snapshots / History**. Presets = the browser LRC puts left — list
  with hover preview (machinery exists), Apply/Update/Delete, search
  filter when the list grows. Snapshots/History arrive with their
  features (gap analysis A). Collapsed by default until it has content
  beyond presets; `⇧⌘[` toggles.
- **Right inspector**: becomes COLLAPSIBLE SECTIONS with disclosure
  headers (LRC's panel discipline): Lens / Develop-Basic / Tone Curve /
  Color Mixer / Color Grading / Detail / Effects / per-node sections
  (Mask, Spots, Export overrides…). Sections remember open/closed state
  (settings.json `ui.` namespace). Today's InspectorPanel renders one
  long scroll — the content is right, only the chrome changes.
- **Toolbar diet**: keep Open ▾, Save+dirty dot, undo/redo, the MODE
  buttons (Crop / Spots / +Radial / +Linear / Compare), Export…,
  Settings…; MOVE Presets ▾ into the left panel; MOVE "Add node ▾",
  "Mask overlay", "Delete node", output selector INTO the node editor's
  own header strip (they are graph actions — Resolve keeps node actions
  on the node graph). Capture info (camera/lens/ISO) moves to a status
  line under the canvas or the inspector header.
- **Node editor**: gains its own slim header (add node / delete /
  overlay toggle / output selector / bypass toggle when it lands) and a
  DRAGGABLE horizontal split vs the canvas (today's fixed ratio is a
  recurring annoyance with big graphs). Double-click the divider =
  reset.
- **Grid view (G)**: the folder context gains a VIEW toggle — filmstrip
  (today) or a thumbnail GRID replacing the canvas (LRC's Library grid
  feel, ratings + edited dots on cells, Enter/double-click returns to
  develop view on the clicked photo). Explicitly still not a catalog:
  it renders the SAME listImages data, nothing persisted. Keyboard: `G`
  grid / `D` (or Escape) develop — LRC muscle memory (`G` currently
  unused; `D`... check the shortcut chain first; if taken, Escape+G
  round-trip suffices).
- **Keyboard map doc**: docs/shortcuts.md generated manually once —
  every shortcut currently lives in App.tsx's chain; the map is now big
  enough that users need a reference (and a `?` overlay later).

## What does NOT change

Canvas overlay system (crop/spot/mask/compare), the render pipeline,
any store semantics, the sidecar. This is chrome + placement, and each
pack must be behavior-preserving for everything it doesn't explicitly
move (the suite's testids pin most of it — packs must keep testids
stable or update every script that uses them IN THE SAME pack).

## Staged packs (each independently shippable, suite-green)

1. **Shell pack A — inspector sections + toolbar diet + node-editor
   header** (the biggest visual cleanup, zero new features). Verify:
   testid stability sweep; section collapse persists via settings.
2. **Shell pack B — left panel with Presets tab** (move presets UI,
   keep the store actions; hover preview unchanged). Verify: presets
   script targets the new home.
3. **Shell pack C — resizable canvas/node-editor split** (+ persisted
   ratio). Small.
4. **Grid view (G)** — the folder grid. Medium; pairs naturally with
   multi-select (gap analysis A) but ship view-only first.
5. Later, with their features: Snapshots/History tabs.

Recommended interleave with the feature queue: Shell A before the
bypass toggle (bypass wants the node-editor header), then features and
shell packs alternating so the UI debt never re-accumulates.
