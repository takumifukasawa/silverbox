/**
 * In-engine ML denoise (denoise v2, stage 1 — docs/brief-bank/denoise-v2.md):
 * the pinned model artifact's identity. Shared between main (download/verify
 * — src/main/denoiseModel.ts) and the renderer (Inspector's consent-button
 * copy, which quotes MODEL_BYTES as a human size) — isomorphic, no node:fs
 * here, just constants.
 *
 * CONDUCTOR NOTE (pending release): MODEL_URL points at a GitHub release
 * asset that does not exist yet — the conductor creates the `models-v1`
 * release and uploads the spike's fp32 ONNX artifact (see
 * docs/research/nafnet-spike/spike-report.md) AFTER this stage-1 plumbing
 * lands. MODEL_SHA256/MODEL_BYTES below are the REAL, already-computed
 * digest/size of that exact file (`nafnet-sidd-width32.fp32.onnx`, produced
 * by the spike's export_nafnet.py) — hashed directly from the spike's local
 * artifact, not a placeholder — so hash verification is correct the moment
 * the release exists; only the URL host/path is provisional.
 */

/** GitHub release asset URL — see this file's CONDUCTOR NOTE above. Overridable per-install via Settings.denoiseModelUrl (self-hosters / offline mirrors). */
export const DENOISE_MODEL_URL =
  'https://github.com/takumifukasawa/silverbox/releases/download/models-v1/nafnet-sidd-width32-fp32.onnx';

/** sha256 of the exact fp32 ONNX file the spike exported (nafnet-sidd-width32.fp32.onnx) — computed directly from that artifact, never a placeholder. Verified before first use; a hash mismatch is treated as a download failure (passthrough + badge, never a silently-wrong model). */
export const DENOISE_MODEL_SHA256 = 'e8c22f50919bd2ca694f7e6b129b3df0a9168fae821c561745b6dfb80e26282f';

/** Exact byte size of the pinned fp32 ONNX (matches spike-report.md's stated 117,089,598 B) — used for the download progress badge and the consent dialog's "~112 MB" copy. */
export const DENOISE_MODEL_BYTES = 117_089_598;

/** Filename under `<userData>/models/` the downloaded artifact is stored as — stable across URL overrides so a self-hoster's differently-named upstream file still lands at a predictable local path. */
export const DENOISE_MODEL_FILENAME = 'nafnet-sidd-width32-fp32.onnx';

/** Human-readable size for UI copy (the consent button/tooltip) — derived from MODEL_BYTES so the two can never drift apart. */
export function denoiseModelSizeLabel(): string {
  return `${Math.round(DENOISE_MODEL_BYTES / (1024 * 1024))} MB`;
}
