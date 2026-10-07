---
name: task-orchestrate
description: 1 つのコンテキストに収まらない大きな機能・タスクを、統括（このセッション）/ 実装役（1 タスク 1 体）/ レビュアー（最後に 1 回）/ 機械検査 の役割分離で進める。準備 → 反復 → 最終レビュー の 3 フェーズを .harness/state/ の JSON で管理し、セッションを切っても続きから再開できる。発火例 - "この機能をハーネスのワークフローで進めて", "タスク分解して 1 つずつ実装させて", "オーケストレータとして進めて", "task-orchestrate", "続きのタスクを進めて", "最終レビューを回して", "/task-orchestrate <spec のパス>"。小さな変更（1 セッションで終わる）には使わない。
---

# task-orchestrate — 統括として大きなタスクを回す

このセッションが**統括（orchestrator）**になる。役割の定義は `docs/roles/`、原則は `AGENTS.md`。ここには**手順**だけ書く。
CLI は `bash .harness/bin/harness <cmd>`（以下 `harness` と略す。PATH に無くてもこの形で動く）。

守ること（役割文より優先度が高い 3 つ）:
1. **自分で実装しない。** 実装も修正も、毎回新しい実装役に渡す。落ちた検査の原因を探るために読むのは、検査出力が指す行の引用まで。
2. **spec 本文とレビュー全文を自分の文脈に載せない。** 例外は準備フェーズ（§1）だけ。合意形成のために spec を読むが、反復に入ったら節見出しと受け入れ条件だけを持つ。
3. **完了判定は検査・git・状態の 3 点を自分で確認して決める。** 実装役の「できました」も、戻り値の `commit` も、判定材料にしない。

## 進捗を聞かれたら

**`harness eta` を叩く。** 推測で答えない。完了数 / 全体数、経過時間、残りの推定（実測の最小〜最大の幅）、推定完了時刻を出す。実績が足りなければ「不明」と言う（数字を捏造しない）。外部ツールに渡すなら `harness eta --json`。
記録は `harness task start/done` で貯まる（§2.1 / §2.3 / §3）。**叩き忘れたタスクは `eta` が「記録が欠けている」と指摘する。**

## 0. 毎ターンの最初にやること

1. `.harness/state/progress.json` を読む。
   - 無い → §1 へ。
   - JSON として壊れている → **上書きせず止まる**。`git log --oneline` と `docs/plans/active/` から状態を再構成した案をユーザーに示し、承認後に書き直す。
2. `mkdir -p .harness/state/reports`（再開時に無いことがある）。
3. `phase` で分岐する。
   - `prepare` → §1 の続き。`open_questions` に残っている項目から再開する。
   - `iterate` → `stages.json` から **`current_task` のタスクだけ**を取り出して読む（他のタスクは開かない）。`jq` があれば `jq '.tasks[] | select(.id=="T03")' .harness/state/stages.json`、無ければ `grep -n '"id": "T03"'` で行を特定し、そのタスクの範囲だけを読む。
   - `review` → §3 の続き。
   - `done` → ユーザーの承認待ち。何もしない。
4. **実態との突合**: `git log --oneline <base_commit>..HEAD` と `git status --porcelain` を見る。
   - `status: in_progress` のタスクがあり、その task_id のコミットが既にある → 前のセッションが途中で死んだ。§2.3 の判定からやり直す（実装役は起こさない）。
   - state に無いコミットがある、または state にあるコミットが無い → 食い違いをユーザーに報告してから直す。

## 1. 準備フェーズ（ユーザーとの合意が必須）

1. **状態を作る**（無いとき）: `.harness/state-template/progress.json` と `stages.json` を `.harness/state/` にコピー。作業ブランチを作るか現ブランチを確認して `branch` に、`git rev-parse HEAD` を `base_commit` に、`phase: "prepare"`。
2. **spec を読む**: `docs/spec/` の対象 spec。無ければユーザーの依頼を `docs/spec/<slug>.md` に spec の形（目的・受け入れ条件・範囲外・未確定）で書き起こす。ここで読んでよいのは**受け入れ条件と未確定事項に関わる節**。実装の詳細まで頭に入れない。
3. **乖離を潰す**: 依頼内容と spec の違い、曖昧な箇所、未確定事項を**1 件ずつ**ユーザーに確認する。まとめて聞かない。合意した結果は spec に**書き戻す**。規律に関わる合意（ロックの取り方、やらないこと）は該当パスの `AGENTS.md` に書く。該当パスに `AGENTS.md` が無ければ作る。規律が本当に無いなら「規律はルート AGENTS.md のみ」と明示できる状態にする。
4. **設計判断**: 複数案あるものは `docs/decisions/NNNN-*.md` に採用案・落選案・理由。
5. **止まる条件**: 乖離が 1 件でも未解決なら次に進まない。`progress.json` の `open_questions` に残し、`phase` は `prepare` のままセッションを終える。
6. **タスク分解**: 1 タスク = 1 セッションで終わる粒度。依存順に並べ、各タスクに次を付けて `stages.json` に書く。
   - `acceptance`: 受け入れ条件。文で数件。「設定で無効にしている対象には作成できない」程度の粒度。テストに落とせる形。
   - `spec_refs`: 読ませる spec の節（`docs/spec/x.md#見出し`）。
   - `rules`: 守らせる規律ファイル（該当パスの `AGENTS.md`）。無い場合は空配列にし、指示に「規律はルート AGENTS.md のみ」と書く。
   - `files_scope`: 触ってよい範囲。
   - `depends_on`: 先に終わっていなければならないタスク id。
   - `model`: そのエージェントで有効なモデル名。設計余地あり（データモデル・状態遷移）→ 上位、決まった型で足す・テスト追加 → 下位。**Claude / Codex ともタスク単位で指定できる**（Claude はサブエージェント起動時に、Codex は `codex exec --model <MODEL>` で）。`inherit` は「起動時に指定しない」の意味で、Claude Code ではサブエージェント既定（`CLAUDE_CODE_SUBAGENT_MODEL`、未設定なら Claude Code の既定）になり、メインセッションと同じモデルになるとは限らない。**分解案をユーザーに提示するとき、この `model` も一緒に示す**（合意の対象）。
7. **検査を用意する**: 各タスクの `acceptance` が `.harness/checks.sh` の検査で判定できるかを確認し、足りなければ検査を登録する（テスト実行、テスト件数 > 0、変更ファイルが `files_scope` 内、依存方向、フラグ OFF で既存挙動）。seed 直後の `checks.sh` にはプロダクトの検査が 0 件（`harness check` が NOTE を出す）。**このままだと検査は常に pass し、完了判定が空洞化する。**
8. **分解案をユーザーに提示して合意**を取る。合意したら `phase: "iterate"`、`current_task` を最初のタスクに、`progress.total` をタスク数に。`docs/plans/active/<slug>.md` を作り、`progress.plan` にそのパスを入れ、`docs/handoff.md` から参照する。

## 2. 反復フェーズ（1 セッション = 1 タスク）

### 2.1 実装役を起動する

まず `stages.json` の該当タスクを `status: "in_progress"`、`progress.current_task` を更新する（セッションが死んでも §0 で再開点が分かる）。
**続けて `harness task start <task_id>` を叩く**（所要時間の記録。これが無いと `harness eta` が「記録が欠けている」と言う）。

**毎回新しい 1 体**。前のタスクや前の試行を担当した実装役を続けて使わない。渡すのは次の内容だけ（spec 全体・他タスク・レビューの話は渡さない）。

```
task_id: T03
title: <タイトル>
読む spec の節: docs/spec/x.md#見出し（この節だけ。spec 全体は読まない）
守る規律: src/api/AGENTS.md の全文を以下に貼る
  <ここに規律ファイルの内容をそのまま貼る。無ければ「規律はルート AGENTS.md のみ」>
受け入れ条件:
  - ...
触ってよい範囲: src/api/**, spec/api/**
やり方: TDD（失敗するテスト → 通す最小実装 → 整える）。各段階でコミット。コミットメッセージに task_id を入れる。
検査: 終わったら `bash .harness/bin/harness check` を**前面（フォアグラウンド）で**回し、出力を report に貼る。裏プロセスで走らせて自分の完了待ちにすると止まる。
CHANGELOG: 利用者に影響する変更を入れたら `CHANGELOG.md` の `[Unreleased]` に書く（挙動変更と「プロジェクト側で必要な作業」）。不要なら report に「不要」と書く。
返すもの（これ以外は report に書く）: status(done|blocked|failed), commit, questions[], report_path, note_for_next
report_path: .harness/state/reports/T03.md
質問はしない: 疑問は questions に書いて返す。
```

規律を**貼る**のは、Codex ではサブディレクトリの `AGENTS.md` が cwd 基準でしか読み込まれないため。パスだけ渡すと載らない。

起動手段はエージェントで異なる。役割文は同じ（`docs/roles/implementer.md`）。
- Claude Code: `implementer` サブエージェント（`.claude/agents/implementer.md`）を、上の指示を本文にして起動する。モデルは `stages.json` の `model` を起動時に指定する。
- Codex: `codex exec --sandbox workspace-write --model <stages.json の model>` で `$role-implementer` を呼び、上の指示を渡す。統括と同じスレッドで続けない。**`< /dev/null` を付ける**（付けないと stdin を読もうとして止まる。`harness/adapters/codex/README.md`）。
- サブエージェント機構が無い環境: ユーザーに「新しいセッションで `role-implementer` を起動し、この指示を貼る」と依頼し、戻り値を受け取る。

### 2.1b 実装役が走っている間にコミットしない（守れないなら add は明示指定）

**実装役と統括は同じ作業ツリーを共有している。** 実装役が編集中のファイルは、統括の `git add -A` に巻き込まれる。

2026-09-28 に実際に起きた: 統括が docs だけをコミットしたつもりが、実装役が編集中だった実装ファイル 2 つ（138 行）が同じコミットに入り、**コミットメッセージと内容が食い違った**。そのときは実装役が Green の状態だったので内容は無事だったが、**Red の途中なら壊れたコードがコミットされる**。

- **待てるなら、実装役が戻るまでコミットしない**
- **待てないなら、`git add -A` を使わず触ったファイルを明示指定する**
- コミット前に `git status --porcelain` を見て、**自分が触っていないファイルが出ていないか**確認する

### 2.2 戻り値を受け取る

- 戻り値が**空・不正・読めない**なら fail 扱い。転記せず §2.3 の実態確認へ進む。
- 正常なら `status` はタスク直下の `status` に、`commit` / `questions` / `report_path` / `note_for_next` は `result` に転記する。**report の本文は開かない。**
- `questions` があれば、統括が答えられるもの（spec に書いてある）は spec の節を指して次の試行に渡し、答えられないものは `progress.json` の `open_questions` に入れてユーザーに聞く。

### 2.3 完了を自分で判定する（3 点すべて）

1. **検査**: `bash .harness/bin/harness check` を自分で叩く。終了コードで分岐する。
   - `0` → 検査 pass。ただし **pass 件数がそのタスクの受け入れ条件を覆っていなければ done にしない**（§1.7 で登録した検査が走っているか出力で確認する）。
   - `1` → 検査 fail。§2.4 へ。
   - `2` 以上 → **環境不備**（`checks.sh` が無い等）。実装役を起こさず、`retry_count` も進めず、ユーザーに報告する。
2. **git**: `git log --oneline <base_commit>..HEAD` に task_id を含むコミットがあること。`git status --porcelain` が空であること（未コミットの変更を残して「done」と言われても認めない）。
3. **状態**: 戻り値の `status` が `done`。

3 点そろったら **done**: **`harness task done <task_id>` を叩き**、タスクの `status: "done"`、`progress.done` を +1、`done_summaries` に 1 行、`current_task` を依存順で次のタスクへ、`retry_count: 0`。`docs/plans/active/<slug>.md` の進捗に 1 行。**3 行で実装内容を報告してセッションを終える。** 統括のセッションは再試行の間は切らないが、タスクが完了したら切る（次のタスクに文脈を持ち越さないため）。

### 2.4 fail のとき

- `retry_count` を +1。**新しい実装役**を起こし、§2.1 の指示に「前回落ちた検査の出力（そのまま）」と「前回の report_path」を足して渡す。前回の実装役の思考や会話は渡さない。
- `retry_count` が 3 になったら止める。タスクを `status: "blocked"` にし、`open_questions` に「T03: 検査 X が 3 回通らない。出力: ...」と書き、ユーザーに判断を返す。検査を弱めて通す提案はしない。

### 2.5 区切りでの追加確認

`depends_on` の合流点、または数タスクごとに、関係する spec 全体のテストをフル実行する。画面を作ったタスクの後は、ユーザーに目視確認を依頼する。結果は `progress.json` の `done_summaries` に 1 行。

### 2.6 途中で確定したことの書き戻し

確定した仕様は spec へ、規律は該当 `AGENTS.md` へ、実装上の不変条件はコードのコメントへ。JSON に残すのは `unconfirmed_assumptions`（未確定の前提）、`open_questions`（未回答）、各タスクの `note_for_next`（次への注意点 1 行）だけ。書き戻す先が無い決定は記録しない。

## 3. 最終レビュー（全タスク完了後に 1 回だけ）

1. 全タスクが `done` であることを確認する。`blocked` が 1 つでも残っていればレビューに入らず、ユーザーに返す。`phase: "review"`。**`harness task start review` を叩く**（レビューも所要時間を記録する。終わったら `harness task done review`）。
2. **観点別に起動**する（毎タスクでは起動しない）。既定の 4 観点は `docs/roles/reviewer.md`: 仕様突合 / 並行性 / 認可 / 機能の完結性。各レビュアーに渡すのは「観点」「差分範囲 `base_commit..HEAD`」「spec の該当節」「報告の形式（場所・問題・コード上の証拠・再現手順・重大度・修正コスト高/低）」「報告の書き先 `.harness/state/reports/review-<spec|concurrency|authz|completeness>.md`」。統括が受け取るのは**要約（件数・重大度・場所・見出し・修正コスト高/低）だけ**。**修正コストを要約に含めるのは、4 の反証の条件を統括が report 本文を開かずに判定するため**（入っていなければ本文を開かず当人に聞き返す）。
   - **モデルは既定で下位**（統括だけ上位を保つ）。レビュアーも反証役も根拠を「コードの該当行かテストの出力」に縛ってあるので下位で足りる。**上位モデルを観点ぶん並列に起動するとセッションのレート上限に当たり、途中で止まる**（実測: 4 体中 3 体が起動直後に停止し、報告は 1 件も残らなかった）。
   - Claude Code: `reviewer` サブエージェントを観点ごとに 1 体、1 メッセージで並列起動。止まったら破棄せず、上限のリセット後に同じエージェントへ「中断地点から再開」を送る（文脈を保ったまま続きを書かせられる）。
   - Codex: 観点ごとに別スレッドで `$role-reviewer`。
   - 機構が無い環境: ユーザーに 4 セッションの起動を依頼。
3. **重複排除**: 同じ場所・同じ問題を複数のレビュアーが報告していたら 1 件にまとめ、「報告者数」を付ける。
4. **反証は絞る**: 「報告者が 1 体だけ」**かつ**「修正コストが高い」の両方を満たす指摘だけ対象にする。反証役は専用の役割ではなく、**新しい `reviewer` を 1 体**、観点を「この指摘の反証」にして起こす（`docs/roles/reviewer.md` の反証の縛りを本文に含める）。根拠として認めるのはコードの該当行かテストの出力だけ。白黒つかない指摘は消さず、重大度を下げて `progress.json` の `final_review.unresolved_findings` に残す。多数決はしない。
5. 残った指摘を修正タスクとして `stages.json` に追加し（`progress.total` を更新）、§2 の手順で潰す。修正も 1 タスク 1 体。統括が直さない。
6. すべて片付いたら `final_review.status: "done"`、`phase: "done"`。ユーザーの承認を待つ。

## 4. セッションを終えるとき（どのフェーズでも）

- `progress.json` の `updated_at` を今日に。`current_task`、各タスクの `status`、`open_questions` が実態と合っているか見る。
- `docs/handoff.md` に人間向けの現在地を書く（`session-handoff` の手順）。state は捨てられる前提なので、人が知るべきことは docs 側に。
- `bash .harness/bin/harness status` の drift を報告する。

## 5. 使わない判断

- 1 セッションで終わる変更。`docs/handoff.md` の NEXT で足りる。**ただし `harness task start/done`（所要時間の記録）はこのワークフロー専用ではない。** 計画を立てない・タスク分解もしない小さな作業（負債返済など）でも、`harness task start <id>` → 作業 → `harness task done <id>` だけを単独で叩ける。`.harness/state/` や `stages.json` が無ければ最小限の state（`tasks: []` / `timings: []`）を自動で作り、作ったことを出力する（`docs/spec/timing-anywhere.md`）。あとで `harness eta` を叩けば、`tasks` が空でも記録から所要時間・実行中の経過時間を返す（進捗 N/M だけは分母が無いので出せない）。**「1 セッションで終わるから」を「記録も取らない」の理由にしない。**
- spec が無く、ユーザーとの認識合わせができない状況（準備フェーズが成立しない）。
- 受け入れ条件をテストに落とせない領域（インフラ設計など）。SmartHR 自身が「銀の弾丸ではない」と書いている。
