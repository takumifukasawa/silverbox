#!/usr/bin/env bash
# agent-harness managed: Codex の PreToolUse hook。標準 deny（AGENTS.md の「やらないこと」）を機械で止める。
# 対象は .claude/settings.json の deny と同じ 5 つ（エージェントを問わず同じに止まることが目的）。
#
# Codex は PreToolUse hook の stdin に JSON を 1 つ渡す（実測 2026-09-21 / CLI 0.154.0）:
#   {"tool_name":"Bash","tool_input":{"command":"..."},"hook_event_name":"PreToolUse", ...}
# 拒否するときは次を標準出力に書く（exit 2 + stderr に理由でも同じ）:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
# 何も出さずに exit 0 すれば素通り。
#
# この hook は「置けば効く」ものではない。プロジェクトが trusted で、かつ hook 定義ごとに
# 信頼されている必要がある（`codex` の /hooks）。効いていないことは harness doctor が報告する。
# apply_patch には deny が効かない既知の不具合もあるため、.githooks/ の門番と二重で使う（決定 0009）。
set -u

payload="$(cat)"

deny() { # 理由
  # 理由は JSON 文字列に入るので、" と \ だけ潰す（コマンドはここに埋め込まない。決定 0003 と同じ方針）
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# コマンド文字列を取り出す。jq があれば使い、無ければ sed で抜く（依存は git と bash だけ。jq は「あれば使う」）。
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
fi
if [ -z "$cmd" ]; then
  cmd="$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(\([^"\\]*\(\\.\)*\)*\)".*/\1/p')"
fi
# 取り出せなければ判定材料が無い。ここで止めると Codex が何もできなくなるので素通りさせる
# （最後の砦は .githooks/ 側。決定 0009 の二重構え）。
[ -n "$cmd" ] || exit 0

# 前後に空白を足してから見る。`-f` のような短いオプションが `-foo` の一部に化けるのを防ぐため。
padded=" $cmd "

is_push=1
case "$padded" in *" git push "*|*" git push"*) is_push=0;; esac
if [ "$is_push" -eq 0 ]; then
  case "$padded" in
    *"--force"*|*" -f "*|*" -f")
      deny "agent-harness: 破壊的な git 操作は指示なしに行わない（AGENTS.md）。force push が要るなら人間が実行する。" ;;
  esac
fi

case "$padded" in
  *" git reset --hard"*)
    deny "agent-harness: git reset --hard は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。" ;;
  *" git branch -D"*|*" git branch --delete --force"*)
    deny "agent-harness: ブランチ削除は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。" ;;
  *" gh repo delete"*)
    deny "agent-harness: リポジトリ削除は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。" ;;
esac

exit 0
