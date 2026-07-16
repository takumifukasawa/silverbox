# Brief: pick/reject flags

Status: LANDED 2026-07-16 (9efc65c) — implemented ahead of
multi-select+sync (which was gated on a hand-test); the flag store
action takes an explicit look path so the later multi-select fan-out
plugs in without surgery. verify-flags.mjs covers it. Original design
notes below.
Prereq reading: Filmstrip.tsx (★n+ filter, cell badges), the rating
plumbing end-to-end (wrapper field in graphDoc.ts, setRating in
appStore, extractSidecarRating cheap read, projectPhotosStatus IPC,
CLI --min-rating), docs/sidecar-spec.md (wrapper conventions),
filmstrip-curation brief if present.

## Decided semantics (don't relitigate)

- **Data**: new optional look-wrapper field `flag: 'pick' | 'reject'`
  — absent means unflagged (identity-omission convention; never write
  `"flag": null`). Additive to schemaVersion 4, sanitizer drops any
  other value. Update docs/sidecar-spec.md's wrapper table in the same
  landing (spec must not drift, it just shipped).
- **Keys** (LR muscle memory, check the keyboard-map memory before
  changing anything): `p` = pick, `x` = reject, `u` = unflag. Act on
  the canvas photo, or on the whole filmstrip selection when
  multi-select has 2+ selected. IMPORTANT: `p` and `x` must not
  collide with existing bindings — audit the round-8-13 keyboard map
  in the conductor playbook / Toolbar shortcuts first; if either is
  taken, report and propose before landing (do not silently pick
  different keys).
- **Filmstrip**: rejected cells render dimmed (≈45% opacity on the
  thumbnail, not the border) with a small ⨯ glyph; picks get a small
  flag glyph. The existing ★n+ filter control gains a second segment:
  All / Hide rejected / Picks only. Filter state is session-only.
- **NEVER a delete workflow.** Reject is metadata; the app does not
  offer "delete rejected" (catalog-slope guard in DESIGN.md — views
  filter, nothing persists beyond the look file, no library
  management). Do not add it even as a menu stub.
- **Rating interplay**: independent axes (LR-consistent). Rejecting
  does not clear rating; the ★ filter and the flag filter compose
  (AND).
- **CLI**: `--skip-rejected` opt-in flag for render/check batch jobs
  (reads each look's flag the same cheap-wrapper way --min-rating
  reads rating). Default behavior unchanged — an existing script's
  output must not change because a user flagged photos in the GUI.
- **Cheap reads**: extend the wrapper cheap-read (extractSidecarRating
  → generalize to extractWrapperMeta returning {rating, flag}) and the
  projectPhotosStatus IPC so the filmstrip gets flags in the same
  round trip it already makes. No extra IPC.

## Verify sketch (verify-flags.mjs or fold into verify-ratings.mjs —
implementer's call, say which)

(1) p/x/u write and clear the wrapper field, autosave lands it, absent
when unflagged; (2) reopen restores flag state; (3) filmstrip filter:
hide-rejected removes the cell, picks-only shows only picks, composes
with ★n+; (4) multi-select flagging writes every selected look;
(5) CLI --skip-rejected skips exactly the rejected inputs with a
warning line, and its absence changes nothing; (6) old sidecars
without the field parse (trivially covered but assert once).

## Explicitly deferred

Delete/trash anything (never); flag sync across virtual copies /
multiple outputs (revisit with the virtual-copy feature); flag-based
smart collections (catalog slope — no).
