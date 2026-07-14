/**
 * External-tool hook node (denoise v1, task #41) — main-process executor.
 *
 * Round trip: check the on-disk cache (externalCache.ts) first — a hit skips
 * spawning entirely; a miss writes the renderer's pixels to a temp TIFF,
 * spawns the user's command (child_process.execFile — shell:false, argv
 * split ourselves, see shared/externalTool.ts's
 * splitCommandTemplate/substituteArgv), reads the result back, and returns it
 * to the renderer for GPU re-entry.
 *
 * DEVIATION from the design brief's "16-bit sRGB-encoded / 32-bit linear
 * float" TIFF spec: this ships 8-BIT TIFF for BOTH modes. Every attempt at a
 * true 16-bit or float round trip through the bundled sharp v0.35.3 +
 * libvips (typed-array input matching sharp's own `rawDepth` inference,
 * `.toColourspace('rgb16')`/`'scrgb'`, `.pipelineColourspace(...)`, PNG as an
 * alternative container) either silently collapsed back to 8-bit or produced
 * garbled/zeroed samples — reproducible, not a one-off fluke (spiked
 * extensively before landing here). The raw *input* depth is honored
 * correctly (confirmed via a pure raw→raw round trip with NO file codec in
 * between), so the bug is specifically in this build's TIFF/PNG *encoders*
 * when writing a synthetically-constructed (not decoded-from-file) high-bit
 * image — a genuine environment limitation, not a usage mistake, but not
 * provably fixable in the time available either. The 8-bit path is fully
 * reliable (proven the same way imageExport.ts's export pipeline already
 * relies on sharp for 8-bit RGBA). `encoded` and `linear` modes still differ
 * meaningfully: `encoded` gets the GPU's WORK_TO_SRGB + exact sRGB OETF
 * applied before quantizing (identical semantics to a normal export's
 * pixels); `linear` gets the raw linear Rec.2020 value CLAMPED to [0,1]
 * before quantizing (so a tool built for scene-linear input still gets
 * genuinely linear, un-curved numbers — just 8-bit-quantized ones, and
 * highlights above 1.0 clip in this wire format, a real precision/dynamic-
 * range cost). Swapping in true 16-bit/float only touches this file (and the
 * verify fixture) — the GPU passes/cache/protocol already carry full
 * rgba16float precision right up to this boundary.
 *
 * FOLLOW-UP FINDING (hand-test round with real gmic, task #41 remaining
 * item): an external TOOL's *output* can still legitimately come back at a
 * higher bit depth than the 8-bit input we sent it (gmic's `-o {out}`
 * defaults to a FLOAT TIFF regardless of input depth). Empirically, in this
 * build, reading pixels back out of such a file is simply broken, even
 * though the file itself is fine: `sharp(out).stats()` reports correct
 * min/max, but `sharp(out).raw({depth:'float'})` returns 255.0 for EVERY
 * sample (a uniform-white image — this was the actual bug a user hit), and
 * `sharp(out).raw({depth:'ushort'})` against a 16-bit TIFF returns all
 * ZEROS. Only `sharp(out).raw()` against a genuine 8-bit ('uchar') TIFF
 * round-trips correctly (proven the same way the file-level deviation above
 * was — pixels 40-146 survive `-o out.tiff,uint8` exactly). So: the
 * extraction layer, not the file, is what's broken for anything above 8-bit
 * here. Rather than keep provably-garbage read paths around, this file now
 * REJECTS any non-uchar tool output outright with an actionable reason
 * (`meta.depth` other than 'uchar'/undefined) instead of silently reading
 * zeros or a blown-out white frame — see the depth check in
 * `runExternalTool` below and `fromRawChannels`' doc comment. The fix for
 * gmic specifically is a `,uint8` suffix on its own `-o` target (see the
 * inspector hint / recommended commands).
 *
 * SECURITY: this module trusts its caller completely — it has no notion of
 * "confirmed" or "disabled" nodes. That gate lives ENTIRELY in the renderer
 * (externalNodeRunner.ts) and the CLI's own `--allow-external` flag; by the
 * time a request reaches here, running the command IS the decision already
 * made. Sub-processes: main process only, never a shell, cwd = a fresh
 * per-run scratch dir (always removed afterward), env reduced to just
 * PATH/HOME/TMPDIR (each passed through only when actually set in
 * process.env, never invented) — no other ambient environment variable
 * reaches the tool.
 *
 * HOME (round-2 hand-test finding): real gmic run without $HOME logged
 * `cimg::create_dir(): Failed to create directory '/gmic'` — with no HOME,
 * G'MIC falls back to a bogus root-level resource dir for its own
 * config/cache. Warning-level noise for a stateless filter like
 * denoise_patchpca, but FATAL for `-denoise_cnn`, which downloads its CNN
 * weights into that same resource dir on first use — no HOME, no writable
 * dir, no weights, no denoise. TMPDIR is passed through for the same class
 * of reason (a tool reaching for its OWN scratch space beyond the cwd we
 * already give it); neither one broadens what the command can reach beyond
 * what running it as this OS user already permits.
 *
 * On ANY failure (spawn error, non-zero exit, timeout, missing/malformed
 * output, dimension mismatch) this resolves `{ok:false,reason}` — it never
 * throws — so the caller's "pass through + badge" contract is trivial to
 * implement (see externalNodeRunner.ts).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { ExternalToolRequest, ExternalToolResult } from '../../shared/ipc';
import { splitCommandTemplate, substituteArgv } from '../../shared/externalTool';
import { readExternalCache, writeExternalCache } from './externalCache';

/** 5 minutes — the hook node is inherently non-realtime (see the design brief); a runaway/hung tool must not wedge the app forever. */
const EXTERNAL_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap on captured stderr — a chatty tool must not balloon memory; only the tail matters for a badge/reason string anyway. */
const STDERR_CAPTURE_BYTES = 64 * 1024;

/**
 * The external tool's child env — PATH always (empty string if somehow
 * unset), HOME/TMPDIR passed through only when this process actually has
 * them (never invented) — see this file's doc comment (HOME) for why: a
 * tool that expects a real home directory for its own resource/config/model
 * dirs (e.g. gmic's `-denoise_cnn` weight download) fails without one.
 * Nothing else from process.env ever reaches the child.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '' };
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  if (process.env['TMPDIR'] !== undefined) env['TMPDIR'] = process.env['TMPDIR'];
  return env;
}

let spawnCount = 0;
/** Verify-only: real subprocess spawn count this session (see shared/ipc.ts's externalToolSpawnCount channel). Cache hits never increment this. */
export function externalToolSpawnCount(): number {
  return spawnCount;
}

/**
 * RGBA float32 (alpha ignored, always 1) → tightly packed 3-channel 8-bit
 * buffer (see this file's doc comment for why 8-bit, both modes). `encoded`
 * values are already clamped [0,1] by the GPU encode pass; `linear` values
 * are clamped [0,1] HERE (the GPU passthrough for linear mode does not clamp
 * — highlights above diffuse white are real and common — so this wire
 * format's own ceiling is where that headroom is lost, not the GPU stage).
 */
function toRawChannels(data: ArrayBuffer, width: number, height: number): Buffer {
  const rgba = new Float32Array(data);
  const n = width * height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = Math.round(Math.min(1, Math.max(0, rgba[i * 4]!)) * 255);
    out[i * 3 + 1] = Math.round(Math.min(1, Math.max(0, rgba[i * 4 + 1]!)) * 255);
    out[i * 3 + 2] = Math.round(Math.min(1, Math.max(0, rgba[i * 4 + 2]!)) * 255);
  }
  return Buffer.from(out.buffer);
}

/**
 * Inverse of toRawChannels: a decoded raw 3-channel 8-bit ('uchar') buffer →
 * tightly packed RGBA float32 (alpha = 1), values back in [0,1]. 8-bit ONLY
 * — callers must reject any other `meta.depth` before reaching here (see
 * runExternalTool's depth check). This used to also handle 'ushort'/'float'
 * inputs, normalizing against each depth's own max; DELETED after hand-
 * testing with real gmic output proved both paths read garbage in this
 * build: a 'ushort' TIFF's raw({depth:'ushort'}) buffer came back all
 * ZEROS, and a 'float' TIFF's raw({depth:'float'}) buffer came back all
 * 255.0 (uniform white) — even though `sharp(...).stats()` reads the same
 * files' real min/max correctly, so the file itself is fine and the bug is
 * specifically in this build's typed raw-pixel extraction for non-8-bit
 * TIFF. Keeping a "supported" path that silently returns wrong pixels is
 * worse than the caller's existing "pass through + badge" failure contract,
 * so those depths are now rejected before this function is ever called.
 */
function fromRawChannels(buf: Buffer, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n * 4);
  const src = new Uint8Array(buf.buffer, buf.byteOffset, n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * 3]! / 255;
    out[i * 4 + 1] = src[i * 3 + 1]! / 255;
    out[i * 4 + 2] = src[i * 3 + 2]! / 255;
    out[i * 4 + 3] = 1;
  }
  return out;
}

function toArrayBuffer(f32: Float32Array): ArrayBuffer {
  return f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength) as ArrayBuffer;
}

export async function runExternalTool(req: ExternalToolRequest): Promise<ExternalToolResult> {
  const { command, encoded, cacheKey, width, height } = req;
  const cached = await readExternalCache(cacheKey, width, height, encoded).catch(() => null);
  if (cached) {
    return { ok: true, width: cached.width, height: cached.height, data: cached.data };
  }

  // {in}/{out} are resolved against the scratch dir below (mkdtemp must run
  // first) — split now only to fail fast on an empty/malformed template.
  const template = splitCommandTemplate(command);
  if (template.length === 0) return { ok: false, reason: 'empty command' };

  let scratchDir: string | null = null;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), 'silverbox-external-'));
    const inPath = join(scratchDir, `in.tiff`);
    const outPath = join(scratchDir, `out.tiff`);
    const raw = toRawChannels(req.data, width, height);
    await sharp(raw, { raw: { width, height, channels: 3 } }).tiff({ compression: 'none' }).toFile(inPath);

    const finalArgv = substituteArgv(template, inPath, outPath);
    spawnCount++;
    const spawnResult = await new Promise<{ stderr: string; error?: Error & { killed?: boolean } }>((resolve) => {
      execFile(
        finalArgv[0]!,
        finalArgv.slice(1),
        // shell:false is execFile's own default (unlike exec/spawn's shell
        // option, execFile never goes through a shell at all) — cwd is a
        // fresh per-run scratch dir, env is reduced to PATH/HOME/TMPDIR (see
        // childEnv's doc comment).
        { cwd: scratchDir!, env: childEnv(), timeout: EXTERNAL_TOOL_TIMEOUT_MS, windowsHide: true },
        (error, _stdout, stderr) => {
          resolve({ stderr, error: (error as (Error & { killed?: boolean }) | null) ?? undefined });
        }
      );
    });

    const stderrTail = spawnResult.stderr.slice(-STDERR_CAPTURE_BYTES);
    if (spawnResult.error) {
      return {
        ok: false,
        reason: spawnResult.error.killed
          ? `external tool timed out after ${EXTERNAL_TOOL_TIMEOUT_MS / 1000}s`
          : `external tool failed: ${stderrTail || spawnResult.error.message}`,
      };
    }

    let meta: Metadata;
    try {
      meta = await sharp(outPath).metadata();
    } catch (err) {
      return { ok: false, reason: `external tool produced no readable output: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (meta.width !== width || meta.height !== height) {
      return {
        ok: false,
        reason: `external tool changed the image dimensions (${meta.width}x${meta.height}, expected ${width}x${height}) — the hook node requires the same resolution back`,
      };
    }
    const depth = meta.depth ?? 'uchar';
    // 8-bit ('uchar') output only — see this file's doc comment for the
    // empirical finding that this build's raw-pixel extraction is broken for
    // anything else (ushort → all zeros, float → all 255s) even though the
    // file itself decodes fine. A tool that wrote e.g. a float TIFF (gmic's
    // default `-o` behavior) must be told to write 8-bit instead (gmic:
    // `-o {out},uint8`) rather than have this silently hand back garbage
    // pixels — this is the SAME "pass through + badge on any failure"
    // contract every other failure mode here already uses.
    if (depth !== 'uchar') {
      return {
        ok: false,
        reason: `external tool wrote a ${depth} TIFF — this build can only read 8-bit output back; make the tool write 8-bit output (gmic: -o {out},uint8)`,
      };
    }
    const outBuf = Buffer.from(await sharp(outPath).raw().toBuffer());
    const rgba = fromRawChannels(outBuf, width, height);
    const outData = toArrayBuffer(rgba);
    await writeExternalCache(cacheKey, width, height, encoded, outData).catch(() => {});
    return { ok: true, width, height, data: outData };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
