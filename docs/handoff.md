# handoff — 現在地

<!-- 最終更新は絶対日付で。session-handoff が更新し、session-catchup が最初に読む。
     長期タスクの機械可読な進行状態は .harness/state/ に置き、ここには人間向けの要約だけ書く。 -->

最終更新: 2026-11-24

## いま何をしているか（1〜3 行）

2026-11-24 に `wip/localtone-stage1` を main へマージした（localtone stage 1e-r、ベーストーン 6 種、スポイトのルーペ、パネルのリサイズ・ノード欄の折りたたみ）。手触り確認はすべて OK。ベーストーンの計画は `docs/plans/completed/base-tone-stage.md`。
**次はマージ後の優先順位付け**（下の「未確定事項」から選ぶ。ユーザーの判断待ち）。

## 状態

| 項目 | 状態 | 出典 |
|---|---|---|
| ベーストーン（決定 0001 + 0002） | main 済み。None / Reinhard / Sigmoid / AgX / AgX Punchy / ACES の 6 種すべて残す（2026-11-24 ユーザー決定） | `docs/plans/completed/base-tone-stage.md`、`npm run verify:basetone` |
| Adobe Color (local) | Source の選択肢から非表示（フラグで戻せる） | `docs/decisions/0003-hide-acrlook-source.md` |
| スポイトのルーペ（WB / ColorKey 共通） | main 済み・手触り OK | `src/renderer/ui/PixelLoupe.tsx`、`npm run verify:loupe` |
| パネルのリサイズ・ノード欄の折りたたみ | main 済み・手触り OK。サイズは settings.json の `panelLayout` に保存 | `src/renderer/ui/PanelSplitters.tsx`、`npm run verify:panels` |
| localtone stage 1e-r（LLF ベースの局所トーン） | main 済み | `npm run verify:localtone` |
| base-match（LR デフォルト描画への自動一致） | 打ち止め（方針 B: 自前のニュートラル既定＋ベーストーン） | `docs/research/lr-base-gap.md` |
| agent-harness | 導入済み | `bash .harness/bin/harness doctor` / `check` |

## NEXT（依存順。順序制約があれば明記）

1. 下の「未確定事項」の優先順位をユーザーと決める（2026-11-24 合意: マージまで保留していたもの）。
2. 保留: LR のパラメトリックトーンカーブ（範囲別スライダー）。ユーザーが欲しいと言うまで着手しない。

## 比較結果（2026-10-05、判断材料）

共通条件: as-shot WB・カメラ行列・レンズ補正 ON・シャープ 40/色NR 25。LR 基準は `test-artifacts/localtone-compare-assets/full/*_base_lr.jpg`。Δ = LR との輝度中央値差（stops）、彩度× = 粗い彩度指標の LR 比。

| scene | linear-raw Δ / 彩度× | LR Like (profile 0 + A7C2 curve; 旧称 B-1) | acrlook (100 + ACRLOOK curve) |
|---|---|---|---|
| DSC03298 | −1.66 / 0.38 | −0.46 / 0.96 | −0.10 / 0.85 |
| DSC04260 | −1.60 / 0.40 | −0.32 / 0.84 | −0.39 / 0.79 |
| DSC06787 | −1.42 / 0.47 | −0.33 / 0.78 | −0.51 / 0.64 |
| DSC07349 | −0.66 / 0.30 | +0.46 / 0.70 | +0.37 / 0.60 |
| DSC09305 | −1.61 / 0.31 | −0.49 / 0.74 | −0.62 / 0.61 |

読み: Adobe の look を入れない LR Like が、輝度・彩度とも acrlook と同等かそれ以上に LR に近い（彩度は 5/5 で LR Like が上）。acrlook の追加価値はこの 5 シーンでは見えない。sunset（DSC07349）の LR の青緑はどの案でも出ない。注意: acrlook の輝度差はここでは平均 −0.25 で、base-2 報告の「−0.03」とずれる（指標とマスクの違いか未調査）。

## 未確定事項（人間の判断待ち）

- 「開いたときに当てるプリセット」設定（LR の raw defaults 相当）を作るか。2026-11-24 に次の 1 本として合意。設計の問い（共通 1 つか機種別か、未編集の写真の追従、Reset の戻り先、CLI、サムネイルなど）をユーザーに出し、回答待ち。
- CSS フレームワークの導入（2026-11-25 ユーザー: 良さそうなら使ってよい、後のタスクでよい）。今は `src/renderer/styles.css` 1 枚の手書き。導入するか・どれにするかは未検討。
- look-extraction stage 2 の GO/NO-GO。
- GO 待ちのブリーフ: store-split リファクタ、grain-quality。linked-looks は設計のみ（明示 GO まで実装しない）。

## このセッションで触らなかったが確認したもの

- 個人パスのルール: テスト写真は gitignore 済みの `test-assets/` シンボリックリンクか `SILVERBOX_TEST_*` 環境変数経由のみ。pre-commit の `no personal paths staged` 検査が機械的に止める（非公開フォルダ名は gitignore 済みの `.harness/private-patterns.local` に置く）。
