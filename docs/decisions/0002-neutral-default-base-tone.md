# 0002: Fresh RAW opens are neutral; base tones are named display transforms

- 日付: 2026-10-07
- 状態: 採用（ユーザー GO 2026-10-07。「なしを前提とは多分する」「LR Like は載せなくていいかも」）

## 背景

Decision 0001 split the base tone from the user tone curve. This decides
what the base tone CONTAINS and what a fresh RAW open looks like.

Evidence (`test-artifacts/default-look-compare-2026-10-05.html`, the
"デフォルト描画 比較" artifact, `scripts/drt-compare/`): the LR-fitted
pipeline (A7C2 curve, later acrlook) hit diminishing returns over base-1..10
and LR's default is scene-adaptive, so a static curve cannot match it. The
user prefers a Resolve-style neutral default with looks supplied by presets.

## 採用案

- A fresh RAW open seeds NO look: `profile.amount` 0 (no Adobe-Color
  emulation), `profile.baseTone` 'none', identity tone curve. Corrections
  stay: demosaic, as-shot WB, camera matrix, baseline exposure, embedded lens
  profile, default sharpen 40 / color NR 25.
- `profile.baseTone` is a closed enum of NAMED display transforms, applied
  in linear working space between the Basic tone stage and the user tone
  curve (0001): `none`, `reinhard`, `sigmoid`, `agx`, `aces`. Each id's math
  is a forever contract (a sidecar must render the same forever): never
  change the formula under an existing id — add a new id instead.
- Each transform includes its own +1 EV pre-gain (darktable-style; the
  neutral decode sits ~1.4 EV under LR's default). `none` has no gain.
- Presets carry it automatically (it lives in `profile`, which travels with
  the `basic-tone` family), so "looks via presets" works without new plumbing.
- LR Like (the A7C2 LR-fitted curve) is NOT offered as a base tone.
- A base tone stacked on a tone-carrying DCP profile applies tone twice. It
  is allowed (a deliberate stack is legal) but never silent: the Inspector
  shows a hint while `source` is 'dcp', the baked DCP has a
  ProfileToneCurve, and the base tone is not 'none'. Nothing is auto-changed.

## 落選案と落選理由

- **Keep the LR-fitted default (A7C2 seed / acrlook).** Diminishing returns
  (base-1..10), not reachable for scene-adaptive cases, and LR-derived.
- **Default to a minimal DRT (e.g. sigmoid) instead of none.** Reasonable
  and still open as a setting later; the user chose neutral-first and wants
  the default to carry no taste at all.
- **Store DRT parameters (curve points / constants) instead of an id.**
  Curve points act in clamped display space and cannot roll off values above
  1.0; free parameters invite a tuning UI nobody asked for. Named ids keep
  the doc small and the math testable.
- **Offer LR Like as a base tone.** User: probably not needed. Old docs
  still render their stored seed points, so nothing depends on it.

## 影響・やり直す条件

- Fresh opens look darker and flatter than before (by design). Thumbnails /
  culling suffer; mitigation candidate: a "preset applied on open" setting
  (like LR's raw defaults) — not built yet.
- The 2026-09-02 slider-response calibration and auto-tone v2 were fit with
  the A7C2 seed after the tone stage; with no base tone their feel vs LR
  changes (`docs/tech-debt.md`).
- Old docs render unchanged (no `baseTone` key = none; their seeded points
  stay in toneCurve).
- Revisit if hand-testing shows the neutral default is unusable for culling
  even with presets.
