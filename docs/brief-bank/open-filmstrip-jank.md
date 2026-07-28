# Fix: filmstrip unmounts during decode (open-time layout jank)

Status: FIXED+LANDED 2026-07-21 (commit bd75181) + DOUBLE-CHECKED 2026-07-28.
Jank fixed via the 4-edit terminal-state model below; a preview-URL leak the
timing shift exposed (verify-preview check 4) was root-caused to a
pre-existing CanvasView inline-release race and fixed with a deterministic
backstop useEffect keyed on the pendingSwitch/openingPreview STATE. Full
gate: typecheck 0, unit 278, SUITE: PASS 74/74. Original hand-test:
"openするとき、decodeしてる時、カタログビューが一瞬閉じた後にまた
decode後に開く感じで、表示領域がガタガタして気持ちが悪い".

## Double-check verdict (2026-07-28, independent re-derivation)

Both risk surfaces re-derived from source, both CLEAN:
- **folderEntries retained through the decode**: the only production consumer
  is Filmstrip.tsx:516 (showing the old folder during decode = the intended
  smooth behavior); CanvasView.tsx:1353 is the `__debug.folderState()` verify
  getter, not a render path. No consumer misuses the retained entries.
- **CanvasView backstop over-release**: showOpeningPreview (2373) requires
  `imageStatus==='loading' || (ready && pendingSwitch)`; the backstop (2410)
  fires only on `!pendingSwitch && !openingPreview`. Case split: the
  pendingSwitch true→false trigger only fires once the real frame presented
  (imageStatus==='ready') → overlay already hidden → release safe; the
  openingPreview→null trigger is either the ready commit (ready → safe) or a
  supersede via clearOpeningPreview, which ALREADY revoked that url itself, so
  the backstop only double-revokes (no-op) and drops a stale ref. "Revoke a
  url the overlay is actively painting" is unreachable. Fix is sound.

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

## The fix (PRECISE — a prior naive attempt FAILED; follow this exactly)

The prior agent removed the top-clear and relied on the SUCCESS commit's
existing `...(projectPatch ? { folderDir: projectPatch.dir } : {})`
spread. That FAILED verify because the success spread only sets folderDir
when a project resolved — so the "no project resolved" and error/unsupported
paths (which the top-clear used to null) were left pointing at a STALE
folder. Its own words: "my appStore.ts change alone causes this."

The top-clear at appStore.ts:4211
(`if (!opts?.keepFolderContext) set({ folderDir: null, folderEntries: [] })`)
is the DEFAULT "exit folder-browsing" semantic, fired 2-4s before the new
value — that early tick is the whole bug. Remove it, and reproduce the
SAME end-state at each of the THREE terminal points instead, so there is
never a null tick mid-decode but every terminal state is byte-identical
to today:

Terminal-state matrix (MUST all hold after the fix):

| open kind | during decode | terminal folderDir |
|---|---|---|
| keepFolderContext=true (filmstrip click / arrow key) | retained (already smooth today) | retained (untouched) |
| !keep, project RESOLVED (folder open / dialog / drop into a project) | OLD folder retained (no unmount) | projectPatch.dir — one clean key-remount at the end |
| !keep, NO project resolved (lone single file) | old folder retained | **null** (strip hidden) |
| error / unsupported-kind, !keep | (n/a) | **null** |
| error / unsupported-kind, keepFolderContext=true | retained | retained (untouched) |

Concretely:
1. DELETE the top-clear at ~4211.
2. SUCCESS commit (~4443): replace the spread with a three-way —
   `...(projectPatch ? { project: projectPatch, folderDir: projectPatch.dir }
   : (opts?.keepFolderContext ? {} : { folderDir: null, folderEntries: [] }))`.
   (projectPatch → new dir; keepFolderContext same-project click → untouched
   so it stays put; else → null, matching the old top-clear end-state but with
   NO mid-decode tick.)
3. UNSUPPORTED-KIND early return (~4214-4216): when `!opts?.keepFolderContext`,
   also `folderDir: null, folderEntries: []` in that error `set` (the top-clear
   used to have already nulled it).
4. ERROR branch (~4521, AFTER the `if (session.stale()) return;` guard — a
   stale/superseded open must still touch NOTHING): when
   `!opts?.keepFolderContext`, add `folderDir: null, folderEntries: []` to the
   error `set` (same reason).
- Preserve the thumbnail-cache cleanup: the `key={folderDir}` remount drives
  revokeAllThumbnails on a real folder switch (Filmstrip.tsx doc comment) — it
  still fires when the key changes X→Y at the success commit, just not on a
  null tick or same-folder open.
- openFolder/openProjectByPath (~4603/4660) already `set({ folderDir, ... })`
  THEN call openImageByPath with keepFolderContext:true → they take the
  "untouched" row above, unchanged. Verify no other folderDir writer depended
  on the top-clear.

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
