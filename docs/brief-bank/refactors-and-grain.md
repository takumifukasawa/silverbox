# Briefs: OpenSession extraction / store split / grain quality

Three ready-to-dispatch briefs from the architecture audit + LR session
leftovers. The two refactors are BEHAVIOR-PRESERVING: the full suite is
the acceptance test, no verify additions except where noted.

## 1. OpenSession extraction (audit risk #1 — do before the next open-path feature)

appStore.openImageByPath is ~250 lines juggling epoch staleness, preview
revocation, folder context, watcher re-arm, default-look seeding,
lastSidecarText, and per-feature resets. Extract an `OpenSession` class
(module-scope in appStore or its own file):
- `new OpenSession(path, opts)` claims the epoch (constructor increments
  the module counter) and exposes `stale()` + `guard<T>(p: Promise<T>)`
  (awaits, throws a symbolic StaleOpenError if superseded — the method
  body becomes linear `await session.guard(...)` steps with ONE catch).
- Owns the cleanup ledger: `session.own(disposeFn)` for blob URLs and
  transient state, torn down automatically when a NEWER session claims
  the epoch (the constructor runs the previous session's disposers) —
  revocation/reset code becomes registrations instead of scattered
  `set(clear…)` calls at N call sites.
- Default-look seeding moves to a pure helper `seedDefaultLook(graph,
  image, flags)` (already nearly pure) — openImageByPath shrinks to:
  read → preview → decode → sidecar → seed → commit, each guarded.
- Acceptance: NO behavior change; full suite green; the epoch-burst
  check in verify-filmstrip and the preview-revocation checks in
  verify-preview are the sentinels. Report any place where existing
  behavior was AMBIGUOUS and a choice was made.

## 2. Store split (audit risk #2 — schedule in a quiet window, conflicts with everything)

appStore.ts ≈ 3000+ lines. Split into slice modules combined at
create(): suggested cuts — imageSlice (open/decode/preview/folder),
graphSlice (doc/history/selection/nodes), toolsSlice (modal tools +
overlays state), exportSlice (export/CLI/LUT/golden), settingsSlice,
presetsSlice, externalSlice. Keep ONE store (no zustand multi-store);
slices are just files exporting `(set, get) => partial` creators and
their own module-scope helpers. Mechanical rules: no logic edits, no
renames of state keys or actions (every verify script and component
selector depends on them), shared helpers move to a `storeShared.ts`.
Acceptance: suite green + `git diff --stat` shows appStore.ts shrinking
to the combiner. High merge-conflict radius: dispatch ONLY when no
other agent is queued.

## 3. Grain quality pass (LR session leftover)

Current grain = per-cell integer-hash noise added in encoded space —
reads as digital speckle next to LR's film-like grain. Upgrade, keeping
the params (grain, grainSize) + calibration constants:
- Band-limited noise: value-noise smoothed across cells (bilinear
  interpolation of per-cell hashes = cheap band-limiting; NOT white
  noise per cell) + a second octave at half amplitude for roughness.
- Add `grainRoughness` (0–100, default 50) blending the two octaves —
  LR's third knob; schema additive with back-compat defaults (same
  proof pattern as the manual-NR pack: defaults reproduce
  current-formula output ONLY if feasible — if the new formula can't
  reproduce the old speckle exactly, this is a LOOK CHANGE: say so,
  gate verify-effects' grain checks on direction/energy rather than
  exact values, and note it for the user's hand-test).
- Luminance weighting: LR applies grain more in mids than deep
  shadows/highlights — add the midtone weight (reuse clarity's
  4·Y·(1−Y) shape) at fixed strength.
- CPU mirror in lockstep (grain is position-aware but per-pixel — the
  existing cpuFxPixel precedent).
- Verify: energy rises with amount, spectrum is band-limited (energy at
  1-px frequency LOWER than the old formula for same amount — assert
  via the gradient-energy metric on two renders), roughness changes the
  octave mix measurably, GPU/CPU parity.
