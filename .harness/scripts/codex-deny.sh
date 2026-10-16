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

# 標準入力の各行（2 行目以降は \u を切り落とした直後の XXXX で始まる）を戻して出力する。
# $( ) の中に case を書くと bash 3.2 が構文エラーにするので、関数に出してある。
unescape_u_lines() { # 退避文字（\ の代わり）
  local first=0 line hex
  while IFS= read -r line; do
    if [ "$first" -eq 0 ]; then printf '%s' "$line"; first=1; continue; fi
    hex="${line:0:4}"; line="${line:4}"
    case "$hex" in
      005[cC]) printf '%s' "$1" ;;                # \u005c は \ そのもの（後段で \n 等と取り違えない）
      00[0-7][0-9a-fA-F]) printf "\\x${hex:2:2}" ;;
      *) printf '?' ;;
    esac
    printf '%s' "$line"
  done
}

# JSON 文字列の中身（sed で抜いたもの）のエスケープを解く。jq が無い経路で使う。
# \\ を先に退避しないと、\\n（バックスラッシュ + n）を改行と取り違える。
# \uXXXX は ASCII（\u0000〜\u007F）だけ文字に戻し、それ以外は ? に置く（判定に要るのは ASCII だけ）。
json_unescape() {
  local s="$1" BS=$'\001'
  s="${s//\\\\/$BS}"
  # \u は sed で行頭に切り出してから 1 行ずつ戻す。sed で抜いた時点では本物の改行を含まないので、
  # 行で切っても中身と混ざらない。戻した結果は変数に継ぎ足さずに出力する
  # （bash 3.2 は文字列の継ぎ足しや ${s%%\\u*} が長さの 2 乗で遅く、hook の timeout に掛かる）。
  case "$s" in
    *'\u'*)
      s="$(printf '%s\n' "$s" | sed 's/\\u/\
/g' | unescape_u_lines "$BS"; printf x)"
      s="${s%x}" ;;
  esac
  s="${s//\\\"/\"}"; s="${s//\\\//\/}"
  s="${s//\\n/$'\n'}"; s="${s//\\t/$'\t'}"; s="${s//\\r/$'\r'}"
  s="${s//\\b/ }"; s="${s//\\f/ }"
  printf '%s' "${s//$BS/\\}"
}

# コマンド文字列を取り出す。jq があれば使い、無ければ sed で抜く（依存は git と bash だけ。jq は「あれば使う」）。
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command | if type == "array" then join(" ") elif type == "string" then . else empty end' 2>/dev/null || true)"
fi
if [ -z "$cmd" ]; then
  cmd="$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(\([^"\\]*\(\\.\)*\)*\)".*/\1/p')"
  if [ -z "$cmd" ]; then
    # 配列（["bash","-lc","git push -f"]）で来た場合。要素の区切りを空白にして 1 本の文字列として見る。
    # 末尾の ] は貪欲に取るので後ろの値まで混ざりうるが、混ざっても止めすぎの側にしか倒れない。
    cmd="$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p' \
          | sed 's/"[[:space:]]*,[[:space:]]*"/ /g; s/^[[:space:]]*"//; s/"[[:space:]]*$//')"
  fi
  cmd="$(json_unescape "$cmd")"
fi
# 取り出せなければ判定材料が無い。ここで止めると Codex が何もできなくなるので素通りさせる
# （最後の砦は .githooks/ 側。決定 0009 の二重構え）。ただし command を持つ入力なのに取り出せなかった
# ときは黙らない（何が素通りしたかを後から追えるように stderr に残す）。
if [ -z "$cmd" ]; then
  case "$payload" in
    *'"command"'*) echo "agent-harness: codex-deny: tool_input.command を取り出せなかったので判定せずに通した（決定 0009）" >&2 ;;
  esac
  exit 0
fi

# ---- 判定 ----
# 文字列の部分一致ではなく、シェルの区切りでコマンドに分け、語に分けてから見る（issue #1）。
# 書き方を変えただけ（空白の数、タブ、区切りの直後、クォート、グローバルオプション、別表記）で
# 素通りしないようにするため。
#
# 正規化:
#   - 行継続（\ + 改行）を空白に。クォートと残りの \ は消す（`git 'push'` を `git push` と見る）
#   - ; & | ( ) { } ` と改行をコマンドの区切りに、タブ・< > を空白に
# クォートの中身もコマンドとして見るので、`bash -c 'git push -f'` は止まる。代わりに
# `git commit -m "... git push -f ..."` のようにメッセージに書いただけでも止まる（止めすぎの側に倒す。
# 以前の部分一致も同じだった）。
norm="${cmd//\\$'\n'/ }"
norm="$(printf '%s\n' "$norm" | tr -d "\"'\\\\" | tr ';&|(){}`' '\n\n\n\n\n\n\n\n' | tr '\t\r<>' '    ')"

# git の直後のグローバルオプションのうち、値を別の語に取るもの
takes_value() {
  case "$1" in -c|-C|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--exec-path) return 0;; esac
  return 1
}

# $@ = git の後ろの語。止めるべきなら理由を出して deny する
judge_git() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      -*) if takes_value "$1"; then shift; fi; shift ;;
      *) break ;;
    esac
  done
  [ $# -gt 0 ] || return 0
  local sub="$1" t has_D=1 has_d=1 has_f=1; shift
  case "$sub" in
    push)
      for t in "$@"; do
        case "$t" in
          --force|--force=*|--force-with-lease|--force-with-lease=*|--force-if-includes) ;;
          --*) continue ;;
          -*f*) ;;              # -f と、-uf のような短いオプションの連結
          +*) ;;                # refspec の + は force と同じ
          *) continue ;;
        esac
        deny "agent-harness: 破壊的な git 操作は指示なしに行わない（AGENTS.md）。force push が要るなら人間が実行する。"
      done ;;
    reset)
      for t in "$@"; do
        [ "$t" = "--hard" ] && deny "agent-harness: git reset --hard は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。"
      done ;;
    branch)
      # -D、または削除（-d / --delete）と force（-f / --force）の組み合わせ。並び・連結を問わない
      for t in "$@"; do
        case "$t" in
          --delete) has_d=0 ;;
          --force) has_f=0 ;;
          --*) ;;
          -*)
            case "$t" in *D*) has_D=0;; esac
            case "$t" in *d*) has_d=0;; esac
            case "$t" in *f*) has_f=0;; esac ;;
        esac
      done
      if [ "$has_D" -eq 0 ] || { [ "$has_d" -eq 0 ] && [ "$has_f" -eq 0 ]; }; then
        deny "agent-harness: ブランチ削除は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。"
      fi ;;
  esac
}

# $@ = gh の後ろの語
judge_gh() {
  local words="" t
  for t in "$@"; do
    case "$t" in -*) continue;; esac
    words="$words $t"
    case "$words" in " repo delete"*) deny "agent-harness: リポジトリ削除は指示なしに行わない（AGENTS.md）。要るなら人間が実行する。";; esac
  done
}

# 各コマンドの中で git / gh の語を探し、その後ろを判定する。先頭に限らない
# （sudo git ... / FOO=1 git ... / xargs git ... / bash -c 'git ...' を拾うため）
while IFS= read -r line; do
  # shellcheck disable=SC2086 # 語への分割が目的。グロブは止める
  set -f; set -- $line; set +f
  while [ $# -gt 0 ]; do
    case "$1" in
      git|*/git) shift; judge_git "$@" ;;
      gh|*/gh) shift; judge_gh "$@" ;;
      *) shift ;;
    esac
  done
done <<EOF
$norm
EOF

exit 0
