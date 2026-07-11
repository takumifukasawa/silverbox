/**
 * Sony embedded lens-profile parser + correction math (task #34, F3b).
 *
 * "The file is the profile": every Sony ARW embeds per-shot correction splines
 * for whatever E-mount lens took it — no lens database. The three splines live
 * as PLAINTEXT little-endian TIFF tags in the first SubIFD (referenced from
 * IFD0's SubIFDs tag 0x014a), NOT in the enciphered makernote block, so the
 * parse is a plain bounds-checked TIFF walk (verified against the real a7C II
 * file with `exiftool -v3`):
 *
 *   0x7032  VignettingCorrParams          int16s[17]  (a7C II layout)
 *   0x7035  ChromaticAberrationCorrParams int16s[33]
 *   0x7037  DistortionCorrParams          int16s[17]
 *
 * Each array's [0] is the knot count n; the knots follow (n real values, the
 * remaining slots padding). Distortion/vignetting store n knots; CA stores 2n
 * (red curve then blue curve). Knots are spread EVENLY over radius r from the
 * frame CENTER (0) to the frame CORNER (r_max) — the axis is r, not r².
 *
 * All math here is PURE (no DOM, no GPU) so it is unit-tested directly (see
 * sonyLensProfile.test.ts) and mirrored in the resample WGSL.
 */

/** Max knots per curve — the WGSL uniform caps the tables at this (Sony ships 11). */
export const LENS_PROFILE_MAX_KNOTS = 16;

/** Distortion knot scale: g = 1 + 2^-14 · f(...). */
export const DISTORTION_KNOT_SCALE = 1 / 16384; // 2^-14
/** CA knot scale: g = 1 + 2^-21 · f(...), no s normalization. */
export const CA_KNOT_SCALE = 1 / 2097152; // 2^-21

export interface LensProfile {
  /** n distortion knots (radius axis, center→corner). */
  distortion: number[];
  /** n red-channel CA knots. */
  caRed: number[];
  /** n blue-channel CA knots. */
  caBlue: number[];
  /** n vignetting knots (divisor still undetermined — see VIGNETTE below). */
  vignette: number[];
}

// --- TIFF walk ---------------------------------------------------------------

const TAG_SUBIFDS = 0x014a;
const TAG_VIGNETTING = 0x7032;
const TAG_CA = 0x7035;
const TAG_DISTORTION = 0x7037;

interface IfdEntry {
  tag: number;
  /** File offset of the entry's value (already resolved past the inline/offset split). */
  valueOffset: number;
  /** Element count (the tag's own count field). */
  count: number;
}

/** Byte size of one element of TIFF `type` (only the types we touch). */
function typeSize(type: number): number {
  // 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 6 SBYTE, 8 SSHORT
  switch (type) {
    case 1:
    case 2:
    case 6:
      return 1;
    case 3:
    case 8:
      return 2;
    case 4:
    case 9:
    case 11:
      return 4;
    default:
      return 0; // unknown / unsupported — caller treats as opaque
  }
}

/** Read one IFD's entries; returns null on any out-of-bounds read. */
function readIfd(view: DataView, offset: number, le: boolean): IfdEntry[] | null {
  if (offset <= 0 || offset + 2 > view.byteLength) return null;
  const count = view.getUint16(offset, le);
  const end = offset + 2 + count * 12;
  if (end > view.byteLength) return null;
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const eo = offset + 2 + i * 12;
    const tag = view.getUint16(eo, le);
    const type = view.getUint16(eo + 2, le);
    const n = view.getUint32(eo + 4, le);
    const bytes = typeSize(type) * n;
    // Value stored inline (≤4 bytes) lives at eo+8; otherwise eo+8 holds a
    // file offset to it.
    const valueOffset = bytes <= 4 ? eo + 8 : view.getUint32(eo + 8, le);
    entries.push({ tag, valueOffset, count: n });
  }
  return entries;
}

/** Read `count` signed int16s at `offset`; null on out-of-bounds. */
function readInt16s(view: DataView, offset: number, count: number, le: boolean): number[] | null {
  if (offset < 0 || offset + count * 2 > view.byteLength) return null;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(offset + i * 2, le);
  return out;
}

/** Pull the knot block out of a `[count, ...values]` tag array. `curves` = 1 (distortion/vignette) or 2 (CA). */
function extractKnots(arr: number[] | null, curves: number): number[][] | null {
  if (!arr || arr.length < 1) return null;
  const n = arr[0]!;
  const perCurve = n / curves;
  if (!Number.isInteger(perCurve) || perCurve < 2 || perCurve > LENS_PROFILE_MAX_KNOTS) return null;
  if (1 + n > arr.length) return null;
  const out: number[][] = [];
  for (let c = 0; c < curves; c++) out.push(arr.slice(1 + c * perCurve, 1 + (c + 1) * perCurve));
  return out;
}

/**
 * Parse the three Sony correction splines from raw ARW bytes. Returns null on
 * ANYTHING unexpected — a JPEG, a non-Sony RAW, a truncated/garbage buffer —
 * and never throws. The three tags always coexist in a Sony ARW; a partial
 * hit yields null.
 */
export function parseSonyLensProfile(buffer: ArrayBuffer): LensProfile | null {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 8) return null;
    const bom = view.getUint16(0, false);
    let le: boolean;
    if (bom === 0x4949) le = true;
    else if (bom === 0x4d4d) le = false;
    else return null;
    if (view.getUint16(2, le) !== 42) return null;
    const ifd0Off = view.getUint32(4, le);
    const ifd0 = readIfd(view, ifd0Off, le);
    if (!ifd0) return null;

    // Collect SubIFD offsets (SubIFDs tag 0x014a) — the plaintext correction
    // tags live in the first SubIFD on this camera generation.
    const subOffsets: number[] = [];
    const subTag = ifd0.find((e) => e.tag === TAG_SUBIFDS);
    if (subTag) {
      if (subTag.count === 1) {
        subOffsets.push(view.getUint32(subTag.valueOffset, le));
      } else {
        for (let i = 0; i < subTag.count; i++) {
          const o = subTag.valueOffset + i * 4;
          if (o + 4 <= view.byteLength) subOffsets.push(view.getUint32(o, le));
        }
      }
    }

    for (const subOff of subOffsets) {
      const sub = readIfd(view, subOff, le);
      if (!sub) continue;
      const dEntry = sub.find((e) => e.tag === TAG_DISTORTION);
      const cEntry = sub.find((e) => e.tag === TAG_CA);
      const vEntry = sub.find((e) => e.tag === TAG_VIGNETTING);
      if (!dEntry || !cEntry || !vEntry) continue;

      const distortion = extractKnots(readInt16s(view, dEntry.valueOffset, dEntry.count, le), 1);
      const ca = extractKnots(readInt16s(view, cEntry.valueOffset, cEntry.count, le), 2);
      const vignette = extractKnots(readInt16s(view, vEntry.valueOffset, vEntry.count, le), 1);
      if (!distortion || !ca || !vignette) continue;

      return { distortion: distortion[0]!, caRed: ca[0]!, caBlue: ca[1]!, vignette: vignette[0]! };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Correction math (pure; mirrored in RESAMPLE_SHADER) ---------------------

/**
 * Linear spline through evenly-spaced knots: knot i sits at parameter i, and
 * `x` is in knot-index units. Clamps beyond the ends (constant extrapolation).
 * Linear (not PCHIP) is the first-pass choice — the corrections it drives are
 * smooth and near-linear between Sony's 11 dense knots, and the JPEG geometry
 * NCC (verify-lensprofile) already lands well within tolerance; the codebase's
 * monotone PCHIP (color/toneCurve.ts) stays available if a future LR side-by-
 * side favors it.
 */
export function evalLinearSpline(knots: number[], x: number): number {
  const n = knots.length;
  if (n === 0) return 0;
  if (x <= 0) return knots[0]!;
  if (x >= n - 1) return knots[n - 1]!;
  const i = Math.floor(x);
  const f = x - i;
  return knots[i]! * (1 - f) + knots[i + 1]! * f;
}

/** Distortion radial gain g(rn) at normalized radius rn = r / r_max (corner = 1). */
export function distortionGain(knots: number[], rn: number): number {
  const t = (knots.length - 1) * rn;
  return 1 + DISTORTION_KNOT_SCALE * evalLinearSpline(knots, t);
}

/** CA radial gain (red or blue) at normalized radius rn; NO s normalization. */
export function caGain(knots: number[], rn: number): number {
  const t = (knots.length - 1) * rn;
  return 1 + CA_KNOT_SCALE * evalLinearSpline(knots, t);
}

/** Vignetting radial gain at normalized radius rn for divisor `d`. */
export function vignetteGain(knots: number[], rn: number, d: number): number {
  const t = (knots.length - 1) * rn;
  return 1 + evalLinearSpline(knots, t) / d;
}

/**
 * The distortion normalizer `s`: max of g over the image EDGES, so
 * distorted(X) = C + (X−C)·g/s keeps the corrected frame inside the output
 * (the corner never samples past the border). Sampled numerically along all
 * four edges (handles non-monotone "mustache" knots too), for an oriented
 * frame of `width`×`height`. Radially symmetric, so orientation-invariant.
 */
export function distortionNormalizer(knots: number[], width: number, height: number, samples = 64): number {
  const cx = width / 2;
  const cy = height / 2;
  const corner = Math.hypot(cx, cy) || 1;
  // Edge midpoints (x=0 → radius cy, y=0 → radius cx) are the extrema for a
  // radially-monotone gain, so pin them exactly; the swept samples below cover
  // any non-monotone ("mustache") knots in between.
  let s = Math.max(distortionGain(knots, cy / corner), distortionGain(knots, cx / corner));
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1);
    // top/bottom edges (y = ±cy, x swept) and left/right edges (x = ±cx, y swept)
    const ex = -cx + t * width;
    const ey = -cy + t * height;
    const rTB = Math.hypot(ex, cy) / corner; // top & bottom share this radius
    const rLR = Math.hypot(cx, ey) / corner; // left & right share this radius
    s = Math.max(s, distortionGain(knots, rTB), distortionGain(knots, rLR));
  }
  return s;
}
