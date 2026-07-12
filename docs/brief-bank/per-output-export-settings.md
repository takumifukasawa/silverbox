# Design note: per-output export settings

Status: DECIDED design, not yet scheduled. The user raised it twice
("複数書き出しは、outputごとに設定が必要な気もする？") — the itch is real:
a "main" full-res output and a "web" 2048px/q80 output are the same doc.

## Decision

Export settings become optional PER-OUTPUT-NODE data, with the export
dialog's global controls as the fallback:

- `GraphNode` (kind 'output') gains an optional `export?: { quality?,
  maxDim?, metadata?, colorSpace? }` — all fields optional; absent field =
  inherit the dialog's value at export time. Sidecar: additive to
  schemaVersion 4 (sanitizers accept absence; unknown-field passthrough
  already covers older builds reading newer docs).
- Rationale for node-resident (vs a dialog-side map keyed by output id):
  the sidecar IS the document; "this output is the 2048px web export" is
  intent that should travel with the doc through git, presets (whole-look
  presets already carry output nodes), and the CLI.
- UI: InspectorPanel, when an output node is selected — an "Export
  overrides" group: each control renders as "inherit" (blank/checkbox off)
  or a concrete value. Keep it compact; testids per control.
- Export dialog: the output selector's rows show a small badge when a node
  carries overrides ("q80 · 2048px"); the dialog's global controls label
  changes to "defaults (per-output overrides win)".
- CLI: `--quality` etc. become the inherit-fallback too; a new
  `--respect-output-settings` is NOT needed (overrides always win; CLI
  flags only fill the gaps — document in --help).
- exportOnePath/exportSelectedOutputs: resolve effective settings =
  node.export ?? dialog/CLI values, per output, in ONE helper
  (`resolveExportSettings(node, fallbacks)`) used by UI and CLI.

## Verify sketch

extend verify-exportsettings: set overrides on output B only (q60/1024px),
export "all" with dialog q95/full — file A honors dialog values, file B
honors its overrides (dims + bytes assertions); sidecar round-trip keeps
the overrides; CLI batch with --quality 90 exports B at 60.

## Effort

Sonnet implementer, one brief, ~45 min. Touches: graphDoc.ts (schema +
sanitize), appStore export paths, InspectorPanel, ExportDialog, cliArgs
help text, verify-exportsettings, verify-cli.
