# 0003: Hide "Adobe Color (local)" from the profile Source picker (reversible)

- 日付: 2026-10-07
- 状態: 採用（ユーザー OK 2026-10-07。「戻せるようにもしておいてほしい」）

## 背景

"Adobe Color (local)" (`profile.source: 'acrlook'`) re-implements LR's
default Adobe Color look from the user's local Adobe Camera Raw files
(Adobe Standard DCP + `Adobe Color.xmp`, read at runtime, never bundled).
It was built to become the automatic default (LR match). Decision 0002 made
fresh opens neutral, so it no longer has a default role and only remains as
a manual Source option.

## 採用案

- Hide the option from the Inspector's Source picker for new choices,
  behind one flag: `ACR_LOOK_IN_SOURCE_PICKER` in
  `src/renderer/ui/profileSourceOptions.ts` (now `false`).
- Everything else stays: the engine path, `refreshAcrLook`, the sidecar
  value, `verify-acrlook`. A doc that already uses 'acrlook' still renders
  the same and still shows the option as its current selection.
- To bring it back: set the flag to `true` (one line). The unit test
  `profileSourceOptions.test.ts` pins the default, so update it too.

## 落選案と落選理由

- Delete the acrlook mode entirely: not reversible, and older sidecars
  that use it would stop rendering the same. The user is not yet sure of
  the feature's role, so keep it.
- Keep it visible: it is an LR-emulation look in a picker that is now about
  camera profiles, and with the neutral model it adds a confusing third
  choice.

## 影響・やり直す条件

- `refreshAcrLook` still reads the local files on every open (cheap; also
  the source of `acrLookAvailable`). The separate WB color-matrix
  correction (fix ①) is unrelated to this flag.
- Re-show it if the user decides LR-look emulation should be a choice
  again, e.g. as a preset or base tone instead of a Source option.
