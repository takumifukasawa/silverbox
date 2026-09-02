/**
 * Unit tests for scripts/lib/tiffWriter.mjs — the byte-level TIFF/IFD writer
 * behind scripts/gen-linear-dng.mjs (docs/research/local-adaptive-tone.md
 * §5.0). Uses a tiny hand-rolled TIFF *reader* (deliberately independent of
 * tiffWriter.mjs's own logic — src/renderer/engine/color/dcp/tiffReader.ts
 * can't be reused here, it explicitly rejects plain TIFF/DNG magic bytes,
 * accepting only the "RC"-marked DCP variant) to check IFD layout, tag
 * ordering, and offset arithmetic independently of the writer's own code.
 */
import { describe, expect, it } from 'vitest';
import { buildTiff, encodeValue, toRational, TYPE } from './tiffWriter.mjs';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Minimal plain-TIFF IFD0 reader for these tests only. */
function readIfd0(buf) {
  expect(buf.readUInt8(0)).toBe(0x49); // 'I'
  expect(buf.readUInt8(1)).toBe(0x49); // 'I'
  expect(buf.readUInt16LE(2)).toBe(42);
  const ifdStart = buf.readUInt32LE(4);
  const count = buf.readUInt16LE(ifdStart);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = ifdStart + 2 + i * 12;
    const tag = buf.readUInt16LE(o);
    const type = buf.readUInt16LE(o + 2);
    const cnt = buf.readUInt32LE(o + 4);
    const size = TYPE_SIZE[type] * cnt;
    const valueOffset = size <= 4 ? o + 8 : buf.readUInt32LE(o + 8);
    entries.push({ tag, type, count: cnt, valueOffset, size });
  }
  const nextIfd = buf.readUInt32LE(ifdStart + 2 + count * 12);
  return { entries, nextIfd, ifdStart };
}

function readInts(buf, entry) {
  const out = [];
  const size = TYPE_SIZE[entry.type];
  for (let i = 0; i < entry.count; i++) {
    const o = entry.valueOffset + i * size;
    out.push(entry.type === TYPE.SHORT ? buf.readUInt16LE(o) : buf.readUInt32LE(o));
  }
  return out;
}

describe('tiffWriter.encodeValue', () => {
  it('ASCII appends a NUL terminator and counts it', () => {
    const { count, bytes } = encodeValue(TYPE.ASCII, 'abc');
    expect(count).toBe(4);
    expect([...bytes]).toEqual([0x61, 0x62, 0x63, 0]);
  });

  it('RATIONAL encodes [num,den] pairs as two little-endian uint32s', () => {
    const { count, bytes } = encodeValue(TYPE.RATIONAL, [
      [1, 1],
      [65535, 1],
    ]);
    expect(count).toBe(2);
    expect(bytes.readUInt32LE(0)).toBe(1);
    expect(bytes.readUInt32LE(4)).toBe(1);
    expect(bytes.readUInt32LE(8)).toBe(65535);
    expect(bytes.readUInt32LE(12)).toBe(1);
  });

  it('SRATIONAL encodes negative numerators (two-s complement int32)', () => {
    const { bytes } = encodeValue(TYPE.SRATIONAL, [[-1537139, 1000000]]);
    expect(bytes.readInt32LE(0)).toBe(-1537139);
    expect(bytes.readInt32LE(4)).toBe(1000000);
  });
});

describe('tiffWriter.toRational', () => {
  it('round-trips a float within denominator precision', () => {
    const [num, den] = toRational(0.18, 1_000_000);
    expect(num / den).toBeCloseTo(0.18, 6);
  });
});

describe('tiffWriter.buildTiff', () => {
  const width = 4;
  const height = 2;
  const samplesPerPixel = 3;
  const pixelData = Buffer.alloc(width * height * samplesPerPixel * 2);
  // fill with a recognizable pattern so the strip-data round trip is checked too
  for (let i = 0; i < width * height * samplesPerPixel; i++) pixelData.writeUInt16LE(i * 111, i * 2);

  const entries = [
    { tag: 256, type: TYPE.LONG, values: [width] }, // ImageWidth
    { tag: 257, type: TYPE.LONG, values: [height] }, // ImageLength
    { tag: 258, type: TYPE.SHORT, values: [16, 16, 16] }, // BitsPerSample
    { tag: 259, type: TYPE.SHORT, values: [1] }, // Compression
    { tag: 262, type: TYPE.SHORT, values: [34892] }, // PhotometricInterpretation (LinearRaw)
    { tag: 271, type: TYPE.ASCII, values: 'Silverbox' }, // Make
    { tag: 277, type: TYPE.SHORT, values: [samplesPerPixel] }, // SamplesPerPixel
    { tag: 50708, type: TYPE.ASCII, values: 'Silverbox Synthetic LinearRaw' }, // UniqueCameraModel — long enough to force an overflow value
  ];

  it('sorts entries ascending by tag regardless of insertion order (TIFF 6.0 §2)', () => {
    const shuffled = [...entries].reverse();
    const buf = buildTiff({ entries: shuffled, pixelData });
    const { entries: parsed } = readIfd0(buf);
    const tags = parsed.map((e) => e.tag);
    const sorted = [...tags].sort((a, b) => a - b);
    expect(tags).toEqual(sorted);
  });

  it('injects StripOffsets(273)/StripByteCounts(279) automatically, byte counts matching pixelData length', () => {
    const buf = buildTiff({ entries, pixelData });
    const { entries: parsed } = readIfd0(buf);
    const stripOffsets = parsed.find((e) => e.tag === 273);
    const stripByteCounts = parsed.find((e) => e.tag === 279);
    expect(stripOffsets).toBeDefined();
    expect(stripByteCounts).toBeDefined();
    const byteCount = readInts(buf, stripByteCounts)[0];
    expect(byteCount).toBe(pixelData.length);
    const [stripOffset] = readInts(buf, stripOffsets);
    expect(buf.subarray(stripOffset, stripOffset + pixelData.length).equals(pixelData)).toBe(true);
  });

  it('inline values (≤4 bytes) live directly in the entry, no offset indirection', () => {
    const buf = buildTiff({ entries, pixelData });
    const { entries: parsed } = readIfd0(buf);
    const widthEntry = parsed.find((e) => e.tag === 256);
    expect(widthEntry.size).toBeLessThanOrEqual(4);
    expect(readInts(buf, widthEntry)[0]).toBe(width);
  });

  it('overflow values (>4 bytes) are stored after the IFD and referenced by offset', () => {
    const buf = buildTiff({ entries, pixelData });
    const { entries: parsed, ifdStart } = readIfd0(buf);
    const model = parsed.find((e) => e.tag === 50708);
    expect(model.size).toBeGreaterThan(4);
    const ifdEnd = ifdStart + 2 + parsed.length * 12 + 4;
    expect(model.valueOffset).toBeGreaterThanOrEqual(ifdEnd);
    const text = buf.toString('ascii', model.valueOffset, model.valueOffset + model.count - 1); // drop NUL
    expect(text).toBe('Silverbox Synthetic LinearRaw');
  });

  it('has no next IFD (single-IFD file)', () => {
    const buf = buildTiff({ entries, pixelData });
    const { nextIfd } = readIfd0(buf);
    expect(nextIfd).toBe(0);
  });

  it('rejects a caller-supplied StripOffsets/StripByteCounts entry', () => {
    expect(() => buildTiff({ entries: [...entries, { tag: 273, type: TYPE.LONG, values: [0] }], pixelData })).toThrow();
    expect(() => buildTiff({ entries: [...entries, { tag: 279, type: TYPE.LONG, values: [0] }], pixelData })).toThrow();
  });

  it('rejects duplicate tags', () => {
    expect(() => buildTiff({ entries: [...entries, { tag: 256, type: TYPE.LONG, values: [99] }], pixelData })).toThrow();
  });

  it('total file length matches strip end (no gaps, no overlap)', () => {
    const buf = buildTiff({ entries, pixelData });
    const { entries: parsed } = readIfd0(buf);
    const [stripOffset] = readInts(buf, parsed.find((e) => e.tag === 273));
    expect(buf.length).toBe(stripOffset + pixelData.length);
  });
});
