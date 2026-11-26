# 0004: Preset applied when a RAW is opened (LR raw-defaults style)

- 日付: 2026-11-26
- 状態: 仮採用（ユーザー「いったん ok」2026-11-26。設計の問い Q1〜Q9 を推奨どおり。未実装）

## 背景

Decision 0002 made fresh RAW opens neutral (no base tone, no seeded curve).
Its "影響" section names the cost — fresh opens look darker and flatter —
and a mitigation candidate: a preset applied on open, like LR's raw
defaults. Chosen on 2026-11-24 as the next feature after the localtone merge.

## 採用案

1. **One global setting**, not per camera model. Per-model defaults can be
   added later if needed.
2. **Unedited photos follow the current setting.** A photo with no look
   file on disk opens with whatever default preset is set now; a photo
   that has a saved look keeps it. Same rule as today's neutral seed
   (autosave writes only after an edit, so merely opening does not freeze
   the default into a sidecar).
3. **Any existing preset**, applied the same way the Presets menu applies
   it: a whole-look preset replaces the look; a family-scoped preset
   (`includes`) merges only its families onto the neutral default. No new
   file format.
4. **RAW only.** JPEGs are already display-rendered and open as before.
5. **UI: Settings dialog**, a dropdown "Preset on RAW open: None / <presets>".
   Default None (= current behavior). A "set as default" entry in the
   Presets menu is deferred.
6. **"Reset all edits" (⇧⌘R) returns to the default-preset state**, not to
   bare neutral (LR's reset goes to raw defaults).
7. **The headless CLI (`--render`) follows the same setting**, keeping the
   invariant that the CLI output equals a fresh open.
8. **Missing preset** (deleted / renamed): open neutral, notify once, keep
   the setting value (so restoring the preset file brings it back).
9. **Thumbnails unchanged.** Never-opened photos keep showing the camera's
   embedded preview; no re-render with the default preset.

## 落選案と落選理由

- **Per-camera-model defaults (LR's full model).** More UI and state for a
  user who shoots mostly one body; can be layered on later.
- **Freeze the default into the doc on first open.** Would make the
  setting's effect depend on which photos happened to be opened before a
  change; also conflicts with "opening alone writes nothing".
- **A dedicated "open defaults" format.** Presets already carry whole and
  scoped looks with the same apply path.
- **Re-render thumbnails with the default.** The embedded preview is the
  camera's own rendering and already good for culling; re-rendering costs
  CPU for every cell.
- **Reset to bare neutral.** Diverges from LR and makes reset undo the
  user's chosen starting point.

## 影響・やり直す条件

- Verify scripts must keep testing the neutral default (setting None in
  test isolation), plus a new verify for the setting itself.
- Revisit per-model defaults if the user starts shooting several bodies.
