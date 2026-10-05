# roles — 役割定義

長期・大規模タスクは 4 つの役割に分けて進める（SmartHR 型）。ここにある役割文はエージェント非依存の正本。
Claude Code では `.claude/agents/<role>.md` に、Codex では `.agents/skills/role-<name>/SKILL.md` に翻訳される（`harness init/update` が生成。直すのはこのディレクトリの正本）。
実際に回す手順は `.agents/skills/task-orchestrate/SKILL.md`。

| 役割 | ファイル | 起動単位 |
|---|---|---|
| orchestrator | [orchestrator.md](orchestrator.md) | メインセッションそのもの。別エージェントに委譲しない |
| implementer | [implementer.md](implementer.md) | タスク 1 つにつき 1 体 |
| reviewer | [reviewer.md](reviewer.md) | 全タスク完了後に観点別に並列で 1 回 |
| machine check | `.harness/scripts/check.sh` | エージェント不使用。各タスク完了時 |

状態は `.harness/state/progress.json` と `stages.json`（gitignore）。初回は `.harness/state-template/` からコピーして作る。確定したことは spec / docs / コードに書き戻し、JSON には未確定だけを残す。
