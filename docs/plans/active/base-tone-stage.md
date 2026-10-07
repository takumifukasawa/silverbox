# Base tone as its own Develop stage

- 開始: 2026-10-06
- 状態: 進行中（2026-10-07 GO）
- 関連: docs/decisions/0001-base-tone-separate-stage.md, docs/decisions/0002-neutral-default-base-tone.md, COLOR.md "Default rendering", docs/brief-bank/dcp-profile.md "Layering decision", docs/sidecar-spec.md

## 目的（何ができれば完了か）

`develop.profile.baseTone` (decisions 0001 + 0002) exists as a named display
transform stage between the Basic tone stage and the user tone curve; a fresh
RAW open is neutral (baseTone none, profile amount 0, identity curve); the
user can pick a base tone in the Inspector and presets carry it.

## 受け入れ条件（検査で確認できる形に）

- [x] `harness check` passes; `npm run verify` has no NEW failures vs the
      2026-10-07 baseline (`test-artifacts/logs/verify-baseline-2026-10-07.log`);
      scripts that asserted the old seeded look are updated to the new default
      with the reason in their own comments.
- [x] Unit tests: each base tone's WGSL and CPU mirror agree; `none` emits no
      pass; values above 1.0 roll off (not clamp) for every non-none id.
- [x] Old docs (no `baseTone` key) sanitize to 'none' and render unchanged.
- [x] Unknown `baseTone` string sanitizes quietly to 'none' (sidecar-spec rule 7).
- [x] Fresh RAW open: profile.amount 0, baseTone 'none', toneCurve identity,
      sharpen 40 / color NR 25 / lens profile kept.
- [x] Inspector shows a base-tone selector; preset save/apply with the
      basic-tone family round-trips it.
- [x] sidecar-spec.md + COLOR.md "Default rendering" describe the new model.

## タスク分解（依存順）

| # | タスク | 状態 | 備考 |
|---|---|---|---|
| 1 | Schema: `profile.baseTone` enum, default 'none', sanitize post-pass | 済 | developNode.ts / graphDoc.ts |
| 2 | Engine: BASETONE pass (WGSL) + CPU mirror, after tone, before toneCurve; formulas from `scripts/drt-compare/drts.mjs` | 済 | unit tests |
| 3 | Store: seedDefaultLook seeds neutral (no profile amount, no curve) | 済 | keeps old-doc juggling paths |
| 4 | UI: base-tone selector in the Inspector profile area | 済（手触りの確認待ち） | UX → pause for user hand-test |
| 5 | Verify: update scripts that pinned the old seed; full suite vs baseline | 済 | basecurve / profilefit / dcp-doubletone rewritten; suite 78/78 vs baseline 77/77 |
| 6 | Docs: sidecar-spec.md, COLOR.md, tech-debt (slider calibration / auto-tone fit against old seed) | 済 | |

## 決定ログ（日付・決めたこと・理由・落選案）

- 2026-10-06: layering decided (decision 0001).
- 2026-10-07: GO. Content decided (decision 0002): neutral fresh open, named
  DRT ids (none/reinhard/sigmoid/agx/aces), LR Like not shipped. Field lives
  in `profile` so presets/diff/linked-looks pick it up via the basic-tone family.

## 進捗ログ（セッションごとに 1〜3 行）

- 2026-10-06: plan written; nothing implemented.
- 2026-10-07: output-DRT candidates rendered for the base-tone CONTENT question
  (`scripts/drt-compare/`, custom-shader node after a neutral Develop; +1 EV
  pre-gain; 5 Italy scenes). Mean vs LR (Δ EV / saturation ratio): none −1.39/0.37,
  Reinhard −0.57/0.63, Sigmoid −0.82/0.70, AgX −0.21/0.66, ACES −1.31/0.58,
  LR Like (A7C2, 旧称 B-1) −0.23/0.80. Facts found: custom nodes DO receive values >1.0
  (headroom capped by sensor saturation ≈1.41 = baseline +0.5 EV, no 1.0 clamp);
  so presets must set the base-tone STAGE, not just toneCurve, to get roll-off.

- 2026-10-07: tasks 1-4 + 6 implemented (baseTone.ts engine + CPU mirror, sanitize,
  neutral seedDefaultLook, Inspector select, setDevelopBaseTone action, diffLook
  line, verify-basetone 20/20, unit 379 incl. 22 new). Removed dead acrlook
  auto-default plumbing (acrLookAvailableSync). Undo: base-tone picks never
  coalesce (found by verify-basetone).

- 2026-10-07: final review (3 reviewers: spec / completeness / compat+engine).
  Fixed: DCP-with-tone-curve + base tone double-tone now shows an Inspector
  hint (dcpHasToneCurve state, verify-dcp-doubletone 1C); preset-family and
  old-doc-compile unit tests; Inf/NaN guard (input clamp 65504, both sides);
  sidecar-spec forward-compat caveat; orphaned Inspector comment. Accepted,
  not fixed: auto-tone ignores the base tone (tech-debt #1, needs a refit).

- 2026-10-07: keep/strength comparison artifact "ベーストーン候補" (claude.ai
  artifact 4QN3YMNCffZQ13Vwo2vx3s; `scripts/drt-compare/run-variants.mjs`):
  5 shipped ids via the real engine (matches the custom-shader renders within
  ~1-2/255) + Sigmoid soft (c 1.2) / strong (c 1.9) + AgX Punchy (Blender look).

## 決定ログ追記

- 2026-10-07: No render-identical migration for old docs whose toneCurve
  equals the old seed. Old docs keep rendering as stored (user: 「作らないでok」).

## 未確定事項（人間の判断待ち）

- "Preset applied on open" setting (LR raw-defaults style) to soften the
  neutral default for culling — not in this plan's scope yet.
- Which base tones to keep long-term after hand-testing (reinhard / sigmoid /
  agx / aces); strength variants if wanted.
