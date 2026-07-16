/**
 * In-engine ML denoise (denoise v2, stage 1) — main-process orchestrator,
 * the direct analogue of src/main/externalTool.ts's `runExternalTool`: check
 * the on-disk cache first (a hit skips model-ensure/inference entirely),
 * else ensure the model is present (downloading it ONLY under explicit,
 * persisted consent — see denoiseModel.ts's doc comment), run tiled ORT
 * inference (denoiseInfer.ts), cache the result, and hand it back.
 *
 * FLOAT32 END TO END: `req.data`/the returned `data` are always tightly-
 * packed RGBA float32, sRGB-encoded — never quantized to 8/16-bit anywhere
 * in this module (unlike v1's external-tool node, which is stuck at 8-bit
 * TIFF — see externalTool.ts's own doc comment for why). This is the whole
 * point of v2 (docs/brief-bank/denoise-v2.md's endorsement): no round trip
 * through any integer format.
 *
 * On ANY failure (missing/no-consent model, download/hash-verify failure,
 * ORT init/inference error) this resolves `{ok:false,...}` — it never
 * throws — so the caller's "pass through + badge" contract
 * (denoiseNodeRunner.ts) is trivial, exactly like runExternalTool's.
 */
import type { DenoiseRunRequest, DenoiseRunResult } from '../../shared/ipc';
import { ensureDenoiseModel } from './denoiseModel';
import { runTiledInference } from './denoiseInfer';
import { readDenoiseCache, writeDenoiseCache } from './denoiseCache';

let runCount = 0;
/** Verify-only: how many times this session actually ran ORT inference to completion (cache hits AND consent-gate rejections don't count — see the increment site below) — scripts/verify-denoise.mjs's cache check, spawnCount-style (see shared/ipc.ts's IPC.denoiseRunCount). */
export function denoiseRunCount(): number {
  return runCount;
}

export async function runDenoise(
  req: DenoiseRunRequest,
  consent: boolean,
  urlOverride: string
): Promise<DenoiseRunResult> {
  const { cacheKey, width, height } = req;
  const cached = await readDenoiseCache(cacheKey, width, height).catch(() => null);
  if (cached) {
    return { ok: true, width: cached.width, height: cached.height, data: cached.data, ep: 'cache' };
  }

  const modelResult = await ensureDenoiseModel(consent, urlOverride);
  if (!modelResult.ok) {
    // Deliberately BEFORE the counter below: a needs-consent (or a download/
    // hash-verify failure) is not a real inference attempt — a doc with a
    // denoise node opened repeatedly before consent is ever granted must
    // show zero runs, not one per render (scripts/verify-denoise.mjs's own
    // "zero inference runs happened before consent" check).
    return { ok: false, reason: modelResult.reason, needsConsent: modelResult.needsConsent };
  }
  runCount++;

  try {
    const rgba = new Float32Array(req.data);
    const { data, ep } = await runTiledInference(modelResult.path, rgba, width, height);
    const outBuffer = data.buffer as ArrayBuffer;
    await writeDenoiseCache(cacheKey, width, height, outBuffer).catch(() => {});
    return { ok: true, width, height, data: outBuffer, ep };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), needsConsent: false };
  }
}
