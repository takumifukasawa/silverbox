# handoff — 現在地

<!-- 最終更新は絶対日付で。session-handoff が更新し、session-catchup が最初に読む。
     長期タスクの機械可読な進行状態は .harness/state/ に置き、ここには人間向けの要約だけ書く。 -->

最終更新: 2026-11-24

## いま何をしているか（1〜3 行）

`wip/localtone-stage1`（未 push）で、ベーストーンの仕上げと手触りフィードバックへの対応をしている。ベーストーン: None / Reinhard / Sigmoid（darktable 既定値準拠＋自前の色相保持）/ AgX / AgX Punchy / ACES。Inspector では Profile 直下の独立セクションにあり、ホバーでプレビューできる。2026-10-08 にスポイトのルーペとパネルのリサイズ（ノード欄の折りたたみ含む）を追加。
**いまはユーザーの手触り確認待ち**（UX の変更なので次の実装に進まない）。計画: `docs/plans/active/base-tone-stage.md`。

## 状態

| 項目 | 状態 | 出典 |
|---|---|---|
| ベーストーン（決定 0001 + 0002） | 実装済み・手触り確認待ち。auto tone はベーストーン越しに輝度を読む（tech-debt #1 の auto tone 部分は返済済み） | `docs/plans/active/base-tone-stage.md`、`npm run verify:basetone` |
| Adobe Color (local) | Source の選択肢から非表示（フラグで戻せる） | `docs/decisions/0003-hide-acrlook-source.md` |
| スポイトのルーペ（WB / ColorKey 共通） | 実装済み・手触り確認待ち | `src/renderer/ui/PixelLoupe.tsx`、`npm run verify:loupe` |
| パネルのリサイズ・ノード欄の折りたたみ | 実装済み・手触り確認待ち。サイズは settings.json の `panelLayout` に保存 | `src/renderer/ui/PanelSplitters.tsx`、`npm run verify:panels` |
| localtone stage 1e-r（LLF ベースの局所トーン） | 検証済み・main 未マージ | `wip/localtone-stage1`、`npm run verify:localtone` |
| base-match（LR デフォルト描画への自動一致） | 打ち止め（方針 B: 自前のニュートラル既定＋ベーストーン） | `docs/research/lr-base-gap.md` |
| agent-harness | 導入済み | `bash .harness/bin/harness doctor` / `check` |

## NEXT（依存順。順序制約があれば明記）

1. **ユーザーの手触り確認**: 2026-11-24 にベーストーンと auto tone は OK。ルーペの RGB 表示が拡大表示に被る件、ノード欄の折りたたみが分かりにくい件は `e74a46e` で修正済み → この 2 つの再確認待ち。
2. ベーストーンの計画を `docs/plans/completed/` へ移す（残す候補の確定後）。
3. localtone の `wip/localtone-stage1` → main マージ判断（マージするとベーストーンも一緒に入る）。
   2026-11-24 ユーザー合意: 手触り確認で致命的な問題が無ければ、ベーストーン候補の確定（2）を待たずにマージしてよい。候補の削減は main 上で別作業。つまり 3 は 2 に依存しない。
4. 保留: LR のパラメトリックトーンカーブ（範囲別スライダー）。ユーザーが欲しいと言うまで着手しない。

2026-11-24 ユーザー合意: 下の「未確定事項」はマージが済むまで全て保留。マージ後に優先順位を付け直す。

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

- 長期的に残すベーストーンの種類。
- 「開いたときに当てるプリセット」設定（LR の raw defaults 相当）を作るか。
- look-extraction stage 2 の GO/NO-GO。
- GO 待ちのブリーフ: store-split リファクタ、grain-quality。linked-looks は設計のみ（明示 GO まで実装しない）。

## このセッションで触らなかったが確認したもの

- 個人パスのルール: テスト写真は gitignore 済みの `test-assets/` シンボリックリンクか `SILVERBOX_TEST_*` 環境変数経由のみ。pre-commit の `no personal paths staged` 検査が機械的に止める（非公開フォルダ名は gitignore 済みの `.harness/private-patterns.local` に置く）。
