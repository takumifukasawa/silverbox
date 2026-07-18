# Design seed: linked looks (references, not copies)

Status: SEED — not scheduled, not decided. Written 2026-07-18 while the
user weighed whether sync should exist at all: 「そもそも、ノードベースを
重視するならsyncしたいときとそうじゃないときがあるだろうしなぁ、むずいね」.
That instinct is the whole brief: in a node-based system, cross-photo
"sameness" should be a REFERENCE, not repeated copying.

## The framing (DCC vocabulary)

Two legitimate cross-photo relationships:

1. **Linked (instanced)**: several photos REFERENCE one shared look.
   Edits propagate because they're the same object, not because a copy
   ran. Detach = "make local" (Blender linked-duplicate / Houdini
   instance vocabulary). This is what "I want sync" actually means.
2. **Independent (copied)**: each photo owns its look. Today's default,
   and what "I don't want sync" means.

Sync-the-button is an imperative patch that emulates (1) with a one-shot
copy; Auto Sync emulates it with CONTINUOUS copies — which is why it
grew a clobber footgun (fixed 2026-07-18, ee95326) and why it keeps
feeling wrong: it answers a declarative question ("are these the same
look?") with a temporal mechanism ("when did you last copy?").

## What it would take (why this is a seed, not a brief)

- The doc model gains a cross-photo reference: a playlist row pointing
  at a SHARED look asset (`looks/shared/<name>.json`?) instead of its
  own file — touches the look-file-per-photo independence that project
  storage deliberately established (sidecar-spec.md), autosave (which
  file does an edit write?), undo (an edit on a shared look changes N
  photos — one entry? N?), the git-native story (a shared look diff
  touches many photos at once — arguably a FEATURE for the
  procedural pitch), CLI resolution, and relink/copy-on-detach UX.
- Per-photo geometry must stay LOCAL even under a shared look (a crop
  is never shared — same reasoning as applyLook's geometry carve-out).
- Presets already cover the "publish a snapshot of a look" half; linked
  looks cover the "keep following it" half. They compose: a preset is a
  frozen fork of a shared look.

## Interim ladder (pragmatic, already decided or cheap)

1. Now: explicit Sync button only; Auto Sync is removal-candidate
   pending the user's call (the 2026-07-18 discussion).
2. Cheap next rung if wanted: "apply preset to selection" — batch
   look application with clear, named, one-shot semantics.
3. This seed, only if/when the user wants true following semantics.
