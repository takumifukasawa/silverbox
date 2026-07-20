# Plan: decompose appStore.ts (8839 lines) into zustand slices

Status: PLAN — not scheduled. **HARD ORDERING CONSTRAINT: do NOT start
until the linked-looks run (stages A-G) has fully landed and no agent
has appStore.ts work in flight.** Stages D/E/F all edit appStore
heavily; a decomposition running concurrently would collide
catastrophically (the golden-window playbook's "selective staging when
parallel agents share the tree" incident, but structural). This is a
single-threaded, no-other-appStore-work refactor by definition.

## Why (and why NOT sooner)

appStore.ts is the single largest file (8839 lines as of stage C), one
`interface AppState` (line 151) and one `create<AppState>` (line 2855)
holding every domain: project (640 kw hits), develop (267), undo/redo
(242), sync (200), preset (195), export (153), sharedLook (143), spot
(139), mask (98), filmstrip (73), compare (69). It works and is
well-doc-commented — this is NOT a rewrite, it's a mechanical
re-housing to make the file navigable for a conductor (human or Opus)
who has to review diffs against it. Value is purely maintainability;
correctness is already enforced by the 69-script suite. So it is
LOW-PRIORITY and only worth doing when the store is otherwise QUIET.

## The mechanism: zustand slices (behavior-preserving)

zustand supports splitting one store into slice creators that each
receive the same `(set, get)` and return a partial of the whole state,
combined by spread:

```ts
const createUndoSlice: StateCreator<AppState, [], [], UndoSlice> =
  (set, get) => ({ /* undo/redo actions, moved verbatim */ });
export const useAppStore = create<AppState>()((...a) => ({
  ...createDecodeSlice(...a),
  ...createProjectSlice(...a),
  ...createDevelopSlice(...a),
  ...createSharedLookSlice(...a),
  // …
}));
```

Because every slice shares one `get()`, cross-slice calls
(`get().saveGraph()` from a sharedLook action) keep working UNCHANGED —
this is why the split is safe and can be incremental. `AppState` stays
ONE interface (the union of slice interfaces) so no call site changes.

## Proposed slice boundaries (by the domain clusters that already exist)

Each is a file under `src/renderer/store/slices/`:

1. **decodeSlice** — image open/decode, embedded-preview-first,
   baseline-exposure re-decode debounce, epoch guard, wbModel.
2. **graphSlice** — the live graph, node add/delete/param edits,
   revalidateShaders, activeOutput, buildPlan plumbing, develop
   mutators (the six fork-on-touch call sites live here).
3. **projectSlice** — project open/save-as/quick, playlist, relink,
   fingerprint, refreshPlaylistStatus, remove-from-project.
4. **sidecarSlice** — autosave (flush-on-switch, lastSidecarText),
   hot-reload (handleExternalSidecarChange), sidecar diff.
5. **undoSlice** — the global undo/redo stack driver and every typed
   entry's undo/redo cases (GraphUndo, Sync, Publish,
   DeleteSharedLook, RemovePhotos, Arrange, Rating, Flag). Big; the
   single clearest win.
6. **presetSlice** — save/apply/delete presets, apply-preset-to-
   selection, FamilyScopeDialog plumbing.
7. **sharedLookSlice** — create/link/fork/revert/unlink/delete/publish,
   drift/materialize (stages B-D). Self-contained by the time this
   runs.
8. **selectionSlice** — filmstrip selection, sync, compare, ratings,
   flags.
9. **exportSlice** — export dialog, per-output overrides, LUT export.
10. **spotsMasksSlice** — spot tool state, mask draw, repair sheets
    (stage F).
11. **uiSlice** — notices, dialogs, view toggles (before/after,
    grayscale), tool exclusivity (deactivateOtherTools).

Module-level pure helpers (mergeFamiliesWithSkipDetection, chainScope,
restrictToChain, forkLinkedFamilies, applySyncEntryGraphs, seed
helpers) move to `src/renderer/store/graphOps.ts` — they already read
like a library and several are shared across would-be slices.

## Execution — one slice per commit, suite green each time

For EACH slice, in dependency order (helpers first, then leaf slices,
undo last since it references every entry type):
1. Cut the slice's actions + its state fields out of the monolith into
   the new file as a `StateCreator`; leave a spread in the `create`
   call.
2. `npm run typecheck` (the compiler proves no field/method was lost —
   `AppState` is unchanged, so any missed move is a type error).
3. Full suite green (behavior unchanged by construction).
4. Commit "store: extract <slice> (no behavior change)".

tsc is the safety net that makes this nearly mechanical: because the
public `AppState` shape is invariant, every extraction is either
type-clean (correct) or a compile error (incomplete) — there is no
silent-wrong state. Do NOT combine slice extraction with any behavior
change in the same commit.

## Risks / watch items

- `usePlanDoc` JSON.stringify-minus-position fragility (playbook) is
  untouched — slices don't change the doc shape.
- zustand middleware (if any is added later) wraps the combined store,
  not slices — fine.
- Don't over-split: 11 slices from one 8839-line file is already
  aggressive; stop there, don't chase 25 tiny ones.
- Circular imports between slice files: keep slices importing only
  graphOps.ts + types, never each other (cross-slice calls go through
  `get()`, not imports).

## Verify

No NEW verify script — the whole point is that the EXISTING 69-script
suite + 243 unit tests are the acceptance test, unchanged, green after
every slice commit. A decomposition that needs a new test changed
behavior and is wrong.
