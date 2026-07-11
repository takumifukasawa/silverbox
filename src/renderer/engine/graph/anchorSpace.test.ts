/**
 * Unit tier (vitest) for the anchor↔output coordinate conversion (UX pack C
 * §1). Pins the identity-geometry invariant (bit-exact pass-through), a
 * hand-computed rotated+cropped case, and round-trip inversion.
 */
import { describe, it, expect } from 'vitest';
import {
  anchorToOutput,
  outputToAnchor,
  anchorRadiusToOutput,
  outputRadiusToAnchor,
} from './anchorSpace';
import type { GeometryParams } from './graphDoc';

const identity: GeometryParams = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  angle: 0,
  orientation: { quarterTurns: 0, flipH: false },
};

// angle 10°, cropped to [0.1..0.9]×[0.1..0.7]; oriented frame 1000×800.
const rotated: GeometryParams = {
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
  angle: 10,
  orientation: { quarterTurns: 0, flipH: false },
};
const OW = 1000;
const OH = 800;

describe('anchorSpace identity invariant', () => {
  it('is the exact identity map when geometry is untouched', () => {
    for (const [x, y] of [
      [0, 0],
      [0.3, 0.7],
      [1, 1],
    ] as const) {
      expect(anchorToOutput(x, y, identity, OW, OH)).toEqual({ x, y });
      expect(outputToAnchor(x, y, identity, OW, OH)).toEqual({ x, y });
    }
    expect(anchorRadiusToOutput(0.25, identity, OW, OH)).toBe(0.25);
    expect(outputRadiusToAnchor(0.25, identity, OW, OH)).toBe(0.25);
  });

  it('is the identity for orientation-only geometry (full crop, zero angle)', () => {
    // a 90° turn swaps the oriented dims the caller passes, but with a full
    // crop and no straighten a point does not move within its oriented frame.
    const orient: GeometryParams = { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, orientation: { quarterTurns: 1, flipH: true } };
    expect(anchorToOutput(0.3, 0.7, orient, OH, OW)).toEqual({ x: 0.3, y: 0.7 });
    expect(anchorRadiusToOutput(0.2, orient, OH, OW)).toBe(0.2);
  });
});

describe('anchorSpace rotated + cropped', () => {
  it('maps the image center into the cropped output frame (hand-computed)', () => {
    // center (0.5,0.5) is the rotation pivot ⇒ unmoved by angle; it lands at
    // ((0.5−0.1)/0.8, (0.5−0.1)/0.6) = (0.5, 0.6666…) in the cropped frame.
    const c = anchorToOutput(0.5, 0.5, rotated, OW, OH);
    expect(c.x).toBeCloseTo(0.5, 10);
    expect(c.y).toBeCloseTo(2 / 3, 10);
  });

  it('matches a hand-computed off-center point', () => {
    // a=(0.75,0.5): v=(250,0) px; rot(v,+10°)=(246.2019…, −43.4120…);
    // pos=v'+(500,400)−(100,80)=(646.2019…, 276.5880…); ÷(800,480).
    const p = anchorToOutput(0.75, 0.5, rotated, OW, OH);
    expect(p.x).toBeCloseTo(0.80775194, 6);
    expect(p.y).toBeCloseTo(0.57622492, 6);
  });

  it('round-trips output→anchor→output for arbitrary points', () => {
    for (const [x, y] of [
      [0.2, 0.3],
      [0.9, 0.1],
      [0.55, 0.8],
    ] as const) {
      const a = outputToAnchor(x, y, rotated, OW, OH);
      const back = anchorToOutput(a.x, a.y, rotated, OW, OH);
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
    }
  });

  it('converts radius by the max-dim ratio and inverts', () => {
    // anchorMax=1000, outputMax=max(800,480)=800 ⇒ ×1000/800 = 1.25
    expect(anchorRadiusToOutput(0.1, rotated, OW, OH)).toBeCloseTo(0.125, 10);
    expect(outputRadiusToAnchor(0.125, rotated, OW, OH)).toBeCloseTo(0.1, 10);
  });
});
