/**
 * Standard color matrices used ONLY by the DCP pipeline (dcp/pipeline.ts) to
 * bridge between our working space (linear Rec.2020, D65 — see
 * engine/color/workingSpace.ts) and the coordinate spaces the DNG spec's
 * camera-profile chapter (DNG 1.7 §6, "Mapping Camera Color Space to CIE XYZ
 * Space") defines its math in: XYZ relative to D50, and linear ProPhoto RGB
 * (also D50-native — Adobe's profile pipeline works in ProPhoto because its
 * primaries are wide enough to hold every camera's gamut without clipping,
 * same reasoning COLOR.md gives for our own Rec.2020 choice).
 *
 * These are standalone from workingSpace.ts's matrices (not composed from
 * them) because they are a different, self-contained numeric family (D50,
 * ProPhoto) that only this module needs — keeping them here avoids growing
 * the shared single-source-of-truth file with constants nothing else reads.
 *
 * All matrices are row-major 3×3 (`result = M · v`), matching every other
 * matrix in this codebase (see workingSpace.ts's own convention note).
 */

export type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
export type Vec3 = readonly [number, number, number];

export function mulMat3Vec3(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function mulMat3Mat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i]![j] = a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!;
    }
  }
  return out as unknown as Mat3;
}

export function invertMat3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
    // Degenerate matrix (e.g. an all-zero ColorMatrix) — identity is the
    // least-surprising fallback; callers that care check for this upstream.
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const s = 1 / det;
  return [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}

/**
 * Rec.2020 (linear) → XYZ (D65), row-major. Derived from the published
 * Rec.2020 primaries — R(0.708,0.292) G(0.170,0.797) B(0.131,0.046), D65
 * white (0.3127,0.3290) — via the standard primaries→XYZ construction
 * (same method as workingSpace.ts's WORK_TO_P3 derivation comment): solve
 * for per-primary scale factors that map the white point, then scale each
 * primary's own XYZ column. Verified against the well-known published
 * BT.2020 RGB→XYZ matrix.
 */
export const REC2020_TO_XYZ_D65: Mat3 = [
  [0.6369580, 0.1446169, 0.1688810],
  [0.2627002, 0.6779981, 0.0593017],
  [0.0, 0.0280727, 1.0609851],
];

/** Exact numeric inverse of REC2020_TO_XYZ_D65 — XYZ (D65) → Rec.2020 (linear). */
export const XYZ_D65_TO_REC2020: Mat3 = [
  [1.7166512, -0.3556708, -0.2533663],
  [-0.6666844, 1.6164812, 0.0157685],
  [0.0176399, -0.0427706, 0.9421031],
];

/**
 * Linear ProPhoto RGB → XYZ (D50), row-major. Derived the same way from
 * ProPhoto's published primaries — R(0.7347,0.2653) G(0.1596,0.8404)
 * B(0.0366,0.0001), D50 white (0.3457,0.3585) (ProPhoto's NATIVE white,
 * chosen so this matrix needs no chromatic adaptation of its own — the
 * adaptation happens once, at the XYZ D65↔D50 boundary below). Matches the
 * matrix published in the ICC ProPhoto RGB profile / DNG SDK's dng_camera_
 * profile.cpp reference values to the printed precision.
 */
export const PROPHOTO_TO_XYZ_D50: Mat3 = [
  [0.7977605, 0.1351858, 0.0313493],
  [0.2880711, 0.7118432, 0.0000857],
  [0.0, 0.0, 0.8251046],
];

/** Exact numeric inverse of PROPHOTO_TO_XYZ_D50 — XYZ (D50) → linear ProPhoto RGB. */
export const XYZ_D50_TO_PROPHOTO: Mat3 = [
  [1.3457990, -0.2555801, -0.0511063],
  [-0.5446225, 1.5082327, 0.0205360],
  [0.0, 0.0, 1.2119675],
];

/**
 * Bradford chromatic adaptation, D65 → D50 (the direction our working space
 * → the DNG spec's D50 PCS needs). Standard published Bradford cone-response
 * matrices (Lindbloom / ICC convention): compute both white points' cone
 * responses via the Bradford matrix, scale by their ratio, and transform
 * back — the textbook Bradford-adaptation recipe. These are the same
 * constants essentially every color-management library (lcms2, ICC v4
 * profiles, DNG SDK) ships for exactly this transform.
 */
export const BRADFORD_D65_TO_D50: Mat3 = [
  [1.0479298, 0.0229469, -0.0501923],
  [0.0296278, 0.9904344, -0.0170738],
  [-0.0092430, 0.0150552, 0.7518743],
];

/** Exact numeric inverse of BRADFORD_D65_TO_D50 — D50 → D65. */
export const BRADFORD_D50_TO_D65: Mat3 = [
  [0.9554734, -0.0230985, 0.0632592],
  [-0.0283697, 1.0099954, 0.0210414],
  [0.0123140, -0.0205076, 1.3303659],
];
