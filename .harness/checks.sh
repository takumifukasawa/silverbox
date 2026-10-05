# .harness/checks.sh — このプロジェクトの検査一覧（seed: プロジェクトが編集する。harness update は触らない）
#
# 書式:  check [fast] "<表示名>" "<コマンド>"
#   fast を付けた検査は pre-commit（harness check --fast）でも走る。数秒で終わるものだけに付ける。
#
# 原則:
# - 各コマンドの失敗出力には「どう直すか」「どの doc を読むか」を含める。
# - 検査は「回避手段」も見る。テスト 0 件で green、除外リストへの追記、フラグ ON 設定の追加 など、
#   通すための抜け道を同じ検査で塞ぐ。エージェントの自己申告ではなく実行結果で判定するのが目的。
# - 機械で判定しきれない項目は自動 pass にせず「要確認」として人間に回す（例: 共有テーブルの変更、画面側のフラグ漏れ）。

# --- 例（SmartHR の 12 項目から。プロジェクトに合わせて書き換える） ---
# check fast "lint"                 "npm run lint"
# check fast "typecheck"            "npm run typecheck"
# check      "tests green (>0)"     "out=\$(npm test -- --json 2>&1); n=\$(echo \"\$out\" | jq .numTotalTests); [ \"\$n\" -gt 0 ] || { echo 'テストが 0 件。0 件で green は不合格。受け入れ条件をテストに落とす。'; exit 1; }"
# check      "flag OFF = baseline"  "bash scripts/check-flag-off-behavior.sh"        # フラグ ON 設定の追加も検知
# check      "changed files in scope" "bash scripts/check-allowed-paths.sh .harness/allowed-paths.txt"  # 許可パスの定義は 1 ファイルだけ
# check      "no new dep violations" "bash scripts/check-dependency-direction.sh"      # 除外リストへの追記も検知。docs/architecture.md の不変条件
# check      "TDD trace in commits"  "bash scripts/check-tdd-trace.sh"                 # test → impl の順にコミットがあるか
# check      "NEEDS HUMAN: shared tables" "git diff --name-only origin/main | grep -q '^db/schema' && { echo '要確認: 共有テーブルの変更あり。人間がレビュー。'; exit 1; } || true"

check fast "docs index exists" "test -f docs/README.md || { echo 'docs/README.md が無い。docs の索引。agent-harness の docs-template/README.md から作る。'; exit 1; }"
check fast "no personal paths staged" "bash scripts/check-no-personal-paths.sh"
check fast "unit tests (vitest)" "npx vitest run || { echo 'Unit tests failed. Fix the failing test or the code under test; never skip/delete tests to go green.'; exit 1; }"
check      "typecheck"         "npm run -s typecheck || { echo 'tsc reported errors (node + web projects). Fix the types; do not add ts-ignore to pass.'; exit 1; }"
check      "doctor: FAIL 0"    "bash .harness/bin/harness doctor || { echo 'doctor が FAIL を報告した。上の FAIL 行の「→」に従って直す。'; exit 1; }"
