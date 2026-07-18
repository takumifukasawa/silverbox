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

## The override problem (user, 2026-07-18 — the core design question)

「上書きしたいパラメーターをどうするか。ハイライトやシャドウなどはある程度
プリセットに埋め込むが、写真ごとにも調整すると思う。が、逆にプリセットの
値を採用したい場合もあるだろうし」— i.e. a photo must be able to (1)
follow the look, (2) locally override parts of it, and (3) RETURN to
following. Three candidate models:

- **(A) Per-family fork + revert (recommended).** The link covers preset
  FAMILIES (the exact vocabulary preset scoping / sync already ship).
  Touching any param in a linked family forks THAT family local (visible
  "modified from look" badge); "Revert to look" per family resumes
  following. Declarative state, reuses existing machinery, expresses
  "tone per-photo, color follows" naturally.
- **(B) Graph stacking (node-native).** Shared look = upstream reference
  node; per-photo tweaks = a separate downstream Develop node. No
  override machinery at all — but the COMPOSITION MATH goes muddy for
  replace-semantics params (running highlights/shadows tone mapping
  twice ≠ replacing the value; curves/WB don't stack) — the reason
  LR/C1 use value-level overrides. Philosophically pretty, rejected on
  image-math grounds unless someone finds a clean composition algebra.
- **(C) Per-parameter override set** (CSS/Houdini-style). Finest grain,
  heaviest UI (every slider needs a follow/override state). Position:
  refine (A) into (C) only where real usage demands it, not up front.

## The UE Material / Material Instance mapping (user, 2026-07-18)

「UEのマテリアルとマテリアルインスタンス的な考え方かなぁ。シェーディング
本体と、パラメーターを上書きするやつ。でもスタンプで消したりとかした後に、
シェーディング本体を上書きするとどうなる？」— the analogy holds precisely,
and the stamp question answers itself through it:

- Material = the shared look (default parameter values, maybe structure).
  Material Instance = the photo's sparse override set; editing the parent
  flows into every non-overridden slot. This is model (A)/(C) above with
  a production-proven precedent.
- UE instances CANNOT change the graph — parameters only — and that's
  exactly why it doesn't collapse. Translated here: **spots/masks/custom
  nodes are NOT part of the look; they're photo-anchored LOCAL structure
  composed downstream of the link.** The codebase already says so twice:
  anchor space stores spot/mask coords in the photo's own pixel frame
  (meaningless on another photo), and the preset-family split already
  quarantines them as 'structural', default-unchecked. So "stamp, then
  update the look body" simply doesn't conflict — the body's changes
  arrive through the parameter layer; local stamps live downstream
  untouched (UE: swap the material, the decals stay).
- Two real edge cases remain: **sensor dust** (see the next section —
  the user found the deeper shape of it) and **orphaned overrides**
  (the body removes/reshapes a family the photo overrode — UE silently
  drops; our non-destructive stance says the fork survives as local).

## Dust is an ORTHOGONAL axis, not a look variant (user, 2026-07-18)

「同じ環境下だけど固定のゴミがある場合とない場合がある。そういうときに
プリセットを増やさないといけなくなる」— exactly: baking dust spots into
the look multiplies presets by dust-state (look × dust = variant
explosion). Dust is equipment-state REPAIR, not aesthetics — a separate
axis that must compose, not fork the preset:

- **Today's answer (already shippable with landed machinery):** keep
  spots OUT of look presets (structural families are default-unchecked
  — already the case); dust handling = select the affected frames,
  Sync with ONLY the spots family checked. Frames without the dust
  simply aren't selected. One look preset, ever.
- **Linked-world answer:** a photo carries MULTIPLE orthogonal links —
  `look` (aesthetics) + `repair set` (dust) attached/detached
  independently. Composition instead of variants; the core node-based
  argument again.
- **And dust may not even deserve a LINK:** sensor dust never changes
  retroactively, so following-semantics buys nothing — a one-shot
  "stamp sheet" copy is the honest weight class. Aperture-dependent
  visibility means per-frame application judgment is needed anyway, so
  fully-automatic following would be wrong even if cheap.

## Interim ladder (pragmatic, already decided or cheap)

1. Now: explicit Sync button only; Auto Sync is removal-candidate
   pending the user's call (the 2026-07-18 discussion).
2. Cheap next rung if wanted: "apply preset to selection" — batch
   look application with clear, named, one-shot semantics.
3. This seed, only if/when the user wants true following semantics.
