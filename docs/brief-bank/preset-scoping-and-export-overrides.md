# Brief: preset scoping + per-output export-override UX

Status: DESIGN OPEN (user feedback 2026-07-13, hand-testing rounds A/B).
Two related "which settings does this thing carry" problems.

## 1. Preset scoping ("temp/tint/exposure はいじらない方がいい？")

Today a preset is the WHOLE look — apply/update always includes WB,
exposure, everything. User's instinct (matching LR): some params are
per-SHOT (WB, exposure — they compensate the capture), some are the
LOOK (curves, color, grain); a preset that stomps WB is usually wrong.

Proposed shape (LR-style, save-time selection):
- Preset file gains an optional `includes` list of param FAMILIES
  (wb / tone / curves / color / effects / detail — exact grouping TBD
  against DevelopParams). Absent ⇒ whole-look (back-compat; existing
  presets unchanged).
- Save dialog gets family checkboxes; sensible default = everything
  EXCEPT wb + exposure (contrast stays in — it reads as look, per
  user's own second-guess). "Update with current look" preserves the
  stored `includes`.
- Apply merges only included families onto the current graph (still
  one undo entry). Non-Develop nodes (masks/blends/outputs) follow the
  existing captureLook contract — unchanged by this brief.
- Hover preview must preview the MERGED result, not the raw preset.

DECIDED (user, 2026-07-13): save-time selection (LR-like, above) —
checkboxes in the save dialog, apply stays one click. Apply-time
selection rejected. Ready to implement as specced.

## 2. Per-output export-override UX ("overrideしたのが export 設定側に
反映されてないのはわかりづらい")

Overrides work (presence-based resolveExportSettings) but are invisible
at export time: the export dialog shows the global settings even when
the chosen output overrides them. Needs a design pass on multi-output
export as a whole. Sketch:
- Export dialog shows the EFFECTIVE settings for the selected output,
  with a per-field "overridden" marker (dot/badge) when a value comes
  from the output node rather than the dialog defaults.
- A "clear override" affordance per field or per output.
- Batch/multi-output export ("export all outputs") decides: dialog
  values apply only to non-overridden fields (presence semantics
  already say this — the UI just has to SHOW it).

Do not build until the user weighs in on the sketch — this is the
"そもそも複数書き出し時のオプションをどうするか" conversation.
