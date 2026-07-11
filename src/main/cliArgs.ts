/**
 * Headless CLI renderer (`electron . --render …` — the batch half of the
 * text-first workflow, ROADMAP "Headless CLI renderer"): argv parsing lives
 * here, isolated from main/index.ts's window/IPC wiring so the pure parsing
 * logic (and the usage text) has one home.
 *
 * `parseCliArgs` only validates shape (numbers parse, enums match); it never
 * touches the filesystem. `buildCliRenderJob` resolves every path against the
 * CLI's own launch cwd — the renderer never needs to know what directory the
 * terminal was in.
 */
import { resolve } from 'node:path';
import type { CliRenderJob, CliRenderPresetRef, CliRenderResult, ExportColorSpace, ExportMetadataPolicy } from '../../shared/ipc';

export const CLI_USAGE = `Usage: silverbox-render [options] <image.arw|jpg> [more images…]

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
`;

export interface CliParsedArgs {
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
}

const METADATA_VALUES: ExportMetadataPolicy[] = ['all', 'minimal', 'none'];
const COLORSPACE_VALUES: ExportColorSpace[] = ['srgb', 'p3'];

/** Parse `--render`'s own argv tail (everything after the flag). Pure — no filesystem access. */
export function parseCliArgs(argv: string[]): CliParsedArgs | { error: string } {
  const opts: CliParsedArgs = {
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
export function buildCliRenderJob(parsed: CliParsedArgs, cwd: string): CliRenderJob {
  const preset: CliRenderPresetRef | null =
    parsed.preset === null
      ? null
      : parsed.preset.endsWith('.json')
        ? { kind: 'path', value: resolve(cwd, parsed.preset) }
        : { kind: 'name', value: parsed.preset };
  return {
    images: parsed.images.map((p) => resolve(cwd, p)),
    outDir: parsed.outDir === null ? null : resolve(cwd, parsed.outDir),
    preset,
    output: parsed.output,
    quality: parsed.quality,
    maxDim: parsed.maxDim,
    metadata: parsed.metadata,
    colorSpace: parsed.colorSpace,
  };
}

/** One progress line: `{stderr,line}` — `--json` puts everything (success AND error) on stdout as NDJSON; human mode splits success (stdout) from error (stderr). */
export function formatCliProgress(result: CliRenderResult, json: boolean): { stderr: boolean; line: string } {
  if (json) return { stderr: false, line: JSON.stringify(result) };
  if ('error' in result) return { stderr: true, line: `${result.input}: ERROR ${result.error}` };
  return {
    stderr: false,
    line: `${result.input} -> ${result.output}  (${result.width}x${result.height}, ${result.bytes} bytes, ${result.ms}ms)`,
  };
}
