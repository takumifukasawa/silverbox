#!/usr/bin/env node
/**
 * Deterministic TIFF transform for scripts/verify-external.mjs (external-tool
 * hook node, task #41's own verify fixture — "a node script that
 * deterministically transforms the TIFF", no new dependency: uses `sharp`,
 * already a project dependency — see src/main/externalTool.ts).
 *
 * 8-bit only, matching externalTool.ts's own wire format (see its doc
 * comment for why v1 ships 8-bit TIFF for both encoded/linear modes rather
 * than the design brief's original 16-bit/float — a confirmed sharp/libvips
 * limitation in this environment, not a choice made here). Adds a constant
 * offset to every sample and writes the result back at the SAME dimensions —
 * satisfying the hook node's "same resolution back" contract. A predictable,
 * easily-inverted transform is what lets the verify script assert real
 * numeric deltas instead of just "something changed".
 *
 * Usage: external-transform.mjs <in.tiff> <out.tiff> [offset|--fail|--write16]
 *   offset    added to every sample, expressed in the SAME normalized [0,1]
 *             space externalTool.ts scales by (i.e. offset*255), clamped to
 *             the format's 0..255 range. Default 0.1.
 *   --fail    exit 1 immediately, writing nothing — the verify script's
 *             ANY-failure-⇒-passthrough-and-badge check.
 *   --write16 write a hand-rolled 16-bit ('ushort') uncompressed TIFF at the
 *             SAME dimensions as the input instead of the usual 8-bit
 *             transform — simulates a tool that (like real gmic's bare `-o`
 *             default) hands back a higher bit depth than this hook node's
 *             8-bit wire format can read, for the "depth mismatch ⇒
 *             pass-through + actionable error" check (see
 *             src/main/externalTool.ts's doc comment for the empirical
 *             finding that this build's raw-pixel extraction is broken for
 *             anything above 8-bit). Hand-rolled rather than via sharp
 *             because sharp/libvips in this build cannot WRITE a high-bit
 *             TIFF either — pixel VALUES are irrelevant (all zero) since
 *             externalTool.ts is expected to reject on depth before ever
 *             reading a pixel.
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const [, , inPath, outPath, arg] = process.argv;

if (arg === '--fail') {
  console.error('external-transform: forced failure (--fail)');
  process.exit(1);
}

if (!inPath || !outPath) {
  console.error('usage: external-transform.mjs <in.tiff> <out.tiff> [offset|--fail|--write16]');
  process.exit(1);
}

if (arg === '--write16') {
  const meta = await sharp(inPath).metadata();
  const { width, height } = meta;
  if (!width || !height) {
    console.error('external-transform: could not read input dimensions');
    process.exit(1);
  }
  writeMinimalUint16Tiff(outPath, width, height);
  process.exit(0);
}

const offset = arg !== undefined ? Number(arg) : 0.1;
if (!Number.isFinite(offset)) {
  console.error(`external-transform: invalid offset "${arg}"`);
  process.exit(1);
}

const input = sharp(inPath);
const meta = await input.metadata();
const { width, height } = meta;
if (!width || !height) {
  console.error('external-transform: could not read input dimensions');
  process.exit(1);
}
const channels = 3;
// Buffer.from() COPIES into a fresh, zero-offset buffer — sharp's raw()
// output can be a view into a larger pooled allocation, and constructing a
// typed array directly over raw.buffer/raw.byteOffset is only valid when
// that offset is itself a multiple of the element size, which isn't
// guaranteed; copying sidesteps the alignment question entirely.
const src = Buffer.from(await input.raw().toBuffer());
const delta = Math.round(offset * 255);
const dst = new Uint8Array(src.length);
for (let i = 0; i < src.length; i++) dst[i] = Math.min(255, Math.max(0, src[i] + delta));

await sharp(dst, { raw: { width, height, channels } }).tiff({ compression: 'none' }).toFile(outPath);

/**
 * Hand-write a minimal, valid, uncompressed 16-bit RGB TIFF (little-endian,
 * single strip, no compression) — no library, just the IFD bytes. Only 9
 * tags are needed for libtiff/libvips to parse it correctly: ImageWidth,
 * ImageLength, BitsPerSample (16,16,16 — SampleFormat is deliberately
 * omitted, defaulting to unsigned int, which is exactly the 'ushort' depth
 * this fixture wants), Compression (1 = none), PhotometricInterpretation
 * (2 = RGB), StripOffsets, SamplesPerPixel, RowsPerStrip, StripByteCounts.
 * Verified empirically (scratch probe) that `sharp(...).metadata()` reads
 * this back as `{ width, height, depth: 'ushort' }` correctly — pixel
 * CONTENT (all zero here) is never inspected by this check, only metadata.
 */
function writeMinimalUint16Tiff(outPath, width, height) {
  const samplesPerPixel = 3;
  const bytesPerSample = 2; // 16-bit
  const pixelBytes = width * height * samplesPerPixel * bytesPerSample;

  const HEADER_SIZE = 8;
  const ENTRY_COUNT = 9;
  const IFD_SIZE = 2 + ENTRY_COUNT * 12 + 4; // count + entries + next-IFD offset
  const bitsPerSampleArrayOffset = HEADER_SIZE + IFD_SIZE;
  const bitsPerSampleArraySize = samplesPerPixel * 2; // one SHORT per sample
  const pixelDataOffset = bitsPerSampleArrayOffset + bitsPerSampleArraySize;

  const buf = Buffer.alloc(pixelDataOffset + pixelBytes); // pixel bytes stay zeroed — content doesn't matter
  let off = 0;
  buf.write('II', off, 'ascii'); off += 2; // little-endian byte order
  buf.writeUInt16LE(42, off); off += 2; // TIFF magic number
  buf.writeUInt32LE(HEADER_SIZE, off); off += 4; // offset of the (only) IFD

  buf.writeUInt16LE(ENTRY_COUNT, off); off += 2;
  const writeEntry = (tag, type, count, value) => {
    buf.writeUInt16LE(tag, off); off += 2;
    buf.writeUInt16LE(type, off); off += 2;
    buf.writeUInt32LE(count, off); off += 4;
    // A SHORT (type 3) with count 1 occupies only the low 2 bytes of the
    // 4-byte value/offset field per the TIFF6 spec; LONG (type 4) fills it.
    if (type === 3 && count === 1) {
      buf.writeUInt16LE(value, off);
      buf.writeUInt16LE(0, off + 2);
    } else {
      buf.writeUInt32LE(value, off);
    }
    off += 4;
  };
  writeEntry(256, 4, 1, width); // ImageWidth (LONG)
  writeEntry(257, 4, 1, height); // ImageLength (LONG)
  writeEntry(258, 3, samplesPerPixel, bitsPerSampleArrayOffset); // BitsPerSample (SHORT x3, external array)
  writeEntry(259, 3, 1, 1); // Compression: none
  writeEntry(262, 3, 1, 2); // PhotometricInterpretation: RGB
  writeEntry(273, 4, 1, pixelDataOffset); // StripOffsets
  writeEntry(277, 3, 1, samplesPerPixel); // SamplesPerPixel
  writeEntry(278, 4, 1, height); // RowsPerStrip (single strip)
  writeEntry(279, 4, 1, pixelBytes); // StripByteCounts
  buf.writeUInt32LE(0, off); off += 4; // next IFD offset: none

  buf.writeUInt16LE(16, bitsPerSampleArrayOffset);
  buf.writeUInt16LE(16, bitsPerSampleArrayOffset + 2);
  buf.writeUInt16LE(16, bitsPerSampleArrayOffset + 4);

  writeFileSync(outPath, buf);
}
