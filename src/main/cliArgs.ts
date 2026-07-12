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
import { resolve } from 'node:path';
import type {
  CliCheckJob,
  CliJob,
  CliProgressResult,
  CliRenderJob,
  CliRenderPresetRef,
  ExportColorSpace,
  ExportMetadataPolicy,
} from '../../shared/ipc';

export const CLI_USAGE = `Usage: silverbox-render [options] <image.arw|jpg> [more images…]
       silverbox-render --check [--update] [--threshold <deltaE>] [--json] <image…>

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
  --json                NDJSON progress on stdout: one object per rendered
                        file, {input,output,width,height,bytes,ms} on
                        success or {input,error} on failure
  --help                show this help

Without --preset, each image uses its own sidecar if one exists, else the
same DEFAULT look a fresh open in the app shows (baseline exposure + the
camera-matched base curve + the embedded Sony lens profile, when present).

Exit codes: 0 every file succeeded, 1 one or more files failed (the rest
still render and are reported), 2 bad usage.

Golden renders (--check): commits a small reference render
(<image>.silverbox.golden.png, 512px long edge sRGB) next to each
image/sidecar, then re-renders and reports drift as it happens — a photo
archive that owns its own regression suite.

  --check               compare each image against its golden instead of
                        rendering to an output file. Options above other
                        than --json are not valid with --check (a golden is
                        always the image's own sidecar-or-default look, at
                        the fixed 512px long edge — nothing else to choose).
  --update              (re)write the golden for every input instead of
                        comparing (requires --check)
  --threshold <deltaE>  max mean CIE76 ΔE to still call it a PASS (default
                        1.0); p95 must also stay within 3x this threshold
                        (requires --check)

A missing golden is a FAILURE unless --update (a check run never silently
skips an unprotected photo). A dimension mismatch (the image's aspect ratio
changed since the golden was made — a crop edit) is also a FAILURE, reported
as {input,status:"dims-changed"} rather than resampled to compare.

Exit codes (--check): 0 every image passed or was updated, 1 one or more
failed/had no golden (without --update), 2 bad usage.
`;

export interface CliParsedArgs {
  mode: 'render' | 'check';
  images: string[];
  outDir: string | null;
  preset: string | null;
  output: string | null;
  quality: number;
  maxDim: number | null;
  metadata: ExportMetadataPolicy;
  colorSpace: ExportColorSpace;
  json: boolean;
  help: boolean;
  /** --update: only meaningful with mode 'check'. */
  update: boolean;
  /** --threshold: only meaningful with mode 'check'; max mean ΔE for a PASS. */
  threshold: number;
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
    json: false,
    help: false,
    update: false,
    threshold: DEFAULT_DELTAE_THRESHOLD,
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
      case '--check':
        opts.mode = 'check';
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
  } else {
    if (opts.update) return { error: '--update requires --check' };
    if (opts.threshold !== DEFAULT_DELTAE_THRESHOLD) return { error: '--threshold requires --check' };
  }
  return opts;
}

/**
 * Resolve parsed argv into the job the renderer actually consumes — every
 * path made absolute against `cwd` (the terminal's cwd, i.e. `process.cwd()`
 * as seen by main before any `chdir`), so nothing downstream needs to know
 * what directory the CLI was launched from. `preset`'s name-vs-path split:
 * see CLI_USAGE above — a trailing `.json` is the only signal, deliberately
 * simple and easy to document rather than sniffing the filesystem.
 */
export function buildCliJob(parsed: CliParsedArgs, cwd: string): CliJob {
  const images = parsed.images.map((p) => resolve(cwd, p));
  if (parsed.mode === 'check') {
    const job: CliCheckJob = { mode: 'check', images, update: parsed.update, threshold: parsed.threshold };
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
    outDir: parsed.outDir === null ? null : resolve(cwd, parsed.outDir),
    preset,
    output: parsed.output,
    quality: parsed.quality,
    maxDim: parsed.maxDim,
    metadata: parsed.metadata,
    colorSpace: parsed.colorSpace,
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
  if ('status' in result) {
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
  return {
    stderr: false,
    line: `${result.input} -> ${result.output}  (${result.width}x${result.height}, ${result.bytes} bytes, ${result.ms}ms)`,
  };
}
