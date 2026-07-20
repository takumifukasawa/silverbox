# Fix: filmstrip unmounts during decode (open-time layout jank)

Status: ROOT-CAUSED (Fable-direct, 2026-07-21) — user hand-test:
"openするとき、decodeしてる時、カタログビューが一瞬閉じた後にまた
decode後に開く感じで、表示領域がガタガタして気持ちが悪い". Fix
pending; dispatch AFTER the fork-bug agent lands (both touch
appStore.ts openImageByPath area — avoid parallel-agent collision).

## Root cause (confirmed)

App.tsx:516 renders the strip as `{folderDir !== null && <Filmstrip
key={folderDir} />}`. openImageByPath, WITHOUT `keepFolderContext`,
clears folderDir/folderEntries to null at the very TOP (appStore.ts
~1214) and only re-sets folderDir on the SUCCESS commit — AFTER the
2-4s RAW decode. So folderDir goes X → null → X across a decode, and
because the render is gated on `folderDir !== null` (and keyed on it),
the Filmstrip UNMOUNTS the instant the open starts and REMOUNTS after
decode: the "closes then reopens after decode" jank. The main view area
reflows without the strip, then with it.

Filmstrip CLICKS (Filmstrip.tsx:275) and arrow-key nav (appStore.ts
~4744) already pass `keepFolderContext: true`, so same-folder
navigation via those does NOT null folderDir — those are already smooth.
The jank hits the non-keepFolderContext paths (folder open, native
dialog, drag-drop, and any open that forgot the flag while a strip is
showing).

## The fix (path-agnostic)

Stop nulling folderDir/folderEntries at the TOP of openImageByPath.
Keep the CURRENT strip visible through the decode and only UPDATE
folderDir/folderEntries at the SUCCESS commit — to the new folder (or
the same one). Net: folderDir transitions X → Y (or X → X) with no null
in between, so the Filmstrip never unmounts mid-decode. On a genuine
folder CHANGE the strip content swaps once at the end (key changes X→Y,
one clean remount) instead of blanking for the whole decode; on a
same-folder open it stays put.
- Preserve the existing thumbnail-cache cleanup semantics: the
  `key={folderDir}` remount is what drives revokeAllThumbnails on a real
  folder switch (Filmstrip.tsx doc comment) — that still fires when the
  key actually changes to a new folder, just not on a same-folder open
  or mid-decode.
- Failure path: if the open FAILS, don't leave a stale strip pointing
  at a folder that changed — restore/refresh folderEntries in the error
  branch as today's top-clear implicitly did.
- Watch the single-file / no-folder open case: a dialog/drop of a
  lone file legitimately has folderDir null (no strip) — that must
  still end with folderDir null (don't resurrect a strip). So the
  "update at success" must set null when the open is folder-less, not
  keep a stale folder.

## Verify (extend verify-filmstrip.mjs)

Open folder A (strip shows N cells) → click-open a DIFFERENT photo in A
→ assert the Filmstrip DOM node is NOT unmounted at any point during
the decode (e.g. its element identity/a data-attr persists across the
open; or assert no folderDir===null tick via a __debug probe). Then a
folder A→B switch → assert exactly ONE remount at the end, not a blank
during decode. Single-file open → no strip (unchanged).

## Read before writing

appStore.ts openImageByPath (the top-of-function clear + the success
commit + the error branch), App.tsx:516 (the render gate), Filmstrip.tsx
(key/remount + thumbnail-cache cleanup coupling), the folderDir/
folderEntries doc comments (their "empty when folderDir null" invariant).

## Standing rules

Gate loop foreground; NEVER git add/commit; zsh `=` hazard; engine
invariants; libraryDir seed if the script mints its own userData.
English code.

## Report back

Files touched; the transition (confirm no null-folderDir tick during a
same-folder open); the verify assertion for no-mid-decode-unmount;
deviations; SUITE line + unit count.
