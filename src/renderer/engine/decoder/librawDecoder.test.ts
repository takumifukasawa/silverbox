/**
 * Unit tier (vitest) for computeCropbox — the pure part of the round-11
 * decode-frame fix (see librawDecoder.ts's doc comment). Exercises it
 * against the REAL raw_inset_crops/iwidth/iheight values measured for both
 * validation photos (scratchpad NCC alignment against the camera JPEG), plus
 * the invalid-input cases that must fall back to "no crop" (preserving
 * exact back-compat for RAW files libraw doesn't expose a crop for).
 */
import { describe, it, expect } from 'vitest';
import type { Metadata as LibRawMetadata } from 'libraw-wasm';
import { computeCropbox } from './librawDecoder';

/** Build a minimal metadata fixture — computeCropbox only reads these three fields. */
function meta(partial: Pick<LibRawMetadata, 'raw_inset_crops' | 'iwidth' | 'iheight'>): LibRawMetadata {
  return partial as LibRawMetadata;
}

describe('computeCropbox', () => {
  it('returns null when raw_inset_crops is absent (non-Sony / older firmware)', () => {
    expect(computeCropbox(meta({ iwidth: 4624, iheight: 3080 }))).toBeNull();
  });

  it('returns null when raw_inset_crops is an empty array', () => {
    expect(computeCropbox(meta({ raw_inset_crops: [], iwidth: 4624, iheight: 3080 }))).toBeNull();
  });

  it('returns null for the 0xFFFF sentinel (unused slot)', () => {
    const crops = [{ cleft: 65535, ctop: 65535, cwidth: 0, cheight: 0 }];
    expect(computeCropbox(meta({ raw_inset_crops: crops, iwidth: 4624, iheight: 3080 }))).toBeNull();
  });

  it('returns null when cwidth/cheight is zero', () => {
    const crops = [{ cleft: 0, ctop: 0, cwidth: 0, cheight: 100 }];
    expect(computeCropbox(meta({ raw_inset_crops: crops, iwidth: 4624, iheight: 3080 }))).toBeNull();
  });

  it('returns null when cleft/ctop is at or past iwidth/iheight', () => {
    const crops = [{ cleft: 4624, ctop: 0, cwidth: 100, cheight: 100 }];
    expect(computeCropbox(meta({ raw_inset_crops: crops, iwidth: 4624, iheight: 3080 }))).toBeNull();
  });

  it('passes the crop through unchanged when it fits within iwidth/iheight (DSC03298: exact camera-dims match)', () => {
    // Real values measured for test-assets/italy/DSC03298.ARW (portrait,
    // flip=6): cleft+cwidth=7020 <= iwidth=7028, ctop+cheight=4680 <=
    // iheight=4688 — fits with margin, no clamping needed. Post-rotation
    // this crop lands on 4672×7008, an EXACT match to the camera JPEG.
    const crops = [{ cleft: 12, ctop: 8, cwidth: 7008, cheight: 4672 }];
    const result = computeCropbox(meta({ raw_inset_crops: crops, iwidth: 7028, iheight: 4688 }));
    expect(result).toEqual([12, 8, 7008, 4672]);
  });

  it('clamps cwidth/cheight to iwidth/iheight when the recommended crop overflows (DSC02993: a real libraw-wasm limit)', () => {
    // Real values measured for test-assets/test.ARW (landscape, flip=0):
    // cleft+cwidth=4652 > iwidth=4624 by 28px, ctop+cheight=3102 > iheight=3080
    // by 22px — libraw's own internal "active area" is a few pixels short of
    // the crop it reports (verified: those pixels aren't recoverable through
    // imageData(), rawImageData(), or a full-raw-frame cropbox request
    // either — see librawDecoder.ts's computeCropbox doc comment). The
    // origin (cleft/ctop) stays exact; only the extent is clamped.
    const crops = [{ cleft: 44, ctop: 30, cwidth: 4608, cheight: 3072 }];
    const result = computeCropbox(meta({ raw_inset_crops: crops, iwidth: 4624, iheight: 3080 }));
    expect(result).toEqual([44, 30, 4580, 3050]);
  });

  it('returns null when iwidth/iheight themselves are missing or zero', () => {
    const crops = [{ cleft: 12, ctop: 8, cwidth: 7008, cheight: 4672 }];
    expect(computeCropbox(meta({ raw_inset_crops: crops, iwidth: 0, iheight: 4688 }))).toBeNull();
  });

  it('ignores a negative cleft/ctop (malformed data) rather than producing an invalid cropbox', () => {
    const crops = [{ cleft: -1, ctop: 8, cwidth: 7008, cheight: 4672 }];
    expect(computeCropbox(meta({ raw_inset_crops: crops, iwidth: 7028, iheight: 4688 }))).toBeNull();
  });
});
