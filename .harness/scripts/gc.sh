#!/usr/bin/env bash
# harness gc — docs の腐敗を機械的に検知して一覧にする（判断と修正はしない。LLM も使わない）。
#
# 使い方:  bash .harness/scripts/gc.sh [--days N] [--commits N] [--strict]
#   --days N     鮮度の閾値（既定 14 日）
#   --commits N  handoff 以降 docs 以外を触ったコミットがこの件数以上なら報告する（既定 10）
#   --strict     1 件でも見つかれば exit 1（CI 用）。既定は常に exit 0
#
# 見るもの:
#   1. docs/handoff.md の「最終更新:」が無い / 雛形のまま / N 日より古い。
#      加えて、最後に handoff.md を触ったコミットより後に docs 以外を触ったコミットが N 件
#      あれば別途報告する（同じ日に何コミットしても日数だけでは古いと判定できないため。
#      spec: docs/spec/writeback-sensors.md 節 A）
#   2. docs/README.md（索引）にリンクされた doc が存在しない
#   3. docs/ 直下の .md が索引に無い
#   4. docs/**/*.md の相対リンク切れ
#   5. docs/plans/active/ の計画が N 日更新されていない（git の最終コミット日で判定）
#   6. docs/tech-debt.md に「未着手」が残っている
#   7. .harness/state/progress.json の updated_at が N 日より古い（放置された state）
#   8. harness status の MODIFIED（管理ファイルの drift）
#   9. docs/references/ の取得日が N*6 日（約 3 か月）より古い
#  10. docs/plans/active/ の計画で、タスク表と状態欄が矛盾している
#      （a) タスク表の行がすべて done なのに状態欄が「完了」でも作業継続中（〜中）でもない
#       (b) 状態欄が「完了」で始まる（部分文字列一致ではない）のに active/ のまま）
#  11. docs/spec/*.md の「状態:」行が、対応する計画（docs/plans/）の状態と食い違っている
#      （対応は計画側にある「spec/<ファイル名>」という参照文字列で取る。対応が取れない spec は
#       警告しない。計画側の完了判定は状態欄の文字列ではなく active/・completed/ の置き場所で見る）
#  12. docs/plans/active/ の計画を最後に更新したコミットより後で、docs/handoff.md が
#      更新されていない（統括が計画を進めたのに handoff の書き戻しを忘れている。
#      spec: docs/spec/handoff-writeback.md）。日数やコミット数の閾値は使わない
#      （同じ日・1 コミットの漏れでも、git のコミット祖先関係だけで捕まえる）
#  13. docs/spec/*.md が spec の索引（docs/spec/README.md の表）に無い（決定 0010 参照。
#      2026-09-28、「新しく作った案内を索引に書き戻し忘れる」を 2 回踏んだので 1 項目だけ
#      再開した）。docs/spec/README.md 自身は対象外。docs/spec/README.md が無い、または
#      表の体をなしていない（区切り行 `|---|` が無い）プロジェクトでは何も言わない
#      （配布先が spec を表形式の索引で持つとは限らない。項目 3 と作法を揃える）
set -u

DAYS=14; STRICT=0; COMMITS=10; handoff_anchor=""
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2;;
    --commits) COMMITS="$2"; shift 2;;
    --strict) STRICT=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 2
DOCS="docs"
[ -d "$DOCS" ] || { echo "gc: docs/ が無い。harness init で seed される。"; exit 2; }

n=0
report() { # severity message hint
  n=$((n + 1))
  printf '%-5s %s\n      → %s\n' "$1" "$2" "$3"
}

today_epoch=$(date +%s)

# YYYY-MM-DD を epoch 秒（その日の 0 時）にする。date の方言は 2 系統あり、どちらか一方しか通らない:
#   GNU coreutils … date -d "2026-09-01" +%s
#   BSD / macOS   … date -j -f '%Y-%m-%d %H:%M:%S' "2026-09-01 00:00:00" +%s
# 以前は GNU 形式だけを試し、失敗を `|| return 1` で握り潰していた。その結果 macOS では
# **日付に依存する判定（handoff の鮮度・計画の放置日数・state・references）が全部無言で飛び**、
# gc が「問題なし」と報告していた（2026-09-20 に実測。tech-debt #8）。両方言に対応したうえで、
# それでも読めなかった日付は下の集計で必ず報告する（黙って飛ばすのが最大の害だった）。
date_to_epoch() { # YYYY-MM-DD -> epoch 秒
  date -d "$1" +%s 2>/dev/null && return 0
  date -j -f '%Y-%m-%d %H:%M:%S' "$1 00:00:00" +%s 2>/dev/null && return 0
  return 1
}

# 読めなかった日付の控えはファイルに貯める。days_since は `d=$(days_since ...)` と
# コマンド置換（= 別プロセス）で呼ばれるので、変数に貯めても呼び出し元には残らない。
UNPARSED_FILE="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/harness-gc-unparsed.$$")"
: >"$UNPARSED_FILE"

# spec/計画の対応表（節 11 で 1 回だけ作る。build_spec_plan_table() 参照）。
SPEC_PLAN_TABLE="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/harness-gc-specplan.$$")"
: >"$SPEC_PLAN_TABLE"

trap 'rm -f "$UNPARSED_FILE" "$SPEC_PLAN_TABLE"' EXIT INT TERM

days_since() { # YYYY-MM-DD -> days（読めなければ非ゼロで返し、読めなかった日付を控える）
  local e
  e=$(date_to_epoch "$1") || { printf '%s\n' "$1" >>"$UNPARSED_FILE"; return 1; }
  echo $(( (today_epoch - e) / 86400 ))
}

# 1. handoff の鮮度
if [ -f "$DOCS/handoff.md" ]; then
  upd_raw=$(sed -n 's/^最終更新: *//p' "$DOCS/handoff.md" | head -1 | tr -d '\r')
  # 「最終更新: 2026-09-20（題材 …）」のように日付の後ろへ一言添える書き方が実際にある。
  # 行の残り全部を日付として扱うと、正しく書かれた handoff に「読めない日付」の警告が出る。
  upd=$(printf '%s' "$upd_raw" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  [ -z "$upd" ] && upd="$upd_raw"
  if [ -z "$upd" ]; then
    report WARN "docs/handoff.md に「最終更新:」の行が無い" "session-handoff の手順で日付を書く"
  elif [ "$upd" = "YYYY-MM-DD" ]; then
    report WARN "docs/handoff.md が雛形のまま（最終更新: YYYY-MM-DD）" "session-handoff で現在地を書く"
  else
    d=$(days_since "$upd") && [ "$d" -gt "$DAYS" ] && report WARN "docs/handoff.md の最終更新が ${d} 日前（${upd}）" "現在地が古い。session-handoff で更新するか、休止中なら明記する"
  fi

  # 1b. handoff の鮮度（コミット数）。日数とは独立に判定する（A4）: 同じ日に何コミットしても
  # 日数ベースでは古いと判定できない（実際に 10 コミット取り逃した。tech-debt / spec
  # writeback-sensors 節 A）。docs/handoff.md を最後に触ったコミットより後を数え、docs/ だけを
  # 触ったコミットは除く（A3。handoff を直すたびに次の警告が積まれるのを防ぐ）。
  # git 呼び出しは 1 回（git log --name-only）に抑える。コミットごとに diff-tree を呼ぶと
  # コミット数が多いリポジトリで遅くなり、gc が誰にも回されなくなる（1 秒で終わる現状を壊さない）。
  # core.quotePath=false を明示する: git は既定（true）だとパスに ASCII 範囲外のバイトが
  # 含まれる行をダブルクォート+8進エスケープで囲む（例: docs/日本語メモ.md ->
  # "docs/\346\227\245..."）。行が `"` から始まると下の case の docs/* にマッチせず、
  # 非 ASCII ファイル名の doc だけを触ったコミットが「docs 以外を触った」に誤分類される
  # （A3 が非 ASCII ファイル名で成立しない。最終レビュー指摘。回帰: tests/gc.sh G25）。
  handoff_anchor=$(git log -1 --format=%H -- "$DOCS/handoff.md" 2>/dev/null)
  if [ -n "$handoff_anchor" ]; then
    non_docs_since=0; in_commit=0; cur_non_docs=0
    while IFS= read -r line; do
      case "$line" in
        __gc_commit__*)
          [ "$in_commit" = 1 ] && [ "$cur_non_docs" = 1 ] && non_docs_since=$((non_docs_since + 1))
          in_commit=1; cur_non_docs=0
          ;;
        docs/*|"") ;;
        *) cur_non_docs=1 ;;
      esac
    done < <(git -c core.quotePath=false log --format='__gc_commit__%H' --name-only "${handoff_anchor}..HEAD" 2>/dev/null)
    [ "$in_commit" = 1 ] && [ "$cur_non_docs" = 1 ] && non_docs_since=$((non_docs_since + 1))
    [ "$non_docs_since" -ge "$COMMITS" ] && report WARN \
      "docs/handoff.md の最終更新から docs 以外を触ったコミットが ${non_docs_since} 件進んでいる（閾値 ${COMMITS}）" \
      "session-handoff で現在地を書く（同じ日でも積み上がったコミット数で古さを見ている）"
  fi
  # handoff_anchor が空（まだ一度もコミットされていない、または git リポジトリでない）ときは、
  # 「〜以降」を数える起点が無いのでこの判定は黙ってスキップする（誤検知よりは沈黙を選ぶ。
  # 日数ベースの判定は上で別途効いている）。
else
  report ERR "docs/handoff.md が無い" "docs-template/handoff.md から作る"
fi

# 2. 索引のリンク先が存在するか
if [ -f "$DOCS/README.md" ]; then
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    case "$link" in http*|\#*) continue;; esac
    target="$DOCS/${link%%#*}"
    [ -e "$target" ] || report ERR "索引 docs/README.md のリンク先が無い: $link" "doc を作るか、索引の行を消す"
  done < <(grep -oE '\]\(([^)]+)\)' "$DOCS/README.md" | sed -E 's/^\]\((.*)\)$/\1/')
  # 3. 索引に無い doc（docs 直下の .md と、サブディレクトリの README 以外の .md）
  while IFS= read -r f; do
    rel="${f#"$DOCS"/}"
    [ "$rel" = "README.md" ] && continue
    case "$rel" in plans/active/*|plans/completed/*|decisions/*|references/*|roles/*|spec/*|rules/*) continue;; esac  # 各ディレクトリの索引が持つ
    grep -qF "($rel" "$DOCS/README.md" || report WARN "docs/$rel が索引に無い" "docs/README.md に行を足す（索引に無い doc は存在しないものとして扱われる）"
  done < <(find "$DOCS" -maxdepth 1 -name '*.md' | sort)
else
  report ERR "docs/README.md（索引）が無い" "docs-template/README.md から作る"
fi

# 4. docs 内の相対リンク切れ
while IFS= read -r f; do
  dir="$(dirname "$f")"
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    case "$link" in http*|mailto:*|\#*) continue;; esac
    t="${link%%#*}"; [ -z "$t" ] && continue
    [ -e "$dir/$t" ] || report WARN "リンク切れ: $f → $link" "リンク先を直すか、移動先を書く"
  done < <(grep -oE '\]\(([^) ]+)\)' "$f" | sed -E 's/^\]\((.*)\)$/\1/')
done < <(find "$DOCS" -name '*.md' | sort)

# 5. 放置された計画
if [ -d "$DOCS/plans/active" ]; then
  while IFS= read -r f; do
    last=$(git log -1 --format=%cs -- "$f" 2>/dev/null)
    [ -z "$last" ] && { report WARN "計画 $f が未コミット" "コミットする（git から辿れて初めて次のセッションの事実になる）"; continue; }
    d=$(days_since "$last") && [ "$d" -gt "$DAYS" ] && report WARN "計画 $f が ${d} 日更新されていない（最終コミット ${last}）" "進めるか、completed/ へ移すか、handoff に休止と書く"
  done < <(find "$DOCS/plans/active" -name '*.md' | sort)
fi

# 6. 負債の放置
if [ -f "$DOCS/tech-debt.md" ]; then
  c=$(grep -c '未着手' "$DOCS/tech-debt.md" || true)
  # 雛形の例示行（"例:" を含む）は数えない
  ex=$(grep '未着手' "$DOCS/tech-debt.md" | grep -c '例:' || true)
  c=$((c - ex))
  [ "$c" -gt 0 ] && report INFO "docs/tech-debt.md に未着手の負債が ${c} 件" "小さく継続的に返す。放置するなら理由を書く"
fi

# 7. 放置された state
if [ -f ".harness/state/progress.json" ]; then
  upd=$(sed -n 's/.*"updated_at": *"\([^"]*\)".*/\1/p' .harness/state/progress.json | head -1)
  if [ -n "$upd" ] && [ "$upd" != "YYYY-MM-DD" ]; then
    d=$(days_since "$upd") && [ "$d" -gt "$DAYS" ] && report WARN ".harness/state/progress.json が ${d} 日更新されていない" "進めるか、確定事項を docs に書き戻して state を捨てる"
  fi
fi

# 8. 管理ファイルの drift
if [ -f ".harness/bin/harness" ]; then
  mod=$(bash .harness/bin/harness status 2>/dev/null | grep -cE '^  (managed|merge|generated) +MODIFIED' || true)
  [ "$mod" -gt 0 ] && report WARN "ハーネス管理ファイルの手変更が ${mod} 件（harness status）" "harness diff で見て、汎用なら upstream、固有なら AGENTS.md のプロジェクト領域へ"
fi

# 9. 古い外部知識
if [ -f "$DOCS/references/README.md" ]; then
  while IFS= read -r dt; do
    d=$(days_since "$dt") && [ "$d" -gt $((DAYS * 6)) ] && report INFO "docs/references/ に取得から ${d} 日経った知識がある（${dt}）" "元を見直すか、腐っていないか確認する"
  done < <(grep -oE '\| *[0-9]{4}-[0-9]{2}-[0-9]{2} *\|' "$DOCS/references/README.md" | tr -d '| ')
fi

# 10. 計画のタスク表と状態欄の矛盾（統括自身の書き戻し漏れを機械で見る。spec no-silent-failures C）
#     見るのは合意済みの 2 つだけ（C3: 表記揺れでは警告しない。広げない）:
#       (a) タスク表の行がすべて `done` なのに、状態欄が「完了」になっていない（＝書き戻し忘れ）
#       (b) 状態欄が「完了」なのに active/ に置かれたまま（＝畳み忘れ）
plan_state_value() { # <file> -> 「- 状態:」行の値（1 行。無ければ空）
  sed -n 's/^- *状態: *//p' "$1" | head -1
}

plan_state_core() { # <state> -> 装飾（**強調**）と括弧の注記を落とした中核語だけ
  # 先に括弧の注記を落としてから前後の空白・強調記号を剥がす。逆順だと「**レビュー中**（…）」の
  # ように強調の閉じ ** が括弧の手前に来る書き方で、末尾の ** が剥がれずに残ってしまう。
  printf '%s' "$1" |
    sed -E 's/[（(].*//' |
    sed -E 's/^\*+//; s/\*+$//; s/^[[:space:]]+//; s/[[:space:]]+$//'
}

plan_state_is_complete() { # <state> -> 真: 状態欄が「完了」を表す（中核語が「完了」で始まる）
  # 部分文字列一致にすると「未完了」「進行中（T01完了、T02未着手）」のように実際には
  # 未完了の文章まで拾ってしまう（レビュー指摘 S4）。中核語の先頭が「完了」の場合だけ拾う。
  case "$(plan_state_core "$1")" in 完了*) return 0;; esac
  return 1
}

plan_state_is_ongoing() { # <state> -> 真: 「〜レビュー中」「〜承認待ち」等、最終レビューが
                          # 正常に進行中／完了して承認待ちであることを表す語
  # C1a はタスク表が全 done なのに状態欄が「完了」でないケースを拾う。task-orchestrate の手順
  # （docs/roles/、.agents/skills/task-orchestrate/SKILL.md）では実装が全部終わってから最終
  # レビューを 1 回回すので、「タスク表は全 done・状態欄はレビュー中」は正常な途中状態であり、
  # ここで警告すると C3（誤検知で既存の指摘を埋もれさせない）に反する（レビュー指摘 G1。実物:
  # docs/plans/active/no-silent-failures.md の「**最終レビュー中**（…）」）。
  # 同じ手順の §3.6 では、最終レビューが終わって指摘も処理し終えたら「ユーザーの承認を待つ」
  # という、もう 1 つの正常な途中状態がある（実物: docs/plans/active/writeback-sensors.md の
  # 「**レビュー完了・ユーザー承認待ち**（5 タスクすべて done、最終レビューの指摘も処理済み）」。
  # T06 で発見。タスク表は全 done・状態欄はまだ「完了」ではない＝task-orchestrate 上は正しい）。
  # 一方 docs/plans/README.md の雛形にある他の状態（計画中/進行中/ブロック中）は、タスク表が
  # 全 done なら矛盾したままなので除外しない（「〜中」全般や「承認」という語を含むだけの状態を
  # 継続中扱いすると、素の書き戻し忘れ＝「進行中」「承認フローの実装中」のまま放置、を見逃して
  # しまう。tests/gc.sh の G8/G28 が回帰を止める）。よって中核語の**末尾**が「レビュー中」または
  # 「承認待ち」に限定して継続中とみなす（表記揺れ「承認待ち」「ユーザー承認待ち」はどちらも
  # 「承認待ち」で終わるので拾える。tests/gc.sh の G27）。
  case "$(plan_state_core "$1")" in *レビュー中|*承認待ち) return 0;; esac
  return 1
}

plan_state_col() { # <file> -> タスク表で「状態」列の配列添字（0-indexed。列が無ければ空）
  local header cells cell idx col
  header=$(grep -m1 -E '^\|.*状態.*\|' "$1") || return 0
  idx=0; col=""
  IFS='|' read -ra cells <<<"$header"
  for cell in "${cells[@]}"; do
    cell=$(printf '%s' "$cell" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    if [ "$cell" = "状態" ]; then col=$idx; break; fi
    idx=$((idx + 1))
  done
  echo "$col"
}

plan_all_tasks_done() { # <file> <col> -> 真: タスク行（先頭列が T+数字）が 1 件以上あり全部 done
  local f="$1" col="$2" any=0 line cells first status
  [ -n "$col" ] || return 1
  while IFS= read -r line; do
    IFS='|' read -ra cells <<<"$line"
    first=$(printf '%s' "${cells[1]:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    case "$first" in T[0-9]*) ;; *) continue;; esac
    any=1
    status=$(printf '%s' "${cells[$col]:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^\*+//; s/\*+$//')
    case "$status" in [Dd][Oo][Nn][Ee]*) ;; *) return 1;; esac
  done < <(grep -E '^\|' "$f")
  [ "$any" = 1 ]
}

if [ -d "$DOCS/plans/active" ]; then
  while IFS= read -r f; do
    state=$(plan_state_value "$f")
    if plan_state_is_complete "$state"; then
      report WARN "計画 $f の状態欄が「完了」なのに active/ に置かれたまま" "docs/plans/completed/ へ移す（畳み忘れ）"
    else
      col=$(plan_state_col "$f")
      if [ -n "$col" ] && plan_all_tasks_done "$f" "$col" && ! plan_state_is_ongoing "$state"; then
        report WARN "計画 $f のタスク表は行が全部 done なのに状態欄が「完了」になっていない" "状態欄を完了に書き戻すか、まだなら理由を書く"
      fi
    fi
  done < <(find "$DOCS/plans/active" -name '*.md' | sort)
fi

# 11. spec の状態欄と対応する計画の状態の食い違い（統括の書き戻し漏れ。spec writeback-sensors 節 C）
#     対応は、計画ファイルの中にある「spec/<spec のファイル名>」という参照文字列で取る
#     （相対リンク `[spec](../../spec/x.md)` でも、バッククォート表記 `docs/spec/x.md` でも拾える）。
#     対応が取れない spec は警告しない（C3。`check-speed.md` のように専用の計画を持たない spec もある）。
#     計画側の完了判定は状態欄の文字列ではなく active/・completed/ の置き場所で見る。状態欄の文字列は
#     畳んだ後も古いまま残ることがある（実例: docs/plans/completed/harness-doctor.md の
#     「- 状態: 進行中（T01 から）」。completed/ に置かれているほうが実態）。C2: 中核語の判定は
#     plan_state_core() / plan_state_is_complete() をそのまま使い、同じ判定を複製しない。
spec_state_value() { # <file> -> 「状態:」行の値（1 行。「状態:」でも「- 状態:」でも拾う。無ければ空）
  sed -n -E 's/^-? *状態: *//p' "$1" | head -1
}

# spec_plan_file() は元々 spec 1 件ごとに `grep -rlF "spec/$1" "$DOCS/plans"` で
# docs/plans を丸ごと毎回スキャンしていた（O(spec 件数 × plans の総サイズ)）。plans は
# `docs/plans/completed/` が削除されずに積み上がる運用なので、育つほど遅くなり「gc は
# 1 秒だから毎回回せる」という設計前提を自ら壊す（最終レビュー実測: spec 300 件・plan 1500
# 件で 50.15s）。docs/plans を 1 回だけ走査して「plan ファイル -> 参照している spec の
# ファイル名」の対応表（$SPEC_PLAN_TABLE）を作ってから、spec ごとにその対応表（plans 全体
# よりずっと小さい）を引く方式に変える。判定の意味（計画ファイル中の「spec/<ファイル名>」
# という参照文字列で対応を取る）は変えない。連想配列は使わない（bash 3.2 互換。
# tests/lint-bash-compat.sh が declare -A を禁止している）。
build_spec_plan_table() { # docs/plans を 1 回だけ走査し、SPEC_PLAN_TABLE に
                           # "<plan ファイルパス><TAB><spec のファイル名>" を書く（複数可）
  [ -d "$DOCS/plans" ] || return 0
  grep -roE 'spec/[^)`[:space:]]+\.md' "$DOCS/plans" 2>/dev/null |
    sed -E 's#^([^:]*):spec/(.*)$#\1\t\2#' |
    sort >"$SPEC_PLAN_TABLE"
  # sort は行全体（先頭列＝plan ファイルパス）の昇順にする。元の実装は
  # `grep -rl | sort | head -1` で「複数あれば計画パスの昇順で最初の 1 件」を選んでいた。
  # この対応表も plan パス昇順に並べておけば、spec_plan_file() が先に見つけた行を返すだけで
  # 同じ選び方になる。
}

spec_plan_file() { # <spec のファイル名> -> 対応する計画ファイルのパス（無ければ空。複数あれば最初の 1 件）
  [ -s "$SPEC_PLAN_TABLE" ] || return 0
  awk -F'\t' -v s="$1" '$2 == s { print $1; exit }' "$SPEC_PLAN_TABLE"
}

if [ -d "$DOCS/spec" ]; then
  build_spec_plan_table
  while IFS= read -r f; do
    spec_state=$(spec_state_value "$f")
    [ -z "$spec_state" ] && continue
    plan_file=$(spec_plan_file "$(basename "$f")")
    [ -z "$plan_file" ] && continue
    case "$plan_file" in
      */plans/completed/*) plan_complete=1; plan_label="完了";;
      *) plan_complete=0; plan_label="未完了";;
    esac
    if plan_state_is_complete "$spec_state"; then spec_complete=1; spec_label="完了"; else spec_complete=0; spec_label="未完了"; fi
    if [ "$spec_complete" != "$plan_complete" ]; then
      report WARN "$f の状態欄が対応する計画 $plan_file と食い違っている（計画: ${plan_label}、spec: ${spec_label}）" \
        "計画の実態（${plan_file} の置き場所）に合わせて $f の状態欄を書き戻す（統括の仕事）"
    fi
  done < <(find "$DOCS/spec" -maxdepth 1 -name '*.md' | sort)
fi

# 12. 計画を進めたのに handoff の書き戻しを忘れていないか（統括の書き戻し漏れ。
#     spec: docs/spec/handoff-writeback.md）。既存の項目 1（handoff の鮮度）は日数・コミット数の
#     閾値方式だが、実測の中央値が低いために閾値の下に日常的な漏れが隠れる（2026-09-22 に
#     writeback-sensors で実際に再発。同じ日・非 docs コミット 1 件だったのでどちらの閾値も
#     発火しなかった）。ここでは頻度ではなく状態の矛盾を見る: 計画を最後に更新したコミットより
#     後で handoff が更新されていなければ、日数やコミット数に関係なく報告する。
#     比較は日付ではなくコミットの祖先関係（`git merge-base --is-ancestor`）で行う。
#     `.harness/state/` と違い `docs/plans/` は git 管理下なので、コミット順序がそのまま
#     追える（日付比較に落とすと「同じ日の漏れ」を取り逃す。spec の「合意済みの決定」参照）。
if [ -d "$DOCS/plans/active" ]; then
  while IFS= read -r f; do
    plan_anchor=$(git log -1 --format=%H -- "$f" 2>/dev/null)
    [ -z "$plan_anchor" ] && continue     # 未コミットの計画は項目 5 が別途報告する
    [ -z "$handoff_anchor" ] && continue  # handoff が一度もコミットされていなければ判定しない（沈黙を選ぶ）
    [ "$plan_anchor" = "$handoff_anchor" ] && continue  # 同じコミットで更新（A4）
    if git merge-base --is-ancestor "$handoff_anchor" "$plan_anchor" 2>/dev/null; then
      report WARN "計画 $f の更新に docs/handoff.md の書き戻しが追いついていない" \
        "session-handoff の手順で docs/handoff.md を更新する（計画は進んでいるのに handoff がそれより前のコミットのまま）"
    fi
  done < <(find "$DOCS/plans/active" -name '*.md' | sort)
fi

# 13. docs/spec/*.md が spec の索引（docs/spec/README.md）に無い（決定 0010、2026-09-28 再開）。
#     作法は項目 3（docs/ 直下の .md が索引に無い）に揃える: 索引ファイル自身は対象外、
#     `grep -qF "($rel"` で行の有無を見る。項目 3 と違うのは、docs/spec/README.md が無い・
#     表の体をなしていない場合に**何も言わない**こと（docs/README.md は必須の索引として
#     項目 3 で ERR にしているが、docs/spec/README.md は配布先の任意の運用なので沈黙を選ぶ）。
#     「表の体をなしている」は区切り行（例: `|---|---|`）の有無で判定する。
if [ -d "$DOCS/spec" ] && [ -f "$DOCS/spec/README.md" ] && grep -qE '^\|[-:| ]+\|$' "$DOCS/spec/README.md"; then
  while IFS= read -r f; do
    rel="${f#"$DOCS/spec"/}"
    [ "$rel" = "README.md" ] && continue
    grep -qF "($rel" "$DOCS/spec/README.md" || report WARN "docs/spec/$rel が spec の索引（docs/spec/README.md）に無い" "docs/spec/README.md の表に行を足す（索引に無い spec は次のセッションから見落とされる）"
  done < <(find "$DOCS/spec" -maxdepth 1 -name '*.md' | sort)
fi

# 読めなかった日付は必ず出す。日付判定が効いていないまま「問題なし」と言うのが一番害が大きい
# （gc が仕事の半分をしていないことに誰も気づけない。tech-debt #8 の本体）。
if [ -s "$UNPARSED_FILE" ]; then
  bad="$(sort -u "$UNPARSED_FILE" | tr '\n' ' ')"
  report WARN "日付として読めなかった記述がある: ${bad}" \
    "YYYY-MM-DD 形式で書く（この日付に依存する鮮度の判定は今回スキップしている）"
fi

echo
if [ "$n" = 0 ]; then
  echo "harness gc: 問題なし（閾値 ${DAYS} 日）"
else
  echo "harness gc: ${n} 件（閾値 ${DAYS} 日）。判断と修正は harness-maintain スキルの D か人間が行う。"
  [ "$STRICT" = 1 ] && exit 1
fi
exit 0
