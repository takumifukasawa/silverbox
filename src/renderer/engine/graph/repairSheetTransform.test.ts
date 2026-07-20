/**
 * Unit tier (vitest) for the repair-sheet sensor↔anchor transform
 * (docs/brief-bank/linked-looks-stage-f.md semantic 3). Pins the coordinate
 * contract BOTH directions: round-trip identity, a synthetic 90° orientation
 * case (hand-computed), a readout-offset case, the outside-window drop, and
 * radius scaling.
 */
import { describe, it, expect } from 'vitest';
import {
  anchorPointToSensor,
  sensorPointToAnchor,
  anchorRadiusToSensor,
  sensorRadiusToAnchor,
  anchorSpotToSensor,
  sensorSpotToAnchor,
  type ReadoutWindow,
} from './repairSheetTransform';
import type { Spot } from './spotsNode';

// flip 0, no offset, square oriented frame.
const plain: ReadoutWindow = { originX: 0, originY: 0, orientedWidth: 1000, orientedHeight: 1000, flip: 0 };
// flip 0 WITH a readout offset (the APS-C-style window origin shift).
const offset: ReadoutWindow = { originX: 200, originY: 300, orientedWidth: 1000, orientedHeight: 1000, flip: 0 };
// flip 6 (90° CW): oriented portrait 800×1200 ⇒ pre-orientation raster 1200×800; offset (100,50).
const cw90: ReadoutWindow = { originX: 100, originY: 50, orientedWidth: 800, orientedHeight: 1200, flip: 6 };
// flip 5 (90° CCW): oriented portrait 800×1200, no offset.
const ccw90: ReadoutWindow = { originX: 0, originY: 0, orientedWidth: 800, orientedHeight: 1200, flip: 5 };
// flip 3 (180°).
const half: ReadoutWindow = { originX: 10, originY: 20, orientedWidth: 900, orientedHeight: 600, flip: 3 };

const spot = (dx: number, dy: number, sx: number, sy: number, radius: number, feather = 0.3): Spot => ({
  dx,
  dy,
  sx,
  sy,
  radius,
  feather,
});

describe('repairSheetTransform readout offset (flip 0)', () => {
  it('adds the readout origin, no rotation', () => {
    expect(anchorPointToSensor(0, 0, offset)).toEqual({ x: 200, y: 300 });
    expect(anchorPointToSensor(0.5, 0.5, offset)).toEqual({ x: 700, y: 800 });
    expect(sensorPointToAnchor(700, 800, offset)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('repairSheetTransform synthetic 90° CW (hand-computed)', () => {
  // sensor = (100 + 1200*ny, 850 − 800*nx) for cw90 — derived in the module doc.
  it('maps the frame corners exactly', () => {
    expect(anchorPointToSensor(0, 0, cw90)).toEqual({ x: 100, y: 850 });
    expect(anchorPointToSensor(1, 1, cw90)).toEqual({ x: 1300, y: 50 });
  });
  it('maps an interior point and inverts it', () => {
    const s = anchorPointToSensor(0.25, 0.5, cw90);
    expect(s).toEqual({ x: 700, y: 650 });
    const a = sensorPointToAnchor(s.x, s.y, cw90);
    expect(a.x).toBeCloseTo(0.25, 12);
    expect(a.y).toBeCloseTo(0.5, 12);
  });
});

describe('repairSheetTransform round-trip identity (all orientations)', () => {
  for (const [name, w] of [
    ['plain', plain],
    ['offset', offset],
    ['cw90', cw90],
    ['ccw90', ccw90],
    ['half', half],
  ] as const) {
    it(`anchor → sensor → anchor is identity for ${name}`, () => {
      for (const [nx, ny] of [
        [0.1, 0.2],
        [0.5, 0.5],
        [0.9, 0.75],
        [0.0, 1.0],
      ] as const) {
        const s = anchorPointToSensor(nx, ny, w);
        const back = sensorPointToAnchor(s.x, s.y, w);
        expect(back.x).toBeCloseTo(nx, 12);
        expect(back.y).toBeCloseTo(ny, 12);
      }
    });
  }
});

describe('repairSheetTransform radius scaling', () => {
  it('scales by the oriented max dim and inverts', () => {
    expect(anchorRadiusToSensor(0.1, cw90)).toBeCloseTo(120, 12); // max(800,1200)=1200
    expect(sensorRadiusToAnchor(120, cw90)).toBeCloseTo(0.1, 12);
    expect(anchorRadiusToSensor(0.05, plain)).toBeCloseTo(50, 12);
  });
});

describe('repairSheetTransform spot round-trip + outside-window drop', () => {
  it('a full spot survives create→apply on the same window (values preserved)', () => {
    const original = spot(0.25, 0.5, 0.3, 0.55, 0.08, 0.4);
    const sensorSpot = anchorSpotToSensor(original, cw90);
    const back = sensorSpotToAnchor(sensorSpot, cw90);
    expect(back).not.toBeNull();
    expect(back!.dx).toBeCloseTo(original.dx, 10);
    expect(back!.dy).toBeCloseTo(original.dy, 10);
    expect(back!.sx).toBeCloseTo(original.sx, 10);
    expect(back!.sy).toBeCloseTo(original.sy, 10);
    expect(back!.radius).toBeCloseTo(original.radius, 10);
    expect(back!.feather).toBeCloseTo(original.feather, 10);
  });

  it('drops a spot whose destination maps outside the target frame', () => {
    // A sensor destination at x = orientedWidth+200 (anchor nx = 1.2) is outside.
    const outside: import('./repairSheetTransform').SensorSpot = {
      dx: 1200,
      dy: 500,
      sx: 500,
      sy: 500,
      radius: 50,
      feather: 0.3,
    };
    expect(sensorSpotToAnchor(outside, plain)).toBeNull();
  });

  it('keeps a spot whose destination is in-frame even if its SOURCE is outside', () => {
    const s: import('./repairSheetTransform').SensorSpot = {
      dx: 500,
      dy: 500,
      sx: 1400,
      sy: 500,
      radius: 50,
      feather: 0.3,
    };
    const back = sensorSpotToAnchor(s, plain);
    expect(back).not.toBeNull();
    expect(back!.dx).toBeCloseTo(0.5, 10);
    expect(back!.sx).toBeCloseTo(1.4, 10); // off-canvas source retained (shader clamps)
  });
});
