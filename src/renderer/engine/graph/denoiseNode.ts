/**
 * In-engine ML denoise node (denoise v2, stage 1 —
 * docs/brief-bank/denoise-v2.md): one input, one output — the SAME graph
 * contract shape as v1's external-tool hook node (externalNode.ts), but a
 * first-party built-in (no user-configured command, no confirm gate, no
 * CLI opt-in — see denoiseNodeRunner.ts's SECURITY note for the one gate
 * this DOES have: a one-time model-download consent, not per-run).
 *
 * Doc-shape module only (params/sanitizer), same split as externalNode.ts:
 * the actual round trip (GPU readback → main-process ORT inference → GPU
 * re-entry) lives in graphRenderer.ts/denoiseNodeRunner.ts.
 */

export const DENOISE_KIND = 'denoise';

export interface DenoiseParams {
  /** 0–100: output blend, `lerp(input, denoised, strength/100)` — the standard trick for a blind (no strength knob of its own) denoiser. 0 = identity (bit-exact pass-through, no pass emitted — see isIdentityDenoise). */
  strength: number;
}

export function defaultDenoiseParams(): DenoiseParams {
  return { strength: 0 };
}

/** strength <= 0 ⇒ IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through), same invariant every other node kind upholds. Never runs inference at strength 0, regardless of whether the model is even downloaded. */
export function isIdentityDenoise(p: DenoiseParams): boolean {
  return p.strength <= 0;
}

function clampStrength(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** Normalize an untrusted denoise payload; throws on structural garbage (maskNode.ts/spotsNode.ts/externalNode.ts convention). */
export function sanitizeDenoiseParams(raw: unknown, nodeId: string): DenoiseParams {
  const base = defaultDenoiseParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { strength?: unknown };
  if (src.strength !== undefined && (typeof src.strength !== 'number' || !Number.isFinite(src.strength))) {
    throw new Error(`${nodeId}.denoise.strength must be a finite number`);
  }
  return { strength: typeof src.strength === 'number' ? clampStrength(src.strength) : base.strength };
}
