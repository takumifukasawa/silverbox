# Architecture audit — risk register (Fable conductor, 2026-07-12)

Not a bug list (the suite is green); a register of DESIGN-level risks and
where they'd bite, ordered by expected cost. Written from two days of
conducting every feature landing; each entry says how to probe it.

## 1. openImageByPath is a god-function under async pressure

It decodes, parses sidecars, seeds defaults (WB, base curve, lens
profile), arms watchers, manages preview overlays, folder context, and
the epoch guard — ~200 lines with three awaits and a dozen `set()`s.
Every new open-time feature (preview, filmstrip, hot-reload baseline,
epoch) patched more state into it. RISK: the next feature added here
misses one of {epoch staleness, preview revocation, lastSidecarText,
folder context, watcher re-arm} and re-introduces a race.
PROBE/REMEDY: extract an OpenSession object (epoch + owned cleanups) so
a stale session's teardown is structural, not per-line `if (stale())`.
Do this BEFORE the next open-path feature, not after.

## 2. The store is becoming the app

appStore.ts is ~2400 lines: engine calls, IPC, UI state, CLI runner,
presets, exports. Zustand tolerates it, reviewers don't. RISK: agents
keep appending (every brief says "follow the existing pattern"), merge
conflicts between parallel features rise, and subtle cross-feature
coupling (e.g. tool exclusivity, overlay auto-clear subscribes) hides at
the file bottom. REMEDY: split by domain into slice files combined at
create() — mechanical, zero behavior change, one focused brief. Do it at
a quiet moment; every open agent branch conflicts with it.

## 3. Test-mode divergence is accumulating

testFlags now gates THREE fresh-open defaults (lens profile, base curve,
CLI forceDefaults). Production default-ON paths run only in
verify-lensprofile / verify-basecurve / verify-cli. RISK: a feature
interacting with the REAL default look (e.g. presets capturing a doc
that includes the base curve) is tested mostly against the suppressed
look. PROBE: one "defaults-on integration" script that opens with ALL
defaults enabled and runs a representative flow (edit, save, reload,
export) — cheap insurance against pairwise default interactions.

## 4. Sidecar semantics vs external writers (the AI loop's edge)

Hot-reload compares raw text (lastSidecarText). An external writer that
round-trips our JSON with different key order/whitespace reads as a
change (reload fires — harmless), but an external write that lands
BETWEEN our save() and its fs-watch echo… is handled; the UNhandled
case: two DIFFERENT external writers interleaving with a dirty session —
the Reload button applies whichever landed last with no diff shown.
REMEDY (later, cheap): show a one-line summary of what changed (node
count / changed params) in the reload notice; full diff UI is overkill.

## 5. Render worker protocol has no versioning

renderProtocol messages grew fields feature-by-feature (overlay, outputId,
dims for anchor space). Main-side and worker-side buildPlan MUST stay in
lockstep (same bundle today, so safe), but a future split build (e.g.
worker from CDN cache, main hot-reloaded in dev) would desync silently.
REMEDY: none needed now; add a protocol version assert if the bundling
story ever changes. Recorded so nobody "optimizes" the bundle apart.

## 6. GPU resource lifetime is counted, not owned

Counted create/destroy wrappers (perf work) found no leaks, but
ownership is by convention (per-pass try/finally). New pass authors can
still leak on early-return paths. PROBE: perf:probe after any new pass
type; REMEDY eventually: RAII-ish helper (withBuffer/withTexture) —
mechanical refactor, good first task for a cheap model.

## 7. Anchor space is correct but non-obvious

Three coordinate spaces now exist (anchor / output / screen) and five
call sites convert. The helpers are centralized (good) but nothing STOPS
a new overlay from reading shape coords raw — it renders correctly at
identity geometry and drifts under crop, exactly the class of bug the
user already caught once. REMEDY: name the raw fields to scream (e.g. a
type-brand `AnchorNorm` on maskNode/spotsNode fields) — type-level, no
runtime change; medium-size refactor, bank for a quiet moment.

## 8. Suite wall-time will creep

44 scripts / ~90-120s today; each feature adds one. The pool hides cost
until the longest script dominates (exportsettings and cli are already
heavy). REMEDY: keep per-script budgets visible (runner prints times —
watch for >30s scripts), split fat scripts rather than raising timeouts,
and keep verify:smoke honest (it should include one NEW-feature script
per era, not only ms1-era).

## Deliberately NOT risks

- JSON sidecars at photo-archive scale (text-first is the product).
- No Windows path handling yet (explicitly deferred).
- cpuEvalPlan divergence — the 1/255 parity checks make drift loud.
- The Develop node's per-node (not per-section) CPU-mirror granularity —
  costs LUT-export precision only, already documented there.
