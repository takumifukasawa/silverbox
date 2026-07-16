/**
 * Headless CLI renderer (`electron . --render …` — the batch half of the
 * text-first workflow, ROADMAP "Headless CLI renderer"; `--check`/`--update`
 * extends it with golden renders, ROADMAP "Golden renders"): argv parsing
 * lives here, isolated from main/index.ts's window/IPC wiring so the pure
 * parsing logic (and the usage text) has one home.
 *
 * `parseCliArgs` only validates shape (numbers parse, enums match, mode-
 * specific options aren't mixed with the wrong mode); it never touches the
 * filesystem. `buildCliJob` resolves every path against the CLI's own launch
 * cwd — the renderer never needs to know what directory the terminal was in.
 */
import { basename, dirname, resolve } from 'node:path';
import {
  PROJECT_MANIFEST_NAME,
  type CliCheckJob,
  type CliDiffJob,
  type CliJob,
  type CliProgressResult,
  type CliRenderJob,
  type CliRenderPresetRef,
  type ExportColorSpace,
  type ExportMetadataPolicy,
} from '../../shared/ipc';

export const CLI_USAGE = `Usage: silverbox-render [options] <image.arw|jpg|look.json> [more…]
       silverbox-render --check [--update] [--threshold <deltaE>] [--json] <image…>
       silverbox-render --diff <sidecarA> <sidecarB> [--image <arw>] [--json]

  --project <dir>       resolve every plain-image input's look from this
                        project's playlist (<dir>/looks/) instead of the
                        legacy adjacent sidecar — a photo not on the
                        playlist renders with the DEFAULT look and a stderr
                        warning (never auto-added: a headless run must not
                        silently mutate someone's project). Accepts the
                        project directory OR a path to its own
                        project.silverbox (normalized to the directory).
                        A relative <name>.json INPUT ARGUMENT (see below)
                        resolves against this directory instead of the
                        launch cwd; without --project, today's behavior
                        is unchanged (each image's own adjacent sidecar).
  --out <dir>          output directory (default: alongside each input)
  --preset <name|path> apply a preset instead of the image's own sidecar.
                        A value ending in .json is read as a preset FILE;
                        anything else is looked up by NAME in
                        <userData>/presets (falling back to slug). Applies
                        exactly like the UI's "Apply preset" on a fresh
                        open: there is no interactive crop to preserve in a
                        batch, so the preset's look lands on identity
                        geometry, not the image's own sidecar geometry.
  --output <name>       which named output to render (default: the doc's
                        first; 'all' = every output, name-suffixed)
  --quality <1-100>     JPEG quality (default 90)
  --max-dim <px>        cap the long edge, preserving aspect (default: none)
  --metadata <policy>   all|minimal|none (default all)
  --colorspace <space>  srgb|p3 (default srgb)
  --min-rating <0-5>    skip inputs whose sidecar rating is absent or below
                        n, reported as {input,status:"skipped-rating"} — a
                        skip never counts as a failure (exit code unaffected)
  --skip-rejected       skip inputs whose sidecar/look is flagged reject
                        (pick/reject flags, docs/brief-bank/reject-flag.md),
                        reported as {input,status:"skipped-rejected"} — never
                        a failure (exit code unaffected). Unlike --min-rating
                        this is also valid with --check (a golden-check batch
                        skips rejects too — see below). Without this flag, a
                        photo flagged reject in the GUI renders/checks
                        exactly as before: an existing script's output must
                        never change just because someone flagged photos.
  --allow-external      opt-in to running a doc's 'external' hook nodes (task
                        #41) — a batch job over someone else's sidecars must
                        not silently execute arbitrary commands, so without
                        this flag every external node renders pass-through
                        and the file's result carries a warning line instead
  --json                NDJSON progress on stdout: one object per rendered
                        file, {input,output,width,height,bytes,ms} on
                        success, {input,status:"skipped-rating"} on a
                        --min-rating skip, or {input,error} on failure
  --help                show this help

Without --preset, each image uses its own sidecar if one exists, else the
same DEFAULT look a fresh open in the app shows (baseline exposure + the
camera-matched base curve + the embedded Sony lens profile, when present).

Rendering directly from a look file: an input ending in .json (a project's
looks/<name>.json, or any standalone look carrying a 'photo' field) is
rendered as-is, geometry included — its 'photo' field is resolved relative
to the look's own project dir (the parent of looks/), and THAT photo is
rendered with THIS look's full graph (unlike --preset, which intentionally
discards geometry). A look with no 'photo' field (a legacy adjacent
sidecar given directly, for instance) is an error naming the field and the
fix — open the IMAGE instead, unchanged.

Per-output export overrides: an output node's own sidecar 'export' field
(set via the app's Inspector, "Export overrides") always wins over
--quality/--max-dim/--metadata/--colorspace, field by field — the flags
above only fill in whatever a given output does NOT override.

Exit codes: 0 every file succeeded, 1 one or more files failed (the rest
still render and are reported), 2 bad usage.

Golden renders (--check): commits a small reference render (512px long edge
sRGB), then re-renders and reports drift as it happens — a photo archive
that owns its own regression suite. With --project, the golden lives at
<project>/golden/<look-name>.png (inside the project — never next to the
photo); without --project, it's the legacy <image>.silverbox.golden.png
next to the image/sidecar (still supported, unchanged — a stderr note
flags this as legacy so a --check run nudges you toward --project).

  --check               compare each image against its golden instead of
                        rendering to an output file. Options above other
                        than --json/--skip-rejected are not valid with
                        --check (a golden is always the image's own
                        sidecar-or-default look, at the fixed 512px long
                        edge — nothing else to choose; --skip-rejected is
                        the one exception, see above).
  --update              (re)write the golden for every input instead of
                        comparing (requires --check)
  --threshold <deltaE>  max mean CIE76 ΔE to still call it a PASS (default
                        1.0); p95 must also stay within 3x this threshold
                        (requires --check)

A missing golden is a FAILURE unless --update (a check run never silently
skips an unprotected photo). A dimension mismatch (the image's aspect ratio
changed since the golden was made — a crop edit) is also a FAILURE, reported
as {input,status:"dims-changed"} rather than resampled to compare. A
rejected input (--skip-rejected) is neither — reported as
{input,status:"skipped-rejected"}, never a failure.

Exit codes (--check): 0 every image passed or was updated, 1 one or more
failed/had no golden (without --update), 2 bad usage.

Sidecar visual diff (--diff): "code review for looks" for two versions of a
look — an AI-edited sidecar reviewed before you trust it, or two git
revisions of the same file. Reports diffLook's human-readable param lines
(added/removed nodes, changed values, curve changes summarized by their
p25/p50/p75 — never a raw point dump) PLUS the ΔE stats between the two
renders (same golden-render style CIE76 comparison --check uses, at the same
512px long edge).

  --diff <sidecarA> <sidecarB>
                        two sidecar JSON files (schemaVersion 2/3/4 all
                        accepted and migrated exactly like a normal open) —
                        neither has to be the image's OWN on-disk sidecar;
                        either side may be a project look file too (its
                        'photo' field is otherwise unused by --diff). This
                        CLI never shells to git; to diff against a git
                        revision, produce the file yourself first:
                          git show <rev>:path/to/photo.ARW.silverbox.json > /tmp/old.json
                          silverbox-render --diff /tmp/old.json photo.ARW.silverbox.json --image photo.ARW
  --image <path>        the image both sidecars render against. May be
                        OMITTED when both sidecars are project look files
                        carrying the SAME resolved 'photo' field — it's
                        derived automatically; otherwise (missing on
                        either side, or the two disagree) omitting --image
                        is a clear error. Not valid outside --diff. No
                        positional image arguments with --diff (pass it
                        via --image, or rely on the 'photo' derivation).

A geometry difference that changes the rendered dimensions (e.g. a crop edit
between the two sidecars) is reported as {input,lines,status:"dims-changed"}
— the param lines still come through, but there is no pixel comparison to
resample and force.

Exit codes (--diff): 0 the comparison ran (regardless of whether it found
differences — the same "diff always succeeds, its OUTPUT is the news"
exit-code philosophy \`git diff\` itself uses), 1 a sidecar/the image could
not be read or parsed, 2 bad usage.
`;

export interface CliParsedArgs {
  mode: 'render' | 'check' | 'diff';
  images: string[];
  outDir: string | null;
  preset: string | null;
  output: string | null;
  quality: number;
  maxDim: number | null;
  metadata: ExportMetadataPolicy;
  colorSpace: ExportColorSpace;
  /** --min-rating: only meaningful with mode 'render'; null = no filtering. */
  minRating: number | null;
  /** --skip-rejected: meaningful with mode 'render' AND 'check' (unlike --min-rating) — see CliRenderJob.skipRejected's doc comment. */
  skipRejected: boolean;
  json: boolean;
  help: boolean;
  /** --update: only meaningful with mode 'check'. */
  update: boolean;
  /** --threshold: only meaningful with mode 'check'; max mean ΔE for a PASS. */
  threshold: number;
  /** --allow-external: only meaningful with mode 'render' (see CliRenderJob's doc comment). */
  allowExternal: boolean;
  /** --diff <sidecarA> <sidecarB>'s first path; only meaningful with mode 'diff'. */
  sidecarA: string | null;
  /** --diff <sidecarA> <sidecarB>'s second path; only meaningful with mode 'diff'. */
  sidecarB: string | null;
  /**
   * --image <path>; only meaningful with mode 'diff'. null is now valid at
   * PARSE time (CLI tooling parity, project-storage.md stage 2) — buildCliJob
   * can't yet know whether both sidecars carry a matching 'photo' field (that
   * needs a filesystem read), so the "must be derivable or given" check moved
   * to runtime (appStore.ts's runCliDiff).
   */
  diffImage: string | null;
  /** --project <dir>; valid with every mode (render/check/diff) — see CLI_USAGE. null = no project (today's legacy behavior). */
  project: string | null;
}

const METADATA_VALUES: ExportMetadataPolicy[] = ['all', 'minimal', 'none'];
const COLORSPACE_VALUES: ExportColorSpace[] = ['srgb', 'p3'];

/** `--threshold`'s default when `--check` is given without one — see CLI_USAGE. */
const DEFAULT_DELTAE_THRESHOLD = 1.0;

/** Parse `--render`'s own argv tail (everything after the flag). Pure — no filesystem access. */
export function parseCliArgs(argv: string[]): CliParsedArgs | { error: string } {
  const opts: CliParsedArgs = {
    mode: 'render',
    images: [],
    outDir: null,
    preset: null,
    output: null,
    quality: 90,
    maxDim: null,
    metadata: 'all',
    colorSpace: 'srgb',
    minRating: null,
    skipRejected: false,
    json: false,
    help: false,
    update: false,
    threshold: DEFAULT_DELTAE_THRESHOLD,
    allowExternal: false,
    sidecarA: null,
    sidecarB: null,
    diffImage: null,
    project: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--allow-external':
        opts.allowExternal = true;
        break;
      case '--skip-rejected':
        opts.skipRejected = true;
        break;
      case '--project':
        opts.project = argv[++i] ?? null;
        if (opts.project === null) return { error: '--project expects a directory or a project.silverbox path' };
        break;
      case '--check':
        opts.mode = 'check';
        break;
      case '--diff': {
        const a = argv[++i];
        const b = argv[++i];
        if (a === undefined || b === undefined) return { error: '--diff expects two sidecar file paths' };
        opts.mode = 'diff';
        opts.sidecarA = a;
        opts.sidecarB = b;
        break;
      }
      case '--image':
        opts.diffImage = argv[++i] ?? null;
        if (opts.diffImage === null) return { error: '--image expects a path' };
        break;
      case '--update':
        opts.update = true;
        break;
      case '--threshold': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) return { error: '--threshold expects a positive number' };
        opts.threshold = v;
        break;
      }
      case '--out':
        opts.outDir = argv[++i] ?? null;
        if (opts.outDir === null) return { error: '--out expects a directory' };
        break;
      case '--preset':
        opts.preset = argv[++i] ?? null;
        if (opts.preset === null) return { error: '--preset expects a name or a .json path' };
        break;
      case '--output':
        opts.output = argv[++i] ?? null;
        if (opts.output === null) return { error: '--output expects a name or "all"' };
        break;
      case '--quality': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v < 1 || v > 100) return { error: '--quality expects a number 1-100' };
        opts.quality = v;
        break;
      }
      case '--max-dim': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) return { error: '--max-dim expects a positive number' };
        opts.maxDim = v;
        break;
      }
      case '--metadata': {
        const v = argv[++i];
        if (!METADATA_VALUES.includes(v as ExportMetadataPolicy)) return { error: '--metadata must be all|minimal|none' };
        opts.metadata = v as ExportMetadataPolicy;
        break;
      }
      case '--colorspace': {
        const v = argv[++i];
        if (!COLORSPACE_VALUES.includes(v as ExportColorSpace)) return { error: '--colorspace must be srgb|p3' };
        opts.colorSpace = v as ExportColorSpace;
        break;
      }
      case '--min-rating': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 5) return { error: '--min-rating expects an integer 0-5' };
        opts.minRating = v;
        break;
      }
      default:
        if (arg.startsWith('--')) return { error: `unknown option: ${arg}` };
        opts.images.push(arg);
    }
  }
  if (opts.mode === 'check') {
    if (opts.outDir !== null) return { error: '--out is not valid with --check' };
    if (opts.preset !== null) return { error: '--preset is not valid with --check' };
    if (opts.output !== null) return { error: '--output is not valid with --check' };
    if (opts.quality !== 90) return { error: '--quality is not valid with --check' };
    if (opts.maxDim !== null) return { error: '--max-dim is not valid with --check (goldens are fixed at 512px long edge)' };
    if (opts.metadata !== 'all') return { error: '--metadata is not valid with --check' };
    if (opts.colorSpace !== 'srgb') return { error: '--colorspace is not valid with --check' };
    if (opts.minRating !== null) return { error: '--min-rating is not valid with --check' };
    // --skip-rejected is deliberately NOT rejected here — unlike --min-rating
    // it's valid with --check too (CliCheckJob.skipRejected's doc comment).
    if (opts.allowExternal) return { error: '--allow-external is not valid with --check' };
    if (opts.diffImage !== null) return { error: '--image is not valid with --check' };
  } else if (opts.mode === 'diff') {
    // --image is no longer required at parse time (CLI tooling parity,
    // project-storage.md stage 2): it can be DERIVED from both sidecars'
    // `photo` field at runtime (appStore.ts's runCliDiff) — a filesystem
    // read this pure parse function never does, so the "derivable or given"
    // check lives there instead.
    if (opts.images.length > 0) return { error: '--diff takes no positional images — pass the image via --image' };
    if (opts.outDir !== null) return { error: '--out is not valid with --diff' };
    if (opts.preset !== null) return { error: '--preset is not valid with --diff' };
    if (opts.output !== null) return { error: '--output is not valid with --diff' };
    if (opts.quality !== 90) return { error: '--quality is not valid with --diff' };
    if (opts.maxDim !== null) return { error: '--max-dim is not valid with --diff' };
    if (opts.metadata !== 'all') return { error: '--metadata is not valid with --diff' };
    if (opts.colorSpace !== 'srgb') return { error: '--colorspace is not valid with --diff' };
    if (opts.minRating !== null) return { error: '--min-rating is not valid with --diff' };
    if (opts.skipRejected) return { error: '--skip-rejected is not valid with --diff' };
    if (opts.allowExternal) return { error: '--allow-external is not valid with --diff' };
    if (opts.update) return { error: '--update is not valid with --diff' };
    if (opts.threshold !== DEFAULT_DELTAE_THRESHOLD) return { error: '--threshold is not valid with --diff' };
  } else {
    if (opts.update) return { error: '--update requires --check' };
    if (opts.threshold !== DEFAULT_DELTAE_THRESHOLD) return { error: '--threshold requires --check' };
    if (opts.diffImage !== null) return { error: '--image requires --diff' };
  }
  return opts;
}

/**
 * `--project <dir>` normalization (CLI tooling parity, project-storage.md
 * stage 2): accepts the project DIRECTORY or a path to its own
 * `project.silverbox` — the latter collapses to its containing directory,
 * same "drop project.silverbox itself" rule App.tsx's drag-drop handler
 * already applies to a dropped project file. Pure string/path op, no
 * filesystem access (parseCliArgs/buildCliJob's own "never touches the
 * filesystem" contract — the resolved dir's actual validity is checked at
 * runtime, once, when the job's first image opens against it).
 */
function normalizeProjectDir(p: string): string {
  return basename(p) === PROJECT_MANIFEST_NAME ? dirname(p) : p;
}

/**
 * Resolve parsed argv into the job the renderer actually consumes — every
 * path made absolute against `cwd` (the terminal's cwd, i.e. `process.cwd()`
 * as seen by main before any `chdir`), so nothing downstream needs to know
 * what directory the CLI was launched from. `preset`'s name-vs-path split:
 * see CLI_USAGE above — a trailing `.json` is the only signal, deliberately
 * simple and easy to document rather than sniffing the filesystem.
 *
 * `resolveInput`: a `.json` argument (a look file — CLI tooling parity item
 * 2) resolves against the ACTIVE PROJECT dir instead of `cwd` when
 * `--project` is given ("path can be relative to project" — CLI_USAGE) —
 * every other argument (plain images, and any `.json` when there's no
 * --project) keeps resolving against `cwd` exactly as before.
 */
export function buildCliJob(parsed: CliParsedArgs, cwd: string): CliJob {
  const projectDir = parsed.project === null ? null : normalizeProjectDir(resolve(cwd, parsed.project));
  const resolveInput = (p: string): string => resolve(p.endsWith('.json') && projectDir !== null ? projectDir : cwd, p);
  const images = parsed.images.map(resolveInput);
  if (parsed.mode === 'check') {
    const job: CliCheckJob = {
      mode: 'check',
      images,
      projectDir,
      update: parsed.update,
      threshold: parsed.threshold,
      skipRejected: parsed.skipRejected,
    };
    return job;
  }
  if (parsed.mode === 'diff') {
    // parseCliArgs's own validation guarantees sidecarA/sidecarB are set
    // whenever mode reaches 'diff' (they come from the SAME --diff parse as
    // the mode flip); diffImage may be null (runtime-derived — see
    // CliDiffJob.image's doc comment).
    const job: CliDiffJob = {
      mode: 'diff',
      projectDir,
      sidecarA: resolveInput(parsed.sidecarA!),
      sidecarB: resolveInput(parsed.sidecarB!),
      image: parsed.diffImage === null ? null : resolve(cwd, parsed.diffImage),
    };
    return job;
  }
  const preset: CliRenderPresetRef | null =
    parsed.preset === null
      ? null
      : parsed.preset.endsWith('.json')
        ? { kind: 'path', value: resolve(cwd, parsed.preset) }
        : { kind: 'name', value: parsed.preset };
  const job: CliRenderJob = {
    mode: 'render',
    images,
    projectDir,
    outDir: parsed.outDir === null ? null : resolve(cwd, parsed.outDir),
    preset,
    output: parsed.output,
    quality: parsed.quality,
    maxDim: parsed.maxDim,
    metadata: parsed.metadata,
    colorSpace: parsed.colorSpace,
    minRating: parsed.minRating,
    skipRejected: parsed.skipRejected,
    allowExternal: parsed.allowExternal,
  };
  return job;
}

/**
 * One progress line: `{stderr,line}` — `--json` puts everything (success AND
 * failure) on stdout as NDJSON; human mode splits success (stdout) from
 * failure (stderr). Handles both `--render`'s CliRenderResult and
 * `--check`'s CliCheckResult shapes (see shared/ipc.ts's CliProgressResult).
 */
export function formatCliProgress(result: CliProgressResult, json: boolean): { stderr: boolean; line: string } {
  if (json) return { stderr: false, line: JSON.stringify(result) };
  if ('error' in result) return { stderr: true, line: `${result.input}: ERROR ${result.error}` };
  if ('lines' in result) {
    // --diff (CliDiffOutcome): checked BEFORE the 'status'/'deltaE' branches
    // below — a dims-changed diff outcome also carries 'status', and a
    // normal one also carries 'deltaE', so 'lines' (diff-only) is the one
    // key that disambiguates both variants from --check's CliCheckOutcome.
    // Never a failure (see this file's CLI_USAGE "git diff" exit-code note).
    const lines = result.lines.map((l) => `  ${l}`);
    if ('status' in result) {
      return { stderr: false, line: [`${result.input}: DIMS CHANGED (no pixel comparison)`, ...lines].join('\n') };
    }
    const { mean, p95, max } = result.deltaE;
    return {
      stderr: false,
      line: [`${result.input}:`, ...lines, `  ΔE mean=${mean.toFixed(3)} p95=${p95.toFixed(3)} max=${max.toFixed(3)}`].join(
        '\n'
      ),
    };
  }
  if ('status' in result) {
    // --render's own statuses (--min-rating/--skip-rejected skips) are never
    // failures — a completely different bucket from --check's no-golden/
    // dims-changed statuses below (which ARE failures unless --update just
    // wrote them). 'skipped-rejected' is shared by BOTH CliRenderResult and
    // CliCheckStatus (--skip-rejected applies to --check too, unlike
    // --min-rating) — same never-a-failure early return either way.
    if (result.status === 'skipped-rating') return { stderr: false, line: `${result.input}: SKIPPED (rating)` };
    if (result.status === 'skipped-rejected') return { stderr: false, line: `${result.input}: SKIPPED (rejected)` };
    const isFailure = result.status !== 'updated';
    const label = result.status === 'updated' ? 'UPDATED' : result.status === 'no-golden' ? 'NO GOLDEN' : 'DIMS CHANGED';
    return { stderr: isFailure, line: `${result.input}: ${label}` };
  }
  if ('deltaE' in result) {
    const { mean, p95, max } = result.deltaE;
    const label = result.pass ? 'PASS' : 'FAIL';
    return {
      stderr: !result.pass,
      line: `${result.input}: ${label}  ΔE mean=${mean.toFixed(3)} p95=${p95.toFixed(3)} max=${max.toFixed(3)}`,
    };
  }
  const base = `${result.input} -> ${result.output}  (${result.width}x${result.height}, ${result.bytes} bytes, ${result.ms}ms)`;
  const warnings = result.warnings ?? [];
  if (warnings.length === 0) return { stderr: false, line: base };
  // Warnings never affect the exit code (see runCliMode's onProgress) — just
  // extra lines under human output; --json keeps them inside the one object
  // (handled by the early `if (json)` return above).
  return { stderr: false, line: [base, ...warnings.map((w) => `  WARNING: ${w}`)].join('\n') };
}
