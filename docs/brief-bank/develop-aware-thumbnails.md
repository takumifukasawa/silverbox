# Brief: develop-aware filmstrip thumbnails

Status: DESIGN OPEN — decision material for the user (hand-test round 3,
2026-07-18: 「変更した見た目がサムネには反映されてないかも？」 while judging
Auto Sync). Not scheduled; the user is separately weighing whether sync
itself stays, so this brief exists to make that call informed, not to
presuppose it.
Prereq reading: engine/thumbnail/thumbnailCache.ts (its own doc comment IS
the current design: embedded-camera-preview only, in-memory, no disk cache,
develop-BLIND by construction), Filmstrip.tsx (IntersectionObserver lazy
loads, `key={dir}` remount cleanup), engine/thumbnail/nodeThumbCache.ts
(the per-node preview precedent — canvas-side, open-photo only),
docs/brief-bank/virtual-copy.md's filmstrip section (already rejected
stacked rendered cells for the same underlying reason).

## The problem

Every filmstrip cell shows the camera's OWN embedded preview — edits,
sync fan-outs, presets, B&W conversions: none of it is visible in the
strip. This is fine for "browse a folder" but actively misleading the
moment looks diverge from camera rendering (the user judged a WORKING
auto-sync as broken because the thumbnails couldn't show it — verified
2026-07-18: the fan-out reached the target look files and reopened
correctly; only the strip lied).

## The hard constraint that shapes everything

Sync (and preset-batch application, and any future virtual-copy work)
writes look files for CLOSED photos. There are no decoded pixels in
memory for them, and a real re-render needs a full RAW decode (~2-4s
per photo) — a 20-photo sync would owe ~a minute of background decode
just for 160px thumbnails. Any design that only refreshes the OPEN
photo's cell (e.g. reusing nodeThumbCache) does NOT solve the actual
complaint, which is about the OTHER cells.

## Options

- **(a) Approximate, instant: run the develop chain's CPU mirror over the
  cached 160px embedded-preview pixels** whenever a cell's look file
  changes. Cost is trivial (160×107 CPU eval), zero decodes, updates
  every cell the moment its look is written (sync targets included).
  Honesty cost: the embedded preview is camera-tone-mapped sRGB, not
  linear sensor data — running our linear-space ops over it double-applies
  the camera curve, so the thumb is a DIRECTION indicator (exposure moved,
  went B&W, warmed up), not a color-accurate preview. LR's own grid
  previews accept similar approximation states ("standard" vs 1:1).
- **(b) Exact, deferred: mini-render written at save time when pixels
  exist.** Whenever a photo IS decoded (open/export), also render a 160px
  true preview and cache it; closed-photo look writes fall back to (a) or
  stay stale-marked. Where to put it: in-memory only (recomputed per
  session) or as a visible per-project artifact (`looks/<name>.thumb.jpg`)
  — the latter touches DESIGN.md's no-hidden-cache stance (a VISIBLE
  project-dir artifact arguably passes; still a principle call for the
  user).
- **(c) Hybrid (recommended if this ships at all): (a) immediately on any
  look change, silently upgraded to (b)'s exact render whenever that photo
  next has real pixels.** One code path decides per cell: exact thumb if
  fresh, else approximate, else embedded.
- **(d) Do nothing + UI honesty: a small "edited" glyph already exists
  (filmstrip-edited-dot); lean on it and never imply the thumb shows the
  look.** Cheapest, and defensible if sync itself gets cut.

## Conductor recommendation (2026-07-20, sharpened after linked-looks)

**Ship (c) hybrid; make its (a) layer sRGB-correct; visible per-project
thumb files for the (b) layer. One word to proceed: "yes".**

Three things changed the calculus since this brief was written:

1. **Linked-looks makes closed-photo look-writes a FIRST-CLASS,
   frequent event, not an edge.** Publish (stage C) fans out to every
   follower's file; apply-preset-to-selection (stage A) writes N closed
   photos at once. The exact complaint this brief came from — "the
   OTHER cells lie" — is now the common path, so (d) do-nothing is no
   longer defensible (it was only tenable if sync got cut; instead sync
   was REPLACED by something that fans out MORE). The
   refresh-only-the-open-cell non-solutions are likewise moot.

2. **(a)'s honesty cost is largely fixable for near-zero extra cost.**
   The double-curve objection (running linear-space ops over
   camera-tone-mapped sRGB) is real but avoidable: sRGB-DECODE the
   embedded 160px preview to approximate linear FIRST, run the CPU
   mirror, re-encode. This doesn't recover clipped highlights or sensor
   gamut (the preview is already baked), so it stays a DIRECTION
   indicator — but it removes the gross error, so exposure/WB/contrast
   moves land in roughly the right magnitude, not doubled. It reuses
   the exact srgb.ts transfer functions the engine already holds in one
   place (invariant-friendly). This makes (a) good enough that the
   approximate state is genuinely acceptable as the resting state, not
   a placeholder people resent.

3. **The (b) storage principle call resolves cleanly toward VISIBLE.**
   Project storage already decided edits live in a visible project
   folder, never a hidden cache (DESIGN.md "Where documents live"). A
   `looks/<name>.thumb.jpg` beside the look file is the SAME shape and
   passes the same test — it's a derived-but-visible artifact the user
   can see, git-ignore, or delete, not a hidden central cache. Put it
   under the project; gate regeneration on look-file mtime so a stale
   thumb self-heals. (If even visible derived files feel wrong, the
   fallback is in-memory-only (b) with (a) as the persistent state —
   still ships (c), just recomputes exact thumbs per session.)

Net: (c) with an sRGB-correct (a) layer gives every cell an
immediately-correct DIRECTION the instant its look changes (publish
targets included, zero decodes), silently upgraded to a color-exact
thumb whenever that photo is next decoded. It's the only option that
keeps the filmstrip honest under linked-looks' fan-out reality.

## Decision needed from the user

1. Is the approximation (a) acceptable as the common state? (It will not
   match the canvas color-exactly, by construction.)
2. If exact thumbs matter: are visible per-project thumb files OK
   (principle call), or in-memory only?
3. Or (d): live with the edited-dot and keep thumbs camera-faithful?

## Verify sketch (if (a)/(c) ships)

Look write → cell bitmap changes without any decode (assert no LibRaw
call); sync fan-out → TARGET cells change within the debounce window; B&W
preset → cell goes visibly grayscale (channel-convergence check on the
cell bitmap); embedded fallback intact for look-less photos; revocation
still leak-free across folder switches.

## Explicitly deferred

Stacked per-output thumbs (virtual-copy.md already rejected); any on-disk
cache OUTSIDE the project dir; progress UI for background exact renders.
