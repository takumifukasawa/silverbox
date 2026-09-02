/**
 * Minimal, dependency-free TIFF/IFD byte WRITER (the mirror of
 * src/renderer/engine/color/dcp/tiffReader.ts, which only reads). Used by
 * scripts/gen-linear-dng.mjs to hand-assemble Linear DNG files for the
 * local-adaptive-tone identification experiments — see
 * docs/research/local-adaptive-tone.md §5.0 ("合成 Linear DNG を作る").
 *
 * Only what a single-IFD, single-strip, uncompressed baseline TIFF needs:
 * tag/type/count/value entries sorted ascending by tag (required by TIFF
 * 6.0 §2 — "entries in the IFD must be sorted in ascending order by Tag"),
 * the inline-vs-offset rule (a value ≤4 bytes lives in the entry itself;
 * larger values are appended after the IFD and referenced by offset), and
 * one trailing pixel strip whose StripOffsets/StripByteCounts this module
 * computes and injects automatically.
 *
 * No compression, no sub-IFDs, no EXIF IFD, no thumbnail — the generated
 * files are throwaway synthetic test patterns, not real camera files.
 */

/** TIFF 6.0 §2 field types this writer supports. */
export const TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SBYTE: 6,
  UNDEFINED: 7,
  SSHORT: 8,
  SLONG: 9,
  SRATIONAL: 10,
  FLOAT: 11,
  DOUBLE: 12,
};

const TYPE_SIZE = {
  [TYPE.BYTE]: 1,
  [TYPE.ASCII]: 1,
  [TYPE.SHORT]: 2,
  [TYPE.LONG]: 4,
  [TYPE.RATIONAL]: 8,
  [TYPE.SBYTE]: 1,
  [TYPE.UNDEFINED]: 1,
  [TYPE.SSHORT]: 2,
  [TYPE.SLONG]: 4,
  [TYPE.SRATIONAL]: 8,
  [TYPE.FLOAT]: 4,
  [TYPE.DOUBLE]: 8,
};

/** Convert a floating-point value to an exact-enough [numerator, denominator] pair for RATIONAL/SRATIONAL encoding. */
export function toRational(value, denominator = 1_000_000) {
  return [Math.round(value * denominator), denominator];
}

/**
 * Encode `count` values of `type` into a little-endian Buffer.
 *  - ASCII: `values` is a single JS string; the NUL terminator is appended
 *    automatically and `count` (byte length incl. NUL) is returned alongside.
 *  - RATIONAL/SRATIONAL: `values` is an array of [numerator, denominator] pairs.
 *  - everything else: `values` is a flat array of `count` numbers.
 */
export function encodeValue(type, values) {
  switch (type) {
    case TYPE.ASCII: {
      const bytes = Buffer.from(String(values) + '\0', 'ascii');
      return { count: bytes.length, bytes };
    }
    case TYPE.BYTE:
    case TYPE.SBYTE:
    case TYPE.UNDEFINED: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.from(arr.map((v) => v & 0xff));
      return { count: arr.length, bytes };
    }
    case TYPE.SHORT: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 2);
      arr.forEach((v, i) => bytes.writeUInt16LE(v, i * 2));
      return { count: arr.length, bytes };
    }
    case TYPE.SSHORT: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 2);
      arr.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
      return { count: arr.length, bytes };
    }
    case TYPE.LONG: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 4);
      arr.forEach((v, i) => bytes.writeUInt32LE(v >>> 0, i * 4));
      return { count: arr.length, bytes };
    }
    case TYPE.SLONG: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 4);
      arr.forEach((v, i) => bytes.writeInt32LE(v, i * 4));
      return { count: arr.length, bytes };
    }
    case TYPE.RATIONAL: {
      const pairs = /** @type {[number, number][]} */ (values);
      const bytes = Buffer.alloc(pairs.length * 8);
      pairs.forEach(([num, den], i) => {
        bytes.writeUInt32LE(num >>> 0, i * 8);
        bytes.writeUInt32LE(den >>> 0, i * 8 + 4);
      });
      return { count: pairs.length, bytes };
    }
    case TYPE.SRATIONAL: {
      const pairs = /** @type {[number, number][]} */ (values);
      const bytes = Buffer.alloc(pairs.length * 8);
      pairs.forEach(([num, den], i) => {
        bytes.writeInt32LE(num, i * 8);
        bytes.writeInt32LE(den, i * 8 + 4);
      });
      return { count: pairs.length, bytes };
    }
    case TYPE.FLOAT: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 4);
      arr.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
      return { count: arr.length, bytes };
    }
    case TYPE.DOUBLE: {
      const arr = /** @type {number[]} */ (values);
      const bytes = Buffer.alloc(arr.length * 8);
      arr.forEach((v, i) => bytes.writeDoubleLE(v, i * 8));
      return { count: arr.length, bytes };
    }
    default:
      throw new Error(`tiffWriter: unsupported type ${type}`);
  }
}

/**
 * Build a single-IFD, single-strip, little-endian, UNCOMPRESSED TIFF/DNG
 * buffer.
 *
 * `entries`: array of `{ tag, type, values }` — MUST NOT include StripOffsets
 * (273) or StripByteCounts (279); those two are injected automatically from
 * `pixelData`. Duplicate tags throw.
 *
 * File layout: [8-byte header][IFD0][overflow value data, tag order][pixel
 * strip]. Every overflow value block is padded to an even length (word
 * alignment is not strictly required by TIFF 6.0 but is universal practice
 * and keeps offsets predictable); the header, IFD, and per-entry byte counts
 * are all even already so this never shifts the strip's own start.
 */
export function buildTiff({ entries, pixelData }) {
  for (const tag of [273, 279]) {
    if (entries.some((e) => e.tag === tag)) throw new Error(`tiffWriter: entry ${tag} (Strip*) is injected automatically, do not pass it`);
  }

  const encoded = entries
    .map((e) => {
      const { count, bytes } = encodeValue(e.type, e.values);
      return { tag: e.tag, type: e.type, count, bytes };
    })
    .concat([
      { tag: 273, type: TYPE.LONG, count: 1, bytes: Buffer.alloc(4) }, // StripOffsets — value patched below
      { tag: 279, type: TYPE.LONG, count: 1, bytes: encodeValue(TYPE.LONG, [pixelData.length]).bytes },
    ])
    .sort((a, b) => a.tag - b.tag);

  const seen = new Set();
  for (const e of encoded) {
    if (seen.has(e.tag)) throw new Error(`tiffWriter: duplicate tag ${e.tag}`);
    seen.add(e.tag);
  }

  const HEADER_SIZE = 8;
  const ifdSize = 2 + encoded.length * 12 + 4; // count + entries + next-IFD-offset(0)
  const ifdStart = HEADER_SIZE;
  const overflowStart = ifdStart + ifdSize;

  // First pass: lay out overflow data, recording each entry's absolute file offset.
  let cursor = overflowStart;
  const overflowChunks = [];
  const offsetByTag = new Map();
  for (const e of encoded) {
    const size = TYPE_SIZE[e.type] * e.count;
    if (size > 4) {
      offsetByTag.set(e.tag, cursor);
      overflowChunks.push(e.bytes);
      const padded = size % 2 === 0 ? size : size + 1;
      if (padded > size) overflowChunks.push(Buffer.alloc(1));
      cursor += padded;
    }
  }
  const stripOffset = cursor; // pixel data starts right after all overflow data
  offsetByTag.set(273, stripOffset); // patch StripOffsets' inline value now that it's known

  const overflowBuffer = Buffer.concat(overflowChunks);

  // Second pass: emit the 12-byte IFD entries.
  const ifdEntries = Buffer.alloc(encoded.length * 12);
  encoded.forEach((e, i) => {
    const o = i * 12;
    ifdEntries.writeUInt16LE(e.tag, o);
    ifdEntries.writeUInt16LE(e.type, o + 2);
    ifdEntries.writeUInt32LE(e.count, o + 4);
    const size = TYPE_SIZE[e.type] * e.count;
    if (size <= 4) {
      const valueBytes = e.tag === 273 ? encodeValue(TYPE.LONG, [stripOffset]).bytes : e.bytes;
      valueBytes.copy(ifdEntries, o + 8);
      // Unused trailing bytes of a short value slot are left zero (already
      // zero-filled by Buffer.alloc), matching common TIFF-writer practice.
    } else {
      ifdEntries.writeUInt32LE(offsetByTag.get(e.tag), o + 8);
    }
  });

  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16LE(encoded.length, 0);
  const nextIfdBuf = Buffer.alloc(4); // 0 = no next IFD

  const fileHeader = Buffer.alloc(HEADER_SIZE);
  fileHeader.write('II', 0, 'ascii'); // little-endian byte order mark
  fileHeader.writeUInt16LE(42, 2); // TIFF magic number
  fileHeader.writeUInt32LE(ifdStart, 4); // offset of IFD0

  const out = Buffer.concat([fileHeader, countBuf, ifdEntries, nextIfdBuf, overflowBuffer, pixelData]);
  if (out.length !== stripOffset + pixelData.length) {
    throw new Error(`tiffWriter: internal layout mismatch (built ${out.length} bytes, expected strip to end at ${stripOffset + pixelData.length})`);
  }
  return out;
}
