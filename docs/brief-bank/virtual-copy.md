# Brief: virtual copies (named output nodes)

Status: LANDED 2026-07-18 (e0b8387 + the unambiguous-single-Develop
fallback follow-up: a preset applied while a fresh-id clone chain is
active now REACHES that chain's one Develop node instead of no-oping —
strict id matching still governs any ambiguous case, i.e. 2+ Develops
on either side). Original hazard analysis kept below for the record.
(Was: DESIGN OPEN.) The two preset/paste hazards below are
CONFIRMED REAL (2026-07-18, conductor): reproduced at runtime against the
actual repo modules (mergeScopedLook + a verbatim copy of the private
mergeLookWithCurrentGeometry; 2-output doc round-trips parseGraphDoc, so
the state is legal and user-creatable today via Add-node > output). Paste
deletes the second chain; scoped apply updates the id-matching copy
regardless of which one the user is working on (the API has no
active-output parameter at all). Single-output control case behaves
correctly on both paths. One ⌘Z recovers, but autosave persists the loss
once unnoticed — ship the scoping fix WITH (or before) any UI that makes
2-output docs common.
Mechanism DECIDED (project memory, 2026-07-10 era):
"multiple named output nodes = the virtual-copy mechanism" — a doc already
supports 2+ `kind: 'output'` nodes (spec §6, `docs/sidecar-spec.md` §4.1),
each a named rendition ('main', 'bw-crop', …). The plumbing below this
already exists end-to-end; this brief is almost entirely about the parts
that DON'T exist yet: the create gesture, the filmstrip representation, and
— the sharp part — what preset/paste/sync do to a doc that now has 2+
independent Develop chains instead of one.
Prereq reading: `graphDoc.ts` (`GraphNode.name`/`.export`, `outputName`,
`resolveExportSettings`, `parseGraphDoc`'s `outputNodes.length === 0` guard),
`appStore.ts`'s `activeOutputId`/`addOpNode('output')`/`removeOpNode`/
`renameOutput`/`setExportOverrides`/`reachableToOutput`/`activeOutputNode`,
`presetFamilies.ts` (`mergeScopedLook`, `buildScopedLook`,
`structuralFamilyCompatible`), `undoStack.ts` (the landed global-undo
timeline — `pushHistory`'s `GraphUndoEntry` shape),
`docs/brief-bank/per-output-export-settings.md` and
`preset-scoping-and-export-overrides.md`
(both already LANDED — see `graphDoc.ts:174-240`, `ExportDialog.tsx`,
`InspectorPanel.tsx`'s `OutputInspector`), `multi-select-sync.md`
(`syncSelection` in `appStore.ts`, already landed as of 0552648 despite that
doc's own stale "ready to dispatch" status line — worth flagging to the
conductor, not this brief's job to fix).

## What already works (build on this, don't reinvent)

- **Toolbar/compare**: `OutputSelector`/`CompareStrip` (`Toolbar.tsx`) already
  show a dropdown once `graph.nodes.filter(n => n.kind === 'output').length
  > 1` — picks `activeOutputId`, which the canvas preview and `exportImage`
  both honor (`appStore.ts:4660-4663`). Nothing to add here.
- **Blank second output**: `addOpNode('output')` (`appStore.ts:3504-3513`)
  already creates a disconnected, unnamed output node — "wire it up freely
  afterwards" (comment at `appStore.ts:3494-3496`). This is a real, if
  manual, creation path today; it stays as the power-user/from-scratch
  option (§ Creation below).
- **Naming, export overrides**: `OutputInspector` (`InspectorPanel.tsx:1033`)
  already has an editable name field (`renameOutput`) and a per-output
  export-overrides group (`per-output-export-settings.md`, landed).
- **Export/CLI target selection**: fully built. `exportSelectedOutputs`
  (`appStore.ts:4680-4729`, id-based: `'active' | 'all' | nodeId`) and the
  CLI's `CliRenderJob.output` (`shared/ipc.ts:533-534`, name-based: `null
  (first) | 'all' | name`, consumed at `appStore.ts:4826-4832`) both already
  resolve 2+ outputs, suffix filenames via `suffixExportPath` (collision-
  disambiguated), and resolve per-output export overrides via
  `resolveExportSettings`. This brief adds no export-side code.

## Decided semantics

- **Creation — "Duplicate output" is the everyday gesture.** A new store
  action clones the ACTIVE output's own upstream chain: compute
  `reachableToOutput(graph, activeOutputId)` minus the input node, clone
  every node in that set with fresh ids (`nextId`, same scheme
  `buildLocalAdjustmentPatch` already uses for its dev/mask/blend triple —
  `appStore.ts:1739-1753`), clone the edges among them 1:1, wire the clone's
  root(s) to the SAME source(s) the original chain's root edge(s) used (the
  input node, or whatever the active chain actually starts from), and append
  a new output node — same `outX + offset` layout convention `addOpNode`
  uses — wired to the clone's tail. Name suggestion: `outputName(active) +
  ' copy'`, deduplicated the same way `suffixExportPath`/`slugifyPresetName`
  already dedupe (`sanitizeToken`, `appStore.ts:1942-1994`) — the user
  renames via the existing `OutputInspector` field. One undo entry
  (`pushHistory(s, null, { label: 'Duplicate output' })`, default kind
  `'photo-edit'` — the landed global-undo stack already covers this for
  free, see `undoStack.ts`'s `GraphUndoEntry`). Selects the new output node
  and sets it `activeOutputId` (matches "just added, now editing it"
  convention `addOpNode` follows for every other kind).
  Blank `addOpNode('output')` stays as the advanced path (Add-node menu) for
  a from-scratch composite that intentionally shares nothing — do not remove
  or rename it; "Duplicate output" is additive.
- **Filmstrip representation — a count badge, NOT stacked fake rows.**
  Rejected LR-style stacked-thumbnail cells because the fact check doesn't
  support them cheaply: `thumbnailCache.ts` (`Filmstrip.tsx`'s thumbnail
  source) decodes the camera's OWN embedded preview per file
  (`extractSonyEmbeddedPreview`/`createImageBitmap`) — it reflects NOTHING
  about develop state, single-output or multi. Every filmstrip thumbnail
  today is blind to edits; building a per-output RENDERED thumbnail (through
  the graph, at develop time) to make virtual copies visible would be a
  materially bigger feature than this brief, with no existing precedent to
  lean on (the per-node-preview pack's thumbnails are canvas-side, keyed to
  the currently OPEN photo's node graph, not usable for a closed filmstrip
  cell). Instead: extend the cheap per-look read `buildPlaylistEntries`
  already does for rating/flag (`folderEntries`) with an `outputCount`
  field (parse `graph.nodes.filter(n => n.kind === 'output').length` from
  the same look-file read, no new I/O). `FilmstripCell` renders a small
  corner badge ("2") when `outputCount > 1`; hovering/tapping it shows a
  lightweight popover listing the output names (each with its export-
  override badge, reusing `describeExportOverrides`) — informational only,
  no open-a-specific-output action from the popover (opening a photo always
  opens the whole doc; picking which output previews/exports happens via the
  existing `OutputSelector` once it's open, unchanged).
- **Export/CLI semantics: no change** — see "What already works" above.
- **Preset/paste/sync interactions — this is the real design work**, because
  today's merge code was written assuming exactly one Develop node per doc:
  - `applyLook` (whole-look paste-develop-settings clipboard, and an
    unscoped/pre-scoping preset) wholesale-replaces `graph.nodes`/`edges`
    (`mergeLookWithCurrentGeometry`, `appStore.ts:2021-2028`) — only the
    input node's geometry survives the swap. On a 2+-output doc this
    SILENTLY DELETES every output besides
    whatever the pasted/preset look itself contained (typically one) — a
    real data-loss hazard, not cosmetic. **DECIDED**: once the CURRENT graph
    has 2+ outputs, whole-look apply/paste is scoped to the ACTIVE output's
    own chain only: remove exactly `reachableToOutput(graph, activeOutputId)
    minus the output node itself` from `graph`, splice in `look`'s own
    corresponding chain (same node kinds, fresh ids to avoid collision with
    the untouched copies) reconnected input → …→ the (unmoved, un-renamed)
    active output node. On a single-output doc `reachableToOutput` already
    covers the WHOLE graph, so this is bit-identical to today's behavior —
    no regression for the overwhelming common case. New helper alongside
    `applyLook`, e.g. `replaceActiveChainWithLook(s, look, opts)`; `applyLook`
    itself becomes the `outputs.length <= 1` fast path (or is kept verbatim
    and the new helper is only invoked when `outputs.length > 1` — either
    way, one code path for the common case, the new logic strictly additive).
  - `mergeScopedLook`/`buildScopedLook` (`presetFamilies.ts:363-382`,
    `:231`) iterate EVERY `DEVELOP_KIND` node in the graph and match a
    Develop node to its counterpart in `look` BY ID. On a multi-output doc
    (2 independent Develop nodes, necessarily 2 different ids once cloned
    with fresh ids per the Duplicate mechanism above) this means: a scoped
    preset apply / paste / sync can silently update the WRONG copy's Develop
    node (whichever id happens to collide with the source `look`'s — in
    practice only the copy that KEPT the original 'dev' id, regardless of
    which output is actually `activeOutputId`), and leaves every id-mismatched
    copy untouched with no notice. **DECIDED**: scope both functions to
    nodes reachable from `activeOutputId` only (same `reachableToOutput`
    helper) — a Develop node outside that chain is left alone, exactly as if
    it belonged to a different photo. Single-output docs are unaffected (only
    one Develop node is ever reachable, so scoping changes nothing there).
    Structural families (masks/spots/custom-nodes,
    `structuralFamilyCompatible`) get the same treatment: their existing
    "graft only if structurally compatible, else skip + count" behavior
    (`multi-select-sync.md`'s decided semantics) now additionally means
    "graft only onto the active chain's own structural nodes."
  - `syncSelection` (`multi-select-sync.md`, cross-PHOTO, already landed)
    reads the PRIMARY's `s.graph` directly as `primaryLook` — once the
    primary itself has 2+ outputs, "the primary's live graph" must mean "the
    primary's ACTIVE-output chain," so `syncSelection` needs the exact same
    active-chain scoping as the paragraph above (it already goes through
    `mergeScopedLook`/`buildScopedLook` internally, per its own doc comment
    at `appStore.ts:5334-5338`, so this mostly falls out of the fix above for
    free). For a TARGET photo that ALSO has 2+ outputs, there is no live
    `activeOutputId` (it isn't open) — default to that target doc's first
    output, the same "`activeOutputId` ?? first" fallback rule
    `activeOutputNode` already applies everywhere else in this codebase.
  - `resetAllEdits` (`appStore.ts:4437-4469`) replaces the WHOLE graph with a
    fresh single-output `defaultGraphDoc()`. **DECIDED: leave as-is, document
    the behavior, no code change.** It collapses every virtual copy back to
    one output — but the button is named "reset ALL edits" (not "reset the
    active chain"), it's one landed global-undo entry away
    (`kind: 'reset-all'`), and DESIGN.md's catalog-slope guard is about photo
    deletion, not graph structure. Implementer: just make sure the verify
    sketch below asserts this is what happens (so it's a documented choice,
    not a silent surprise discovered later).
  - `resetDevelopNode` (`appStore.ts:4471-`) already targets one explicit
    `nodeId` — already correctly scoped, no change.
- **Undo**: no new entry kind needed. "Duplicate output" and "Remove output"
  (`removeOpNode`'s existing `kind === 'output'` branch,
  `appStore.ts:3597-3617`) both already go through `pushHistory` with a whole
  before/after `GraphDoc`, `target: imagePath` — exactly the shape every
  other graph mutation uses, and the landed global-undo stack
  (`undoStack.ts`) covers it with zero new code.
- **Sidecar back-compat**: unaffected. `parseGraphDoc` already accepts N
  output nodes (its own validation loop runs `buildPlan` once per output
  node, `graphDoc.ts:923-925`); a single-output doc round-trips byte-
  identical (no new fields introduced by this brief — `name`/`export` were
  both added by earlier, already-landed briefs).

## UI notes

- "Add node ▾" menu gains a "Duplicate output" entry near the existing
  "output" (blank) entry — always enabled while any output exists (even a
  single-output doc can duplicate itself to create its second).
- Filmstrip cell: small corner badge, `data-testid="filmstrip-output-badge"`,
  showing the output count; a hover/click popover lists names +
  override-badges (reuse `describeExportOverrides`).

## Verify sketch (verify-virtualcopy.mjs)

(1) Duplicate output on a fresh doc produces 2 outputs; the clone's Develop
node has its own id and editing one's params leaves the other's compiled
plan/render untouched (readback mean differs only for the edited copy);
(2) `--output <name>`/`all`/first CLI selection and the export dialog's
output-target selector both already resolve the two copies to two distinct
files (regression guard on TOP of `verify-exportsettings`/`verify-cli`, not
a re-test of already-covered plumbing) — assert the SECOND file's pixels
differ once its Develop diverges; (3) paste-develop-settings / unscoped
preset apply onto a 2-output doc replaces only the ACTIVE chain — the OTHER
output's node ids/params are byte-identical before/after; (4) scoped preset
apply / sync onto a 2-output doc updates only the Develop node reachable
from the active output, leaving the inactive copy's Develop params
untouched; (5) `resetAllEdits` on a 2-output doc collapses to 1 output (this
IS the decided/documented behavior) and is exactly one `⌘Z` away; (6)
filmstrip badge appears once a look's on-disk graph gains a 2nd output and
disappears if pruned back to 1; (7) sidecar round-trip: a 2-named-output
look re-parses byte-stable; a legacy 1-output look is unaffected.

## Explicitly deferred

Rendered (not embedded-preview) per-output filmstrip thumbnails / real
stacked LR-style cells — revisit only if the badge+popover proves
insufficient in hand-testing, since it would need a genuinely new preview
pipeline. Duplicating a SPECIFIC non-active output (v1 always duplicates
whichever output is currently active/selected). Reordering output nodes.
Cross-output visual compare (already covered, unaffected, by
`compareOutputId`/`compare-view-and-ratings.md`). Batch export of multiple
PHOTOS each producing multiple outputs (that's `batch-export-selection.md`).
