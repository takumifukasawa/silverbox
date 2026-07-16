/**
 * In-engine ML denoise (denoise v2, stage 1): owns the onnxruntime-node
 * `InferenceSession` and drives tiled inference over a full sRGB-encoded
 * image, using the PURE geometry/packing helpers in denoiseTiling.ts (see
 * that file's doc comment for the divisible-by-16 contract and the
 * float32-no-quantization invariant — both apply everywhere in this file).
 *
 * RUNTIME LOCATION (deviation from the brief's "utilityProcess or
 * worker_threads" menu — see this session's final report for the full
 * reasoning): this runs DIRECTLY in the main process, not a separate
 * utilityProcess/worker_threads. onnxruntime-node ships a native (N-API)
 * addon per platform; `session.run()` is already async (returns a Promise)
 * and the underlying native call releases the Node event loop while it
 * executes (same shape as any other N-API async worker), so the "the UI
 * thread is sacred" concern (DESIGN §10) is satisfied without a second
 * process: this code never runs on the RENDERER's UI thread — it's already
 * one hop away in main, exactly where sharp's synchronous-looking-but-
 * actually-threaded encode calls already live. A real utilityProcess/
 * worker_threads split was not attempted this stage (unverified in the
 * spike, per the brief) because it adds a second IPC hop and a second
 * place a native addon must successfully load, for a benefit (keeping
 * inference off the main process's own event loop) that `session.run`'s
 * existing async/non-blocking behavior already delivers in practice for a
 * single 512² tile (~0.3s CPU-EP per the spike, and CoreML is faster) — a
 * batch of tiles awaits sequentially either way (see the brief's "sequential
 * tiles are fine for v2.0"). Revisit if a real preview render is ever found
 * to visibly stall OTHER main-process IPC traffic during inference.
 *
 * EP SELECTION: try CoreML first (darwin arm64's accelerated path per the
 * onnxruntime-node README), fall back to CPU on any CoreML init failure.
 * Attempted as two SEPARATE session-creation calls (not one array letting
 * ORT silently fall back per-op) specifically so `ep` below is an honest,
 * observable answer to "which EP actually initialized" — see
 * DenoiseRunResult.ep's doc comment (reproducibility-stamp material, never
 * used for a bitwise golden compare — CoreML/GPU EPs are not deterministic
 * run-to-run, see the brief's Determinism section).
 */
import * as ort from 'onnxruntime-node';
import {
  DENOISE_TILE_OVERLAP,
  DENOISE_TILE_SIZE,
  accumulateTile,
  computeTileGrid,
  cropTileRgba,
  extractPaddedTileRgba,
  nchwToRgba,
  normalizeAccumulator,
  paddedTileSize,
  rgbaToNchw,
  tileWeightMap,
} from './denoiseTiling';

interface SessionHandle {
  session: ort.InferenceSession;
  ep: string;
}

/** One session per model PATH (the path already encodes which model — today always the single pinned NAFNet checkpoint) — created once, reused for every subsequent inference call this process's lifetime. */
const sessionCache = new Map<string, Promise<SessionHandle>>();

async function createSession(modelPath: string): Promise<SessionHandle> {
  try {
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['coreml'] });
    return { session, ep: 'coreml' };
  } catch {
    // CoreML unavailable/unsupported on this platform (or this ORT build) —
    // CPU EP always works, everywhere onnxruntime-node ships a binding.
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    return { session, ep: 'cpu' };
  }
}

function getSession(modelPath: string): Promise<SessionHandle> {
  let cached = sessionCache.get(modelPath);
  if (!cached) {
    cached = createSession(modelPath);
    sessionCache.set(modelPath, cached);
  }
  return cached;
}

/** Test/verify-only: drop every cached session (a new fixture model at the SAME path — e.g. between verify-denoise.mjs runs against a mutated fixture — must not reuse a stale session). Also lets a session-creation failure be retried on the next call rather than permanently cached as a rejected promise. */
export function clearDenoiseSessionCache(): void {
  sessionCache.clear();
}

let inferenceRunCount = 0;
/** Verify-only: how many REAL per-tile ORT `session.run` calls happened this session (see shared/ipc.ts's IPC.denoiseRunCount). */
export function denoiseInferenceRunCount(): number {
  return inferenceRunCount;
}

/**
 * Run the model over one already-padded tile: NCHW-pack → `session.run` →
 * unpack back to RGBA. `paddedW`/`paddedH` are already multiples of 16 (see
 * denoiseTiling.ts's divisible-by-16 contract) — this function trusts its
 * caller for that; it does no padding itself.
 */
async function runOneTile(
  session: ort.InferenceSession,
  paddedRgba: Float32Array,
  paddedW: number,
  paddedH: number
): Promise<Float32Array> {
  const nchw = rgbaToNchw(paddedRgba, paddedW, paddedH);
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;
  const inputTensor = new ort.Tensor('float32', nchw, [1, 3, paddedH, paddedW]);
  inferenceRunCount++;
  const results = await session.run({ [inputName]: inputTensor });
  const outputTensor = results[outputName]!;
  return nchwToRgba(outputTensor.data as Float32Array, paddedW, paddedH);
}

/**
 * Full tiled inference over one sRGB-encoded RGBA float32 image (see
 * denoiseTiling.ts for the tile grid / padding / feather-blend math this
 * wires together). Tiles run SEQUENTIALLY (the brief's own "memory ceiling
 * beats latency" call for v2.0) — a future stage could parallelize with a
 * session pool, not attempted here. `onTile` (optional) fires after each
 * tile completes, `{done, total}` — the brief's "report per-tile progress to
 * the existing spinner-badge channel if cheap" clause; stage 1 wires this to
 * nothing yet (the badge is a plain running/error/needsConsent state, see
 * denoiseNodeRunner.ts), but the hook exists for a cheap future wire-up
 * without re-plumbing this function.
 */
export async function runTiledInference(
  modelPath: string,
  rgba: Float32Array,
  width: number,
  height: number,
  onTile?: (done: number, total: number) => void
): Promise<{ data: Float32Array; ep: string }> {
  const { session, ep } = await getSession(modelPath);
  const tiles = computeTileGrid(width, height, DENOISE_TILE_SIZE, DENOISE_TILE_OVERLAP);
  const colorAcc = new Float32Array(width * height * 3);
  const weightAcc = new Float32Array(width * height);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const { paddedW, paddedH } = paddedTileSize(tile.w, tile.h);
    const paddedRgba = extractPaddedTileRgba(rgba, width, tile, paddedW, paddedH);
    const outPaddedRgba = await runOneTile(session, paddedRgba, paddedW, paddedH);
    const outRgba = cropTileRgba(outPaddedRgba, paddedW, tile.w, tile.h);
    const weights = tileWeightMap(tile, width, height, DENOISE_TILE_OVERLAP);
    accumulateTile(colorAcc, weightAcc, width, tile, outRgba, weights);
    onTile?.(i + 1, tiles.length);
  }
  const data = normalizeAccumulator(colorAcc, weightAcc, width, height);
  return { data, ep };
}
