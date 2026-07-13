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
const TAG_EXIF_IFD = 0x8769;
const TAG_LENS_MODEL = 0xa434;
const TAG_MAKE = 0x010f;
/** Standard TIFF/EXIF Orientation tag, sitting right in IFD0 next to Make —
 * see extractSonyEmbeddedPreview's `flip` field for why this is read too. */
const TAG_ORIENTATION = 0x0112;
/** JPEGInterchangeFormat / …Length — the standard TIFF/EXIF preview-JPEG
 * pointer pair (embedded-preview-first opening; see extractSonyEmbeddedPreview). */
const TAG_JPEG_OFFSET = 0x0201;
const TAG_JPEG_LENGTH = 0x0202;

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

/** Read an ASCII string of `count` bytes at `offset` (trailing NUL/whitespace trimmed); null on out-of-bounds/empty. Endianness-independent (bytes). */
function readAscii(view: DataView, offset: number, count: number): string | null {
  if (offset < 0 || count <= 0 || offset + count > view.byteLength) return null;
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
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

/**
 * Extract the EXIF LensModel string (tag 0xA434 in the ExifIFD, reached via
 * IFD0's ExifIFD pointer tag 0x8769) from raw ARW bytes — e.g. "FE 24mm F2.8
 * G". Reuses the same bounds-checked plaintext TIFF walk as
 * parseSonyLensProfile; returns null on a JPEG/non-Sony/garbage buffer or a
 * missing/empty tag, and never throws. (Camera model comes from libraw's
 * CaptureInfo; this covers the lens, which libraw does not surface.)
 */
export function parseSonyLensModel(buffer: ArrayBuffer): string | null {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 8) return null;
    const bom = view.getUint16(0, false);
    let le: boolean;
    if (bom === 0x4949) le = true;
    else if (bom === 0x4d4d) le = false;
    else return null;
    if (view.getUint16(2, le) !== 42) return null;
    const ifd0 = readIfd(view, view.getUint32(4, le), le);
    if (!ifd0) return null;
    const exifPtr = ifd0.find((e) => e.tag === TAG_EXIF_IFD);
    if (!exifPtr) return null;
    const exif = readIfd(view, view.getUint32(exifPtr.valueOffset, le), le);
    if (!exif) return null;
    const lens = exif.find((e) => e.tag === TAG_LENS_MODEL);
    if (!lens) return null;
    return readAscii(view, lens.valueOffset, lens.count);
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

// --- Embedded preview extraction (embedded-preview-first opening) -----------

/** A sliced-out (COPY, not a view into the source buffer) embedded JPEG. */
export interface EmbeddedPreview {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  /**
   * Rotation the bytes need to display upright, in the SAME code space as
   * RawDecoder's `flip` (0=none, 3=180°, 5=90°CCW, 6=90°CW) — round-8 fix:
   * unlike the main decode (LibRaw physically pre-rotates its mem-image
   * output per EXIF, see decodeWorker.ts's NOTE), this is a bare JPEG stream
   * sliced straight out of the file with no orientation of its own, so a
   * portrait shot's overlay rendered unrotated for ~1s until the real decode
   * replaced it. Read from IFD0's Orientation tag (0x0112) — the exact same
   * IFD parseSonyLensProfile/parseSonyLensModel already walk. Mirror-orientations
   * (EXIF 2/4/5/7) aren't produced by any Sony body seen so far and fall back
   * to 0 (unrotated) rather than guess at a mirror the caller can't undo with
   * a plain rotate.
   */
  flip: number;
}

/** EXIF Orientation tag values that are pure rotations (no mirroring), mapped
 * to RawDecoder's flip code space. See EmbeddedPreview.flip's doc comment. */
const EXIF_ORIENTATION_TO_FLIP: Record<number, number> = { 1: 0, 3: 3, 6: 6, 8: 5 };

/**
 * Cheap JPEG dimension read: scans markers from SOI looking for a Start-Of-
 * Frame segment (0xFFC0-0xFFCF, excluding the DHT/JPG/DAC markers C4/C8/CC)
 * and reads its height/width fields — no pixel decode, just a header walk
 * that stops at the first SOF (always near the front of a baseline/
 * progressive JPEG, well before the entropy-coded scan data). Returns null on
 * anything that doesn't parse as a JPEG within `[offset, offset+length)`.
 */
function readJpegDimensions(view: DataView, offset: number, length: number): { width: number; height: number } | null {
  if (offset < 0 || length < 4 || offset + length > view.byteLength) return null;
  if (view.getUint16(offset, false) !== 0xffd8) return null; // SOI
  const end = offset + length;
  let p = offset + 2;
  while (p + 4 <= end) {
    if (view.getUint8(p) !== 0xff) return null; // not a marker where one was expected
    const marker = view.getUint8(p + 1);
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      p += 2; // markers with no payload (RSTn, SOI/EOI, TEM)
      continue;
    }
    const segLen = view.getUint16(p + 2, false);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (p + 9 > end) return null;
      const height = view.getUint16(p + 5, false);
      const width = view.getUint16(p + 7, false);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda || segLen < 2) return null; // start-of-scan reached (or bogus length) — no more headers
    p += 2 + segLen;
  }
  return null;
}

/**
 * Collect every (offset, length) JPEGInterchangeFormat pair reachable from
 * IFD0: this camera generation (a7C II) parks three of them across the
 * top-level next-IFD chain, NOT just IFD0/IFD1 —
 *
 *   IFD0            1616×1080  ~300KB  ("PreviewImage")
 *   IFD1 (chained)   160×120   ~11KB   (the plain TIFF thumbnail)
 *   IFD2 (chained)  4608×3072  ~1.6MB  ("JpgFromRaw" — the full camera frame)
 *
 * verified with `exiftool -v3` against the default ARW; see
 * extractSonyEmbeddedPreview's doc comment). Also checks IFD0's SubIFDs (tag
 * 0x014a, the same link parseSonyLensProfile walks) in case a different body
 * parks a preview there instead. Capped chain length as a safety net against
 * a corrupt/circular next-IFD pointer.
 */
function collectJpegCandidates(view: DataView, le: boolean, ifd0Off: number): { offset: number; length: number }[] {
  const candidates: { offset: number; length: number }[] = [];
  const visit = (entries: IfdEntry[]) => {
    const offEntry = entries.find((e) => e.tag === TAG_JPEG_OFFSET);
    const lenEntry = entries.find((e) => e.tag === TAG_JPEG_LENGTH);
    if (!offEntry || !lenEntry) return;
    const offset = view.getUint32(offEntry.valueOffset, le);
    const length = view.getUint32(lenEntry.valueOffset, le);
    if (offset > 0 && length > 0 && offset + length <= view.byteLength) candidates.push({ offset, length });
  };
  let ifdOff = ifd0Off;
  let guard = 0;
  while (ifdOff && guard < 8) {
    if (ifdOff <= 0 || ifdOff + 2 > view.byteLength) break;
    const count = view.getUint16(ifdOff, le);
    const end = ifdOff + 2 + count * 12;
    if (end + 4 > view.byteLength) break;
    const entries = readIfd(view, ifdOff, le);
    if (!entries) break;
    visit(entries);
    if (guard === 0) {
      const subTag = entries.find((e) => e.tag === TAG_SUBIFDS);
      if (subTag) {
        const subOffsets: number[] = [];
        if (subTag.count === 1) {
          subOffsets.push(view.getUint32(subTag.valueOffset, le));
        } else {
          for (let i = 0; i < subTag.count; i++) {
            const o = subTag.valueOffset + i * 4;
            if (o + 4 <= view.byteLength) subOffsets.push(view.getUint32(o, le));
          }
        }
        for (const subOff of subOffsets) {
          const sub = readIfd(view, subOff, le);
          if (sub) visit(sub);
        }
      }
    }
    ifdOff = view.getUint32(end, le);
    guard++;
  }
  return candidates;
}

/**
 * Size preference for extractSonyEmbeddedPreview:
 *  - 'largest' (default): the biggest embedded JPEG — embedded-preview-first
 *    opening wants the full-frame camera JPEG.
 *  - 'smallest-above': the SMALLEST embedded JPEG whose long edge is still
 *    >= `minLongEdge` (default 160) — the filmstrip thumbnail cache wants the
 *    a7C II's own 160×120 IFD1 thumb, not its 1616×1080 IFD0 preview or its
 *    4608×3072 JpgFromRaw. Falls back to 'largest' if nothing clears the
 *    floor (still returns something rather than nothing).
 */
export interface ExtractPreviewOptions {
  prefer?: 'largest' | 'smallest-above';
  /** Long-edge floor (px) for 'smallest-above'; ignored for 'largest'. */
  minLongEdge?: number;
}

/**
 * Extract an embedded full-frame JPEG preview from a Sony ARW, as a cheap
 * byte-range slice (no decode) — task: embedded-preview-first opening (also
 * reused by the folder filmstrip's thumbnail cache with `{ prefer:
 * 'smallest-above' }`). Default (`opts` omitted) is unchanged from before
 * this option existed: the LARGEST candidate.
 *
 * Gated to Sony (Make tag 0x010f) — a non-Sony TIFF-based RAW may carry the
 * same standard 0x0201/0x0202 tag pair, but this function's chain-walk
 * (collectJpegCandidates) is tuned against this camera generation's specific
 * IFD layout and hasn't been validated elsewhere, so it stays in scope with
 * the rest of this file's "Sony only, the file is the profile" approach.
 *
 * Returns null (never throws) for a JPEG, a non-Sony RAW, a truncated/garbage
 * buffer, or a Sony ARW whose preview tags don't parse as a JPEG with a
 * readable SOF header.
 */
export function extractSonyEmbeddedPreview(buffer: ArrayBuffer, opts?: ExtractPreviewOptions): EmbeddedPreview | null {
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
    const makeEntry = ifd0.find((e) => e.tag === TAG_MAKE);
    const make = makeEntry ? readAscii(view, makeEntry.valueOffset, makeEntry.count) : null;
    if (!make || !make.toUpperCase().startsWith('SONY')) return null;

    // EXIF Orientation (0x0112, inline SHORT) — see EmbeddedPreview.flip's doc
    // comment. Missing/unrecognized (mirror orientations) ⇒ 0 (unrotated),
    // same as a body that never reports one.
    const orientationEntry = ifd0.find((e) => e.tag === TAG_ORIENTATION);
    const orientationValue =
      orientationEntry && orientationEntry.valueOffset + 2 <= view.byteLength
        ? view.getUint16(orientationEntry.valueOffset, le)
        : 1;
    const flip = EXIF_ORIENTATION_TO_FLIP[orientationValue] ?? 0;

    const candidates = collectJpegCandidates(view, le, ifd0Off);
    const dimsCandidates: { offset: number; length: number; width: number; height: number }[] = [];
    for (const { offset, length } of candidates) {
      const dims = readJpegDimensions(view, offset, length);
      if (dims) dimsCandidates.push({ offset, length, ...dims });
    }
    if (dimsCandidates.length === 0) return null;

    const prefer = opts?.prefer ?? 'largest';
    const pickLargest = () =>
      dimsCandidates.reduce((best, c) => (c.width * c.height > best.width * best.height ? c : best));
    let chosen: (typeof dimsCandidates)[number];
    if (prefer === 'largest') {
      chosen = pickLargest();
    } else {
      const minLongEdge = opts?.minLongEdge ?? 160;
      const above = dimsCandidates.filter((c) => Math.max(c.width, c.height) >= minLongEdge);
      chosen = above.length > 0 ? above.reduce((best, c) => (c.width * c.height < best.width * best.height ? c : best)) : pickLargest();
    }
    return { bytes: buffer.slice(chosen.offset, chosen.offset + chosen.length), width: chosen.width, height: chosen.height, flip };
  } catch {
    return null;
  }
}
