/**
 * Decoder for an ACR/Lightroom XMP "Look" preset's embedded LookTable
 * (`crs:Table_<md5>`) — the format DNG calls a "big table" (per the DNG
 * spec's own `dng_big_table` concept). This is a REIMPLEMENTATION from
 * observed facts (byte-level structure recovered by decoding the user's own,
 * locally-installed "Adobe Color.xmp" and cross-checking every field against
 * its embedded MD5 fingerprint and the documented sample table entries — see
 * docs/research/lr-base-gap.md's round-2 addendum and data appendix) — NOT
 * transcribed from DNG SDK source, whose license is not MIT-compatible (the
 * brief's hard legal line). Nothing from any Adobe file is embedded in this
 * module or its tests; every fixture in scripts/fixtures/build-acrlook-
 * fixture.mjs is hand-authored with our own numbers.
 *
 * Format, outer to inner:
 *
 *  1. Base85 text (custom 85-char alphabet, NOT standard ASCII85/Z85 — see
 *     `ACR_BASE85_ALPHABET`): groups of 5 characters decode to one uint32
 *     with LITTLE-ENDIAN digit order — `value = d0 + d1*85 + d2*85² + d3*85³
 *     + d4*85⁴` (the reverse of standard ASCII85's big-endian digit order) —
 *     then the uint32 is written out LITTLE-ENDIAN as 4 bytes. A trailing
 *     partial group of 4/3/2 characters is padded with the alphabet's LAST
 *     character (index 84) up to 5, decoded the same way, and only the LOW
 *     3/2/1 bytes are kept (the standard ASCII85-family partial-group
 *     convention). A trailing group of length 1 is invalid (a single base85
 *     digit cannot encode a whole byte).
 *  2. The decoded byte stream starts with a 4-byte LE uint32 — the
 *     UNCOMPRESSED size of what follows (a redundant integrity check, not
 *     needed to decode; verified when present).
 *  3. The remaining bytes are a standard zlib (RFC 1950) stream — decoded
 *     here via the platform `DecompressionStream('deflate')` (native in both
 *     Chromium/Electron and Node ≥18; the 'deflate' format name is the
 *     zlib-WRAPPED one, matching this stream's own 0x78 0x9C header — see
 *     `inflateZlib`'s doc comment).
 *  4. The inflated bytes are the DNG "big table" stream itself: 5×uint32 LE
 *     (`btt` tag [observed 0 — no distinguishing use made of it here],
 *     `version`, `hueDivisions`, `satDivisions`, `valDivisions`), then
 *     `hueDivisions × satDivisions × valDivisions` entries of 3×float32 LE
 *     (HueShift°, SatScale, ValScale) in NATIVE order `index = (v ×
 *     hueDivisions + h) × satDivisions + s` (s fastest, then h, then v —
 *     DIFFERENT from this codebase's own `HueSatTable.data` convention,
 *     h-major/s/v-minor — `parseAcrLookStream` below reorders on the way in,
 *     once, so every consumer downstream uses the ONE existing convention
 *     `pipeline.ts`'s `lookupTable` already implements), then a trailing
 *     uint32 LE `encoding` tag (0 = Linear, matching
 *     `ProfileHueSatMapEncoding`/`ProfileLookTableEncoding`'s own 0=linear/
 *     1=sRGB convention in parser.ts — reused verbatim, not reinvented).
 *
 * Empirical verification performed while writing this module (not committed
 * — no Adobe bytes in the repo, per the brief): decoding the user's local
 * "Adobe Color.xmp" through every step above reproduces (a) the file's own
 * `crs:LookTable="<md5>"` value exactly as MD5(inflated stream bytes), (b)
 * `hueDivisions=36, satDivisions=16, valDivisions=16` (36×16×16, matching the
 * project memory's recorded dims), (c) the exact sample entries recorded in
 * docs/research/lr-base-gap.md's data appendix (h=0/3/6/21/33 @ v=8,s=15),
 * and (d) `crs:ToneCurvePV2012` as the exact points documented in the brief.
 * This module's own decode of a fresh read of that same local file is what
 * scripts/verify-acrlook.mjs's optional fingerprint check re-runs at verify
 * time (skipped gracefully when the file isn't present on the machine).
 */
import type { HueSatTable } from './parser';

/**
 * The custom 85-character alphabet this format uses — NOT standard ASCII85
 * (which uses '!'..'u') and NOT Z85 (which uses a different character set
 * entirely). Order matters: index IS the digit value. 85 characters exactly.
 */
export const ACR_BASE85_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?' + '`' + "'|()[]{}@%$#";

const DIGIT_VALUE = new Map<string, number>(Array.from(ACR_BASE85_ALPHABET).map((ch, i) => [ch, i]));

/**
 * Decode one base85 text blob (this module's custom alphabet + LE digit
 * order — see this file's doc comment) to raw bytes. Throws on an unknown
 * character or a trailing group of length 1 (undecodable — see the format
 * doc comment).
 */
export function decodeBase85(text: string): Uint8Array {
  const out: number[] = [];
  const padChar = ACR_BASE85_ALPHABET[84]!;
  for (let i = 0; i < text.length; i += 5) {
    const chunk = text.slice(i, i + 5);
    const chunkLen = chunk.length;
    if (chunkLen === 1) throw new Error(`decodeBase85: a trailing group of exactly 1 character is invalid (at offset ${i})`);
    const padded = chunkLen < 5 ? chunk + padChar.repeat(5 - chunkLen) : chunk;
    let value = 0;
    let mult = 1;
    for (const ch of padded) {
      const d = DIGIT_VALUE.get(ch);
      if (d === undefined) throw new Error(`decodeBase85: character ${JSON.stringify(ch)} is not in the alphabet (at offset ${i})`);
      value += d * mult; // LITTLE-ENDIAN digit order (first char = least significant)
      mult *= 85;
    }
    const nBytes = chunkLen < 5 ? chunkLen - 1 : 4;
    for (let k = 0; k < nBytes; k++) out.push(Math.floor(value / 256 ** k) % 256);
  }
  return new Uint8Array(out);
}

/**
 * Inflate a zlib (RFC 1950, 2-byte-header-wrapped) DEFLATE stream via the
 * platform `DecompressionStream` — a native Web Streams API available in
 * both Electron's Chromium renderer and Node ≥18 (stable in the Node 22 this
 * project's verify scripts already target — see verify-dcp.mjs's esbuild
 * `target: 'node22'`), so the exact same code path runs in the app and in
 * scripts/verify-acrlook.mjs without any bundler shim or third-party zlib
 * dependency. `'deflate'` (not `'deflate-raw'`) names the zlib-WRAPPED
 * format, matching this stream's observed 0x78 0x9C header.
 */
export async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export interface AcrLookTable {
  hueDivisions: number;
  satDivisions: number;
  valDivisions: number;
  /** Reordered into this codebase's own HueSatTable convention (h-major/s/v-minor) — see this file's doc comment. */
  table: HueSatTable;
  encoding: 'linear' | 'sRGB';
  /** The raw inflated DNG-stream bytes (pre-parse) — exposed only so verify-acrlook.mjs can compute MD5(payload) and compare it against the XMP's own `crs:LookTable` value; production code never needs it. */
  payload: Uint8Array;
}

/** Parse the INFLATED DNG big-table stream (post base85+zlib) — see this file's doc comment, step 4. */
export function parseAcrLookStream(bytes: Uint8Array): AcrLookTable {
  if (bytes.length < 24) throw new Error(`parseAcrLookStream: stream too short (${bytes.length} bytes, need at least 24)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // btt (offset 0) is read but not otherwise validated — its meaning beyond
  // "observed 0 on the one real table decoded while writing this" is unknown
  // and not load-bearing for the math below.
  const version = view.getUint32(4, true);
  const hueDivisions = view.getUint32(8, true);
  const satDivisions = view.getUint32(12, true);
  const valDivisions = view.getUint32(16, true);
  if (hueDivisions < 1 || satDivisions < 1 || valDivisions < 1) {
    throw new Error(`parseAcrLookStream: non-positive division count (${hueDivisions}, ${satDivisions}, ${valDivisions})`);
  }
  const nEntries = hueDivisions * satDivisions * valDivisions;
  const HEADER_BYTES = 20; // 5 × uint32
  const TRAILER_BYTES = 4; // 1 × uint32 (encoding)
  const expectedLen = HEADER_BYTES + nEntries * 3 * 4 + TRAILER_BYTES;
  if (bytes.length !== expectedLen) {
    throw new Error(`parseAcrLookStream: stream length ${bytes.length} doesn't match header-declared ${expectedLen} (${hueDivisions}×${satDivisions}×${valDivisions})`);
  }
  // Reorder native (v-major, h-mid, s-minor: index = (v*H + h)*S + s) into
  // this codebase's HueSatTable convention (h-major, s-mid, v-minor: index =
  // ((h*S + s)*V + v)*3) — see pipeline.ts's `lookupTable`, which every
  // consumer (DCP mode's own HueSatMap/LookTable, and this table) shares.
  const data = new Float32Array(hueDivisions * satDivisions * valDivisions * 3);
  for (let h = 0; h < hueDivisions; h++) {
    for (let s = 0; s < satDivisions; s++) {
      for (let v = 0; v < valDivisions; v++) {
        const nativeIdx = (v * hueDivisions + h) * satDivisions + s;
        const srcOff = HEADER_BYTES + nativeIdx * 12;
        const dstBase = ((h * satDivisions + s) * valDivisions + v) * 3;
        data[dstBase] = view.getFloat32(srcOff, true);
        data[dstBase + 1] = view.getFloat32(srcOff + 4, true);
        data[dstBase + 2] = view.getFloat32(srcOff + 8, true);
      }
    }
  }
  const encodingCode = view.getUint32(HEADER_BYTES + nEntries * 3 * 4, true);
  if (encodingCode !== 0 && encodingCode !== 1) {
    throw new Error(`parseAcrLookStream: unknown encoding code ${encodingCode} (expected 0=linear or 1=sRGB)`);
  }
  void version; // parsed for completeness/forward-compat; no version-specific branching needed for what this decoder reads
  return {
    hueDivisions,
    satDivisions,
    valDivisions,
    table: { dims: [hueDivisions, satDivisions, valDivisions], data },
    encoding: encodingCode === 1 ? 'sRGB' : 'linear',
    payload: bytes,
  };
}

/**
 * Top-level decode: an ACR XMP Look preset's `crs:Table_<md5>` ATTRIBUTE
 * VALUE (the base85 text) → a usable HueSatTable. See this file's doc
 * comment for the full byte-level pipeline and its empirical verification.
 */
export async function decodeAcrLookTable(base85Text: string): Promise<AcrLookTable> {
  const raw = decodeBase85(base85Text);
  if (raw.length < 4) throw new Error(`decodeAcrLookTable: decoded byte stream too short (${raw.length} bytes, need at least 4)`);
  const declaredSize = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
  const compressed = raw.subarray(4);
  const inflated = await inflateZlib(compressed);
  if (inflated.length !== declaredSize) {
    throw new Error(`decodeAcrLookTable: inflated length ${inflated.length} doesn't match the declared uncompressed size ${declaredSize}`);
  }
  return parseAcrLookStream(inflated);
}
