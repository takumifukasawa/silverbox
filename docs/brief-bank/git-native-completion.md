# Briefs: completing the git-native / AI-loop thesis (three features)

Philosophy-review decisions (user-approved 2026-07-13): hot-reload and
the CLI realized half the thesis; these three finish it.

## 1. Sidecar visual diff (the headline — "code review for looks")

Show the difference between two versions of a look in LOOK terms, not
JSON terms.
- Entry points: (a) the hot-reload notice gains "Show diff" (external/
  AI edits reviewed before Reload — the AI-loop code-review moment);
  (b) CLI `silverbox-render --diff <sidecarA> <sidecarB> --image <arw>`
  renders both and reports; (c) later, a git integration ("diff against
  HEAD") — v1 takes two sidecar FILES, git supplies them via
  `git show rev:path > tmp` (document the recipe, don't shell to git).
- Output, two layers:
  1. **Param diff**: walk both docs and emit human lines — "dev:
     basic.ev 0 → +0.3", "toneCurve.rgb: midpoint lifted (128→150ish —
     summarize curves by their p25/p50/p75 evaluations, not point
     lists)", "added: mask-2 (radial) + blend-2", "spots: 3 → 5".
     Pure function over two GraphDocs (`engine/look/diffLook.ts`,
     unit-tested exhaustively — this is the load-bearing part).
  2. **Visual**: in-app, drive the EXISTING compare machinery with
     previewLook-style transient docs (pane A = doc A, pane B = doc B);
     CLI renders both to files + reports the golden-render ΔE stats
     between them (machinery exists).
- Verify: diff of hand-authored docs produces the expected lines
  (unit); hot-reload notice path shows the diff summary (e2e); CLI
  --diff exit codes + NDJSON.

## 2. Sidecar spec document (the AI's UI)

**Landed** (docs-only pass): `docs/sidecar-spec.md` now covers the
project folder layout, the `project.silverbox` manifest, the look
wrapper (schemaVersion/createdAt/rating/photo/fingerprint/unknown-
passthrough), the graph body at a summary level (node kinds, edges +
ports, anchor-space coordinate semantics) pointing at graphDoc.ts as
source of truth for per-node param schemas, versioning/migration
promises (v2/v3/v4), the fingerprint recipe verbatim, legacy adjacent
sidecars, what the CLI accepts, "rules for writers", and a complete
worked example (project.silverbox + one look file). Written BY HAND
from graphDoc.ts/projectDoc.ts/main's computeFingerprint (a generator
script would rot).

**Landed** (code follow-up): `npm run verify:sidecar-spec`
(`scripts/verify-sidecar-spec.mjs`) round-trips the spec's own §10 worked
example through the real `parseGraphDoc`/`serializeGraphDoc` and
`parseProjectManifest`/`serializeProjectManifest` — reached via an esbuild
Node bundle of the source modules directly (no Electron/Playwright needed;
both modules are pure-function, dependency-free, same precedent as the
vitest `unit` tier and `verify-ms0-decode.mjs`'s esbuild bundling) — plus
checks the doc's stated schema versions against
`SIDECAR_SCHEMA_VERSION`/`PROJECT_SCHEMA_VERSION` and the fingerprint recipe
in §7 against a from-scratch reference implementation.

## 3. Reproducibility stamp

Exports gain metadata (EXIF UserComment or XMP-ish sidecar-adjacent
field — decide with sharp's capabilities): app version + git-describe
of the engine build + SHA-256 of the exact sidecar text used + the
settings that affect pixels (baselineExposureEV). CLI prints the same
stamp as an NDJSON field. Golden-render reports include it. Purpose:
any archive JPEG answers "what made you?" Verify: stamp present +
matches a recomputed sidecar hash; stripped under metadata=none
(privacy wins over provenance — document).
