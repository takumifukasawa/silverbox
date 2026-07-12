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
 * SECURITY: this module trusts its caller completely — it has no notion of
 * "confirmed" or "disabled" nodes. That gate lives ENTIRELY in the renderer
 * (externalNodeRunner.ts) and the CLI's own `--allow-external` flag; by the
 * time a request reaches here, running the command IS the decision already
 * made. Sub-processes: main process only, never a shell, cwd = a fresh
 * per-run scratch dir (always removed afterward), env reduced to just PATH.
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

/** Inverse of toRawChannels: a decoded raw 3-channel 8-bit buffer → tightly packed RGBA float32 (alpha = 1), values back in [0,1]. Tolerates a tool handing back a different (even higher) depth by normalizing against that depth's own max. */
function fromRawChannels(buf: Buffer, width: number, height: number, depth: string): Float32Array {
  const n = width * height;
  const out = new Float32Array(n * 4);
  const max = depth === 'ushort' ? 65535 : depth === 'float' ? 1 : 255;
  const src =
    depth === 'ushort'
      ? new Uint16Array(buf.buffer, buf.byteOffset, n * 3)
      : depth === 'float'
        ? new Float32Array(buf.buffer, buf.byteOffset, n * 3)
        : new Uint8Array(buf.buffer, buf.byteOffset, n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * 3]! / max;
    out[i * 4 + 1] = src[i * 3 + 1]! / max;
    out[i * 4 + 2] = src[i * 3 + 2]! / max;
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
        // fresh per-run scratch dir, env is reduced to just PATH.
        { cwd: scratchDir!, env: { PATH: process.env['PATH'] ?? '' }, timeout: EXTERNAL_TOOL_TIMEOUT_MS, windowsHide: true },
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
    // Request the OUTPUT raw depth explicitly when the tool's own result
    // claims to be higher than 8-bit (some tools may emit 16-bit output even
    // though we only ever send 8-bit input, see this file's doc comment) —
    // sharp's plain `.raw()` with no options otherwise collapses to 8-bit
    // regardless of the source's real depth, which would desync fromRawChannels'
    // byte-width assumption from what's actually in the buffer.
    const outRaw = depth === 'ushort' || depth === 'float' ? sharp(outPath).raw({ depth }) : sharp(outPath).raw();
    const outBuf = Buffer.from(await outRaw.toBuffer());
    const rgba = fromRawChannels(outBuf, width, height, depth);
    const outData = toArrayBuffer(rgba);
    await writeExternalCache(cacheKey, width, height, encoded, outData).catch(() => {});
    return { ok: true, width, height, data: outData };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
