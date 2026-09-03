/**
 * Stage base-2, fix ① — composes the WB color-matrix correction
 * (dcp/wbCorrection.ts) with the BUILTIN per-camera profile fit
 * (profileFit.ts), into ONE N³ residual lattice so the existing
 * develop/profile GPU pass + `applyProfileCpu` CPU mirror render it with
 * zero new pass code (see dcp/wbCorrection.ts's own doc comment for why
 * this composition is exact: trilinear interpolation reproduces an affine
 * function like a matrix multiply exactly at every grid node).
 *
 * `combined(grid) = builtinFit(correction · grid)` — evaluate the matrix
 * correction FIRST (undo the decoder's wrong-matrix conversion + reproject
 * through the interpolated one), THEN run the existing builtin fit on the
 * corrected value, then store the residual relative to the ORIGINAL grid
 * coordinate (the same "residual vs. this node's own coordinate" contract
 * `bakeDcpLattice` uses).
 */
import { applyProfileCpu, PROFILE_LATTICE_N } from './profileFit';
import { mulMat3Vec3, type Mat3 } from './dcp/matrices';

/** Small memo (camera model string × flattened correction matrix) — buildPlan calls this on every resolve() of every Develop node, potentially many times a second while dragging a slider; the bake itself is cheap (N³ ≈ 4913 nodes) but there's no reason to redo identical work every frame. Unbounded is fine: at most a handful of (model, matrix) pairs exist per session (one matrix per opened photo's camera). */
const memo = new Map<string, readonly number[]>();

function memoKey(model: string | null | undefined, correction: readonly number[]): string {
  return `${model ?? ''}|${correction.join(',')}`;
}

/**
 * Bake the combined lattice. `baseLattice` is the builtin per-camera fit
 * (profileFit.ts's `profileForModel(model)` result) already resolved by the
 * caller; `correction` is a flat row-major 3×3 (dcp/wbCorrection.ts's
 * `flattenMat3` output, as threaded through CompileContext).
 */
export function bakeWbCorrectedLattice(
  model: string | null | undefined,
  baseLattice: readonly number[],
  correction: readonly number[],
  n: number = PROFILE_LATTICE_N
): readonly number[] {
  const key = memoKey(model, correction);
  const cached = memo.get(key);
  if (cached) return cached;

  const m: Mat3 = [
    [correction[0]!, correction[1]!, correction[2]!],
    [correction[3]!, correction[4]!, correction[5]!],
    [correction[6]!, correction[7]!, correction[8]!],
  ];
  const out = new Array<number>(n * n * n * 3);
  for (let ix = 0; ix < n; ix++) {
    const r = ix / (n - 1);
    for (let iy = 0; iy < n; iy++) {
      const g = iy / (n - 1);
      for (let iz = 0; iz < n; iz++) {
        const b = iz / (n - 1);
        const corrected = mulMat3Vec3(m, [r, g, b]);
        const fitted = applyProfileCpu(baseLattice, corrected, 100);
        const base = ((ix * n + iy) * n + iz) * 3;
        out[base] = fitted[0] - r;
        out[base + 1] = fitted[1] - g;
        out[base + 2] = fitted[2] - b;
      }
    }
  }
  memo.set(key, out);
  return out;
}
