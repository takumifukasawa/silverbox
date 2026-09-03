#!/usr/bin/env node
/**
 * Generator for the "Adobe Color (local)" verify fixture (scripts/verify-
 * acrlook.mjs, stage base-2 fix ②, docs/research/lr-base-gap.md). Hand-rolls
 * a SYNTHETIC ACR-Look-preset table directly against the byte format
 * src/renderer/engine/color/dcp/bigTable.ts documents (custom base85 +
 * zlib + a small DNG-stream header/entries/trailer) — no library beyond
 * Node's built-in `zlib`, same "hand-roll the exact bytes" precedent as
 * build-dcp-fixture.mjs. Every value below is OURS: tiny, synthetic,
 * invented for this test — zero Adobe content, the brief's hard legal line
 * (never commit Adobe table data; this fixture proves the CODEC, not any
 * particular look).
 */
import zlib from 'node:zlib';

// --- base85 encoder (own alphabet — see bigTable.ts's doc comment) ---------
export const ACR_BASE85_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?' + '`' + "'|()[]{}@%$#";

/**
 * Inverse of decodeBase85 (bigTable.ts): groups of 4 bytes → 5 base85
 * digits, LITTLE-ENDIAN digit order. A trailing partial group of nBytes
 * (1..3) bytes needs care: the decoder pads a short GROUP of (nBytes+1)
 * characters with the alphabet's LAST character (index 84) up to 5 before
 * computing the full 32-bit value, so encoding must choose digits that
 * ACCOUNT for that fixed padding contribution — solved via a modular
 * congruence (BigInt, exact) rather than assumed to be "the low digits of
 * the zero-padded value" (which is wrong — the padding digits' weight
 * bleeds into the low bytes on decode; verified against the production
 * decoder before this fixture builder was trusted).
 */
export function encodeBase85(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.slice(i, i + 4);
    const nBytes = chunk.length;
    let value = 0n;
    for (let k = 0; k < nBytes; k++) value += BigInt(chunk[k]) * 256n ** BigInt(k);
    let chunkLen;
    let myValue;
    if (nBytes === 4) {
      chunkLen = 5;
      myValue = value;
    } else {
      chunkLen = nBytes + 1;
      let contribution = 0n;
      let weight = 85n ** BigInt(chunkLen);
      for (let p = chunkLen; p < 5; p++) {
        contribution += 84n * weight;
        weight *= 85n;
      }
      const modulus = 256n ** BigInt(nBytes);
      let chosen = (value - contribution) % modulus;
      if (chosen < 0n) chosen += modulus;
      myValue = chosen;
    }
    let v = myValue;
    for (let d = 0; d < chunkLen; d++) {
      out += ACR_BASE85_ALPHABET[Number(v % 85n)];
      v /= 85n;
    }
  }
  return out;
}

/**
 * Build the RAW (post-inflate) DNG big-table stream — see bigTable.ts's doc
 * comment for the exact layout. `entries` is indexed in OUR OWN test's
 * choice of iteration order below (h outer, s mid, v inner) but WRITTEN in
 * the format's NATIVE order (index = (v*H + h)*S + s) — exercising the
 * exact reorder bigTable.ts's `parseAcrLookStream` performs.
 */
function buildAcrLookStream({ hueDivisions, satDivisions, valDivisions, entryAt, encoding }) {
  const nEntries = hueDivisions * satDivisions * valDivisions;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0, 0); // btt
  header.writeUInt32LE(1, 4); // version
  header.writeUInt32LE(hueDivisions, 8);
  header.writeUInt32LE(satDivisions, 12);
  header.writeUInt32LE(valDivisions, 16);
  const data = Buffer.alloc(nEntries * 12);
  for (let h = 0; h < hueDivisions; h++) {
    for (let s = 0; s < satDivisions; s++) {
      for (let v = 0; v < valDivisions; v++) {
        const nativeIdx = (v * hueDivisions + h) * satDivisions + s;
        const [hue, sat, val] = entryAt(h, s, v);
        data.writeFloatLE(hue, nativeIdx * 12);
        data.writeFloatLE(sat, nativeIdx * 12 + 4);
        data.writeFloatLE(val, nativeIdx * 12 + 8);
      }
    }
  }
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(encoding === 'sRGB' ? 1 : 0, 0);
  return Buffer.concat([header, data, trailer]);
}

/**
 * Full pipeline: our own small (hueDivisions × satDivisions × valDivisions)
 * table → inflated DNG stream → zlib-deflate → 4-byte LE size prefix →
 * base85 text (`crs:Table_<md5>`'s attribute-value shape). Returns both the
 * base85 text AND the raw inflated `payload` bytes (so the test can compute
 * its own MD5 / compare decoded values against what it asked for).
 */
export function buildAcrLookFixtureBase85({
  hueDivisions = 3,
  satDivisions = 2,
  valDivisions = 2,
  encoding = 'linear',
  entryAt = (h, s, v) => [h * 10 - 5 + s, 0.9 + 0.05 * s, 0.8 + 0.05 * v], // OUR OWN synthetic formula, nothing Adobe
} = {}) {
  const payload = buildAcrLookStream({ hueDivisions, satDivisions, valDivisions, entryAt, encoding });
  const compressed = zlib.deflateSync(payload);
  const sizeHeader = Buffer.alloc(4);
  sizeHeader.writeUInt32LE(payload.length, 0);
  const raw = Buffer.concat([sizeHeader, compressed]);
  const base85 = encodeBase85(new Uint8Array(raw));
  return { base85, payload: new Uint8Array(payload), hueDivisions, satDivisions, valDivisions, encoding, entryAt };
}

/** A tiny synthetic XMP snippet with the exact `crs:*` fields localAdobeProfile.ts's `parseAcrLookXmp` reads — own data, not a real Adobe file. */
export function buildAcrLookFixtureXmp({ base85, md5 = 'AA'.repeat(16), cameraProfile = 'Adobe Standard', curvePoints = [[0, 0], [64, 80], [192, 210], [255, 255]] }) {
  const li = curvePoints.map(([x, y]) => `     <rdf:li>${x}, ${y}</rdf:li>`).join('\n');
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Look"
   crs:CameraProfile="${cameraProfile}"
   crs:LookTable="${md5}"
   crs:Table_${md5}="${base85}">
   <crs:ToneCurvePV2012>
    <rdf:Seq>
${li}
    </rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}
