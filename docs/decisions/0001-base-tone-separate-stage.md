# 0001: Base tone is its own stage; the user tone curve always starts flat

- 日付: 2026-10-06
- 状態: 採用（暫定 — ユーザーは「1 な気がする」。実装着手前に最終確認する）

## 背景

A fresh RAW open needs a display tone mapping (lift the midtones, roll off the
highlights) — sRGB encoding alone renders a correct-but-dark, flat image
(`linear-raw` column of `test-artifacts/default-look-compare-2026-10-05.html`:
−1.4..−1.7 EV vs LR on 4/5 scenes).

Today that tone mapping is written as editable points INTO the user's tone
curve (`develop.toneCurve.rgb`, seeded by `seedDefaultLook`; COLOR.md
"Default rendering", 2026-07-12: "NOT hidden decode magic"). But the layering
is inconsistent across profile modes:

| mode | where the base tone lives | user tone curve at open |
|---|---|---|
| builtin (default) | seeded points in `toneCurve.rgb` | pre-filled |
| dcp | inside the profile stage (`dcp-profile.md` "Layering decision", 2026-07-18) | flat |
| acrlook | seeded points in `toneCurve.rgb` (ACRLOOK_BASE_CURVE) | pre-filled |

and source switching has to juggle the user's curve to compensate
(flatten-if-equals-seed for DCP, swap-if-equals-seed for acrlook —
`appStore.ts` around the `curvePointsEqual` call sites).

Both reference apps separate the two: Lightroom's default tone lives in the
profile / process version and its Tone Curve panel opens Linear; Resolve's
tone mapping lives in the output transform and grading curves act before it.

## 採用案

The base tone becomes a separate, named Develop stage (`develop.baseTone`),
applied between the Basic tone stage and the user tone curve — exactly where
the seeded points act today, so a fresh open renders identically and the
2026-09-02 slider-response calibration (which assumed the base curve sits
right after the tone stage) stays valid. The user tone curve always opens
flat, in every profile mode.

- The stage is recorded in the document (not resolved from code at render
  time), so a sidecar renders the same forever. A doc WITHOUT the field
  means "no base tone" — every existing sidecar renders unchanged (its
  toneCurve still carries the old seeded points).
- It stays visible and removable as a named setting (Basic/Profile area),
  keeping COLOR.md's "no hidden decode magic" intent — it is just no longer
  disguised as user curve points.
- Profile modes set it instead of juggling the user curve: builtin →
  the camera base curve, acrlook → ACRLOOK_BASE_CURVE, tone-carrying DCP →
  none (the DCP's own curve is the base tone).

WHAT the base tone contains (LR-fitted A7C2 curve vs a generic,
LR-independent tone mapper — the A/B/C default-look question in
`docs/handoff.md`) is a separate, still-open decision; this one only fixes
the layering. Phase 1 keeps today's curves byte-for-byte.

## 落選案と落選理由

- **Keep seeding visible points into `toneCurve` (status quo).** Matches
  neither reference app, keeps the three-way inconsistency above, and keeps
  the per-mode curve juggling (a source of past bugs: the DCP double-tone
  bug, `50de364`). A user who "resets the curve" also silently removes the
  display tone mapping and gets the dark linear-raw look.
- **Put the base tone inside the profile stage (DCP style) for every mode.**
  The profile stage runs BEFORE the Basic tone sliders; moving the base tone
  there changes what every slider does and invalidates the 2026-09-02
  LR response calibration.
- **Hard-code the base tone in the renderer (not stored in the doc).**
  Breaks "the document is the truth": changing the default curve later
  would re-render every old photo.

## 影響・やり直す条件

- Schema: new optional Develop field; sidecar-spec.md must document it.
  Old docs need no migration to keep rendering; whether to offer a
  render-identical migration (seed points → baseTone) is open.
- Revisit if a reference app is found that keeps base tone as user-curve
  points and that is what users expect, or if the slider calibration is
  redone in a pre-base-tone space.
