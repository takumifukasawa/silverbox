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
 * Usage: external-transform.mjs <in.tiff> <out.tiff> [offset|--fail]
 *   offset  added to every sample, expressed in the SAME normalized [0,1]
 *           space externalTool.ts scales by (i.e. offset*255), clamped to
 *           the format's 0..255 range. Default 0.1.
 *   --fail  exit 1 immediately, writing nothing — the verify script's
 *           ANY-failure-⇒-passthrough-and-badge check.
 */
import sharp from 'sharp';

const [, , inPath, outPath, arg] = process.argv;

if (arg === '--fail') {
  console.error('external-transform: forced failure (--fail)');
  process.exit(1);
}

if (!inPath || !outPath) {
  console.error('usage: external-transform.mjs <in.tiff> <out.tiff> [offset|--fail]');
  process.exit(1);
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
