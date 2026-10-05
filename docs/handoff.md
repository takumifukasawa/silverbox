# handoff — 現在地

<!-- 最終更新は絶対日付で。session-handoff が更新し、session-catchup が最初に読む。
     長期タスクの機械可読な進行状態は .harness/state/ に置き、ここには人間向けの要約だけ書く。 -->

最終更新: 2026-10-05

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

0. 本線の作業に戻るときは `git switch wip/localtone-stage1`。ハーネスをそちらでも効かせたいなら先に `git merge main`（main 側の差分はハーネス導入のみ。`.gitignore` と `.claude/settings.json` は wip 側で未変更なので衝突しない見込み）。
1. **設計方針の決定**（ユーザー判断。下記）。これが 2〜4 を全部ゲートしている。
2. 判断材料として 5 シーンの 3 枚並べを作る: linear-raw | B-1（トーンカーブ + as-shot WB + カメラ行列のみ、Adobe の look なし）| 現行 acrlook。
3. 方針に従って `seedDefaultLook` が `toneCurve` に書く初期値を決める（base curve と調整用トーンカーブは同じフィールド `developNode.ts` の `toneCurve`）。acrlook の base curve refit（base-5r の Curve A/B）は B を選ぶと不要になりうる。
4. localtone の `wip/localtone-stage1` → main マージ判断（比較ページの再目視が前提）。

## 未確定事項（人間の判断待ち）

- **デフォルト描画の方針**（ユーザーは B に傾いているが未確定）
  - A: LR の Adobe Color デフォルトを追い続ける（base-1..10 で収穫逓減が確定）
  - B: 自前の素直なニュートラルデフォルト。look はすべて手動。demosaic・as-shot WB・カメラ行列・素のトーンカーブは「補正」なので残す
  - C: B + 既存の acrlook を「Lightroom に合わせる」オプトインモードとして残す（B を選べばほぼタダで付く）
- look-extraction stage 2 の GO/NO-GO。
- GO 待ちのブリーフ: store-split リファクタ、grain-quality。linked-looks は設計のみ（明示 GO まで実装しない）。

## このセッションで触らなかったが確認したもの

- 個人パスのルール: テスト写真は gitignore 済みの `test-assets/` シンボリックリンクか `SILVERBOX_TEST_*` 環境変数経由のみ。pre-commit の `no personal paths staged` 検査が機械的に止める（非公開フォルダ名は gitignore 済みの `.harness/private-patterns.local` に置く）。
