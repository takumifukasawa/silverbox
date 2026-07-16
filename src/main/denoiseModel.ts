/**
 * In-engine ML denoise (denoise v2, stage 1 — docs/brief-bank/denoise-v2.md):
 * download/verify/cache the pinned NAFNet-SIDD-width32 ONNX weights.
 *
 * CONSENT (SECURITY — read before changing this file): unlike v1's
 * external-tool node, which fully trusts its caller (the confirm gate lives
 * entirely in the renderer, see externalTool.ts's doc comment), this module
 * re-checks `consent` ITSELF before ever hitting the network — "may we fetch
 * 112MB over the network" is a materially different risk than "run a
 * command the user already typed in", so the gate belongs at the point of
 * the actual network action, not just trusted from whichever caller happens
 * to invoke this. A doc opened from the internet must never trigger a
 * silent download (docs/brief-bank/denoise-v2.md's SECURITY section) even if
 * some future call site forgot to check `settings.denoiseModelConsent`
 * first — this file is the one place that would still stop it.
 *
 * Download is atomic (temp file in a scratch dir under the SAME models/
 * directory, sha256-verified, then rename over the target) — a crash or a
 * corrupt/truncated download can never leave a partially-written file at the
 * path `ensureDenoiseModel` treats as "present". `verifiedThisSession`
 * memoizes a clean verification for the rest of this process's lifetime
 * (mirrors the spirit of externalToolSpawnCount's per-session counters) so a
 * burst of denoise render requests doesn't re-hash a 112MB file on every one
 * of them — only a fresh Electron launch re-verifies from disk.
 */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENOISE_MODEL_BYTES, DENOISE_MODEL_FILENAME, DENOISE_MODEL_SHA256, DENOISE_MODEL_URL } from '../../shared/denoiseModel';

/**
 * Verify-only hash/size override (scripts/verify-denoise.mjs): the tiny
 * fixture ONNX (scripts/fixtures/denoise-identity.onnx) has neither the real
 * model's sha256 nor its byte count, so exercising the REAL download+verify
 * pipeline against it (rather than bypassing verification entirely) needs
 * the expected digest/size to be swappable — gated on SILVERBOX_TEST so a
 * stray env var can never weaken production verification (same discipline
 * as every other SILVERBOX_TEST_* hook — see shared/ipc.ts's testFlags doc
 * comment). Read once at module load, same as the other constants.
 */
const IS_TEST = process.env['SILVERBOX_TEST'] === '1';
const EXPECTED_SHA256 = (IS_TEST && process.env['SILVERBOX_TEST_DENOISE_MODEL_SHA256']) || DENOISE_MODEL_SHA256;
const EXPECTED_BYTES =
  IS_TEST && process.env['SILVERBOX_TEST_DENOISE_MODEL_BYTES']
    ? Number(process.env['SILVERBOX_TEST_DENOISE_MODEL_BYTES'])
    : DENOISE_MODEL_BYTES;

function modelsDir(): string {
  return join(app.getPath('userData'), 'models');
}

/** Where the verified model lives (or will, once downloaded) — main/denoiseInfer.ts's InferenceSession.create target. */
export function denoiseModelPath(): string {
  return join(modelsDir(), DENOISE_MODEL_FILENAME);
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** True once this process has confirmed the on-disk file is present and hash-valid — see this file's doc comment. Reset only by a fresh Electron launch (module-level state, same lifetime as externalTool.ts's spawnCount). */
let verifiedThisSession = false;

/** Test-only: forget the memoized verification (scripts/verify-denoise.mjs isolates via a fresh userData dir per launch already, so this exists only for a same-process re-check if ever needed — not currently called by the verify script). */
export function resetDenoiseModelVerificationForTest(): void {
  verifiedThisSession = false;
}

async function downloadAndVerify(url: string, destPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  await mkdir(modelsDir(), { recursive: true });
  const tmpDir = await mkdtemp(join(modelsDir(), '.download-'));
  const tmpFile = join(tmpDir, DENOISE_MODEL_FILENAME);
  try {
    if (url.startsWith('file://')) {
      // Verify-only path (scripts/verify-denoise.mjs's `denoiseModelUrl`
      // override points at the local fixture ONNX) — "still no network" per
      // the brief's own check (d): a plain filesystem copy, no fetch() at
      // all. Real self-hoster overrides are always http(s); this branch only
      // exists so the consent→download flow is exercisable end to end
      // without a real network dependency in CI.
      await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(tmpFile));
    } else {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (err) {
        return { ok: false, reason: `denoise model download failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!response.ok || !response.body) {
        return { ok: false, reason: `denoise model download failed: HTTP ${response.status} ${response.statusText}` };
      }
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmpFile));
    }
    const digest = await sha256OfFile(tmpFile);
    if (digest !== EXPECTED_SHA256) {
      return { ok: false, reason: `downloaded denoise model failed hash verification (expected ${EXPECTED_SHA256}, got ${digest}) — refusing to use it` };
    }
    // Atomic: rename is a single filesystem op, so a crash mid-download never
    // leaves a partial file at `destPath` — only ever the temp scratch dir,
    // cleaned up in `finally` regardless of outcome.
    await rename(tmpFile, destPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `denoise model download failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export type EnsureModelResult = { ok: true; path: string } | { ok: false; reason: string; needsConsent: boolean };

/**
 * Ensure the model is present and hash-valid at `denoiseModelPath()`,
 * downloading it ONLY when `consent` is true (see this file's doc comment).
 * `urlOverride` is `settings.denoiseModelUrl` (empty = use DENOISE_MODEL_URL)
 * — a self-hoster's mirror, never a way to bypass the fixed sha256 check.
 */
export async function ensureDenoiseModel(consent: boolean, urlOverride: string): Promise<EnsureModelResult> {
  const path = denoiseModelPath();
  if (verifiedThisSession) return { ok: true, path };
  const st = await stat(path).catch(() => null);
  if (st && st.isFile() && st.size === EXPECTED_BYTES) {
    const digest = await sha256OfFile(path).catch(() => null);
    if (digest === EXPECTED_SHA256) {
      verifiedThisSession = true;
      return { ok: true, path };
    }
  }
  if (!consent) {
    return {
      ok: false,
      reason: 'denoise model not downloaded — consent required (see the Inspector\'s "Download denoise model" button)',
      needsConsent: true,
    };
  }
  const url = urlOverride.trim() !== '' ? urlOverride : DENOISE_MODEL_URL;
  const result = await downloadAndVerify(url, path);
  if (!result.ok) return { ok: false, reason: result.reason, needsConsent: false };
  verifiedThisSession = true;
  return { ok: true, path };
}
