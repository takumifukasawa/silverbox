# Brief: external-tool hook node (denoise v1)

Status: v1 LANDED (10c42de graph node + c50c406 compare-pane reach;
verify-external.mjs green with the fixture command). REMAINING: (a)
user-side hand-test with a REAL tool — install one (e.g. `brew install
gmic`) and run e.g. `gmic {in} -denoise_patchpca 5 -o {out},uint8`
through the node (the `,uint8` suffix is REQUIRED — this build can only
read 8-bit TIFF output back; gmic's own `-o {out}` default is a float
TIFF, which reads as a uniform white frame, see src/main/externalTool.ts's
doc comment), including the fresh-open disabled/confirm flow; first
hand-test attempt (round with gmic 4.0.2) hit exactly that bug and is
now fixed. (b) v2 bundled NAFNet/ONNX — still deferred per the research
doc. Original dispatch notes kept below.
Prereq reading:
docs/research/denoise.md (the decided architecture + G'MIC findings),
spotsNode/custom-shader node shapes, exportOnePath's decode flow,
DESIGN.md non-goals (no bundled ML runtime in v1).

## Decided semantics (from the research doc — don't relitigate)

- New node kind `'external'`: one input, one output. Params:
  `external: { command: string, encoded: boolean, cacheKey?: never }` —
  `command` is a user template with `{in}`/`{out}` placeholders, e.g.
  `gmic {in} -denoise_patchpca 5 -o {out},uint8` (the tool must write its
  result back as 8-bit — see the Status note above). `encoded: true` (default)
  pipes sRGB-ENCODED 16-bit TIFF (most external denoisers expect
  display-referred input); false pipes linear Rec.2020 float TIFF for
  tools that can take it. Conversion sits at the node boundary, both
  directions, exact helpers only.
- Execution: main process spawns the command (shell: false — split argv
  ourselves; document quoting rules in the inspector hint), temp in/out
  TIFFs in the scratch dir, 5-min timeout, stderr captured to a node
  badge on failure (node passes through its input unchanged on ANY
  failure — a broken externally-processed look must never brick the doc).
- CACHE: keyed by hash(input-pixels-hash, command, encoded, node
  upstream-plan fingerprint) — an in-memory LRU of decoded results in the
  render worker plus an on-disk cache in userData/external-cache (bounded,
  e.g. 2GB LRU; the sidecar stays intent-only). Preview edits upstream of
  the node re-run the tool ONLY when the upstream pixels actually changed
  (the hash does that naturally). Debounce: run on idle (~600ms after the
  last upstream change), show a spinner badge meanwhile, render the STALE
  cached result (or passthrough) until fresh.
- The node is inherently non-realtime: document in the inspector ("runs an
  external command; expect seconds").
- Spatial: no CPU mirror; LUT reducer bypasses + reports (same as image
  node / custom shader).
- Sidecar: additive to v4. SECURITY note in code + README: opening a
  sidecar with an external node does NOT auto-run the command — the node
  starts DISABLED with a "Run external tool: <command>" confirm button the
  first time a given (doc, command) pair is seen in a session. A text file
  from the internet must not execute arbitrary commands on open.
- CLI: `--allow-external` opt-in flag; otherwise external nodes pass
  through with a warning line.

## Verify sketch (verify-external.mjs)

Use a tiny KNOWN command instead of gmic (no new dependency): a node
one-liner script shipped in scripts/fixtures that reads the TIFF, inverts
it (or adds 0.1), writes it back — deterministic, fast. (1) node with the
fixture command changes the render exactly as the fixture predicts
(region means); (2) cache: second render with unchanged upstream does NOT
re-spawn (spawn-counter via a debug/IPC counter); upstream edit re-runs;
(3) failure (command exits 1) ⇒ passthrough + badge; (4) sidecar
round-trip; fresh-open starts disabled + confirm button runs it;
(5) CLI without --allow-external passes through with warning, with the
flag it applies; (6) encoded vs linear mode produce the documented
different results for the same fixture.

## Explicitly deferred

Bundled NAFNet/ONNX inference (v2 — see research doc for the chosen
model/runtime), tiling for >24MP through the external tool, per-node
progress UI beyond the spinner badge.
