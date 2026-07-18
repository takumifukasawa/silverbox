# Brief: project storage — the ONE place documents live

Status: DECIDED 2026-07-13 (user + conductor discussion, superseding
the adjacent-sidecar placement). **ALL THREE STAGES LANDED 2026-07-16**
(65aaa68 stage 1 + suite migration, db9feae stage 2 CLI parity, a5404c1
stage 3 relink/fingerprint/import/save-as-move; suite 55/55). The
container format is documented in docs/sidecar-spec.md. Remaining
follow-ups: user hand-test of the dialog-driven flows, and a
verify:sidecar-spec round-trip script keeping the spec's worked
examples honest.

## The decision

Adjacent sidecars (`<image>.silverbox.json` next to the photo) are
RETIRED as the write target. User's reason, which is product-correct:
"知らない間に写真置き場にいろんなファイルが増えてる" — an app that
silently litters photo folders is bad etiquette. (Double-check
2026-07-13: merely OPENING a RAW does NOT write — fresh opens commit
`graphDirty: false` and the autosave subscriber requires dirty
(appStore.ts) — but the FIRST slider touch writes a file next to the
photo, which is still the complaint.) LRC itself proves the muscle
memory: XMP sidecar writing is OFF by default there.

One storage model. No dual mode — the complexity tax of two look-
resolution paths forever was judged worse than migrating once, and
pre-release (zero users) is the cheapest this migration will ever be.

## The shape

```
MyProject/
  project.silverbox     ← entry point: JSON manifest + playlist
  looks/
    DSC001.ARW.json     ← one per photo, SAME format as the old sidecar
    DSC900.ARW.json
```

- `project.silverbox`: schemaVersion, name, photo list (paths —
  relative preferred, absolute allowed for out-of-tree photos).
  Double-clicking it opens the app on that project (file association —
  NOTE: electron-builder `fileAssociations` in the PACKAGED app only
  (`npm run package` exists); dev-mode `electron .` never gets
  double-click. In-app "Open project…" + drag-drop must work
  regardless, association is sugar on top).
- `looks/<basename>.json`: byte-format identical to today's sidecar
  (wrapper + graph). Adds `photo` (path relative to the project) and
  `fingerprint` (cheap content hash of the photo file) fields for
  relink.
- **Etiquette rule, absolute: the app never writes into photo
  folders.** All writes land inside the active project.
- Rating stays in the look file's wrapper (unchanged).

## Quick project (no-ceremony opens)

Opening a photo with NO project active lands it in the QUICK project
at a fixed, VISIBLE user location (default `~/Silverbox/Quick/`,
settings-overridable) — a real folder the user can open, inspect, and
git. Explicitly REJECTED: an app-internal cache/userData area — that
is the hidden-central-library failure mode (edits trapped in an opaque
app-owned place; edits are not cache). Title bar always shows the
active project name, so nothing happens "behind the user's back".

**Per-launch quick project (UX pack round 2, item A, 2026-07-18 —
LANDED).** The original single fixed Quick directory turned out to be
ONE eternal project across every app launch forever — dropping 2
photos after a relaunch showed every photo ever dropped into Quick,
since. User's decisions, verbatim: filmstrip content is 「そのプロジェク
トの中で今までドロップした全写真」って感じ。なぜならそのプロジェクトの
カタログなので — accumulation WITHIN one project/session is correct,
catalog semantics; the bug was that "session" never actually ended.
とりあえず silverbox を開いてから open とかで写真を開いた場合は新しい
プロジェクト扱い confirms the fix's shape: a fresh app launch (or an
explicit "New Project") starts a NEW quick project, not a resumption of
the old one. Settings' `quickProjectDir` is now the quick-projects ROOT,
not a single project directory; the first photo-open of an app session
that needs a quick project creates+activates a fresh dated subdirectory
under it (`<root>/<local-date><letter>`, e.g. `2026-07-18a`,
disambiguated against whatever the root already contains so a same-day
relaunch never reuses an earlier session's dir) — every later open/drop
in the SAME session keeps accumulating into that one subdirectory, same
as before. A legacy `project.silverbox` sitting directly in the root
(the pre-round-2 single quick project) is left completely untouched —
never migrated or moved silently — and stays openable as an ordinary
project by pointing "Open project…" at the root itself. A **"New
Project"** toolbar action (near Open) closes the current project/photo
(flushing any pending autosave first) and resets the session cache so
the next photo open/drop mints a brand-new dated subdirectory.

"Save as project…" MOVES the quick project's current entries (playlist
rows + their look files) into the newly created project folder (user
decision: move, not copy — Quick is a staging area, not a second
home).

## Missing photos

Playlist entries whose photo path no longer resolves show a
placeholder cell (never silently dropped). "Relink…" points at the new
location; the fingerprint auto-verifies the match (and can scan a
chosen folder for candidates). Relink rewrites the playlist row + the
look file's `photo` field. Image-node references keep their existing
gray+badge missing state.

## Migration & compatibility

- Old adjacent sidecars remain READABLE forever (principle 9 —
  sanitizers keep accepting them); the app just stops CREATING them.
- "Import sidecars from folder…" walks a folder, copies each adjacent
  sidecar into the active project's looks/ (adding photo/fingerprint),
  and appends the photos to the playlist. Originals left untouched.
- Opening a photo that has an adjacent sidecar but no look in the
  active project: offer one-click import of that sidecar (do NOT
  silently read it as live state — one source of truth per context).

## Implementation stages (each gated + committed separately)

1. **Project core**: project.silverbox format + parser/sanitizers;
   open/create/quick-project flows; look read/write redirected to the
   active project's looks/; autosave + hot-reload watcher pointed at
   the project; title-bar project name; filmstrip fed by the playlist
   (folder-open becomes "create/extend a project from a folder").
2. **Tooling parity**: CLI `--project <dir>` + rendering directly from
   a look file (it knows its photo); golden renders + reproducibility
   artifacts live inside the project; visual diff reads looks/ paths.
3. **Relink + fingerprint + import-sidecars + save-as-move.**

**Verify-suite impact (the heavy lift, plan first):** 48 of the 52
scripts reference adjacent sidecar paths (counted 2026-07-13). Add a central test-harness helper
(project dir under the scratch area, SILVERBOX_TEST_PROJECT env) and
migrate scripts through it — prefer ONE shared helper edit over 52
hand-edits. Budget a dedicated agent-day for the suite alone.

## Ripples into other briefs/docs

- filmstrip-curation.md: the "folders from elsewhere" question is
  ANSWERED by the playlist (photos from anywhere, no collections
  engine — a playlist doesn't own photos). Reject flag unaffected.
- git-native-completion.md §2 (sidecar spec doc): document the project
  layout + look wrapper additions (photo/fingerprint) as part of it.
- DESIGN.md updated same-day (principle 2 wording, catalog non-goal,
  new "Where documents live" section).
