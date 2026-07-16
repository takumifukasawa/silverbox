/**
 * Golden-render check/update (ROADMAP "Golden renders", `silverbox-render
 * --check`/`--update` — main/goldenRender.ts) — main-process side.
 *
 * The renderer's job is producing full-resolution display-encoded RGBA8
 * pixels (exactly what exportOnePath already produces for a normal export —
 * see appStore.ts's runCliCheck); this module does everything else:
 *  - resize to the golden's fixed long edge (GOLDEN_LONG_EDGE) through the
 *    same sharp resize the export pipeline uses (imageExport.ts's
 *    buildPipeline), so a golden is byte-for-byte "what --render would have
 *    written, at 512px" — no separate resize implementation to drift from
 *    the real one;
 *  - encode to PNG (a real, viewable, git-diffable file — sRGB ICC profile
 *    attached for correctness, no EXIF: goldens must be deterministic, and a
 *    timestamp/serial baked into the PNG would make every re-render "differ"
 *    for a reason that has nothing to do with the pixels);
 *  - `--update`: write it to `<image>.silverbox.golden.png`;
 *  - `--check`: decode the existing golden + the freshly rendered PNG back
 *    to raw RGB8 via sharp and compare (dimensions first — a mismatch is
 *    reported as `dims-changed`, never resampled to force a comparison; then
 *    per-pixel CIE76 ΔE via shared/color/deltaE.ts).
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compareSrgbBuffers } from '../../shared/color/deltaE';
import { GOLDEN_LONG_EDGE, GOLDEN_SUFFIX, type CliCheckImageRequest, type CliCheckOutcome } from '../../shared/ipc';

/**
 * p95 gets 3x the mean threshold's headroom: the mean alone would let a
 * small but real localized regression (a corner, a clipped highlight) hide
 * under a good average, while a bare p95 at 1x threshold would fail a render
 * over a handful of naturally noisy pixels (dithering, a single-pixel edge)
 * that never add up to a visible difference. 3x is a documented calibration
 * constant, not derived from anything — the brief's own "document" ask.
 */
const P95_THRESHOLD_MULTIPLIER = 3;

/** `req.goldenPath` (--project's relocation, CliCheckImageRequest's doc comment) wins over the legacy `<image>.silverbox.golden.png` derivation. */
function goldenPathFor(req: CliCheckImageRequest): string {
  return req.goldenPath ?? `${req.input}${GOLDEN_SUFFIX}`;
}

/** Resize `data` (full-res RGBA8) to the golden's fixed long edge and encode as PNG — the export pipeline's own resize, reused. */
async function renderGoldenPng(data: ArrayBuffer, width: number, height: number): Promise<Buffer> {
  let img = sharp(Buffer.from(data), { raw: { width, height, channels: 4 }, limitInputPixels: false }).removeAlpha();
  if (GOLDEN_LONG_EDGE < Math.max(width, height)) {
    img = img.resize({ width: GOLDEN_LONG_EDGE, height: GOLDEN_LONG_EDGE, fit: 'inside', withoutEnlargement: true });
  }
  return img.png().withIccProfile('srgb').toBuffer();
}

export async function checkGoldenImage(req: CliCheckImageRequest): Promise<CliCheckOutcome> {
  const expected = req.width * req.height * 4;
  if (req.data.byteLength !== expected) {
    throw new Error(`checkGoldenImage: pixel buffer is ${req.data.byteLength} bytes, expected ${expected}`);
  }
  const pngBuffer = await renderGoldenPng(req.data, req.width, req.height);
  const goldenPath = goldenPathFor(req);

  if (req.update) {
    // `<projectDir>/golden/` may not exist yet (first --check --update
    // --project run) — creating it is fine, it's inside the project, not a
    // photo folder (the legacy adjacent path's directory always already
    // exists, so this mkdir is a harmless no-op there).
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, pngBuffer);
    return { input: req.input, status: 'updated' };
  }

  if (!existsSync(goldenPath)) {
    // A check run must never silently skip an unprotected photo — missing
    // golden counts as a FAILURE (see cliArgs.ts/index.ts's exit-code logic).
    return { input: req.input, status: 'no-golden' };
  }

  const [current, golden] = await Promise.all([
    sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true }),
    sharp(await readFile(goldenPath))
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  if (current.info.width !== golden.info.width || current.info.height !== golden.info.height) {
    // The image's aspect ratio changed since the golden was made (a crop
    // edit) — that IS look drift by definition, so this is a FAIL, not a
    // resample-and-compare.
    return { input: req.input, status: 'dims-changed' };
  }

  const deltaE = compareSrgbBuffers(current.data, golden.data, current.info.width, current.info.height, current.info.channels);
  const pass = deltaE.mean <= req.threshold && deltaE.p95 <= P95_THRESHOLD_MULTIPLIER * req.threshold;
  return { input: req.input, deltaE, pass };
}
