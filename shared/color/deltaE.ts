/**
 * CIE76 ΔE in CIE Lab, computed from pairs of 8-bit sRGB samples — golden
 * render drift detection (ROADMAP "Golden renders" / `silverbox-render
 * --check`). CIE76 (plain Euclidean distance in Lab) is sufficient here: we
 * only need "did this pixel change, and roughly how much" to flag engine
 * drift, not the perceptual-uniformity precision CIEDE2000 buys for e.g.
 * paint-matching — if ΔE76's known weakness (over-weighting chroma
 * differences in saturated blues/purples) ever produces a confusing false
 * positive in practice, upgrading this one module to CIEDE2000 is a
 * self-contained follow-up.
 *
 * Pure module, no DOM/Node/Electron dependency — lives under `shared/` (not
 * `src/renderer/engine/color/`) specifically so the MAIN process can import
 * it too: `src/main` is a separate TS build from `src/renderer` (see
 * tsconfig.node.json's `include`, which excludes src/renderer — same reason
 * src/main/lutExport.ts hardcodes constants instead of importing the
 * renderer's engine/color/lutExport.ts), so a color-math module shared by
 * both processes has to live outside src/renderer. `srgbDecode` below is
 * intentionally a duplicate of engine/color/srgb.ts's function of the same
 * name (identical formula, kept in sync by hand) rather than an import, for
 * that same layering reason.
 *
 * Pipeline per pixel: 8-bit sRGB -> linear (exact piecewise sRGB EOTF) ->
 * CIE XYZ (D65) -> CIE L*a*b* (D65 white) -> Euclidean distance. Sources:
 *  - sRGB transfer curve: IEC 61966-2-1:1999.
 *  - sRGB(D65 linear)->XYZ matrix: IEC 61966-2-1:1999 Annex G, reproduced at
 *    http://www.brucelindbloom.com/index.html?Eqn_RGB_XYZ_Matrix.html
 *  - XYZ->Lab: CIE 15:2004 §8.2.1 (same Lindbloom page cross-references it).
 */

/** sRGB electro-optical transfer (encoded [0,1] -> linear [0,1]). Mirrors engine/color/srgb.ts's srgbDecode. */
function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** D65 reference white in CIE XYZ (Y normalized to 1) — same values the sRGB matrix below is derived against. */
const D65_WHITE = { x: 0.95047, y: 1.0, z: 1.08883 };

/** Linear sRGB (D65 primaries) -> CIE XYZ, IEC 61966-2-1 Annex G matrix. */
function linearSrgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ];
}

/** CIE Lab's f(t) helper (CIE 15:2004 §8.2.1) — the cube-root with a linear segment near 0. */
function labF(t: number): number {
  const DELTA = 6 / 29;
  return t > DELTA * DELTA * DELTA ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / D65_WHITE.x);
  const fy = labF(y / D65_WHITE.y);
  const fz = labF(z / D65_WHITE.z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** One 8-bit sRGB sample -> CIE L*a*b* (D65). */
export function srgb8ToLab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = srgbDecode(r8 / 255);
  const g = srgbDecode(g8 / 255);
  const b = srgbDecode(b8 / 255);
  const [x, y, z] = linearSrgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** CIE76 ΔE: plain Euclidean distance between two Lab triples. */
export function deltaE76(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export interface DeltaEStats {
  mean: number;
  p95: number;
  max: number;
}

/**
 * Per-pixel CIE76 ΔE between two same-sized interleaved 8-bit sRGB buffers
 * (RGB or RGBA — alpha, if present, is ignored). Returns mean/p95/max over
 * every pixel; p95 via nearest-rank on the sorted per-pixel ΔE values (no
 * interpolation — simple and adequate for a drift-detection threshold, not a
 * statistics deliverable).
 */
export function compareSrgbBuffers(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number
): DeltaEStats {
  const n = width * height;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const labA = srgb8ToLab(a[o]!, a[o + 1]!, a[o + 2]!);
    const labB = srgb8ToLab(b[o]!, b[o + 1]!, b[o + 2]!);
    values[i] = deltaE76(labA, labB);
  }
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    sum += v;
    if (v > max) max = v;
  }
  const mean = n > 0 ? sum / n : 0;
  const sorted = Array.from(values).sort((x, y) => x - y);
  const p95 = n > 0 ? sorted[Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))]! : 0;
  return { mean, p95, max };
}
