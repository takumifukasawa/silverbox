# Base tone as its own Develop stage

- 開始: 2026-10-06
- 状態: 計画中（ユーザーの最終 GO 待ち）
- 関連: docs/decisions/0001-base-tone-separate-stage.md, COLOR.md "Default rendering", docs/brief-bank/dcp-profile.md "Layering decision", docs/sidecar-spec.md

## 目的（何ができれば完了か）

A fresh RAW open renders exactly as today, but the base tone comes from a
named `develop.baseTone` stage and the user tone curve is flat in every
profile mode. Profile-source switching no longer edits the user's curve.

## 受け入れ条件（検査で確認できる形に）

- [ ] `harness check` passes; `npm run verify` suite green.
- [ ] Fresh-open render of the 5 Italy scenes is byte-identical (or within
      float noise) before/after, in builtin and acrlook modes
      (`verify:golden`, `verify:basecurve`, `verify:acrlook`).
- [ ] Every existing sidecar without `baseTone` renders unchanged
      (golden renders of restored docs).
- [ ] Fresh open: `toneCurve.rgb` is identity in all modes.
- [ ] Switching builtin ↔ acrlook ↔ DCP changes only `baseTone`; a
      user-edited curve is never touched (the `curvePointsEqual`
      flatten/swap paths are deleted).
- [ ] GPU (WGSL) and CPU-mirror paths agree (existing parity checks).
- [ ] sidecar-spec.md documents the field; `verify:sidecar-spec` round-trips it.

## タスク分解（依存順）

| # | タスク | 状態 | 備考 |
|---|---|---|---|
| 1 | Schema: `develop.baseTone` (stored points or id — decide in task), sanitize default = none, sidecar-spec.md | 未着手 | absent = none keeps old docs identical |
| 2 | Engine: apply baseTone after tone stage, before user toneCurve; compose into the existing toneCurve LUT (base first, user on top) — WGSL + CPU mirror | 未着手 | no extra pass needed |
| 3 | Store: seedDefaultLook writes baseTone instead of toneCurve; source switching sets baseTone; delete curve flatten/swap juggling | 未着手 | appStore.ts `curvePointsEqual` sites |
| 4 | UI: show base tone as a named, removable setting (Basic/Profile area) | 未着手 | UX → pause for user hand-test |
| 5 | Verify: fresh-open identity, old-doc identity, switch-doesn't-touch-curve E2E | 未着手 | |
| 6 | COLOR.md "Default rendering" + DESIGN/ROADMAP sync | 未着手 | |

## 決定ログ（日付・決めたこと・理由・落選案）

- 2026-10-06: layering decided (decision 0001, provisional). Content of the
  base tone (A7C2 LR-fit vs generic tone mapper) deliberately out of scope
  — phase 1 keeps current curves.

## 進捗ログ（セッションごとに 1〜3 行）

- 2026-10-06: plan written; nothing implemented.
- 2026-10-07: output-DRT candidates rendered for the base-tone CONTENT question
  (`scripts/drt-compare/`, custom-shader node after a neutral Develop; +1 EV
  pre-gain; 5 Italy scenes). Mean vs LR (Δ EV / saturation ratio): none −1.39/0.37,
  Reinhard −0.57/0.63, Sigmoid −0.82/0.70, AgX −0.21/0.66, ACES −1.31/0.58,
  LR Like (A7C2, 旧称 B-1) −0.23/0.80. Facts found: custom nodes DO receive values >1.0
  (headroom capped by sensor saturation ≈1.41 = baseline +0.5 EV, no 1.0 clamp);
  so presets must set the base-tone STAGE, not just toneCurve, to get roll-off.

## 未確定事項（人間の判断待ち）

- Final GO on decision 0001 (user said "1 な気がする").
- Offer a render-identical migration for old docs whose toneCurve equals
  the old seed? (default: no — old docs just keep rendering as stored)
- User direction 2026-10-07: default base tone probably NONE (fully neutral),
  looks via presets; wants to compare DRT patterns first. Implies presets must
  be able to set `baseTone` (and a "preset applied on open" setting, like LR's
  raw defaults, is the proposed mitigation for dull thumbnails).
- User direction 2026-10-07 (tentative): the LR-fitted tone (comparison label
  "LR Like", = A7C2 curve) probably does NOT need to ship as a product option.
- What the base tone contains long-term (handoff A/B/C; B-2 = generic
  LR-independent tone mapper, not yet rendered for comparison).
