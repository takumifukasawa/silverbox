#!/usr/bin/env bash
# harness/scripts/seed-case.sh — 判定: 配布先と大文字小文字違いの既存ファイルの衝突
# （seed は tech-debt #13、managed は tech-debt #14）
#
# source して使う（実行はしない。関数を定義するだけで副作用は無い）。
#   . harness/scripts/seed-case.sh          # 正本（bin/harness の apply_plan から、$PAYLOAD 経由で読む）
#   . "$(dirname "$0")/seed-case.sh"        # 導入コピー（plan() が .harness/scripts/ へ自動配布するので
#                                             #   doctor.sh の隣に必ず置かれる）
#
# 背景: case を区別しないファイルシステム（macOS / Windows）では、既存の docs/HANDOFF.md が
# あると seed の docs/handoff.md の配布が `[ -f docs/handoff.md ]` で「既にある」と判定されて
# スキップされる。にもかかわらず manifest には docs/handoff.md として記録される。case を区別する
# Linux に持っていくと、その名前のファイルが本当に無いと判定されて harness update が雛形を新たに
# 配り、HANDOFF.md と handoff.md が併存する（docs/tech-debt.md #13。2026-09-21、実プロジェクトへの
# 導入で発見。その場は git mv で寄せて解消した）。
#
# 判定そのものは ownership に依存しない（「配布先のパスと case 違いの既存ファイルがあるか」を
# 見ているだけ）。managed（.githooks/pre-commit 等）も同じ判定で衝突しうる: 既存に case 違いの
# 無関係なファイルがあると、apply_plan は seed 分岐の CASE-CONFLICT ではなく汎用の CONFLICT
# として .harness/conflicts/ に逃がすだけで、harness doctor は「OK」を返し続ける
# （docs/tech-debt.md #14。onboarding-polish 最終レビューの反証役が実機確認）。
#
# bin/harness（apply_plan。init / update の出力）と harness/scripts/doctor.sh の両方がこの判定を
# 使う。どちらも元々は独立した bash スクリプトで共通処理を source する形は無かったが、この判定は
# テストから単体で呼べる必要があり（下記）、複数箇所に複製すると実装がずれたときに気付けない。
# plan() は harness/scripts/*.sh をそのまま .harness/scripts/*.sh として配るので、この選択で
# 導入先にも自動的に同梱される（plan() 自体の変更は不要）。
#
# テスト容易性: 「このファイルシステムが case を区別するか」は実 FS の挙動そのものなので、
# テストから切り替えられない。そこで判定を 2 段に分ける。
#   1. fs_case_insensitive() … 実 FS を、呼び出し側が渡したディレクトリ配下で確かめる。
#      戻り値はホスト環境（とプローブ先のボリューム）に依存するので、テストはこの関数の
#      戻り値そのものは当てにしない。
#   2. seed_case_collision() … 衝突の有無を決める純粋ロジック。「case を区別しないか」は
#      呼び出し側が 1. の結果を引数 ci で渡す。テストは ci を固定するので、実ホストの FS が
#      どちらであっても「衝突あり / 衝突なし / case を区別する環境」の 3 系統を再現できる。
#      ファイル名の一致は `find -name` / `-iname`（readdir が返す生のファイル名どうしの文字列比較。
#      パス解決時に OS が行う case フォールディングは経由しない）で見るので、この判定自体は
#      ホストの実 FS が case を区別するかどうかに左右されない
#      （実機確認 2026-09-21, macOS 15 / APFS 既定ボリューム: `FOO.txt` のみが存在する状態で
#       `[ -e foo.txt ]` は真になるが、`find . -name foo.txt` は `FOO.txt` を拾わない）。
#
# 最終レビュー指摘（2026-09-21）の修正:
#   X1. fs_case_insensitive() は元々 `mktemp -d`（OS 既定の一時ディレクトリ）でプローブして
#       いたが、判定したいのは「seed を配る $ROOT のあるボリュームが case を区別するか」であり、
#       OS 既定の一時ディレクトリが別ボリュームなら判定を取り違える（`TMPDIR` を設定しても
#       macOS の `mktemp -d` は `_CS_DARWIN_USER_TEMP_DIR` を優先するため回避できない。man mktemp）。
#       偽陽性（case を区別する $ROOT なのに誤検出）は git mv を促すのでデータ損失リスクになる。
#       そこで呼び出し側が「プローブ先のディレクトリ（= $ROOT）」を引数で渡す形にした。
#   C1. seed_case_collision() は、ディレクトリ名だけ case 違いでファイル名は完全一致する
#       ネストケース（既存 docs/Plans/README.md、seed 配布先 docs/plans/README.md）を検出
#       できなかった。dirname/basename で「最後の 1 段」だけを見ていたため、ファイル名が
#       一致すると常に「衝突ではなく配布済み」と判定してしまっていた。パスを 1 段ずつ root から
#       歩き、途中の段で完全一致が無ければそこを衝突として報告する形に直した。
#   X2. `find ... -iname | head -1` は、case 違いの候補が 3 つ以上あるとき、どれを報告するかが
#       find 実装（BSD/GNU/MSYS）依存で非決定的だった。`LC_ALL=C sort` してから先頭を取る。

# このファイルシステムは case を区別しないか。
# root（プローブ先。呼び出し側は $ROOT を渡す）配下に隠しディレクトリを作り、小文字のファイルを
# 置いて大文字名で -e を見る。判定できなければ「区別する」側へ倒す（誤検出を避ける。
# 区別する環境・root が使えない環境では何も報告しない）。
# 戻り値: 0 = 区別しない（衝突の可能性がある） / 1 = 区別する、または判定不能
fs_case_insensitive() { # root
  local root="$1" d insensitive=1
  [ -n "$root" ] && [ -d "$root" ] || return 1
  d="$(mktemp -d "$root/.harness-case-probe.XXXXXX" 2>/dev/null)" || return 1
  : >"$d/harness-case-probe" 2>/dev/null || { rm -rf "$d" 2>/dev/null; return 1; }
  [ -e "$d/HARNESS-CASE-PROBE" ] && insensitive=0
  rm -rf "$d" 2>/dev/null
  return "$insensitive"
}

# root: プロジェクトルート（絶対パス）
# dest_rel: seed の配布先（root からの相対パス。例: docs/handoff.md、docs/plans/README.md）
# ci: 呼び出し側が渡す「この環境は case を区別しないか」（1 = 区別しない / それ以外 = 区別する）
#
# dest_rel を root から 1 段ずつ歩き、各段で完全一致するエントリがあればそこへ進む。完全一致が
# 無い段で大文字小文字違いのエントリが見つかれば、そこから先（既存側の実際の大文字小文字）を
# たどれるところまでたどった実パス（root からの相対）を 1 行標準出力して 0 を返す
# （ディレクトリ名だけの食い違いでも、ファイル名だけの食い違いでも同じ経路で検出する）。
# 途中で何も見つからない、または dest_rel のすべての段が完全一致で存在する（= seed が
# 既に配布済みというだけ）場合は、何も出力せず 1 を返す。
seed_case_collision() {
  local root="$1" dest_rel="$2" ci="$3"
  [ "$ci" = "1" ] || return 1
  [ -d "$root" ] || return 1

  local segs seg cur exact ci_match mismatch=0 i n
  IFS='/' read -r -a segs <<<"$dest_rel"
  n="${#segs[@]}"
  cur="$root"
  for ((i = 0; i < n; i++)); do
    seg="${segs[$i]}"
    [ -n "$seg" ] || continue
    [ -d "$cur" ] || return 1
    exact="$(find "$cur" -maxdepth 1 -name "$seg" 2>/dev/null | head -1)"
    if [ -n "$exact" ]; then
      cur="$exact"
      continue
    fi
    # 完全一致が無い。大文字小文字違いのエントリがあれば、そこが衝突。3 つ以上あっても
    # 報告する対象を find の実装に依存させない（ソートして先頭を取る。X2）。
    ci_match="$(find "$cur" -maxdepth 1 -iname "$seg" 2>/dev/null | LC_ALL=C sort | head -1)"
    if [ -z "$ci_match" ]; then
      # ここより深いパスは何も無い。それまでに mismatch を見つけていればそこまでを報告する。
      if [ "$mismatch" = 1 ]; then
        printf '%s\n' "${cur#"$root"/}"
        return 0
      fi
      return 1
    fi
    mismatch=1
    cur="$ci_match"
  done

  if [ "$mismatch" = 1 ]; then
    printf '%s\n' "${cur#"$root"/}"
    return 0
  fi
  return 1
}

# 衝突の説明文・直し方（bin/harness と doctor.sh で文言を揃えるための共通ヘルパー。
# ownership（seed / managed / generated）で説明文の中身だけを出し分ける。直し方は git mv で共通。
# B4（tech-debt #14 受け入れ条件）: 利用者から見て「seed の検出」と「managed の検出」が
# 2 つの別物に見えないよう、語彙（「case 違いで衝突している」「git mv ... で寄せる」）と
# 直し方はどちらも同じ関数から出す）。generated（no-silent-failures 最終レビュー指摘 S2）は
# apply_plan が managed と全く同じ経路で扱うため、語彙は managed と揃え、対象だけ言い換える。
case_collision_reason() { # dest_rel existing_rel kind(seed|managed|generated。省略時 seed)
  local dest="$1" existing="$2" kind="${3:-seed}"
  case "$kind" in
    managed)
      printf 'この環境は大文字小文字を区別しないため、managed の配布先 %s は既存の %s と同じファイル扱いになっている。harness init / update はそれを一般の CONFLICT として .harness/conflicts/ へ退避するだけで、実際に使われているのは既存の %s の内容のまま。case を区別する環境（Linux 等）に持っていくと、%s と %s が別ファイルとして併存する（tech-debt #14）' \
        "$dest" "$existing" "$existing" "$existing" "$dest"
      ;;
    generated)
      printf 'この環境は大文字小文字を区別しないため、generated（役割ファイル等の生成物。生成元は docs/roles/）の配布先 %s は既存の %s と同じファイル扱いになっている。harness init / update はそれを一般の CONFLICT として .harness/conflicts/ へ退避するだけで、実際に使われているのは既存の %s の内容のまま（harness は中身を保証できない）。case を区別する環境（Linux 等）に持っていくと、%s と %s が別ファイルとして併存する' \
        "$dest" "$existing" "$existing" "$existing" "$dest"
      ;;
    *)
      printf 'この環境は大文字小文字を区別しないため、seed の配布先 %s は既存の %s と同じファイル扱いになっている。雛形は配っていないが manifest には %s として記録される。case を区別する環境（Linux 等）に持っていくと、%s と %s が別ファイルとして併存する（tech-debt #13）' \
        "$dest" "$existing" "$dest" "$dest" "$existing"
      ;;
  esac
}
case_collision_fix() { # dest_rel existing_rel
  printf 'git mv %s %s で寄せる（内容を確認してから。自動では変更しない）' "$2" "$1"
}
