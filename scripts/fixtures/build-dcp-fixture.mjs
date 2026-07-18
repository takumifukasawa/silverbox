#!/usr/bin/env node
/**
 * Generator for scripts/fixtures/silverbox-test.dcp — the DCP (DNG Camera
 * Profile) verify fixture (scripts/verify-dcp.mjs, docs/brief-bank/dcp-
 * profile.md). Hand-rolled directly against the TIFF/DCP IFD wire format
 * (src/renderer/engine/color/dcp/tiffReader.ts's own doc comment has the
 * byte-order-mark/magic story) — no library, same "hand-roll the exact
 * bytes" precedent as generate-denoise-fixture.mjs / external-transform.mjs's
 * writeMinimalUint16Tiff. Every value below is OURS: tiny, synthetic,
 * invented for this test — zero Adobe content, the brief's hard legal line.
 *
 * What this fixture contains, and WHY each value was chosen (see
 * verify-dcp.mjs's golden-math section for the full hand-derivation this
 * shape enables):
 *
 *  - CalibrationIlluminant1/2 = 17 (StdA, 2856K) / 21 (D65, 6504K) — the
 *    exact codes real Sony DCPs use (confirmed by reading several locally-
 *    installed Adobe profiles for this research — see the brief's legal
 *    line: reading is fine, their bytes are never copied here).
 *  - ColorMatrix1 / ForwardMatrix1 / ForwardMatrix2 = IDENTITY. Required
 *    tags (ColorMatrix1) or the preferred path (ForwardMatrix) get a
 *    deliberately trivial matrix so the golden test's hand-derivation
 *    doesn't need to carry symbolic 3×3 products through — the interesting
 *    numeric behavior (illuminant interpolation) is exercised by the
 *    HueSatMap tables instead (see below), which DO differ between
 *    illuminant 1 and 2.
 *  - ProfileHueSatMapDims = [2, 2, 1] — the brief's own suggested minimal
 *    shape (2 hue × 2 sat × 1 val, the spec's documented "value axis
 *    collapsed" special case). Data1 node (h=0,s=0) = (+15° hue, ×1.1 sat,
 *    ×0.95 val); Data2's SAME node = (+25°, ×1.2, ×0.9) — different between
 *    the two illuminants, so the golden test's chosen asShotTempK (exactly
 *    mired-halfway between 2856K/6504K, fraction=0.5) exercises a REAL
 *    50/50 blend, not a degenerate single-illuminant no-op. The other 3
 *    nodes are identity-ish filler (never reached by the golden test's
 *    input, which lands exactly on the h=0,s=0 grid node — see below).
 *  - ProfileLookTableDims = [1, 1, 1] — the spec's other documented
 *    degenerate case (a single-cell "constant adjustment" table), applied
 *    AFTER HueSatMap per spec precedence: (-5° hue, ×1.0 sat, ×1.02 val).
 *  - ProfileToneCurve = (0,0) (0.5,0.6) (1,1) — a small non-identity lift,
 *    piecewise-linear-evaluable by hand.
 *  - BaselineExposureOffset = +0.25 EV (a plain final gain).
 *
 * The golden test's own input triplet is chosen so the WHOLE chain
 * degenerates to gray-in→gray-out (sat stays exactly 0 throughout — see
 * verify-dcp.mjs), which is what makes "hand-derivable" actually true: no
 * fractional trilinear interpolation ever happens (every table lookup lands
 * exactly on its [0,0,0] grid node), so the only arithmetic is the matrix/
 * tone-curve/gain SCALARS themselves, auditable line by line.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- TIFF/DCP field types (TIFF 6.0 §2) -------------------------------------
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const SRATIONAL = 10;
const FLOAT = 11;
const TYPE_SIZE = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [SRATIONAL]: 8, [FLOAT]: 4 };

/** One IFD entry's logical value, encoded to bytes at build time. */
function entry(tag, type, values) {
  return { tag, type, values };
}

function asciiBytes(s) {
  const withNul = s + '\0';
  return Buffer.from(withNul, 'ascii');
}

/** Encode a decimal as a small-denominator SRATIONAL (good enough for this fixture's simple values: integers, 0.25, 1.1, 1.02, …). */
function toSrational(v) {
  const den = 1000000;
  return [Math.round(v * den), den];
}

function encodeValues(type, values) {
  if (type === ASCII) return asciiBytes(values[0]);
  const size = TYPE_SIZE[type];
  const bufOut = Buffer.alloc(size * values.length);
  for (let i = 0; i < values.length; i++) {
    if (type === SHORT) bufOut.writeUInt16LE(values[i], i * 2);
    else if (type === LONG) bufOut.writeUInt32LE(values[i], i * 4);
    else if (type === FLOAT) bufOut.writeFloatLE(values[i], i * 4);
    else if (type === SRATIONAL) {
      const [num, den] = toSrational(values[i]);
      bufOut.writeInt32LE(num, i * 8);
      bufOut.writeInt32LE(den, i * 8 + 4);
    } else throw new Error(`unsupported type ${type}`);
  }
  return bufOut;
}

/** Build a full DCP (IFD0 only, no pixel data) from a list of entries — see this file's doc comment for the exact fixture contents. */
export function buildFixtureDcpBytes(entries) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const encoded = sorted.map((e) => ({ tag: e.tag, type: e.type, count: e.type === ASCII ? null : e.values.length, bytes: encodeValues(e.type, e.values) }));
  for (const e of encoded) if (e.count === null) e.count = e.bytes.length; // ASCII count includes the trailing NUL

  const headerSize = 8;
  const ifdCountSize = 2;
  const entrySize = 12;
  const ifdEntriesSize = encoded.length * entrySize;
  const nextIfdOffsetSize = 4;
  const dataStart = headerSize + ifdCountSize + ifdEntriesSize + nextIfdOffsetSize;

  // Assign each out-of-line value's absolute offset (inline values — total
  // size ≤4 bytes — stay in the entry itself, standard TIFF rule).
  let cursor = dataStart;
  const offsets = encoded.map((e) => {
    const inline = e.bytes.length <= 4;
    const off = inline ? null : cursor;
    if (!inline) cursor += e.bytes.length;
    return off;
  });
  const totalSize = cursor;

  const buf = Buffer.alloc(totalSize);
  buf.write('IIRC', 0, 'ascii'); // little-endian DCP magic (see tiffReader.ts's doc comment)
  buf.writeUInt32LE(headerSize, 4); // IFD0 offset

  buf.writeUInt16LE(encoded.length, headerSize);
  encoded.forEach((e, i) => {
    const eo = headerSize + ifdCountSize + i * entrySize;
    buf.writeUInt16LE(e.tag, eo);
    buf.writeUInt16LE(e.type, eo + 2);
    buf.writeUInt32LE(e.count, eo + 4);
    const off = offsets[i];
    if (off === null) {
      e.bytes.copy(buf, eo + 8);
    } else {
      buf.writeUInt32LE(off, eo + 8);
      e.bytes.copy(buf, off);
    }
  });
  buf.writeUInt32LE(0, headerSize + ifdCountSize + ifdEntriesSize); // next-IFD offset: none

  return buf;
}

/** The Stage-1 verify fixture's exact entry list — see this file's doc comment for the rationale behind every value. */
export function fixtureEntries() {
  const identity3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [
    entry(50708, ASCII, ['Silverbox Test Cam']), // UniqueCameraModel
    entry(50936, ASCII, ['Silverbox Test']), // ProfileName
    entry(50778, SHORT, [17]), // CalibrationIlluminant1 (StdA, 2856K)
    entry(50779, SHORT, [21]), // CalibrationIlluminant2 (D65, 6504K)
    entry(50721, SRATIONAL, identity3x3), // ColorMatrix1 (required; unused here — ForwardMatrix wins)
    entry(50964, SRATIONAL, identity3x3), // ForwardMatrix1
    entry(50965, SRATIONAL, identity3x3), // ForwardMatrix2
    entry(50937, LONG, [2, 2, 1]), // ProfileHueSatMapDims
    // ProfileHueSatMapData1/2: node (h=0,s=0) carries the test's real delta;
    // the other 3 nodes are unreached filler (identity: 0° hue, ×1 sat, ×1 val).
    entry(50938, FLOAT, [15, 1.1, 0.95, 0, 1, 1, 0, 1, 1, 0, 1, 1]),
    entry(50939, FLOAT, [25, 1.2, 0.9, 0, 1, 1, 0, 1, 1, 0, 1, 1]),
    entry(50981, LONG, [1, 1, 1]), // ProfileLookTableDims (single-cell)
    entry(50982, FLOAT, [-5, 1.0, 1.02]), // ProfileLookTableData
    entry(50940, FLOAT, [0, 0, 0.5, 0.6, 1, 1]), // ProfileToneCurve
    entry(51109, SRATIONAL, [0.25]), // BaselineExposureOffset
  ];
}

export function buildFixtureDcp() {
  return buildFixtureDcpBytes(fixtureEntries());
}

// --- malformed-file fixtures (verify-dcp.mjs's error-path checks) ----------

/** A well-formed TIFF/DNG (correct magic 42, NOT the DCP "RC" marker) — the "wrong file type" error path. */
export function buildPlainTiffBytes() {
  const buf = Buffer.alloc(16);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(0, 8); // 0 IFD entries — never parsed this far anyway (magic check throws first)
  return buf;
}

/** Truncated mid-IFD (entry count says 16 fields but the file ends immediately) — the "malformed structure" error path. */
export function buildTruncatedDcpBytes() {
  const buf = Buffer.alloc(12);
  buf.write('IIRC', 0, 'ascii');
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(16, 8); // claims 16 entries; file ends 2 bytes later
  return buf;
}

// CLI usage: node build-dcp-fixture.mjs [outPath] — writes the main fixture
// (the malformed variants are built in-memory by verify-dcp.mjs itself, no
// need for their own on-disk files).
if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = process.argv[2] ?? fileURLToPath(new URL('./silverbox-test.dcp', import.meta.url));
  writeFileSync(outPath, buildFixtureDcp());
  console.log(`wrote ${outPath}`);
}
