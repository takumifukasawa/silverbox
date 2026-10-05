# docs 索引

このプロジェクトの永続事実の正本。エージェントも人間も、まずここを読んで必要な doc だけ開く。
索引に無い doc は「存在しないもの」として扱われるので、doc を足したら必ず行を足す（`harness gc` が食い違いを検知する）。
下の表の場所は雛形の既定で、**この索引が正**。既に別の場所にある doc（例: 既存の仕様書）は移さなくてよく、ここに行を足せば流儀どおりになる。
リポジトリの外（チャット・会議・頭の中）にある知識は、ここに書き戻すまで「存在しない」。

| doc | 何が書いてあるか | 更新するタイミング |
|---|---|---|
| [handoff.md](handoff.md) | 現在地。何が済み / 何が途中 / 次の一手 / 順序制約。active な plan への入口 | セッション終了時（session-handoff） |
| [architecture.md](architecture.md) | モジュール境界・依存の向き・機械的に強制している不変条件と、その強制手段 | 境界や不変条件を変えた時 |
| [plans/](plans/README.md) | 数セッションに跨る作業の計画。進捗・決定ログ込み。`active/` と `completed/` | 着手前に作り、進めるごとに追記 |
| [decisions/](decisions/README.md) | 決定記録（採用案・落選案・理由） | 何かを決めた時 |
| [learnings.md](learnings.md) | 踏んだ罠と対処。ハーネスへ昇格する候補の溜まり場 | 罠を踏んで解決した直後 |
| [tech-debt.md](tech-debt.md) | 既知の負債と返済状況。gc と定期リファクタの対象 | 負債を作った時・返した時 |
| [references/](references/README.md) | 依存ライブラリの仕様抜粋など、外部知識をリポジトリに持ち込んだもの | 外部知識に依存する判断をした時 |
| [spec/](spec/README.md) | 何を作るかの唯一の正。受け入れ条件はここに | 合意が変わった時（会話ではなくここに書き戻す） |
| [roles/](roles/README.md) | 長期タスクの役割分担（統括 / 実装 / レビュー / 機械検査） | 役割の責務を変えた時 |
| [rules/](rules/README.md) | パス限定の規律（サブディレクトリ `AGENTS.md`）の一覧 | 規律を足した時 |

<!-- プロジェクト固有の doc はこの下に追加する。例:
| generated/db-schema.md | スキーマの生成 doc。checks.sh が再生成する | 自動 |
-->

### Silverbox 固有（ハーネス導入前からある doc）

| doc | 何が書いてあるか | 更新するタイミング |
|---|---|---|
| [../DESIGN.md](../DESIGN.md) | 設計思想。何を作り何を作らないか、全機能が従う原則 | 原則を変えた時 |
| [../COLOR.md](../COLOR.md) | 色管理の具体的な決定（DESIGN.md 原則 6） | 色パイプラインを変えた時 |
| [../ROADMAP.md](../ROADMAP.md) | ロードマップとギャップ分析 | マイルストーンの区切り |
| [sidecar-spec.md](sidecar-spec.md) | サイドカー / プロジェクトのコンテナ契約（正本の仕様） | フォーマットを変えた時 |
| [ui-architecture.md](ui-architecture.md) | UI シェルの再編設計 | UI 構造を変えた時 |
| [architecture-audit.md](architecture-audit.md) | 設計レベルのリスク台帳 | リスクを足した・潰した時 |
| [feature-gap-analysis.md](feature-gap-analysis.md) | LR Classic / LR / Resolve との機能差 | 計画を見直す時 |
| [conductor-playbook.md](conductor-playbook.md) | conductor（統括）+ implementer の開発フローの実際 | フローを変えた時 |
| [brief-bank/](brief-bank/) | 機能ごとの実装ブリーフ（implementer への設計指示書）。GO 済み・GO 待ちの両方 | ブリーフを書いた時 |
| [research/](research/) | LR 挙動の測定・Adobe LookTable 解読・局所トーン・denoise 等の調査記録 | 調査ラウンドごと |
