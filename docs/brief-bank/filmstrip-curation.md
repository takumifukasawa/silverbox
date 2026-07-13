# Brief: filmstrip curation — reject flag & the multi-folder question

Status: DESIGN OPEN (user feedback 2026-07-13, hand-testing round C
item 21: "写真を除外したい時はどうしたらいいんだ" + "全然違う場所にある
フォルダを追加できるか — 議論が必要かもね").

## 1. Reject flag (proposed — fits the boundary cleanly)

LR's X/reject, as sidecar metadata next to `rating` (wrapper field
`rejected: true`, absent = false — sanitizers/versioning follow the
rating precedent exactly; unknown-field passthrough already protects
old readers). UI: `x` key on the filmstrip selection toggles it;
rejected thumbs dim + small flag glyph; the existing ★n+ filter row
gains a "hide rejected" toggle (default ON once any reject exists).
CLI: `--skip-rejected` alongside `--min-rating`. This stays perfectly
stateless — the folder is still the library, the sidecar still the
single source of truth. Small (day-agent with verify extension).

Alternative considered: rating 0 as implicit reject — rejected ≠
unrated (LR distinguishes them for good reason; culling means marking
BAD, not just not-yet-rated).

## 2. Folders from elsewhere — ANSWERED (2026-07-13)

Superseded by the project-storage decision
(docs/brief-bank/project-storage.md): a project's playlist references
photos from ANYWHERE, the way a playlist references songs — no
collections engine, nothing owned. The filmstrip becomes playlist-fed;
"add photos from another shoot" is just appending playlist rows. The
earlier saved-nowhere-session idea in this section is obsolete. The
reject flag (§1) is unaffected — it moves into the look wrapper the
same way rating does.

## Related

- Preset list as a pulldown is cramped vs LRC's panel (round C item
  19) — already covered by Shell pack B (docs/ui-architecture.md);
  that feedback is a +1 for it, not a new design.
