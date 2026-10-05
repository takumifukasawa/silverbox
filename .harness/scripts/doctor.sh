#!/usr/bin/env bash
# harness doctor — 導入先の環境とハーネス導入状態を機械的に診断して一覧にする。
# 報告のみ（自動修復はしない）。gc が docs の健康診断なら、doctor は環境の健康診断。LLM は使わない。
#
# 使い方:  bash .harness/scripts/doctor.sh   （オプションは取らない。--fix / --json は未実装）
#
# 各行:  OK|WARN|FAIL|INFO  項目  →  直し方     （OK 行に直し方は付かない）
#   INFO は参考情報（例: source に新版がある）。OK/WARN/FAIL の判定・終了コードには数えない。
#   集計行には参考として件数だけ添える（B10 だけが出す）。
# 最後に集計行（OK / WARN / FAIL の件数。参考として INFO の件数も添える）。
#
# 終了コード:
#   0  問題なし、または WARN のみ
#   1  FAIL あり
#   2  診断自体ができない環境不備（未導入ディレクトリ、未知の引数など）
#
# 診断は bash と git だけで動く。node / jq が無くても全項目が実行できる（あれば使う、で留める）。
set -u

# 自分自身のディレクトリ（後段の B12 が隣の seed-case.sh を source するため）。後で ROOT へ
# cd するので、その前に BASH_SOURCE[0] を解決しておく（相対パスで起動された場合、cd の後では
# 起動時のカレントディレクトリを基準にした意味が失われる）。
DOCTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

# doctor はオプションを取らない。--fix / --json 等の未知の引数を黙って無視すると「指定どおり
# 動いた」と誤解されうる（spec: --fix は範囲外、--json は要望が出るまで未実装）。usage を出して
# 「診断自体ができない環境不備」と同じ 2 で終わる。
if [ "$#" -gt 0 ]; then
  echo "harness doctor: 未知の引数: $*（doctor はオプションを取らない。--fix / --json は未実装）" >&2
  echo "  使い方: bash .harness/bin/harness doctor" >&2
  exit 2
fi

# git が無い環境でも診断できるよう、ROOT の決定は git に依存しすぎない
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Git for Windows は C:/... を返す。MSYS の /c/... に揃える（bin/harness の project_root と同じ扱い）
if command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -u "$ROOT" 2>/dev/null || echo "$ROOT")"; fi
cd "$ROOT" 2>/dev/null || { echo "harness doctor: $ROOT に入れない" >&2; exit 2; }

if [ ! -f "$ROOT/.harness/manifest.json" ]; then
  # A3（no-silent-failures）: manifest.json が無いのは「まだ何も入れていない」とは限らない。
  # init / update は apply_plan（ファイルを配る）→ write_manifest（manifest.json を書く）の順で
  # 進むので、途中（mkdir -p や cp）で失敗すると manifest.json を書く前にスクリプトごと落ち、
  # 配った分の残骸だけが残る。この 2 つを機械で区別しないと、残骸に気づく手段が無いまま
  # 「harness init をやり直す」とだけ案内し、実際には既に散らばっているファイルを隠してしまう
  # （実機再現: docs をファイルで塞いで init を失敗させると 20 件超の残骸が残るが、修正前の
  # doctor はここで即 exit 2 し、それについて何も言わなかった）。
  #
  # 判定は簡易にする: 配布先としてよく使う既知のパスのどれかが存在すれば「残骸あり」とみなす。
  # bin/harness の plan() の全項目と厳密に一致させる必要は無い（doctor は plan() を読まない。
  # git と bash だけで動く前提を保つ）。取りこぼして「未導入」と誤診するより、多めに拾って
  # 「残骸かもしれない」と言う方が安全（A3 は気づけることが目的で、自動修復はしない）。
  # AGENTS.md はプロジェクトが独自に書いていることもあるので、harness のマーカーが無ければ
  # 残骸の証拠として扱わない（誤検知を避ける）。
  residue_paths=""
  for residue_p in .harness/bin .harness/scripts .harness/checks.sh .harness/state-template \
                   .agents/skills .claude/skills .claude/agents .githooks/pre-commit \
                   .codex/hooks.json AGENTS.md; do
    [ -e "$ROOT/$residue_p" ] || continue
    if [ "$residue_p" = "AGENTS.md" ] && ! grep -q '<!-- harness:begin' "$ROOT/$residue_p" 2>/dev/null; then
      continue
    fi
    residue_paths="$residue_paths $residue_p"
  done
  residue_paths="${residue_paths# }"

  if [ -n "$residue_paths" ]; then
    n_residue="$(find "$ROOT/.harness" "$ROOT/.agents/skills" "$ROOT/.claude/skills" "$ROOT/.claude/agents" \
      "$ROOT/.githooks" "$ROOT/.codex" -type f 2>/dev/null | grep -vF "/.harness/manifest.json" | wc -l | tr -d ' ')"
    echo "harness doctor: 導入が中途半端（$ROOT/.harness/manifest.json が無いが、配布物と見られるファイルが残っている。約 ${n_residue} 件）" >&2
    echo "  これは harness init / update が manifest.json を書く前に失敗したときに残る状態（残骸）で、「未導入」とは別。自動では消さない。" >&2
    echo "  残骸として見つかったパス:${residue_paths}" >&2
    echo "  直し方: 原因を直してから同じコマンド（init または update）をもう一度実行する（配布は冪等）。中身を確認したいときは上記のパスを直接見る" >&2
    exit 2
  fi

  echo "harness doctor: 導入コピーが無い（$ROOT/.harness/manifest.json が見つからない）" >&2
  echo "  直し方: このディレクトリで harness init を実行する" >&2
  echo "          例: bash <agent-harness を clone した場所>/bin/harness init --source <同じ場所>" >&2
  exit 2
fi

n_ok=0; n_warn=0; n_fail=0; n_info=0
report() { # severity 項目 [直し方]
  case "$1" in
    OK)   n_ok=$((n_ok + 1));;
    WARN) n_warn=$((n_warn + 1));;
    FAIL) n_fail=$((n_fail + 1));;
    INFO) n_info=$((n_info + 1));;
  esac
  if [ -n "${3:-}" ]; then
    printf '%-4s  %s  →  %s\n' "$1" "$2" "$3"
  else
    printf '%-4s  %s\n' "$1" "$2"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# 2 つのファイルの内容が同一か（パスではなく中身で見る。Windows では C:/ と /c/ と /tmp が混在する）。
# 素の git hash-object は使わない。理由が 2 つある:
#   1. .gitattributes の text eol=lf フィルタを通すので、CRLF 化しただけのファイルを「一致」と誤診する
#   2. git が無い環境では両辺が空文字になり、常に「一致」になる（誤った OK を出す）
# そこで生バイトで比べる。cmp → git hash-object --no-filters → bash 内蔵だけ、の順に落ちる。
content_eq() { # a b
  [ -f "$1" ] && [ -f "$2" ] || return 1
  if have cmp; then
    cmp -s "$1" "$2"
  elif have git; then
    local h1 h2
    h1="$(git hash-object --no-filters "$1" 2>/dev/null)"
    h2="$(git hash-object --no-filters "$2" 2>/dev/null)"
    [ -n "$h1" ] && [ "$h1" = "$h2" ]
  else
    # 外部コマンドが一切無くても判定する最後の手段。mapfile は bash 4+ 専用（決定 0006）なので
    # bash 3.2 でも動く while read で読む（最終行に改行が無いファイルも拾えるよう || [ -n "$line" ] を足す）
    local -a lines_a=() lines_b=()
    local line
    while IFS= read -r line || [ -n "$line" ]; do lines_a+=("$line"); done <"$1"
    while IFS= read -r line || [ -n "$line" ]; do lines_b+=("$line"); done <"$2"
    [ "${#lines_a[@]}" = "${#lines_b[@]}" ] && [ "${lines_a[*]}" = "${lines_b[*]}" ]
  fi
}

# grep -c は 0 件のとき "0" を出して exit 1 を返す。`|| echo 0` を足すと出力が "0\n0" になり、
# 続く整数比較が「integer expression expected」で失敗して条件が常に偽になる（偽の全快の元）。
# 数を数えるときは必ずこの 2 つを通し、整数以外が来ても 0 に落とす。
as_int() { # 文字列 → 先頭の整数（空や非整数は 0）
  local n="${1%%[!0-9]*}"
  printf '%s' "${n:-0}"
}
count_matches() { # 正規表現 ファイル → マッチした行数（整数）
  as_int "$(grep -c "$1" "$2" 2>/dev/null || true)"
}

# manifest 由来のディレクトリ（source）の VERSION は外部ファイル。書式・長さを検証せずに出力へ
# 載せると、無関係な内容や長文がそのまま診断ログ（≒ CI ログやエージェントの文脈）に出る
# （最終レビュー low 指摘）。使う前にこの 2 つを通す。
looks_like_version() { # 文字列 → 版番号らしい形式か（例: 0.3.0, 1.2.3-rc1）。長さも制限する
  case "$1" in
    [0-9]*.[0-9]*)
      [ "${#1}" -le 32 ] || return 1
      case "$1" in *[!0-9A-Za-z.-]*) return 1;; esac
      return 0
      ;;
    *) return 1 ;;
  esac
}
printable_snippet() { # 文字列 長さ → 印字可能文字だけに絞った先頭 N 文字（制御文字・ANSI 混入を防ぐ）
  printf '%s' "$1" | tr -cd '[:print:]' | cut -c "1-${2:-24}"
}

os_name="$(uname -s 2>/dev/null || echo unknown)"
is_windows=0
case "$os_name" in MINGW*|MSYS*|CYGWIN*) is_windows=1;; esac

# ---------------------------------------------------------------- B1. 必須ツール
# bash の版は BASH_VERSINFO[0]/[1] で見る（BASH_VERSINFO は readonly なのでテストから上書きできない。
# 「bash < 3.2」のシナリオは自動テストでは再現せず、実機がその版の環境でこの行を見る）。
# macOS 既定の bash は 3.2.57 のまま更新されない見込みで、ハーネスはこれを切らない（決定 0006）。
# 連想配列（declare -A）や mapfile は使わない前提でコードを書き、3.2 以上を最低ラインにする。
bash_min_ok=0
if [ "${BASH_VERSINFO[0]:-0}" -gt 3 ]; then
  bash_min_ok=1
elif [ "${BASH_VERSINFO[0]:-0}" -eq 3 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 2 ]; then
  bash_min_ok=1
fi
if [ "$bash_min_ok" = 1 ]; then
  report OK "bash ${BASH_VERSION:-?}（3.2 以上。決定 0006）"
else
  report FAIL "bash の版が ${BASH_VERSION:-不明}（3.2 未満）" \
    "bash 3.2 以上を用意する（決定 0006: macOS 既定の 3.2.57 はそのまま使える。3.2 未満の環境は個別に新しい bash を用意する）"
fi

if have git; then
  report OK "git（$(git --version 2>/dev/null | head -1)）"
else
  report FAIL "git が見つからない（ハーネスは git と bash だけに依存する）" \
    "git を入れて PATH に通す（Windows: Git for Windows、macOS: xcode-select --install、Linux: apt install git など）"
fi

# ---------------------------------------------------------------- B2. 任意ツール
if have node; then
  report OK "node（任意。$(node --version 2>/dev/null)）"
else
  report WARN "node が無い（任意）" \
    ".claude/settings.json の自動マージが手動になる。無くてもハーネスは動く。必要なら node を入れる"
fi

if have jq; then
  report OK "jq（任意。$(jq --version 2>/dev/null)）"
else
  report WARN "jq が無い（任意）" \
    "task-orchestrate の stages.json 抽出が grep 頼りになる。無くてもハーネスは動く。必要なら jq を入れる"
fi

if [ "$is_windows" = 1 ]; then
  if have cygpath; then
    report OK "cygpath（Windows）"
  else
    report WARN "cygpath が無い（${os_name}）" \
      "パス形式（C:/ と /c/）の正規化ができない。Git for Windows 同梱の bash から実行する"
  fi
fi

# ---------------------------------------------------------------- B3. manifest
# bin/harness の manifest_get / manifest_entries と同じ「1 エントリ 1 行」書式を前提にする。
MANIFEST="$ROOT/.harness/manifest.json"
manifest_get() { # key
  sed -n "s/^  \"$1\": *\"\(.*\)\",\{0,1\}$/\1/p" "$MANIFEST" | head -1
}

mf_version="$(manifest_get harness_version)"
mf_source="$(manifest_get source)"
mf_agents="$(manifest_get agents)"

# path<TAB>src<TAB>ownership<TAB>sha256<TAB>source_sha256
mf_entries="$(grep '^    {"path"' "$MANIFEST" 2>/dev/null | sed -E \
  's/.*"path":"([^"]*)".*"src":"([^"]*)".*"ownership":"([^"]*)".*"sha256":"([^"]*)".*"source_sha256":"([^"]*)".*/\1\t\2\t\3\t\4\t\5/')"
mf_entry_lines="$(count_matches '^    {"path"' "$MANIFEST")"

# 1 行に複数エントリ / 別のインデント で書かれた manifest を「エントリ 0 件」と取り違えないための照合。
# ファイル全体の "path" キーの数とエントリ行の数が食い違えば、1 エントリ 1 行になっていない。
mf_path_keys="$mf_entry_lines"   # awk が無ければ照合しない（無い側に倒して誤検知を避ける）
if have awk; then
  mf_path_keys="$(as_int "$(awk '{ c += gsub(/"path":"/, "&") } END { print c + 0 }' "$MANIFEST" 2>/dev/null)")"
fi

mf_bad_lines=0
if [ "$mf_entry_lines" -gt 0 ] && have awk; then
  mf_bad_lines="$(as_int "$(printf '%s\n' "$mf_entries" | awk -F'\t' 'NF!=5{c++} END{print c+0}')")"
fi

mf_broken=""
[ -z "$mf_version" ] && mf_broken="$mf_broken harness_version が読めない;"
[ -z "$mf_source" ] && mf_broken="$mf_broken source が読めない;"
[ -z "$mf_agents" ] && mf_broken="$mf_broken agents が読めない;"
[ "$mf_entry_lines" -eq 0 ] && mf_broken="$mf_broken files のエントリ行が 0 件;"
[ "$mf_bad_lines" -gt 0 ] && mf_broken="$mf_broken 項目が欠けたエントリ行が ${mf_bad_lines} 件;"
[ "$mf_path_keys" -ne "$mf_entry_lines" ] && \
  mf_broken="$mf_broken 1 エントリ 1 行ではない（\"path\" が ${mf_path_keys} 個に対しエントリ行は ${mf_entry_lines} 行）;"

manifest_ok=1
[ -n "$mf_broken" ] && manifest_ok=0

# 壊れた manifest の復旧経路は決定 0003 のとおり、見出し（version/source/agents）が読めるかで
# 二手に分かれる。読めれば harness update がツリーの実物から files を作り直せる（files の中身は
# 読まない）。読めなければ update は source を解決できず失敗し、init は manifest.json が
# 存在するだけで拒否するので、壊れたものを退避してから作り直す以外に道が無い（実測済み）。
if [ "$manifest_ok" = 1 ]; then
  report OK "manifest（version=$mf_version, agents=$mf_agents, ${mf_entry_lines} 件）"
elif [ -n "$mf_version" ] && [ -n "$mf_source" ] && [ -n "$mf_agents" ]; then
  report FAIL "manifest（.harness/manifest.json）の files が壊れている:${mf_broken%;}" \
    "bash .harness/bin/harness update で作り直す（version/source/agents は読めているので、files の記載が壊れていても復元できる）"
  # 黙ってスキップしない。何を確認できていないかを出力に残す。
  report WARN "manifest が読めないため B4（ファイルの存在）/ B5（改行）/ B8・B9（アダプタ側の照合）/ B10（新版）/ B12（seed / managed / generated の case 衝突）の診断をスキップした" \
    "先に上の FAIL（manifest）を直してから、もう一度 harness doctor を回す"
else
  report FAIL "manifest（.harness/manifest.json）が壊れている（見出しごと読めない）:${mf_broken%;}" \
    "mv .harness/manifest.json .harness/manifest.json.broken && bash .harness/bin/harness init --source <このプロジェクトの導入元。不明なら .harness/manifest.json.broken や git log -p -- .harness/manifest.json、docs/handoff.md で確認。省略時は既定の公開リポジトリを使う>"
  # 黙ってスキップしない。何を確認できていないかを出力に残す。
  report WARN "manifest が読めないため B4（ファイルの存在）/ B5（改行）/ B8・B9（アダプタ側の照合）/ B10（新版）/ B12（seed / managed / generated の case 衝突）の診断をスキップした" \
    "先に上の FAIL（manifest）を直してから、もう一度 harness doctor を回す"
fi

# ---------------------------------------------------------------- B4. ファイルの存在（manifest 記載分）
# seed の欠落は WARN（導入後にプロジェクトが編集・削除しうる）。managed / generated / merge の欠落は FAIL。
if [ "$manifest_ok" = 1 ]; then
  mf_missing=0
  while IFS=$'\t' read -r f_path f_src f_own f_sha f_srcsha; do
    [ -z "$f_path" ] && continue
    [ -e "$ROOT/$f_path" ] && continue
    mf_missing=$((mf_missing + 1))
    if [ "$f_own" = "seed" ]; then
      # apply_plan は seed が無ければ雛形（src。多くは docs-template/ だが .harness/checks.sh の
      # ように checks.seed.sh など docs-template/ 外のこともある）から作り直す。src ごとに手で
      # 辿らせず、update 1 回に一本化する（実測済み。決定 0003）。
      report WARN "seed ファイルが無い: $f_path" \
        "bash .harness/bin/harness update で雛形から復元する（seed は導入後にプロジェクトが編集する前提なので、復元後の内容は必要に応じて書き直す）"
    else
      report FAIL "$f_own ファイルが無い: $f_path" \
        "bash .harness/bin/harness update で復元する（直接編集していた場合は上書きされる点に注意）。復元できなければ bash .harness/bin/harness init をやり直す"
    fi
  done <<<"$mf_entries"
  [ "$mf_missing" -eq 0 ] && report OK "manifest 記載ファイル（${mf_entry_lines} 件）はすべて存在する"
fi

# ---------------------------------------------------------------- B5. 改行
# managed / generated のファイルに CR（\r）が含まれていないか。Windows の core.autocrlf=true で
# チェックアウトすると LF 管理のはずのファイルが CRLF になり、ハッシュ比較や shebang 実行が壊れる。
if [ "$manifest_ok" = 1 ]; then
  cr_found=0
  # 対象を先に集め、判定はまとめて 1 回で済ませる。ファイルごとに tr + wc を起動すると、
  # doctor 1 回が起動する外部プロセス 113 のうち 75 がここになる（実測 2026-09-21）。
  # tests/doctor.sh は doctor を 45 回呼ぶので、ここがそのままテスト時間に乗る
  # （`docs/spec/check-speed.md` の B2）。
  cr_targets=()
  while IFS=$'\t' read -r f_path f_src f_own f_sha f_srcsha; do
    [ -z "$f_path" ] && continue
    case "$f_own" in managed|generated) ;; *) continue;; esac
    case "$f_path" in *.cmd) continue;; esac  # *.cmd は CRLF が規約（.gitattributes）
    [ -f "$ROOT/$f_path" ] || continue  # 欠落は B4 で報告済み
    cr_targets+=("$ROOT/$f_path")
  done <<<"$mf_entries"
  # grep の \r マッチは環境によって信用できない（MSYS の一部 grep が誤検知しない）ので、
  # tr -d '\r' の前後でバイト数を比べる（CR があれば減る）。まず全部つないだ合計で比べ、
  # 一致すれば 1 件も CR を含まないのでそこで終わる。違ったときだけ 1 件ずつ特定する（異常系）。
  # 一括判定に awk や bash の文字列比較を使わないのは、どちらも NUL から先を落とすため
  # （NUL を含むファイルの CR を見逃す。実測 2026-09-21）。バイト数の比較なら落ちない。
  if [ -n "${cr_targets[*]:-}" ] &&
     [ "$(cat "${cr_targets[@]}" | tr -d '\r' | wc -c)" != "$(cat "${cr_targets[@]}" | wc -c)" ]; then
    for cr_file in "${cr_targets[@]}"; do
      [ "$(tr -d '\r' < "$cr_file" | wc -c)" != "$(wc -c < "$cr_file")" ] || continue
      cr_found=$((cr_found + 1))
      # update の復元は git checkout を経由せず生バイトで書くので、core.autocrlf の設定に
      # 関係なく直る（決定 0002 の hash_of/apply_plan、実測済み）。autocrlf 設定自体の是正は
      # 「直し方」ではなく再発防止の話なので、直し方は update 1 本にする（決定 0003）。
      report FAIL "改行: ${cr_file#"$ROOT"/} に CR（\\r）が含まれる（CRLF 化されている。多くは core.autocrlf=true が原因）" \
        "bash .harness/bin/harness update で復元する（正本の内容を生バイトで書き込むため autocrlf の設定に関係なく直る）"
    done
  fi
  [ "$cr_found" -eq 0 ] && report OK "改行: managed / generated ファイルに CR は無い"

  if [ -f "$ROOT/.gitattributes" ] && grep -qxF ".harness/** text eol=lf" "$ROOT/.gitattributes"; then
    report OK ".gitattributes に .harness/** text eol=lf がある"
  else
    report WARN ".gitattributes に .harness/** text eol=lf が無い" \
      ".gitattributes に \".harness/** text eol=lf\" を足す（本来 harness init/update が足す行。手で消していないか確認する）"
  fi
fi

# ---------------------------------------------------------------- B6. git hooks
# $ROOT が git リポジトリでなければ（.git が無い）、core.hooksPath はそもそも設定できない
# （git config core.hooksPath ... は "fatal: not in a git directory" で落ちる）。
# `config --get` 単体はこのエラーを 2>/dev/null で握りつぶし「未設定」と区別が付かなくなるので、
# 根本原因（git リポジトリではない）を先に確認してから分岐する（実測済み。決定 0003）。
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  report WARN "git hooks: $ROOT が git リポジトリではない（.git が無い）ため core.hooksPath を確認できない（git config はここでは fatal: not in a git directory になる）" \
    "git init . && git config core.hooksPath .githooks でこのディレクトリを git 管理下に置いたうえで hooksPath も設定する（git を使わない運用なら、この WARN は無視してよい）"
else
  hooks_path="$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)"
  if [ "$hooks_path" != ".githooks" ]; then
    report WARN "git hooks（core.hooksPath が .githooks になっていない。現在値: ${hooks_path:-未設定}）" \
      "git config core.hooksPath .githooks"
  elif [ ! -f "$ROOT/.githooks/pre-commit" ]; then
    # core.hooksPath 自体はすでに .githooks を正しく指している。この分岐で上と同じ
    # `git config core.hooksPath .githooks` を直し方として出すと no-op になる（設定はもう
    # 正しいので実行しても何も変わらない）。実際の問題は managed ファイルの欠落なので、
    # B4（manifest 記載ファイルの存在チェック）と同じ「harness update で復元する」を出す
    # （最終レビュー指摘: 前置きと直し方が状態と噛み合っていなかった。実機で再現）。
    report WARN "git hooks（core.hooksPath は .githooks に設定されているが .githooks/pre-commit が無い）" \
      "bash .harness/bin/harness update で復元する（.githooks/pre-commit は managed ファイル）"
  else
    # 存在（-f）だけでは足りない。git は**実行できないフックを黙って無視する**（hint が 1 行出るだけで
    # commit は成功する）ので、-f しか見ないと「pre-commit で速い検査が回っている」つもりのまま一度も
    # 回っていない状態に緑を出す（2026-09-20 に macOS 実機で発覚）。見るのは 2 つ。
    #   1. git index の mode … clone した先に配られる値。100644 なら、その先では実行ビットが付かない
    #   2. 作業ツリーの -x  … この PC で今フックが走るか
    # 2 は Windows の Git では意味を持たない（core.filemode=false が既定で、chmod しても記録されない）。
    # そこで filemode=false のときは 2 を見ない。1 は OS を問わず git が記録するので常に見る。
    hook_path="$ROOT/.githooks/pre-commit"
    hook_problem=""
    hook_tracked=0
    hook_index_mode="$(git -C "$ROOT" ls-files -s -- .githooks/pre-commit 2>/dev/null | awk '{print $1; exit}')"
    [ -n "$hook_index_mode" ] && hook_tracked=1
    if [ "$hook_tracked" = 1 ] && [ "$hook_index_mode" != "100755" ]; then
      hook_problem="git index 上の mode が ${hook_index_mode}（clone した先で実行ビットが付かず、そこでフックが黙って無視される）"
    fi
    hook_filemode="$(git -C "$ROOT" config --get core.filemode 2>/dev/null || true)"
    if [ "$hook_filemode" != "false" ] && [ ! -x "$hook_path" ]; then
      if [ -n "$hook_problem" ]; then
        hook_problem="作業ツリーに実行ビットが無く、${hook_problem}"
      else
        hook_problem="作業ツリーに実行ビットが無い（この PC ではフックが走らない）"
      fi
    fi
    if [ -n "$hook_problem" ]; then
      # 未追跡のファイルに git update-index は使えない（fatal になる）ので、直し方を場合分けする。
      if [ "$hook_tracked" = 1 ]; then
        hook_fix="chmod +x .githooks/pre-commit && git update-index --chmod=+x .githooks/pre-commit"
      else
        hook_fix="chmod +x .githooks/pre-commit"
      fi
      # 重大度は FAIL（決定 0007）。「フックが実行不可」は検査の門番が不在という状態であって
      # 劣化ではない。WARN のままだと doctor の総括行に WARN=1 が出るだけで harness check は
      # 緑のままになり、このリポジトリ自身が数セッション見逃したのと同じ見落とし方を許してしまう。
      # 配布 seed（harness/checks.seed.sh）には専用の検査を足さない。決定 0005 で seed に既に
      # 入っている「doctor: FAIL 0」がこの FAIL を自動的に拾うため（検査を二重に持たない）。
      report FAIL "git hooks: .githooks/pre-commit が実行できない状態（${hook_problem}）。git は実行できないフックを黙って無視するので、commit は成功するのに検査が走らない" \
        "$hook_fix"
    else
      report OK "git hooks（core.hooksPath=.githooks, .githooks/pre-commit は実行可能）"
    fi
  fi
fi

# ---------------------------------------------------------------- B7. AGENTS.md のマーカーと版
AGENTS_FILE="$ROOT/AGENTS.md"
if [ ! -f "$AGENTS_FILE" ]; then
  report FAIL "AGENTS.md が無い" \
    "bash .harness/bin/harness update をやり直すか、.harness/backup/ から復元する"
else
  begin_count="$(count_matches '<!-- harness:begin' "$AGENTS_FILE")"
  end_count="$(count_matches '<!-- harness:end -->' "$AGENTS_FILE")"
  if [ "$begin_count" -eq 0 ] && [ "$end_count" -eq 0 ]; then
    report FAIL "AGENTS.md に harness の管理ブロックのマーカーが無い（<!-- harness:begin v=X --> / <!-- harness:end -->）" \
      "bash .harness/bin/harness update をやり直すか、.harness/backup/ から復元する"
  elif [ "$begin_count" -ne 1 ] || [ "$end_count" -ne 1 ]; then
    # update は begin/end が複数あっても 1 対に畳む（決定 0002。手で整理させる必要はない。実測済み）。
    report FAIL "AGENTS.md のマーカーがちょうど 1 組ではない（begin=${begin_count}, end=${end_count}）" \
      "bash .harness/bin/harness update で 1 対に畳む（変更前の AGENTS.md は .harness/backup/ に退避される）"
  else
    agents_ver="$(sed -n 's/.*<!-- harness:begin v=\([^ ]*\) -->.*/\1/p' "$AGENTS_FILE" | head -1)"
    if [ "$manifest_ok" != 1 ]; then
      report WARN "AGENTS.md のマーカー（v=${agents_ver:-不明}）と manifest の harness_version の一致は、manifest が壊れているため確認できない" \
        "先に manifest（B3）を直してから、もう一度 harness doctor を回す"
    elif [ -n "$agents_ver" ] && [ "$agents_ver" = "$mf_version" ]; then
      report OK "AGENTS.md のマーカー（v=$agents_ver, manifest と一致）"
    else
      report WARN "AGENTS.md のマーカーの版（v=${agents_ver:-不明}）が manifest の harness_version（${mf_version:-不明}）と食い違う" \
        "bash .harness/bin/harness update で同期する"
    fi
  fi
fi

# ---------------------------------------------------------------- B8. Claude アダプタ
# manifest の agents に claude を含むときだけ実行する。含まないときは CLAUDE.md 等がそもそも
# 導入されていないので、何も報告しない（誤検知を避ける）。
case ",$mf_agents," in
  *,claude,*)
    if [ -f "$ROOT/CLAUDE.md" ] && grep -q '^@AGENTS\.md' "$ROOT/CLAUDE.md"; then
      report OK "CLAUDE.md に @AGENTS.md の import がある"
    else
      report FAIL "CLAUDE.md に @AGENTS.md の import が無い" \
        "bash .harness/bin/harness update をやり直すか、CLAUDE.md の先頭付近に @AGENTS.md を足す"
    fi

    if [ "$manifest_ok" = 1 ]; then
      skill_mismatch=0
      while IFS=$'\t' read -r f_path f_src f_own f_sha f_srcsha; do
        [ -z "$f_path" ] && continue
        case "$f_path" in .claude/skills/*) ;; *) continue;; esac
        rel="${f_path#.claude/skills/}"
        agents_side="$ROOT/.agents/skills/$rel"
        claude_side="$ROOT/$f_path"
        [ -f "$agents_side" ] || continue  # 欠落は B4 で報告済み
        [ -f "$claude_side" ] || continue  # 同上
        if ! content_eq "$agents_side" "$claude_side"; then
          skill_mismatch=$((skill_mismatch + 1))
          report WARN ".claude/skills/$rel が .agents/skills/$rel と内容がずれている" \
            "bash .harness/bin/harness update で同期する（.claude 側を直接編集していないか確認する）"
        fi
      done <<<"$mf_entries"
      [ "$skill_mismatch" -eq 0 ] && report OK ".claude/skills/* は .agents/skills/* と内容が一致する"

      # .claude/agents/*.md の欠落。B4 も個別に FAIL を出すが、B9（Codex）と同じ形で B8 としても
      # まとめて報告する（最終レビュー low 指摘: 欠落時に B8 が何も言わないと項目そのものが消えて見える）。
      claude_agents_missing=0
      while IFS=$'\t' read -r f_path f_src f_own f_sha f_srcsha; do
        [ -z "$f_path" ] && continue
        case "$f_path" in .claude/agents/*.md) ;; *) continue;; esac
        [ -f "$ROOT/$f_path" ] || claude_agents_missing=$((claude_agents_missing + 1))
      done <<<"$mf_entries"
      if [ "$claude_agents_missing" -eq 0 ]; then
        report OK ".claude/agents/*.md は manifest どおりに揃っている"
      else
        report FAIL "Claude アダプタの役割ファイルが足りない（.claude/agents/*.md が ${claude_agents_missing} 件欠落）" \
          "bash .harness/bin/harness update で復元する（復元できなければ bash .harness/bin/harness init をやり直す）"
      fi
    fi
  ;;
esac

# ---------------------------------------------------------------- B9. Codex アダプタ
# manifest の agents に codex を含むときだけ実行する。
case ",$mf_agents," in
  *,codex,*)
    if [ "$manifest_ok" = 1 ]; then
      codex_missing=0
      for f in .agents/skills/role-implementer/SKILL.md .agents/skills/role-reviewer/SKILL.md; do
        [ -f "$ROOT/$f" ] || codex_missing=$((codex_missing + 1))
      done
      if [ "$codex_missing" -eq 0 ]; then
        report OK "Codex アダプタ（role-implementer / role-reviewer）が揃っている"
      else
        report FAIL "Codex アダプタの役割スキルが足りない（role-implementer / role-reviewer）" \
          "bash .harness/bin/harness update で復元する（復元できなければ bash .harness/bin/harness init をやり直す）"
      fi

      # 標準 deny の hook（決定 0009）。**置いただけでは効かない**: (1) プロジェクトが trusted で、
      # (2) さらに hook 定義ごとに信頼されている必要がある（実測 2026-09-21 / Codex CLI 0.154.0。
      # trust_level だけでは hook が 1 つも発火しなかった）。つまり core.hooksPath と同じで
      # clone しただけでは効かないので、ここで見て直し方を案内する。
      if [ -f "$ROOT/.codex/hooks.json" ]; then
        codex_cfg="${CODEX_HOME:-${HOME:-}/.codex}/config.toml"
        if [ ! -f "$codex_cfg" ]; then
          report INFO "Codex の設定（${codex_cfg}）がこの PC に無いため、標準 deny の hook が効いているか確認できない" \
            "この PC で Codex を使うなら codex を一度起動する（設定が作られる）。使わないならこの行は無視してよい"
        else
          codex_trusted=0; codex_hook_trusted=0
          # [projects."<ROOT>"] セクションの中に trust_level = "trusted" があるか
          if awk -v key="[projects.\"${ROOT}\"]" '
                $0 == key { inside = 1; next }
                inside && /^\[/ { inside = 0 }
                inside && /trust_level[[:space:]]*=[[:space:]]*"trusted"/ { found = 1 }
                END { exit found ? 0 : 1 }
              ' "$codex_cfg" 2>/dev/null; then
            codex_trusted=1
          fi
          # hook 定義ごとの信頼は [hooks.state."<hooks.json の絶対パス>:<event>:..."] に記録される
          grep -qF "${ROOT}/.codex/hooks.json:" "$codex_cfg" 2>/dev/null && codex_hook_trusted=1
          if [ "$codex_trusted" = 1 ] && [ "$codex_hook_trusted" = 1 ]; then
            report OK "Codex の標準 deny hook（.codex/hooks.json）が信頼されている"
          else
            codex_why="プロジェクトが信頼されていない（trust_level）"
            [ "$codex_trusted" = 1 ] && codex_why="hook 定義が信頼されていない"
            report WARN "Codex の標準 deny hook が効いていない: ${codex_why}。破壊的な git 操作が Codex 側では機械的に止まらない（.githooks/ の門番は別途効いている）" \
              "このディレクトリで codex を起動し、プロジェクトの信頼を求められたら信頼したうえで /hooks で hook を信頼する（信頼は各 PC で 1 回。git には乗らない）"
          fi
        fi
      fi
    fi
  ;;
esac

# ---------------------------------------------------------------- B10. 版（source の新版）
# source の解決順は bin/harness と同じ: 環境変数 HARNESS_SOURCE > .harness/source.local >
# manifest.json の source（決定 0004）。manifest はコミットされる共有ファイルなので機械依存の
# 絶対パスを置かない。ここは診断だけなので、どの経路でもネットワークには触らない。
SOURCE_LOCAL="$ROOT/.harness/source.local"
eff_source=""; eff_source_from=""
if [ -n "${HARNESS_SOURCE:-}" ]; then
  eff_source="$HARNESS_SOURCE"; eff_source_from="環境変数 HARNESS_SOURCE"
elif [ -f "$SOURCE_LOCAL" ]; then
  eff_source="$(sed -e 's/\r$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$SOURCE_LOCAL" 2>/dev/null | head -1)"
  [ -n "$eff_source" ] && eff_source_from=".harness/source.local"
fi
if [ -z "$eff_source" ]; then eff_source="$mf_source"; eff_source_from="manifest.json の source"; fi

if [ "$manifest_ok" = 1 ]; then
  # manifest（共有ファイル）に機械依存の絶対パスが残っていたら、それ自体が問題。
  # 他の PC / 他の worktree で clone すると、update / diff / upstream が他人のツリーを見に行く。
  case "$mf_source" in
    http://*|https://*|ssh://*|git://*|git@*|"") ;;
    *) report WARN "manifest の source が機械依存の絶対パス（${mf_source}）。コミットされる共有ファイルなので、他の PC や worktree では辿れない" \
         "bash .harness/bin/harness update で manifest を共有値に直し、このパスを .harness/source.local（gitignore 対象）へ移す";;
  esac

  if [ -n "$eff_source" ] && [ -d "$eff_source" ] && [ -f "$eff_source/VERSION" ]; then
    # VERSION の中身は書式検証・長さ制限をしてから使う（最終レビュー low 指摘）。読み取り自体も
    # 200 バイトで打ち切り、版らしい形式でなければ内容を出力に載せずスキップする。
    src_version_raw="$(head -c 200 "$eff_source/VERSION" 2>/dev/null | tr -d '\r\n')"
    if ! looks_like_version "$src_version_raw"; then
      report WARN "source（${eff_source}。${eff_source_from}）の VERSION が版番号の形式ではない（先頭: $(printable_snippet "$src_version_raw" 24)）。新版の確認をスキップした" \
        "source の VERSION ファイルの中身を確認する（1 行に版番号だけを書く形が正しい）"
    elif [ "$src_version_raw" != "$mf_version" ]; then
      report INFO "source（${eff_source}。${eff_source_from}）に新版 $src_version_raw がある（導入済みは ${mf_version}）" \
        "bash .harness/bin/harness update で追従する（別 ref を使うときは --ref を付ける）"
    else
      report OK "source の版は導入済みと同じ（${mf_version}。$eff_source_from = ${eff_source}）"
    fi
  else
    # ここを OK と言い切らない。source が辿れないと update / diff / upstream が動かない（または
    # 毎回 clone しに行く）ので、直し方まで出す。診断側からネットワークへは出ない。
    report WARN "source（${eff_source}。${eff_source_from}）がこの PC のローカルディレクトリとして辿れず、新版を確認できない（診断はネットワークに触らない）" \
      "agent-harness を clone し、その絶対パスを機械ローカルの上書きに書く: echo '<clone した絶対パス>' > .harness/source.local （gitignore 対象＝コミットしない）／一度きりなら HARNESS_SOURCE=<絶対パス> を付けて実行する"
  fi
fi

# ---------------------------------------------------------------- B11. gitignore
GITIGNORE="$ROOT/.gitignore"
gi_missing=""
for entry in ".harness/state/" ".harness/backup/" ".harness/conflicts/" ".harness/source.local"; do
  if [ -f "$GITIGNORE" ] && grep -qxF "$entry" "$GITIGNORE"; then
    :
  else
    gi_missing="$gi_missing $entry"
  fi
done
gi_missing="${gi_missing# }"
if [ -z "$gi_missing" ]; then
  report OK ".gitignore に .harness/state|backup|conflicts/ と source.local がある"
else
  report WARN ".gitignore に無いエントリ: $gi_missing" \
    ".gitignore に「${gi_missing}」を追記する"
fi

# ---------------------------------------------------------------- B12. 配布先の case 衝突（tech-debt #13 / #14）
# case を区別しないファイルシステム（macOS / Windows）では、harness の配布先パスと大文字小文字
# 違いの既存ファイルが同じもの扱いになる。seed は apply_plan がそれを「既にある」として雛形を
# 配らないが manifest には配布先の名前で記録される（tech-debt #13。2026-09-21、実プロジェクトへの
# 導入で発見）。managed（.githooks/pre-commit を含む）・generated
# （.claude/agents/*.md 等の役割ファイル。生成元は docs/roles/）も同じ理由で衝突しうる。
# apply_plan は managed と generated を全く同じ経路（case 非依存の `[ -f ]` 判定）で扱うので、
# 両方とも一般の CONFLICT として .harness/conflicts/ へ逃がすだけで、実際に使われているのは
# 既存の大文字小文字違いファイルの内容のまま（managed は tech-debt #14。onboarding-polish
# 最終レビューの反証役が実機確認: .githooks/Pre-commit を先に置いて init すると、seed 分岐の
# CASE-CONFLICT ではなく汎用の CONFLICT に逃げるだけで、doctor は git hooks の実行ビット等しか
# 見ないため「OK」を恒久的に返し続けた。generated も同型で、no-silent-failures 最終レビュー
# 指摘 S2 で発見: 大文字違いの無関係な既存ファイルを混入させて init すると、B8 の
# 「.claude/agents/*.md は manifest どおりに揃っている」は存在確認しかしていないため、実際には
# harness が生成した内容ではない別ファイルが使われているのに恒久的に OK を返していた）。
# どれも case を区別する環境（Linux 等）に持っていくと 2 つのファイルが併存する。
#
# 判定ロジックは harness/scripts/seed-case.sh（bin/harness と共有。導入コピーでは
# .harness/scripts/seed-case.sh としてこのファイルの隣に配られる）。判定そのものは ownership に
# 依存しないので、seed / managed / generated の 3 つをこの 1 か所の走査で見る（同じロジックを
# 複数箇所に複製しない）。この節は、この環境が case を区別しない場合だけ動く。区別する環境では
# 別ファイルとして正しく共存するので、何も報告しない（B3。Codex アダプタの B9 が agents を見て
# 出し分けるのと同じ作法）。
#
# 重大度: seed は WARN（据え置き。二重になるのは docs の雛形だけ）。managed / generated も基本は
# WARN だが、.githooks/pre-commit だけは FAIL にする。理由: harness check が赤くなる経路は決定
# 0005 の `doctor: FAIL 0` だけなので、WARN のままでは check が緑のまま＝この題材が塞ぎたい
# 「偽の緑」がそのまま残る。.githooks/pre-commit は決定 0007 が「フックが実行不可なら FAIL」と
# した対象そのもので、case 衝突は「実行不可」よりさらに悪い「harness が中身を保証できない別
# ファイルが使われる」状態なので、同じ結論（FAIL）が自然に伸びる。他の managed / generated
# ファイルの case 衝突は安全装置の迂回ではなく機能欠落の一種なので、seed 側の B12（WARN）と
# 同じ扱いに揃える（generated が役割ファイルであっても、.githooks/pre-commit のような検査の
# 門番そのものではないので、これも他の managed ファイルと同じ WARN でよい）。
if [ "$manifest_ok" = 1 ]; then
  seed_case_lib="${DOCTOR_DIR:-}/seed-case.sh"
  if [ -n "$DOCTOR_DIR" ] && [ -f "$seed_case_lib" ]; then
    # shellcheck source=./seed-case.sh
    . "$seed_case_lib"
    seed_ci=0
    fs_case_insensitive "$ROOT" && seed_ci=1
    if [ "$seed_ci" = 1 ]; then
      seed_conflicts=0
      managed_conflicts=0
      while IFS=$'\t' read -r f_path f_src f_own f_sha f_srcsha; do
        [ -z "$f_path" ] && continue
        case "$f_own" in
          seed | managed | generated) ;;
          *) continue ;;
        esac
        case_existing="$(seed_case_collision "$ROOT" "$f_path" "$seed_ci" 2>/dev/null || true)"
        [ -n "$case_existing" ] || continue
        if [ "$f_own" = "seed" ]; then
          seed_conflicts=$((seed_conflicts + 1))
          report WARN "seed の配布先 $f_path が既存の $case_existing と case 違いで衝突している（$(case_collision_reason "$f_path" "$case_existing" seed)）" \
            "$(case_collision_fix "$f_path" "$case_existing")"
        else
          # managed / generated: apply_plan は同じ経路で扱うので、判定・重大度もここで揃える。
          managed_conflicts=$((managed_conflicts + 1))
          if [ "$f_own" = "managed" ] && [ "$f_path" = ".githooks/pre-commit" ]; then
            report FAIL "managed の配布先 $f_path が既存の $case_existing と case 違いで衝突している（$(case_collision_reason "$f_path" "$case_existing" managed)）" \
              "$(case_collision_fix "$f_path" "$case_existing")"
          else
            report WARN "${f_own} の配布先 $f_path が既存の $case_existing と case 違いで衝突している（$(case_collision_reason "$f_path" "$case_existing" "$f_own")）" \
              "$(case_collision_fix "$f_path" "$case_existing")"
          fi
        fi
      done <<<"$mf_entries"
      [ "$seed_conflicts" -eq 0 ] && report OK "seed の配布先に大文字小文字違いの衝突は無い（この環境は case を区別しない）"
      [ "$managed_conflicts" -eq 0 ] && report OK "managed / generated の配布先に大文字小文字違いの衝突は無い（この環境は case を区別しない）"
    fi
  fi
fi

# ---------------------------------------------------------------- 集計
echo
echo "harness doctor: OK=$n_ok WARN=$n_warn FAIL=$n_fail INFO=$n_info"
if [ "$n_fail" -gt 0 ]; then
  echo "  FAIL の行の「→」に従って直す。直せたらもう一度 harness doctor を回す。"
  exit 1
fi
exit 0
