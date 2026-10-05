---
name: session-catchup
description: ハーネス導入済みプロジェクトでセッションを始めるとき、docs/README.md（索引）→ docs/handoff.md（現在地）→ VCS 実態 の順に安く読み、現在地のブリーフィングを返す。発火例 - "現状を教えて", "前回の続きから", "キャッチアップして", "catch me up", "resume where we left off", セッション冒頭で作業を頼まれた時。全 doc を頭から読まない。
---

# session-catchup — 索引 → handoff → VCS 照合

## 手順

1. **索引だけ読む**: `docs/README.md`。開くべき doc を決める。ここで本文を読み始めない。
2. **現在地を読む**: `docs/handoff.md`。`最終更新` の日付と `NEXT` を拾う。`.harness/state/` があれば `progress.json` の未確定事項も見る。
3. **実態と照合する**: `git log --oneline -20`、`git status --short`。handoff の記述より新しいコミットがあれば、handoff は古い。未追跡ファイルに doc があれば「未コミットの正史」として報告する。
4. **規律を拾う**: 触る予定のディレクトリに `AGENTS.md` があれば読む（`docs/rules/README.md` に一覧）。
5. **ハーネスの健康**: `harness status` が使えれば実行し、managed ファイルの drift を報告に含める。

## 出力（ブリーフィング。読んだファイルの要約リストではない）

1. いま何をしているプロジェクトか（1〜2 行）
2. 状態表（`項目 | 状態 | 出典`。状態は曖昧さのない語で）
3. NEXT 候補（依存順・順序制約つき）
4. 行動を変えるルール（AGENTS.md・規律・learnings 由来）
5. docs と実態のズレ・不明点

各項目に出典パスを添える。長文引用はしない。
