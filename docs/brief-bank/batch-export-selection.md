# Brief: batch export of the filmstrip selection

Status: DESIGN OPEN — the deferred item from `multi-select-sync.md`
("batch export of the selection: OUT of this brief… queue as its own small
brief after this lands"). That brief landed (0552648); multi-select
(`filmstripSelection`) and `syncSelection` both already exist in
`appStore.ts`.
Prereq reading: `ExportDialog.tsx` (the single-photo export UI this brief
extends), `Filmstrip.tsx` (`filmstripSelection`/`totalSelectedCount`, the
"N selected" badge + Sync… button precedent), `appStore.ts`'s
`exportOnePath`/`exportSelectedOutputs`/`runCliRender`/`openImageByPath`
(read the doc comments on `opts.legacySidecarOnly`/`opts.cliProjectDir` at
`appStore.ts:847-863` carefully — see the correction below, this is the
sharpest fact in this brief), `shared/ipc.ts`'s `CliRenderJob`, and
`docs/brief-bank/per-output-export-settings.md` (already landed —
`resolveExportSettings` is the one place effective per-output settings are
computed, reused here unchanged).

## What already exists (the reuse surface)

- `exportOnePath(targetPath, outputId, opts, allowExternal)`
  (`appStore.ts:2461-2535`) is the ONE function that decodes-at-full-res,
  resolves external/denoise nodes, renders, and encodes+writes a single
  output-node-to-file. Every export path already funnels through it. This
  brief adds no second implementation of it.
- `runCliRender` (`appStore.ts:4731-4876`) already does almost exactly what
  a "batch export N photos" feature needs: for each input path, open it,
  resolve its OWN sidecar/project look (not the previously-open photo's
  in-memory graph), resolve which output node(s) `job.output` (a NAME, or
  `'all'`, or `null` = the doc's first — `shared/ipc.ts:533-534`) picks
  against THAT photo's own graph, suffix-disambiguate via
  `suffixExportPath`, call `exportOnePath` per target, and report
  `{input, output, …}` or `{input, error}` per file via `onResult` — errors
  are already per-photo, never batch-fatal (the `try/catch` wraps each
  `images` loop iteration and simply continues).
- `exportSelectedOutputs` (`appStore.ts:4680-4729`) is the existing
  SINGLE-photo multi-output export (`'active' | 'all' | nodeId` — note:
  ID-based, not name-based) — the precedent for the suffix-disambiguation
  loop, but not itself reusable across DIFFERENT photos (node ids aren't
  stable across docs; only `outputName` is, which is exactly why
  `CliRenderJob.output` is name-based instead).

## Correction that shapes this whole brief

`runCliRender`'s internal `openImageByPath` calls set `legacySidecarOnly`/
`cliProjectDir` based on `job.projectDir` (`appStore.ts:4794-4798`). Both
options are explicitly documented "HEADLESS CLI ONLY … **Never set by
interactive UI code**" (`appStore.ts:847-863`): they bypass the live
`AppState.project`/playlist entirely (`cliProjectDir` is a READ-ONLY lookup
that never adds a playlist row; `legacySidecarOnly` bypasses the project
system altogether). Calling `get().runCliRender(job, …)` verbatim from the
interactive renderer would therefore violate that stated invariant — it
would silently stop writing through the ACTIVE project's own
`ensureProjectAndAddPhoto` path even though every selected filmstrip photo
is already on that live project's playlist. **Decision: do not call
`runCliRender` directly.** Instead, ride its REUSABLE atoms
(`exportOnePath`, the name-based output-target resolution +
`suffixExportPath` disambiguation loop it shares in spirit with
`exportSelectedOutputs`) inside a NEW small loop that calls plain
`openImageByPath(path, { keepFolderContext: true })` — no `cliProjectDir`,
no `legacySidecarOnly` — so each selected photo opens through the exact same
interactive path a filmstrip click already uses, against the SAME live
project. This is "the same batch machinery" in the sense that matters (one
`exportOnePath`, one target-resolution contract, one non-fatal-per-photo
error model) without repurposing a function whose own doc comment forbids
interactive use.

## Decided semantics

- **Trigger**: opening the normal Export dialog (Toolbar "Export…" / `⌘E`)
  while the selection has 2+ (the exact `totalSelectedCount` calculation
  `Filmstrip.tsx:322` already uses: `(imagePath ? 1 : 0) +
  filmstripSelection.length`) switches `ExportDialog` into an "N photos"
  batch mode — same dialog shell, not a second component/button.
- **Per-photo look resolution**: each photo renders its OWN sidecar/project
  look, never the primary's in-memory graph. Mechanism: `openImageByPath`
  (bare, `keepFolderContext: true`) per selected path, THEN resolve/export —
  identical in effect to `runCliRender`'s `job.preset === null` path (no
  preset/paste ever applied; "whatever that photo's own look already is on
  disk").
- **Output-target selection**: NAME-based (`null` = doc's first / `'all'` /
  a name string), matching `CliRenderJob.output`'s existing contract — NOT
  `exportSelectedOutputs`'s id-based `target`, since node ids differ per
  photo. The dialog's existing output-target `<select>` (`ExportDialog.tsx`,
  `export-output-target`), in batch mode, is populated from the union of
  output NAMES visible on the currently-open PRIMARY (best-effort UI
  preview) but the actual resolution re-runs per photo against ITS OWN
  graph — a photo lacking that name falls back to its own first output,
  exactly `job.output`'s existing "no match ⇒ first" rule.
- **Filenames**: no new template syntax. Reuse `cliOutputPath(input, outDir)`
  (basename + `.jpg` alongside each input, or inside a chosen `outDir`) plus
  the existing `suffixExportPath`-based per-output-name suffix + numeric
  disambiguator for 2+ resolved outputs on any one photo — both already used
  verbatim by `runCliRender`, nothing new to build. The batch dialog adds
  one control: an optional output directory (folder picker); empty = "next
  to each source file," same as `--out` omitted.
- **Quality/metadata/color space**: the SAME dialog controls as single-photo
  export, applied as the FALLBACK to each output node's own per-output
  overrides via `resolveExportSettings` — unchanged semantics, just looped
  per photo/output.
- **Progress**: `onResult`-shaped callback fires once per rendered FILE
  (already true of the reused atoms) — the dialog counts DISTINCT `input`
  values for "N of M photos" (one photo with `'all'` outputs produces
  multiple results for the same input; don't double-count it as 2 photos).
- **Cancel**: NEW. Today's reused loop has no cancellation point (headless
  CLI never needs one — it's a one-shot process). Add an optional
  `isCancelled: () => boolean` check at the top of each photo iteration
  (checked between photos, never mid-photo — an in-flight photo's file
  always finishes so nothing is left half-written). Purely additive; no
  existing caller passes it, so CLI behavior is unchanged.
- **Errors**: per-photo, never batch-fatal — already the existing contract
  of the reused loop shape; the dialog renders a final per-photo error list
  ("12 exported, 1 failed: DSC004.ARW — <message>").
- **Interactive side-effects the reused atoms don't handle themselves** (all
  three additive, all inert for the unrelated CLI path since they only ever
  fire when called with the new interactive-only entry point):
  1. Before the loop starts, `await flushPendingAutosave(get())` once — the
     PRIMARY may hold an edit that hasn't autosaved yet; `openImageByPath`'s
     own outgoing-photo flush is deliberately fire-and-forget
     (`appStore.ts:2910`, to avoid a same-path race on a plain reopen), so a
     batch that includes the primary itself needs an explicit AWAITED flush
     first — the exact precedent `openProject` already establishes at
     `appStore.ts:3349` for the identical reason.
  2. Every `openImageByPath` call in the loop passes `keepFolderContext:
     true` — omitting it would exit "project mode" (clear `folderDir`/
     `folderEntries`, hiding the filmstrip) on the FIRST photo switch.
  3. After the loop completes (or is cancelled), re-open the ORIGINAL
     primary path (`openImageByPath(originalPath, { keepFolderContext: true
     })`) so the canvas lands back where the user started, not on whichever
     photo happened to render last — safe because step 1 already flushed
     anything that needed saving before the loop touched anything.
- **Undo**: N/A, stated explicitly rather than left as a silent gap — an
  export writes an OUTPUT FILE, never a document mutation. `exportImage`/
  `exportSelectedOutputs` already push no undo entry today; this feature
  follows the identical precedent for the same reason.

## UI notes

- `ExportDialog`: batch mode relabels the run button "Export N photos", adds
  an output-directory picker, a per-photo progress counter + Cancel button
  while running, and a completion summary (count exported / count failed,
  with the failed list expandable). The existing quality/maxDim/metadata/
  colorSpace/preset controls are unchanged and shared between single and
  batch mode.
- Reads `filmstripSelection`/`imagePath` directly (same source
  `Filmstrip.tsx`'s own "N selected" badge already uses) — no new selection
  state needed.

## Verify sketch (verify-batchexport.mjs)

(1) select 3 photos (2 via ⌘-click + the primary), each with a DIFFERENT
look already on disk (distinct `ev`), run a batch export to a chosen output
dir: 3 files land, pixel means differ per the on-disk look — NOT the
primary's in-memory graph, proving per-photo resolution; (2) a photo
carrying a per-output export override (`per-output-export-settings.md`) is
honored inside the batch while dialog defaults apply elsewhere (byte/dim
assertions, same contract `verify-exportsettings` already covers — asserted
once here inside a batch run, not re-litigated); (3) output target `'all'`
on a photo with 2 outputs inside a 3-photo batch produces the right total
file count with the right name suffixes; (4) one photo's export is forced
to fail (e.g. a relink-pending/missing path) — the other two still export,
the failure is reported per-photo, nothing else in the batch aborts; (5)
cancel mid-batch: the in-flight photo's file still completes intact, no
further photos render; (6) after the batch (success or cancel), `imagePath`
is back to the original primary and `folderEntries`/`filmstripSelection` are
unchanged (the `keepFolderContext` round trip); (7) no undo entry is pushed
by a batch export (`peekUndo` identical before/after).

## Explicitly deferred

Filename templating beyond the existing basename/outDir/suffix convention
(no `{n}`/date/custom-pattern syntax). Per-photo progress thumbnails or a
visual grid (text/count progress only, v1). Resuming a cancelled batch.
Exporting a specific NON-shared output id across photos whose output names
differ entirely (name-or-first is the only selection rule, same limitation
`CliRenderJob.output` already has). Virtual copies interacting with batch
export beyond what "name-based, per-photo-resolved" already covers — see
`virtual-copy.md`.
