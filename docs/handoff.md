# handoff — 現在地

<!-- 最終更新は絶対日付で。session-handoff が更新し、session-catchup が最初に読む。
     長期タスクの機械可読な進行状態は .harness/state/ に置き、ここには人間向けの要約だけ書く。 -->

最終更新: 2026-10-07

## いま何をしているか（1〜3 行）

agent-harness を導入して main に push した（`14b1845`）。このセッションは main で終わっている。
開発の本線は 2026-09-04 から止まっており、再開点は「RAW を開いた時のデフォルト描画をどうするか」という設計方針の決定（下の「未確定事項」）。
本線の作業ブランチは `wip/localtone-stage1`（main より 27 コミット先行。base-match の調査記録もそちらにある。ハーネスはまだ入っていない）。

## 状態

| 項目 | 状態 | 出典 |
|---|---|---|
| localtone stage 1e-r（LLF ベースの局所トーン） | 検証済み・main 未マージ | `wip/localtone-stage1`（`caaca8e`）、`npm run verify:localtone` |
| base-match（LR デフォルト描画への自動一致） | base-10 で打ち止め。bridge の彩度と sunset の色は自動一致の到達限界として記録 | `wip/localtone-stage1` の `docs/research/lr-base-gap.md` |
| acrlook プロファイルモード（Adobe Color LookTable 再実装） | 実装済み・自動デフォルト化は conductor hold で無効 | `wip/localtone-stage1` の `appStore.ts`（seedDefaultLook 周辺） |
| auto-tone v2 | 検証済み・park（ユーザーは「多少雑でもいい」） | `718bbe1`, `d011f05` |
| look-extraction stage 2 | blocked（stage 1 の Italy 参照での目視 OK 待ち） | `docs/brief-bank/look-extraction-mode2-stage2.md` |
| agent-harness | 導入済み | `bash .harness/bin/harness doctor` / `check` |

## NEXT（依存順。順序制約があれば明記）

- **2026-10-06 追加**: レイヤ構造を決定（暫定）— ベーストーンを独立段にし、ユーザーのトーンカーブは常に平らから始める（`docs/decisions/0001-base-tone-separate-stage.md`、LR / Resolve と同じ分け方）。計画は `docs/plans/active/base-tone-stage.md`（最終 GO 待ち。フェーズ 1 は見た目を変えないリファクタなので、下の A/B/C とは独立に進められる）。

0. 本線の作業に戻るときは `git switch wip/localtone-stage1`。ハーネスをそちらでも効かせたいなら先に `git merge main`（main 側の差分はハーネス導入のみ。`.gitignore` と `.claude/settings.json` は wip 側で未変更なので衝突しない見込み）。
1. **設計方針の決定**（ユーザー判断。下記）。これが 2〜4 を全部ゲートしている。
2. ~~判断材料として 5 シーンの 3 枚並べを作る~~ **済（2026-10-05）**: `test-artifacts/default-look-compare-2026-10-05.html`（gitignore。再生成は sidecar 3 種を CLI `--render` で描く。構成は下の「比較結果」）。
3. 方針に従って `seedDefaultLook` が `toneCurve` に書く初期値を決める（base curve と調整用トーンカーブは同じフィールド `developNode.ts` の `toneCurve`）。acrlook の base curve refit（base-5r の Curve A/B）は B を選ぶと不要になりうる。
4. localtone の `wip/localtone-stage1` → main マージ判断（比較ページの再目視が前提）。

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

- **デフォルト描画の方針**（ユーザーは B に傾いているが未確定）
  - A: LR の Adobe Color デフォルトを追い続ける（base-1..10 で収穫逓減が確定）
  - B: 自前の素直なニュートラルデフォルト。look はすべて手動。demosaic・as-shot WB・カメラ行列・素のトーンカーブは「補正」なので残す
  - C: B + 既存の acrlook を「Lightroom に合わせる」オプトインモードとして残す（B を選べばほぼタダで付く）
- look-extraction stage 2 の GO/NO-GO。
- GO 待ちのブリーフ: store-split リファクタ、grain-quality。linked-looks は設計のみ（明示 GO まで実装しない）。

## このセッションで触らなかったが確認したもの

- 個人パスのルール: テスト写真は gitignore 済みの `test-assets/` シンボリックリンクか `SILVERBOX_TEST_*` 環境変数経由のみ。pre-commit の `no personal paths staged` 検査が機械的に止める（非公開フォルダ名は gitignore 済みの `.harness/private-patterns.local` に置く）。
