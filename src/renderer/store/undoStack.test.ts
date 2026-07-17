/**
 * Unit tier for the pure global-undo stack mechanics (docs/brief-bank/
 * global-undo.md) — push/bound/truncate-redo, and moving entries between the
 * undo and redo stacks in the right LIFO order. Kind-specific apply/revert
 * (jumping photos, autosave) lives in appStore.ts and is covered by
 * scripts/verify-undo.mjs instead; this file only exercises the generic
 * stack shape, independent of what an entry's payload even is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  emptyUndoStackState,
  moveTopToRedo,
  moveTopToUndo,
  nextUndoSeq,
  peekRedo,
  peekUndo,
  pushUndoEntry,
  resetUndoSeqForTests,
  UNDO_STACK_LIMIT,
  type RatingUndoEntry,
} from './undoStack';

/** Minimal rating entry — the smallest UndoEntry shape, enough to exercise the generic stack mechanics without a GraphDoc fixture. */
function ratingEntry(target: string, before: number): RatingUndoEntry {
  return { seq: nextUndoSeq(), at: Date.now(), kind: 'rating', label: `Set rating to ${before + 1}`, target, before };
}

describe('undoStack (pure global-undo mechanics)', () => {
  beforeEach(() => {
    resetUndoSeqForTests();
  });

  it('starts empty', () => {
    const state = emptyUndoStackState();
    expect(peekUndo(state)).toBeNull();
    expect(peekRedo(state)).toBeNull();
  });

  it('push adds to the top of the undo stack and clears redo', () => {
    let state = emptyUndoStackState();
    const e1 = ratingEntry('a.ARW', 0);
    state = pushUndoEntry(state, e1);
    expect(peekUndo(state)).toBe(e1);
    expect(state.redo).toHaveLength(0);

    const e2 = ratingEntry('b.ARW', 2);
    state = pushUndoEntry(state, e2);
    expect(peekUndo(state)).toBe(e2); // most recent push is on top
    expect(state.undo).toEqual([e1, e2]);
  });

  it('a new push truncates whatever was on the redo branch (standard timeline semantics)', () => {
    let state = emptyUndoStackState();
    const e1 = ratingEntry('a.ARW', 0);
    state = pushUndoEntry(state, e1);
    const settled = { ...e1, after: 3 };
    state = moveTopToRedo(state, settled); // undo e1 -> redo now has one entry
    expect(state.redo).toHaveLength(1);

    const e2 = ratingEntry('b.ARW', 1);
    state = pushUndoEntry(state, e2); // a brand-new op after an undo
    expect(state.redo).toHaveLength(0);
    expect(peekUndo(state)).toBe(e2);
  });

  it('undo -> redo round trip restores the same entry and ordering (LIFO both ways)', () => {
    let state = emptyUndoStackState();
    const e1 = ratingEntry('a.ARW', 0);
    const e2 = ratingEntry('a.ARW', 1);
    state = pushUndoEntry(state, e1);
    state = pushUndoEntry(state, e2);

    // Undo twice: e2 first (most recently pushed), then e1.
    expect(peekUndo(state)).toBe(e2);
    const e2Settled = { ...e2, after: 2 };
    state = moveTopToRedo(state, e2Settled);
    expect(peekUndo(state)).toBe(e1);
    expect(peekRedo(state)).toBe(e2Settled);

    const e1Settled = { ...e1, after: 1 };
    state = moveTopToRedo(state, e1Settled);
    expect(peekUndo(state)).toBeNull();
    // redo is also LIFO: the MOST recently undone (e1) redoes FIRST.
    expect(peekRedo(state)).toBe(e1Settled);
    expect(state.redo).toEqual([e1Settled, e2Settled]);

    // Redo twice, back in forward order: e1 first, then e2.
    state = moveTopToUndo(state, e1Settled);
    expect(peekUndo(state)).toBe(e1Settled);
    expect(peekRedo(state)).toBe(e2Settled);

    state = moveTopToUndo(state, e2Settled);
    expect(peekUndo(state)).toBe(e2Settled);
    expect(peekRedo(state)).toBeNull();
    expect(state.undo).toEqual([e1Settled, e2Settled]);
  });

  it('bounds the stack at UNDO_STACK_LIMIT, dropping the oldest entry first', () => {
    let state = emptyUndoStackState();
    for (let i = 0; i < UNDO_STACK_LIMIT + 5; i++) {
      state = pushUndoEntry(state, ratingEntry('a.ARW', i));
    }
    expect(state.undo).toHaveLength(UNDO_STACK_LIMIT);
    // the oldest 5 pushes (before=0..4) were dropped; the stack starts at before=5
    expect(state.undo[0]!.kind).toBe('rating');
    expect((state.undo[0] as RatingUndoEntry).before).toBe(5);
    expect((state.undo[state.undo.length - 1] as RatingUndoEntry).before).toBe(UNDO_STACK_LIMIT + 4);
  });

  it('nextUndoSeq is monotonically increasing (stable ordering for equal timestamps)', () => {
    const a = nextUndoSeq();
    const b = nextUndoSeq();
    expect(b).toBeGreaterThan(a);
  });
});
