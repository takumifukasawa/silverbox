/**
 * Global undo (docs/brief-bank/global-undo.md): ONE LIFO timeline shared by
 * every photo and every batch action, replacing the old per-open-photo
 * `history: { past, future }` GraphDoc arrays. Pure/dependency-free on
 * purpose (no zustand import, no appStore types) so its mechanics are
 * unit-testable in isolation — same discipline openSession.ts already
 * follows for the epoch guard appStore wires in around it.
 *
 * appStore.ts owns all the kind-specific APPLY/REVERT logic (jumping photos,
 * writing sidecars, autosave) — this module only knows how to push/bound the
 * stack and move entries between undo <-> redo. An entry's `before` is always
 * known at creation time (whatever the store's own state held right before
 * the mutation); `after` is filled in lazily, the first time the entry is
 * undone — captured from whatever's CURRENT for its target at that moment,
 * which (by construction: strict LIFO, no cherry-picking — decision 3 of the
 * brief) is guaranteed to equal what the mutation originally produced, since
 * nothing else can have touched that same target in between without ITSELF
 * being a later entry that would have to be undone first.
 */
import type { GraphDoc } from '../engine/graph/graphDoc';
import type { ProjectPhoto } from '../engine/graph/projectDoc';
import type { PhotoFlag } from '../../../shared/ipc';

/** Kinds whose value is a whole GraphDoc, keyed by the photo path that owns it. */
export type GraphEntryKind = 'photo-edit' | 'preset-apply' | 'develop-reset' | 'reset-all';

interface UndoEntryBase {
  seq: number;
  at: number;
  /** Human-readable summary for the Edit-menu-shaped surface (decision 5): "Undo <label>". */
  label: string;
}

/** Whole-graph, single-photo entries — the bulk of everyday edits (WB, curve, spot, mask, crop, node graph…), plus preset-apply/develop-reset/reset-all (same mechanics, distinct kind for labeling). */
export interface GraphUndoEntry extends UndoEntryBase {
  kind: GraphEntryKind;
  target: string; // photo path
  before: GraphDoc;
  after?: GraphDoc;
  /**
   * Drag-coalescing tag (a slider/wheel/curve-drag session key) — internal
   * bookkeeping only, never surfaced in the label. `null` = always its own
   * discrete entry (pushHistory's existing `key` convention, ported as-is).
   */
  coalesceKey: string | null;
}

/** Star rating (0-5) — sidecar WRAPPER metadata about the photo, not the graph. */
export interface RatingUndoEntry extends UndoEntryBase {
  kind: 'rating';
  target: string; // photo path
  before: number;
  after?: number;
}

/** Pick/reject flag — same wrapper-metadata shape as rating. */
export interface FlagUndoEntry extends UndoEntryBase {
  kind: 'flag';
  target: string; // photo path
  before: PhotoFlag | null;
  after?: PhotoFlag | null;
}

/**
 * Batch sync (multi-select-sync.md): N target looks revert/reapply
 * together — no single photo to jump to (decision 1's BATCH carve-out: never
 * jump, revert all targets in place + a completion notice listing them).
 * Type + dispatch only for v1 — Sync itself hasn't landed, so nothing ever
 * constructs one of these yet.
 */
export interface SyncUndoEntry extends UndoEntryBase {
  kind: 'sync';
  targets: string[];
  before: Record<string, GraphDoc>;
  after?: Record<string, GraphDoc>;
}

/**
 * Node-editor Arrange (node-editor-ux.md's auto-layout successor): before/
 * after are the stored node positions of every node that actually MOVED,
 * keyed by node id (a subset of the doc's nodes, not necessarily all of
 * them). `target` is the open photo whose doc was arranged — same meaning
 * as every other single-photo entry's `target` (photo-edit/rating/flag);
 * "jump semantics don't apply" per the brief just means undo/redo don't need
 * a SPECIAL case beyond the ordinary ensurePhotoOpenForUndo jump-if-needed
 * machinery every other kind already uses.
 */
export interface ArrangeUndoEntry extends UndoEntryBase {
  kind: 'arrange';
  target: string; // photo path
  before: Record<string, { x: number; y: number }>;
  after?: Record<string, { x: number; y: number }>;
}

/**
 * "Remove from project" (UX pack round 2, item C): removing one or more
 * playlist rows is a whole-PLAYLIST operation, same "no single photo to jump
 * to, revert all targets in place" shape as SyncUndoEntry above — the look
 * FILES themselves are never touched (removal only drops playlist rows; the
 * brief's own "an orphan row is recoverable by re-dropping the photo" note is
 * exactly what keeps this entry simple: undo only needs to restore the
 * ProjectPhoto rows, never resurrect any file). `removed` carries each row's
 * ORIGINAL playlist index so undo can splice it back at (approximately) the
 * same position rather than just appending it at the end.
 */
export interface RemovePhotosUndoEntry extends UndoEntryBase {
  kind: 'remove-photos';
  projectDir: string;
  removed: { index: number; photo: ProjectPhoto }[];
}

/**
 * Shared-look deletion (docs/brief-bank/linked-looks-stage-b.md semantic 7):
 * the SyncUndoEntry shape doesn't fit here — a plain `before`/`after` graph
 * pair per follower would restore every follower's `link` field on undo, but
 * has nowhere to carry the deleted FILE's own bytes back. Conductor review
 * finding: "the deletePreset analogy doesn't hold — nothing references a
 * preset, but link fields REFERENCE the shared look", so undo of a delete
 * must resurrect the FILE too, or a restored `link` points at nothing (a
 * user-reachable inconsistent state one ⌘Z away, in the SAME session that
 * created it — not stage D's separate missing-look-file problem). `lookText`
 * is the shared-look file's own serialized bytes, captured BEFORE the
 * delete; `targets`/`before`/`after` are the followers' graphs, same shape
 * SyncUndoEntry's own pair uses (both sides known synchronously at push
 * time, like a sync entry). Undo: re-write `lookText` to
 * `<projectDir>/shared-looks/<slug>.json`, THEN restore every follower's
 * `before` graph. Redo: write every follower's `after` (link stripped)
 * graph, THEN delete the file again. `targets` may be empty (a look with no
 * followers is still undoable — the delete itself, not just any follower
 * change, is what this entry restores).
 */
export interface DeleteSharedLookUndoEntry extends UndoEntryBase {
  kind: 'delete-shared-look';
  projectDir: string;
  slug: string;
  lookText: string;
  targets: string[];
  before: Record<string, GraphDoc>;
  after?: Record<string, GraphDoc>;
}

export type UndoEntry =
  | GraphUndoEntry
  | RatingUndoEntry
  | FlagUndoEntry
  | SyncUndoEntry
  | ArrangeUndoEntry
  | RemovePhotosUndoEntry
  | DeleteSharedLookUndoEntry;

/** Bounded (~200 entries, oldest dropped — brief's "Bounded stack"), session-scoped (no persistence across restarts). */
export const UNDO_STACK_LIMIT = 200;

export interface UndoStackState {
  /** LIFO — the LAST element is the most recently pushed entry, i.e. what `undo()` applies next. */
  undo: UndoEntry[];
  /** LIFO — the FIRST element is the most recently undone entry, i.e. what `redo()` applies next. */
  redo: UndoEntry[];
}

export const emptyUndoStackState = (): UndoStackState => ({ undo: [], redo: [] });

let seqCounter = 0;
export function nextUndoSeq(): number {
  return ++seqCounter;
}
/** Test-only: reset the module-scope seq counter between unit tests. */
export function resetUndoSeqForTests(): void {
  seqCounter = 0;
}

/**
 * Push a new entry: any new operation truncates the redo branch (standard
 * timeline semantics — brief's "truncate-redo-on-new-op") and bounds the
 * stack to UNDO_STACK_LIMIT, dropping the oldest entry once full.
 */
export function pushUndoEntry(state: UndoStackState, entry: UndoEntry): UndoStackState {
  return { undo: [...state.undo.slice(-(UNDO_STACK_LIMIT - 1)), entry], redo: [] };
}

/** The entry `undo()` would apply next, without mutating anything. */
export function peekUndo(state: UndoStackState): UndoEntry | null {
  return state.undo.length > 0 ? state.undo[state.undo.length - 1]! : null;
}
/** The entry `redo()` would apply next, without mutating anything. */
export function peekRedo(state: UndoStackState): UndoEntry | null {
  return state.redo.length > 0 ? state.redo[0]! : null;
}

/** Move the top undo entry onto the redo stack — call after successfully applying its `before` (with `after` freshly captured onto `settled`). */
export function moveTopToRedo(state: UndoStackState, settled: UndoEntry): UndoStackState {
  return { undo: state.undo.slice(0, -1), redo: [settled, ...state.redo] };
}
/** Move the top redo entry back onto the undo stack — call after successfully applying its `after`. */
export function moveTopToUndo(state: UndoStackState, entry: UndoEntry): UndoStackState {
  return { undo: [...state.undo, entry], redo: state.redo.slice(1) };
}
