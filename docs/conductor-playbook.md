# Conductor playbook

How this project's orchestrated development flow works. Written 2026-07-12 by
the Fable-5 conductor session for whoever conducts next (human or model —
after 2026-07-13 16:00 JST the conductor session runs on Opus; flip
`.claude/settings.json`'s `model` from `claude-fable-5` to `claude-opus-4-8`).
Refreshed 2026-07-18 after the golden-window sprint (2026-07-16 through 18 —
project storage stages 1-3, denoise v2, global undo, filmstrip multi-select,
six calibration rounds, the decode-geometry fixes) with the operational
practices that sprint actually ran on, below.

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

- `npm run verify` is `scripts/run-verify.mjs`: one build, then a
  concurrency pool (default 3 at a time) of the whole verify-*.mjs family
  plus unit, isolating shared state (hardlinked test image, fresh temp
  userData/project dirs per script) so pooled runs don't collide.
  `verify:serial` is the old one-at-a-time chain (~15+ min) — reach for it
  only when you need to isolate a single script's true behavior with zero
  contention.
- **FLAKY retry-once policy** (run-verify.mjs's own doc comment): a script
  that fails IN THE POOL gets exactly one serial retry with fresh isolation
  after the pool drains. A retry that passes counts as green but prints
  `FLAKY <name> (failed pooled, passed serial retry)` and the SUITE line
  grows a `(N flaky)` suffix — never silently absorbed into a plain PASS. A
  retry that fails too is a real FAIL, normal exit behavior. Three genuine
  contention flakes hit in one sprint (a React Flow drag test losing
  pointermove events, an Electron launch hanging on GPU context under load,
  a GPU-readback NCC check reading 0.52 instead of ~1.0 mid-composite) — all
  passed clean standalone. A growing flake rate over time is itself a
  signal (real nondeterminism creeping in); don't let "it passed on retry"
  become a reason to stop looking.
- Running a single verify-*.mjs script standalone (not through the pool)
  needs its own fresh `SILVERBOX_USER_DATA` — the dev machine's own real
  settings.json can have things like `autosaveSidecar` turned off, and a
  script that assumes defaults will red on YOUR machine's config, not a bug
  in the code. Check how run-verify.mjs sets up isolation and mirror it
  rather than pointing a script at your live profile.
- If the full suite hangs or reds under parallel load and the failure looks
  impossible given the diff, don't start debugging the code — rerun the
  specific script standalone first. Pool contention produces false reds;
  chasing them as regressions burns real time for nothing.
- A live app launch WITHOUT `SILVERBOX_TEST_PROJECT` (e.g. hand-testing the
  real per-launch quick-session path, which the pinned-override suite never
  exercises) needs ONE MORE isolation lever: `quickProjectDir`'s default is
  `~/Silverbox/Quick` in the REAL home even under a fresh
  `SILVERBOX_USER_DATA` (settings.ts resolves it from homedir, not
  userData). Pre-seed the fresh userData's settings.json with a tmp
  `quickProjectDir` or the test writes real session dirs into the user's
  own folder (a conductor live-check did exactly that once and had to
  clean up after itself).
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

## Landing discipline (the rhythm every landing follows)

1. Implementer agent delivers its report (files touched, deviations, its own
   gate output). Read the report but do not trust it as the gate.
2. Conductor runs the FULL gate itself — typecheck, unit, verify — on the
   real working tree. The agent's own green run is evidence for the report,
   never the commit's basis.
3. `git diff --staged` (or the full diff before staging) gets grepped for
   personal paths before anything is staged — home-directory fragments,
   private folder names, anything not meant to leave the machine. Do this
   every time, not just when something looks suspicious.
4. **Selective staging when parallel agents share the tree.** If another
   agent has in-flight uncommitted work sitting in the same working tree,
   ENUMERATE that agent's touched files first (ask it, or diff against what
   you know it owns) before running any `git add`. A real incident: a
   landing's `git add` swept in a parallel calibration task's in-progress
   `baseCurve.ts`/`COLOR.md` edits as if they belonged to the commit being
   landed — an unapproved default-look change went out accidentally and had
   to be reverted in a follow-up commit before the calibration work could
   land properly on its own. Stage by explicit filename, never a blanket
   `git add -A`/`git add .`, whenever two efforts are touching the tree at
   once.
5. Commit with an evidence-bearing message: what changed, why, the gate
   numbers (SUITE line, unit count), deviations from the brief and the
   reason. See the commit log for the house style — every landing states
   its gate results in the body.
6. Push per the standing push policy (適宜 — as appropriate; don't ask every
   time, don't push on a whim either).

## Background-agent operations

- Implementer agents often kick off their OWN background verify run and
  then sit waiting on it; their own monitors frequently never fire (the
  agent's watch loop dies with its turn, or the tool that was supposed to
  notify it doesn't). Don't wait on the agent to come back on its own — set
  your OWN watcher (`sleep N; while pgrep -f run-verify.mjs >/dev/null; do
  sleep N; done`, or the Monitor tool's until-loop form) and, once the
  process is actually gone, WAKE the agent with an explicit "your suite
  finished, deliver the final report" message. Silence from an agent
  running a long verify is not a stall to escalate on — check the process
  table before assuming anything is wrong.
- Agents interrupted mid-turn by transient API/connection errors (including
  mundane causes — a laptop lid closing kills the network) are not dead:
  resume them with a "pick up where you left off" message and they continue
  from their own transcript. Don't re-dispatch a fresh agent for work that
  was already most of the way done.
- Use worktree isolation (`EnterWorktree`/`ExitWorktree`, or the Agent tool's
  `isolation: "worktree"`) for parallel work that touches overlapping files,
  so two agents editing the same area don't collide mid-edit. To pull work
  back out of a worktree: `git diff` the worktree against its base and
  `git apply -3` in the main tree, or copy the changed files directly — pick
  whichever is cleaner for the size of the diff.
- **Always verify your own `cwd` before any git operation**, especially
  after working inside a worktree. A real incident: a patch meant for the
  main tree was applied INSIDE the worktree instead, because a `cd` from
  earlier in the session was still in effect — the fix was invisible where
  it was expected to land. `pwd` before `git apply`/`git diff`/`git commit`
  whenever a worktree has been touched this session, not just when
  something looks wrong.

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

## Calibration & comparison methodology

Applies to any "make it look like LR/the camera" work (base curve, lens
profile, color profile fit, effects constants). Two independent fit tracks
each ran their own numbered rounds this sprint — base curve
(`scripts/fit-base-curve.mjs`, COLOR.md's "Calibration state") and profile
fit (`engine/color/profileFit.ts`'s doc-comment history, six rounds) — don't
conflate "round 3" of one with "round 3" of the other.

- **The ship gate is numeric AND the user's eye — either can veto.** A
  candidate that wins on the headline numeric metric can still fail: base
  curve round 3 (14-scene unweighted whole-frame percentile matching) *won*
  the headline metric (mean |Δp50| 9.30 → 2.95/255) but lost on subject
  crops — unweighted whole-frame pixels are dominated by whatever fills the
  frame (sky, out-of-focus background), not what the user actually looks
  at — and was rejected by eye; the shipped curve is still the original
  single-scene round-1/2 fit. Conversely a candidate the user calls
  visually neutral still ships if the numbers are clean and it removes a
  measured harm: profile-fit round 6 ("ほぼ違いない" + strictly better
  dE2000/percentile numbers + fixes a lattice that measured worse than
  identity) shipped on that basis. Neither gate alone is sufficient — a
  brief proposing a calibration change must show both.
- **Align geometry before judging color.** Every profile-fit round through
  round 4 was fit and compared with the lens correction OFF; when it was
  finally turned ON for the comparison, the NCC pixel-pairing acceptance
  rate nearly doubled (1169/2016 → 1970/2016 tiles) and the measured
  "identity vs LR" color gap dropped by more than half on the SAME data —
  most of what earlier rounds attributed to chroma disagreement was
  actually geometric/vignetting misalignment leaking into a color
  comparison. Any new comparison page or fit script must confirm geometry
  (crop, lens distortion, orientation) matches BEFORE trusting a color
  delta from it.
- **Flip beats wipe for tone/color judgment.** A wipe (split-screen slider)
  punishes any pixel-level residual — misregistration, a 1px crop offset —
  even when the actual tonal/color character matches; a flip (instant
  toggle between the two full frames) is what the eye actually needs to
  judge whether the LOOK matches. Reach for wipe only when the question is
  literally "is there a residual here," never for a first-pass character
  judgment.
- **The perception-control pattern** settles "is this difference real or an
  illusion": show LR⇄camera-JPEG as the floor calibrator (the irreducible
  gap between two genuinely different renderers) alongside LR⇄LR (the same
  export shown against itself, the null — proves the comparison viewer
  itself isn't introducing artifacts). A candidate's LR⇄ours gap is only
  meaningful relative to those two anchors, not in isolation.
- **Negative results get recorded, never silently discarded.** Every
  no-ship round (3, 4, 4-attempt-2, 5 in the profile-fit history) is
  preserved in the doc-comment history with its actual numbers, its
  hypothesis, and what to try next — not deleted because it didn't ship.
  The next round (or the next conductor) needs that record to avoid
  re-running a dead end; `scripts/*-fit.json` artifacts and the
  `shipped: false` / `attemptLabel` fields are the same discipline applied
  to the data files.

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
- `shared/ipc.ts` `IPC` const object: a comment block longer than ~5 lines
  immediately before a property triggers a Rollup/esbuild bug in
  `electron-vite build`'s main bundle that SILENTLY TRUNCATES the next
  string literal → "Unterminated string literal" at build time (loud, not a
  runtime bug, but baffling to bisect). Keep IPC-property comments ≤4 lines
  (found stage E, 2026-07-20). `interface` doc comments are erased by TS and
  safe at any length — this is specific to the runtime `const` object.
- Any verify script that mints its OWN `SILVERBOX_USER_DATA` (bypassing the
  pool's `setupIsolation`) must ALSO seed an isolated `libraryDir` in that
  userData's settings.json — else boot-time preset migration mkdir+writes
  into the real `~/Silverbox/Library` (stage E made `setupIsolation` do this
  for pooled runs; standalone-minting scripts each needed the same, and a
  residual set — verify-bw/virtualcopy/preset-selection and the early
  launches in flags/ratings — still don't isolate userData AT ALL, a
  pre-existing hazard flagged for a follow-up sweep).

## Memory & docs

- Session memory lives in the auto-memory directory (MEMORY.md index +
  one-fact files). Update silverbox-milestones.md at milestones; decisions
  go to silverbox-spec-source.md; calibration state to
  silverbox-lightroom-reference.md. Certain personal photo folders are OFF-LIMITS (recorded in memory, not in the repo).
- Repo truth: DESIGN.md (principles), COLOR.md (color decisions + default
  rendering), ROADMAP.md (implemented / next). Keep them current with each
  landing — agents update them as part of briefs.
- **DESIGN.md is the sole authority on principles.** When a brief's
  decision and DESIGN.md's stated principle would conflict, DESIGN.md wins
  or gets amended explicitly (its own commit, its own reasoning) — never
  silently overridden by a feature brief. New principles get folded into it
  the same landing they're established (e.g. the camera-faithful-geometry
  principle landed alongside the decode-crop fix that motivated it).
- **Update brief-bank statuses AT LANDING TIME, not later.** A brief's
  `Status:` line is read by the next conductor session (or the next
  agent-dispatch decision) at face value. A stale "queued"/"ready to
  dispatch" status on an already-landed brief cost a full redundant
  implementation dispatch in this sprint (manual-noise-reduction.md said
  "queued" four days after it had actually shipped) — it turned into a
  useful audit rather than wasted work only by luck. Flip the status line
  in the same commit that lands the feature, or in the same doc-sweep
  commit if several landed without one.
- **The user's verbatim Japanese quotes are load-bearing design rationale**
  — preserve them, don't paraphrase them away, in brief-bank entries and
  commit messages (e.g. global-undo's "基本、undo-redoは全部を戻したり復帰
  するようにしたい。じゃないとプロシージャルの意味がない" IS the spec for
  cross-photo jump semantics, not decoration on top of it). A paraphrase
  loses the exact scope of what was actually agreed to.

## User-facing conventions

- Chat in Japanese; code/comments/commits/docs in English.
- Notify (PushNotification, Japanese, actionable first sentence) ONLY when
  the user's input is needed — stop points, blocking questions. Not for
  intermediate landings.
- The user restarts the app to pick up builds; tell them when the working
  tree is committed + freshly built ("再起動 OK"), and never let them
  rebuild mid-agent-run.
