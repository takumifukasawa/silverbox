# Brief: fix the DCP double-tone bug (option a' — flatten to identity)

Status: LANDED 2026-07-20 (SUITE 73/73, unit 270; all 3 guards proven by verify-dcp-doubletone.mjs). Fixes the CONFIRMED bug recorded in
dcp-profile.md's "Layering decision" section (Fable double-check). USER-
DECIDED approach: **a'** — when a tone-carrying DCP becomes active, the
visible tone curve actually goes flat (matches the documented "the
user's visible tone curve starts flat on top"; the panel never lies
about what renders). Read the dcp-profile.md finding + fix-design
wrinkle FIRST.

## The bug (confirmed, triple-checked)

seedDefaultLook (appStore.ts:~2188) seeds baseCurveForModel into
`toneCurve.rgb` on every fresh RAW open. bakeDcpLattice
(dcp/pipeline.ts:34) bakes the DCP's ProfileToneCurve INTO the profile
lattice. The compile site (graphDoc.ts:1468) swaps the profile stage to
the DCP lattice when source==='dcp' but toneCurve is a SEPARATE
downstream stage. So a fresh RAW switched to a tone-carrying DCP applies
tone TWICE. setDevelopProfileSource / setDevelopProfileDcpPath only set
the source/path — neither flattens toneCurve.

## The fix (option a', decided)

1. **Surface `hasToneCurve` from the DCP bake.** The bake happens in the
   renderer store at appStore.ts:5577-5587 (parseDcp → bakeDcpLattice —
   NOT a main-process round-trip, good). `parseDcp` returns a
   `ParsedDcp` whose `toneCurve` field is null when the DCP carries no
   ProfileToneCurve (dcp/parser.ts). So `hasToneCurve = parsed.toneCurve
   != null` is available RIGHT THERE, synchronously, next to where the
   lattice is computed. No new plumbing across processes.
2. **Flatten the seeded base curve — GUARDED.** At the point the DCP
   parse+bake resolves for a Develop node whose `profile.source ===
   'dcp'`, if `hasToneCurve` AND that node's `toneCurve.rgb` deep-equals
   the seeded base curve for THIS photo's camera model
   (`baseCurveForModel(cameraModel)` — the exact value seedDefaultLook
   wrote), set `toneCurve.rgb = identityCurvePoints()`
   (developNode.ts:204). The equals-seed guard is REQUIRED: never flatten
   a curve the user has edited themselves — only the untouched seed.
   - `hasToneCurve === false` (a tone-less DCP): do NOTHING — the base
     curve is the only tone and MUST stay (a tone-less DCP provides color
     only). This is the wrinkle that makes a naive flatten wrong.
   - Only touch `toneCurve.rgb` (the master curve the base curve seeds);
     leave r/g/b channel curves alone.
3. **One undoable step + notice.** The flatten is a single global-undo
   entry (⌘Z restores the base curve) with a short projectNotice
   («DCPプロファイルのトーンカーブを使用中 — 写真側のトーンカーブは
   フラットにしました»). Do NOT bundle it silently into an unrelated
   entry.
4. **Switching back to builtin**: leave the flattened curve as-is (the
   documented posture — "switching back does not re-seed"; the user
   resets the curve or re-opens). Do NOT auto-re-seed (that needs
   "was-this-identity-from-our-flatten?" state we deliberately don't
   keep). Note this in the notice/code comment.

## Where to wire it

- The bake site appStore.ts:5577-5587 is the natural home: it already
  has `parsed` (⇒ hasToneCurve), the node, and the camera model in
  scope. Compute the flatten right after the lattice is set, gated as
  above. Confirm this path runs both on source-switch-to-dcp (with a
  path already set) AND on choosing a new dcpPath — if only one triggers
  the bake, make both reach this flatten check (the bug repro is
  "switch source to dcp on a base-curve-seeded photo").
- baseCurveForModel is imported at appStore.ts:100; identityCurvePoints
  from developNode.ts; a deep curve-equality helper may already exist
  (else a simple points-array compare — the seed is integer point space,
  so exact compare works).

## Verify (new verify-dcp-doubletone.mjs, or extend verify-dcp.mjs)

1. Open the test ARW (base curve seeded into toneCurve.rgb). Point at a
   fixture DCP that CARRIES a ProfileToneCurve → assert toneCurve.rgb
   became identity AND the rendered tone matches a DCP-only reference
   (NOT a doubled-contrast result — compare luma percentiles).
2. A fixture DCP with NO ProfileToneCurve → assert toneCurve.rgb is
   UNCHANGED (base curve kept) and render is correct (single tone).
3. User-edited curve guard: edit toneCurve.rgb away from the seed, then
   switch to a tone-carrying DCP → the edited curve is NOT flattened
   (only the untouched seed is).
4. One ⌘Z restores the base curve after a flatten.
Use tiny hand-authored DCP fixtures (ours, spec-conformant, no Adobe
content) — the parser already has fixture tests to model on. Register
in package.json + run-verify.mjs; SUITE +1 (or +0 if extending
verify-dcp).

## Standing rules

Gate loop foreground before reporting (typecheck, test:unit, verify;
SUITE line). NEVER git add/commit. zsh `=` hazard. Engine invariants
(identity curve ⇒ the tone stage is skipped, so flattening to identity
also removes the redundant pass — a nice consequence). If a script mints
its own SILVERBOX_USER_DATA, seed an isolated libraryDir. Japanese
display text for the notice, English code.

## Report back

Files touched; where each numbered step lives (file:line); confirmation
BOTH trigger paths (source-switch + dcpPath-choose) reach the flatten;
the tone-less-DCP and user-edited-curve guards both proven by the verify
script; deviations; SUITE line + unit count.
