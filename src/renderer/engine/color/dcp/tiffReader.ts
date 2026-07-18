/**
 * Minimal, self-contained TIFF/IFD byte reader — the container format a DCP
 * (DNG Camera Profile) is wrapped in. No dependency beyond DataView; this is
 * intentionally NOT a general TIFF/EXIF library, just enough of the format to
 * walk one IFD's tag list and fetch each tag's typed values.
 *
 * Byte order mark: a real TIFF starts "II*\0" (little-endian) or "MM\0*"
 * (big-endian) — bytes 2-3 are the literal magic number 42 (0x002A). A DCP
 * is a DIFFERENT (but otherwise IDENTICAL) container: bytes 2-3 are the
 * ASCII "RC" instead, i.e. the file starts "IIRC" (little-endian) or "MMRC"
 * (big-endian) — hex bytes 49 49 52 43 / 4D 4D 52 43. This is Adobe's own
 * DCP-vs-DNG discriminator (a plain TIFF reader would refuse a DCP outright,
 * on purpose). Verified against every locally-installed Sony ILCE-7CM2
 * profile: all little-endian "IIRC" — this reader handles both endians
 * anyway since nothing about the rest of the format depends on which.
 * Everything past the 8-byte header (IFD offset, entry count, 12-byte
 * entries, inline-vs-offset value rule) is bog-standard TIFF6.0/EXIF IFD
 * structure.
 */

export type TiffType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** Byte size of one value of a given TIFF field type (TIFF 6.0 §2, "Data Types"). */
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL (2×LONG)
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL (2×SLONG)
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

export class DcpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DcpParseError';
  }
}

export interface IfdEntry {
  tag: number;
  type: TiffType;
  count: number;
  /** Absolute byte offset of this entry's value data (already resolved past the inline-vs-offset indirection). */
  valueOffset: number;
}

export class TiffIfd {
  constructor(
    private readonly view: DataView,
    private readonly littleEndian: boolean,
    readonly entries: readonly IfdEntry[]
  ) {}

  private entry(tag: number): IfdEntry | undefined {
    return this.entries.find((e) => e.tag === tag);
  }

  has(tag: number): boolean {
    return this.entry(tag) !== undefined;
  }

  /** Every SHORT/LONG value of the tag as a plain number array (throws if absent or the wrong integer type). */
  ints(tag: number, tagName: string): number[] {
    const e = this.entry(tag);
    if (!e) throw new DcpParseError(`missing required tag ${tagName} (${tag})`);
    if (e.type !== 3 && e.type !== 4) {
      throw new DcpParseError(`tag ${tagName} (${tag}) has type ${e.type}, expected SHORT or LONG`);
    }
    const out: number[] = [];
    const size = TYPE_SIZE[e.type]!;
    for (let i = 0; i < e.count; i++) {
      const o = e.valueOffset + i * size;
      out.push(e.type === 3 ? this.view.getUint16(o, this.littleEndian) : this.view.getUint32(o, this.littleEndian));
    }
    return out;
  }

  intOpt(tag: number, tagName: string): number[] | null {
    return this.has(tag) ? this.ints(tag, tagName) : null;
  }

  /** Every RATIONAL/SRATIONAL value of the tag as a plain (already-divided) number array. */
  rationals(tag: number, tagName: string): number[] {
    const e = this.entry(tag);
    if (!e) throw new DcpParseError(`missing required tag ${tagName} (${tag})`);
    if (e.type !== 5 && e.type !== 10) {
      throw new DcpParseError(`tag ${tagName} (${tag}) has type ${e.type}, expected RATIONAL or SRATIONAL`);
    }
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const o = e.valueOffset + i * 8;
      const num = e.type === 5 ? this.view.getUint32(o, this.littleEndian) : this.view.getInt32(o, this.littleEndian);
      const den = e.type === 5 ? this.view.getUint32(o + 4, this.littleEndian) : this.view.getInt32(o + 4, this.littleEndian);
      if (den === 0) throw new DcpParseError(`tag ${tagName} (${tag}) has a rational with zero denominator`);
      out.push(num / den);
    }
    return out;
  }

  rationalOpt(tag: number, tagName: string): number[] | null {
    return this.has(tag) ? this.rationals(tag, tagName) : null;
  }

  /** Every FLOAT value of the tag as a Float32Array-backed number array. */
  floats(tag: number, tagName: string): number[] {
    const e = this.entry(tag);
    if (!e) throw new DcpParseError(`missing required tag ${tagName} (${tag})`);
    if (e.type !== 11 && e.type !== 12) {
      throw new DcpParseError(`tag ${tagName} (${tag}) has type ${e.type}, expected FLOAT or DOUBLE`);
    }
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const o = e.valueOffset + i * TYPE_SIZE[e.type]!;
      out.push(e.type === 11 ? this.view.getFloat32(o, this.littleEndian) : this.view.getFloat64(o, this.littleEndian));
    }
    return out;
  }

  floatsOpt(tag: number, tagName: string): number[] | null {
    return this.has(tag) ? this.floats(tag, tagName) : null;
  }

  /** ASCII string value (NUL-terminated per TIFF convention — trimmed at the first NUL, or the full run if absent). */
  ascii(tag: number, tagName: string): string {
    const e = this.entry(tag);
    if (!e) throw new DcpParseError(`missing required tag ${tagName} (${tag})`);
    if (e.type !== 2) throw new DcpParseError(`tag ${tagName} (${tag}) has type ${e.type}, expected ASCII`);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + e.valueOffset, e.count);
    const nul = bytes.indexOf(0);
    return new TextDecoder('ascii').decode(nul >= 0 ? bytes.subarray(0, nul) : bytes);
  }

  asciiOpt(tag: number, tagName: string): string | null {
    return this.has(tag) ? this.ascii(tag, tagName) : null;
  }
}

/**
 * Parse the 8-byte TIFF/DCP header + IFD0's entry list. Throws DcpParseError
 * with an actionable message for anything that isn't a well-formed DCP —
 * never returns a partially-valid structure for the caller to trip over
 * later.
 */
export function readDcpIfd0(buf: ArrayBuffer, sourcePath?: string): TiffIfd {
  const where = sourcePath ? ` (${sourcePath})` : '';
  if (buf.byteLength < 8) throw new DcpParseError(`file${where} is too small to be a DCP (${buf.byteLength} bytes)`);
  const view = new DataView(buf);
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  const b2 = view.getUint8(2);
  const b3 = view.getUint8(3);
  let littleEndian: boolean;
  if (b0 === 0x49 && b1 === 0x49) littleEndian = true; // "II…"
  else if (b0 === 0x4d && b1 === 0x4d) littleEndian = false; // "MM…"
  else throw new DcpParseError(`file${where} is not a DCP: bad byte-order mark (expected "II" or "MM", got ${String.fromCharCode(b0, b1)})`);
  if (!(b2 === 0x52 && b3 === 0x43)) {
    // A plain TIFF/DNG here (bytes 2-3 = 0x00 0x2A) is a common, specific
    // mistake worth naming — the user pointed us at a raw photo or a DNG,
    // not the small camera-PROFILE sidecar file.
    const isPlainTiff = (littleEndian && b2 === 0x2a && b3 === 0x00) || (!littleEndian && b2 === 0x00 && b3 === 0x2a);
    throw new DcpParseError(
      isPlainTiff
        ? `file${where} is a plain TIFF/DNG, not a DCP (missing the "RC" DCP marker at bytes 2-3) — pass a .dcp camera-profile file`
        : `file${where} is not a DCP: bad magic bytes 2-3 (expected "RC", got 0x${b2.toString(16)}${b3.toString(16)})`
    );
  }
  if (buf.byteLength < 12) throw new DcpParseError(`file${where} is truncated (no room for an IFD offset)`);
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset + 2 > buf.byteLength) throw new DcpParseError(`file${where} has an IFD offset (${ifdOffset}) past the end of the file`);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const entriesEnd = ifdOffset + 2 + entryCount * 12;
  if (entriesEnd > buf.byteLength) throw new DcpParseError(`file${where} has a truncated IFD (${entryCount} entries don't fit)`);

  const entries: IfdEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const eo = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(eo, littleEndian);
    const type = view.getUint16(eo + 2, littleEndian) as TiffType;
    const count = view.getUint32(eo + 4, littleEndian);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    if (!Number.isFinite(size) || size < 0) throw new DcpParseError(`file${where} has a malformed IFD entry (tag ${tag}, bad size)`);
    // Inline rule (TIFF 6.0 §2): a value ≤4 bytes lives directly in the entry's
    // own value slot; anything larger is an offset to elsewhere in the file.
    const valueOffset = size <= 4 ? eo + 8 : view.getUint32(eo + 8, littleEndian);
    if (valueOffset + size > buf.byteLength) {
      throw new DcpParseError(`file${where} has tag ${tag}'s data (offset ${valueOffset}, ${size} bytes) past the end of the file`);
    }
    entries.push({ tag, type, count, valueOffset });
  }
  return new TiffIfd(view, littleEndian, entries);
}
