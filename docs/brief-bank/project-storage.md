# Brief: project storage — the ONE place documents live

Status: DECIDED 2026-07-13 (user + conductor discussion, superseding
the adjacent-sidecar placement). Implementation NOT started — staged
for the golden window; this is the largest structural migration in the
queue and touches autosave, hot-reload, CLI, golden renders, and every
verify script.

## The decision

Adjacent sidecars (`<image>.silverbox.json` next to the photo) are
RETIRED as the write target. User's reason, which is product-correct:
"知らない間に写真置き場にいろんなファイルが増えてる" — an app that
silently litters photo folders is bad etiquette (autosave-ON made it
worse: opening a RAW wrote a file). LRC itself proves the muscle
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
  Double-clicking it opens the app on that project (file association).
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

**Verify-suite impact (the heavy lift, plan first):** ~all 52 scripts
assume adjacent sidecar paths. Add a central test-harness helper
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
