/**
 * The engine's working color space — the SINGLE definition point.
 *
 * Silverbox develops in LINEAR Rec.2020 (COLOR.md: "scene-referred color,
 * output-referred late"). Decoding lands the camera color in Rec.2020
 * primaries (D65) and every pass exchanges linear-light `rgba16float` in that
 * space; the sRGB gamut clip and transfer curve happen only at the display /
 * export EXIT (graphRenderer's encode shaders + CanvasView's CPU mirror).
 *
 * Everything that needs the primaries matrices or the luma weights imports
 * them from HERE — shaders via the WGSL string snippets below (template
 * interpolation, same convention as the LENS_ / FX_ constants), CPU code via
 * the numeric arrays. Change a value once here and both paths move together.
 */

/** Informational id; surfaced by the __debug workingSpaceInfo() hook. */
export const WORKING_SPACE_ID = 'rec2020-linear';

type Mat3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/**
 * Rec.2020 (linear) → sRGB (linear), D65, row-major. Standard primaries
 * conversion; applied at the exit before the sRGB curve, followed by the
 * gamut clip. `result = WORK_TO_SRGB · rgb`.
 */
export const WORK_TO_SRGB: Mat3 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

/**
 * sRGB (linear) → Rec.2020 (linear), D65, row-major — the exact numeric
 * inverse of WORK_TO_SRGB (both D65, so their shared white maps to itself).
 * Used to retarget XYZ→display math (white balance) into the working space.
 */
export const SRGB_TO_WORK: Mat3 = [
  [0.627409, 0.32926, 0.043272],
  [0.069125, 0.919549, 0.011321],
  [0.016423, 0.088048, 0.895617],
];

/**
 * Luma weights used by ops and scopes (grayscale view, saturation/vibrance,
 * grading, detail luma/chroma split, waveform/vectorscope math).
 *
 * INTENTIONAL AESTHETIC CHOICE: these are the Rec.709 / sRGB weights, KEPT
 * rather than switched to Rec.2020's own (0.2627, 0.6780, 0.0593) so the feel
 * stays continuous with the Lightroom-calibrated look the ops were tuned
 * against. This is the one place to change them — a single-line edit here
 * moves every op and scope together.
 */
export const WORKING_LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

// --- WGSL snippets (one source of truth shared with the shaders) -------------

const f = (v: number): string => {
  const s = String(v);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

/** WGSL mat3x3f (column-major) literal for a row-major math matrix M, so that
 *  `M_wgsl * v` equals the mathematical `M · v`. */
function wgslMat3(m: Mat3): string {
  const col = (j: number) => `vec3f(${f(m[0][j]!)}, ${f(m[1][j]!)}, ${f(m[2][j]!)})`;
  return `mat3x3f(${col(0)}, ${col(1)}, ${col(2)})`;
}

/** `WORK_TO_SRGB` as an inline WGSL mat3x3f expression. */
export const WGSL_WORK_TO_SRGB = wgslMat3(WORK_TO_SRGB);

/** `WORKING_LUMA` as an inline WGSL vec3f expression. */
export const WGSL_WORKING_LUMA = `vec3f(${f(WORKING_LUMA[0])}, ${f(WORKING_LUMA[1])}, ${f(WORKING_LUMA[2])})`;
