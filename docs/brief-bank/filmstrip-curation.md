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

## 2. Folders from elsewhere (the catalog-boundary edge)

Adding arbitrary other folders into one filmstrip session = a virtual
collection — the first step toward the collections engine MANIFESTO.md
refuses ("views may help you browse — they will never own your
photos"). Current position: one folder at a time; opening another
folder replaces the strip. If a real workflow need appears (e.g.
compare picks across two shoots), the boundary-respecting shape would
be a SAVED-NOWHERE session view (drag several folders in, never
persisted, nothing written except sidecars) — acceptable because no
state outlives the window. Do NOT build until the user brings a
concrete workflow; record the shape so the discussion starts here.

## Related

- Preset list as a pulldown is cramped vs LRC's panel (round C item
  19) — already covered by Shell pack B (docs/ui-architecture.md);
  that feedback is a +1 for it, not a new design.
