# Conductor playbook

How this project's orchestrated development flow works. Written 2026-07-12 by
the Fable-5 conductor session for whoever conducts next (human or model —
after 2026-07-13 16:00 JST the conductor session runs on Opus; flip
`.claude/settings.json`'s `model` from `claude-fable-5` to `claude-opus-4-8`).

## The division of labor

- **Conductor** (the interactive session): writes implementation briefs,
  reviews the real diff (never just the agent's report), runs the gates,
  commits, talks to the user in Japanese, maintains the memory directory.
- **Implementer agents** (`.claude/agents/implementer.md`, model `sonnet`;
  override to `opus` for numerically delicate work — coordinate transforms,
  curve fitting, shader math): implement one brief, run the gates themselves,
  report, and NEVER commit.
- The user hand-tests feel; the suite proves correctness. Neither replaces
  the other.

## The gate (non-negotiable, run it yourself)

```sh
npm run typecheck        # expect exit 0
npm run test:unit        # vitest tier
npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"
grep -E 'SUITE|FAIL' /tmp/v.log   # expect SUITE: PASS n/n and no FAIL lines
```

- NEVER pipe `npm run verify` into grep directly — the pipe eats the exit
  code (we once committed on a hidden red that way).
- Agents claim green; verify it anyway. One agent left its suite running in
  the background at turn end and the orphaned run collided with the
  conductor's (shared `test-artifacts/logs/*.log`) — brief them to run the
  final suite in the FOREGROUND, and if a red looks impossible, check for
  process contention before debugging code.
- A new verify script must appear in three places: `package.json`
  (`verify:<name>` and `verify:serial`), `scripts/run-verify.mjs`, and the
  suite count you expect in the SUITE line.

## Brief-writing (the actual leverage point)

A good brief contains: repo + HEAD; pointers to the files that define the
conventions ("read X before writing"); the decided semantics (not options —
decisions, with the reasoning inline so the agent can flag genuine
conflicts); the verify checks item by item; what to report back (root
causes, deviations with reasons, fragile spots, the SUITE line). See
docs/brief-bank/ for ready-to-dispatch briefs.

Standing content every brief needs: the gate loop; "never git commit/add";
zsh's bare `=`/`==` argument hazard; the engine invariants (identity ⇒ pass
not emitted ⇒ bit-exact; GPU/CPU mirror parity 1/255 never loosened;
spatial ops have no CPU mirror; sidecar sanitizers accept all previous
versions; unknown-field passthrough); the user's UX preferences (big hit
targets ≥20px visible/36px hitbox, create-by-drag, cursors that say what a
drag will do, Escape cancels, one undo per gesture, red = affected area).

## Review before commit (what to actually look at)

1. `git diff --stat`, then read the load-bearing files fully — engine math,
   store actions, anything touching buildPlan/serialization.
2. Hunt the class of bug the suite can't see: state-machine gaps (tool
   exclusivity), async races (the open-epoch guard), resource leaks (blob
   URLs, GPU buffers), semantics that differ between two entry points that
   should share one implementation (clipboard vs presets; slider vs wheel).
3. After feel-heavy features: run the double-check (re-derive from the
   diff, adversarially), fix findings, THEN declare a stop point with a
   hand-test list and a PushNotification. Engine/CLI/math work flows
   through without stopping. This is the user's standing rule.

## Known fragilities (check these when something breaks weirdly)

- `usePlanDoc` (CanvasView) compares the doc minus `position` via
  JSON.stringify — a new layout-only GraphNode field must be excluded there.
- testFlags (shared/ipc.ts): fresh-open defaults (lens profile, base curve)
  are SUPPRESSED under SILVERBOX_TEST except for their dedicated verify
  scripts (env opt-ins) and forced ON for the CLI. New default-look features
  must follow the same pattern or 40+ baselines break.
- Anchor space (anchorSpace.ts): masks/spots are stored in oriented
  pre-geometry coords, converted at plan-build/overlay/gesture time. Any new
  position-carrying feature must do the same or it drifts under crop/rotate.
- clampGeometry keeps crop in [0,1]; the rotated-frame containment
  (cropFit.ts) is interactive-path-only by design — hand-written sidecars
  may carry void and must keep loading.
- The Mac sleeping suspends agents (an overnight run stalled 4.5h) — use
  `caffeinate` for unattended runs.
- verify scripts: never wait on a condition satisfiable by STALE state
  (e.g. the previous image's 'ready') — wait on compound conditions.
- Playwright: `fill()` mis-validates some range-input steps; SVG `<g>` in
  React Flow needs `waitFor({state:'attached'})`; sharp `stats()` ignores
  `extract()` unless you `toBuffer()` the crop first.

## Memory & docs

- Session memory lives in the auto-memory directory (MEMORY.md index +
  one-fact files). Update silverbox-milestones.md at milestones; decisions
  go to silverbox-spec-source.md; calibration state to
  silverbox-lightroom-reference.md. Certain personal photo folders are OFF-LIMITS (recorded in memory, not in the repo).
- Repo truth: DESIGN.md (principles), COLOR.md (color decisions + default
  rendering), ROADMAP.md (implemented / next). Keep them current with each
  landing — agents update them as part of briefs.

## User-facing conventions

- Chat in Japanese; code/comments/commits/docs in English.
- Notify (PushNotification, Japanese, actionable first sentence) ONLY when
  the user's input is needed — stop points, blocking questions. Not for
  intermediate landings.
- The user restarts the app to pick up builds; tell them when the working
  tree is committed + freshly built ("再起動 OK"), and never let them
  rebuild mid-agent-run.
