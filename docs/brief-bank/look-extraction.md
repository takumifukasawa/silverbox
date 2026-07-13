# Brief: look extraction — distill a preset from a set of images

Status: DESIGNED (user idea, expanded 2026-07-13: "大量の画像を食わせて
プリセットを抽出する" — folders, multi-selection, Pinterest boards,
driven by any AI via the CLI). Exploratory but moat-aligned: the output
is an ordinary preset JSON, the input is ordinary files, and the CLI
form makes it AI-drivable.

## Two modes (different problems, one command)

### Mode 1 — from EDITED SIDECARS (consensus distillation)
`--extract-preset --from-sidecars <img-or-sidecar…>`: the user edited N
photos toward one look; distill the SHARED parameters.
- Numeric params: per-param robust consensus (median; report spread —
  a param with huge variance isn't part of "the look" and stays at
  default, threshold configurable).
- Tone curves: average in point space after resampling to a common x
  grid (PCHIP-evaluate each, mean the y's, refit ~8 control points).
- Geometry: never part of a look (captureLook strips input geometry —
  appStore.ts captureLook). NOTE (double-check 2026-07-13): captureLook
  does NOT strip mask/spots/blend nodes — today's presets DO carry
  them; whether they should is an open product question (a pasted
  look carrying another photo's spot circles is dubious — fold into
  the preset-scoping design, docs/brief-bank/
  preset-scoping-and-export-overrides.md). Extraction v1 is stricter
  than captureLook regardless: extract the Develop consensus only;
  report non-Develop nodes as skipped.
- Output: a preset file + a fit report (per-param spread table).

### Mode 2 — from REFERENCE IMAGES (statistical look solve)
`--extract-preset --from-references <images…>`: images that HAVE the
look (film scans, a downloaded Pinterest board, another shooter's
JPEGs); no pairing with our photos exists.
- Extract the reference set's aggregate SIGNATURE: luma percentile
  vector (p2..p98), per-HSL-band mean saturation and hue centroid
  shift, shadow/highlight chroma vectors (a*b* means below p25 / above
  p75 — the grading-wheel signal), global chroma distribution,
  contrast proxy (p90−p10), grain energy (band-limited high-freq
  metric).
- Solve OUR Develop params so a NEUTRAL baseline maps toward the
  signature: define the baseline as the statistical average of a
  BUNDLED reference corpus (a fixed constant table derived once from a
  few hundred "natural rendering" images — ship the numbers, not the
  images), then solve tone-curve points from percentile matching
  (exactly the base-curve fitter's method, reused), HSL band
  sat/hue from the band stats, grading wheels from the shadow/highlight
  chroma vectors, saturation/vibrance from the chroma distribution,
  grain amount from the grain energy.
- Solver: closed-form per family where possible (curves = percentile
  match; wheels = direct from chroma vectors); a final small
  coordinate-descent refinement loop evaluating candidates through the
  EXISTING CPU mirrors (cpuEvalPlan) against the signature distance —
  fast, no GPU needed, fully headless.
- Honesty requirements: the report states which signature components
  were solved vs unsupported; results are a STARTING POINT (the preset
  hover-preview makes auditioning cheap). No claim of per-image
  optimality — same epistemic status as an LR preset.

## Input channels (the boundary)

Files only. Folder = expand to images. In-app entry ("Extract preset
from selection…") arrives WITH filmstrip multi-select (gap analysis A
#4) and just shells the same code path. Pinterest/web = the user
downloads pins to a folder first — no scraping, no network, no auth in
Silverbox, ever (document in --help). AI-driven = the AI curates files
and runs the CLI; it can then hand-edit the emitted JSON (presets are
already the AI-loop surface).

## Implementation shape

`--extract-preset` joins the CLI (cliArgs mode alongside render/check);
the analysis runs headless in the app's renderer (needs decode +
cpuEvalPlan; the CLI plumbing exists). New pure modules:
`engine/look/signature.ts` (image set → signature; unit-testable),
`engine/look/solve.ts` (signature → DevelopParams; unit-testable with
synthetic signatures). Preset emission through the existing
serializePreset. Verify: verify-lookextract.mjs — mode 1 consensus on
two hand-authored sidecars (exact medians, spread-drops-param), mode 2
on synthetic reference images with a KNOWN injected look (generate
refs by applying a known preset to test renders → extraction recovers
the tone curve within tolerance and the wheel hues within ~15°),
CLI report lines parse, in-app entry deferred until multi-select.

## Sizing / order

Mode 1 is small (a day-agent). Mode 2 is the exploratory core —
medium-large, Opus, and worth a spike checkpoint after the signature +
curve-solve land (validate on the Italy set before building the full
solver). Slot after the current queue; before or with multi-select.
