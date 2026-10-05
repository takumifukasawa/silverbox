---
name: harness-maintain
description: agent-harness を導入したプロジェクトで、ハーネス自身を扱うときの手順。ハーネスの更新（harness update）、ハーネス管理ファイルを直したときの上流への戻し方（harness diff / upstream）、docs/learnings.md からプロジェクト非依存の学びを共通ルール・スキル・検査へ昇格させる判断、docs の腐敗掃除（harness gc）。発火例 - "ハーネスを更新して", "このルールを全プロジェクトに反映したい", "learnings をハーネスに昇格", "harness gc して", "ハーネスの drift を直して"。
---

# harness-maintain — ハーネスを育てる

ハーネスは「効くのに勝手には育たない」。育てる経路は 3 つ。どれも**最後の判断は人間**。

## A. ハーネスの更新を取り込む

1. `harness status` で現在の版・drift を確認。
2. `harness update`。CHANGELOG の「プロジェクト側で必要な作業」を読み、指示に従う。
3. `.harness/conflicts/*.new` が出たら、差分を見て「新版を採る / 自分の改変を残す（→ C で上流へ）」を決める。
4. `harness check` を回して壊れていないことを確認。

## B. learnings を昇格させる

`docs/learnings.md` の `[harness候補]` を見て、プロジェクトを跨いで真かを問う。真なら昇格先を**この優先順位**で選ぶ:

1. **検査（computational）**: `harness/scripts/check.sh` の項目や git hook にできるなら、それが最も確実。文章で注意させるより二度と起きない。
2. **スキル**: 手順として再現できるなら SKILL.md。
3. **AGENTS.core.md の文章**: 上 2 つにできないものだけ。常時ロードされるので短く。

昇格させたら learnings の行に「→ harness vX.Y.Z へ昇格」と書き、行自体は残す。

## C. 直した managed ファイルを上流へ戻す

1. `harness diff` で改変一覧を見る。
2. 改変が**このプロジェクト固有**なら、managed ファイルを直すのではなく AGENTS.md のプロジェクト領域や seed ファイルへ移す。
3. 汎用なら `harness upstream <path>`。秘密情報・個人情報・プロジェクト名が混ざっていないか確認する（共有物になる）。
4. agent-harness リポジトリ側で: レビュー → commit → `CHANGELOG.md` に「プロジェクト側で必要な作業」→ `VERSION` を上げる。
5. 他プロジェクトでは A の手順で取り込む。

## D. 腐敗の掃除（gc）

`harness gc` の出力（handoff の鮮度、as-of 日付の化石、索引と実体の食い違い、drift、放置された state）を見て、直すか捨てるかを決める。古い doc は全部直す対象ではない。役割を終えた doc は「現状の正がどこか」だけ明示して残す。
