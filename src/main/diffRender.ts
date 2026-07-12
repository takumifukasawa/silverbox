/**
 * Sidecar visual diff CLI's ΔE half (`--diff <sidecarA> <sidecarB> --image
 * <arw>` — git-native completion brief §1, main/diffRender.ts). The
 * renderer's job is producing both docs' full-resolution rendered pixels
 * (renderToPixels, same as any CLI render — see appStore.ts's runCliDiff);
 * this module does the rest: resize each render to the SAME fixed long edge
 * goldenRender.ts's golden PNGs use (GOLDEN_LONG_EDGE — "the golden-render ΔE
 * stats" the brief asks for, reusing that exact convention rather than
 * inventing a second resize constant), then per-pixel CIE76 ΔE via
 * shared/color/deltaE.ts.
 *
 * Unlike goldenRender.ts there is no PNG file to write/read — both sides are
 * transient renders that only ever exist for this one comparison, so this
 * skips straight from raw pixels to the resize (sharp can resize directly
 * off a raw RGBA buffer, same as renderGoldenPng's own first step).
 */
import sharp from 'sharp';
import { compareSrgbBuffers } from '../../shared/color/deltaE';
import { GOLDEN_LONG_EDGE, type CliDiffImageRequest, type CliDiffImageResult } from '../../shared/ipc';

/** Resize one full-res RGBA8 render down to the golden long edge and decode back to raw RGB8 — same pipeline renderGoldenPng/checkGoldenImage already use, just without the PNG round-trip (nothing here is ever written to disk). */
async function toResizedRgb8(
  data: ArrayBuffer,
  width: number,
  height: number
): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  let img = sharp(Buffer.from(data), { raw: { width, height, channels: 4 }, limitInputPixels: false }).removeAlpha();
  if (GOLDEN_LONG_EDGE < Math.max(width, height)) {
    img = img.resize({ width: GOLDEN_LONG_EDGE, height: GOLDEN_LONG_EDGE, fit: 'inside', withoutEnlargement: true });
  }
  const { data: buf, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data: buf, width: info.width, height: info.height, channels: info.channels };
}

export async function diffRenderImages(req: CliDiffImageRequest): Promise<CliDiffImageResult> {
  const expected = req.width * req.height * 4;
  if (req.dataA.byteLength !== expected || req.dataB.byteLength !== expected) {
    throw new Error(`diffRenderImages: pixel buffer size mismatch (expected ${expected} bytes at ${req.width}x${req.height})`);
  }
  const [a, b] = await Promise.all([
    toResizedRgb8(req.dataA, req.width, req.height),
    toResizedRgb8(req.dataB, req.width, req.height),
  ]);
  // Both inputs share width/height (the caller's contract — see
  // CliDiffImageRequest's doc comment), so the SAME resize target dims apply
  // to both; a's dims stand in for the pair.
  const deltaE = compareSrgbBuffers(a.data, b.data, a.width, a.height, a.channels);
  return { deltaE };
}
