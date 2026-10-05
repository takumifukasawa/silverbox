# learnings — 踏んだ罠と対処

<!-- 書くのは「コードや git log から導出できないこと」だけ。
     形式は「症状 → 原因 → 対処（再発したらまず X を見る）」。日付は絶対日付。
     プロジェクト非依存のものには [harness候補] を付ける。harness-maintain が昇格を検討する。
     昇格先の優先順位: 検査スクリプト（check.sh）> スキル > AGENTS.core.md の文章 -->

## YYYY-MM-DD 例: タイトル
- 症状:
- 原因:
- 対処 / 再発したら:

## 2026-10-05 harness gc が数式を「リンク切れ」と報告する [harness候補]
- 症状: `harness gc` が local-adaptive-tone.md の座標表記（x0,y0 など）を対象にしたリンク切れ WARN を 8 件出す。
- 原因: 角括弧の直後に丸括弧が続く数式が、Markdown リンクの正規表現に一致している。
- 対処 / 再発したら: 実害なし。リンク先が座標・変数名ならこの誤検知。上流の gc.sh でコードスパン / 数式を除外するか、ターゲットに空白・カンマを含むものを除外するのが筋。

## 2026-10-05 harness init が既存の implementer エージェントと衝突する
- 症状: `harness init` が `.claude/agents/implementer.md` を CONFLICT にし、新版を `.harness/conflicts/` に置く。
- 原因: Silverbox は導入前から独自の implementer（エンジン不変条件・no-commit ルール入り）を持っている。
- 対処 / 再発したら: プロジェクト版を残す（ハーネス版の汎用 TDD 手順よりこちらが正）。`harness update` で再度 CONFLICT が出ても同じ判断でよい。

## 2026-10-05 個人パス検査のパターンはリポジトリに書けない
- 症状: 非公開フォルダ名を検査スクリプトに書くと、それ自体が漏洩になる。
- 原因: 検査対象と検査定義が同じリポジトリにある。
- 対処 / 再発したら: 汎用パターン（ホームディレクトリ配下の絶対パス等）だけ `scripts/check-no-personal-paths.sh` に置き、固有名は gitignore 済みの `.harness/private-patterns.local`（1 行 1 ERE）へ。別 PC では空なので、その PC で作り直す。
