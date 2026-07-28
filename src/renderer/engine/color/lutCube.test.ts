/**
 * Unit tier (vitest) for the .cube LUT parser + CPU sampling math (LUT
 * import node, docs/brief-bank/lut-import-node.md). Hand-authored fixtures
 * (scripts/fixtures/lut-*.cube) keep the expected values checkable by hand —
 * see each fixture's own construction note below.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  applyCubeLutCpu,
  buildLutStripPixels,
  parseCubeLut,
  sampleLut1DLinear,
  sampleLut3DTrilinear,
  type CubeLut1D,
  type CubeLut3D,
} from './lutCube';

const IDENTITY_3D_PATH = 'scripts/fixtures/lut-identity-2x2x2.cube';
const SWAP_3D_PATH = 'scripts/fixtures/lut-swap-2x2x2.cube';
const TONE_1D_PATH = 'scripts/fixtures/lut-tone-1d.cube';

function readCube(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('parseCubeLut', () => {
  it('parses the 2x2x2 identity fixture into an exact 8-corner table', () => {
    const table = parseCubeLut(readCube(IDENTITY_3D_PATH));
    expect(table?.kind).toBe('3d');
    const t = table as CubeLut3D;
    expect(t.size).toBe(2);
    expect(Array.from(t.data)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
    ]);
  });

  it('parses the red/blue-swap 2x2x2 fixture (RED fastest, then GREEN, then BLUE row order)', () => {
    const table = parseCubeLut(readCube(SWAP_3D_PATH)) as CubeLut3D;
    expect(table.size).toBe(2);
    // row 1 is (r=1,g=0,b=0) — the swap fixture maps it to (b,g,r) = (0,0,1)
    expect(Array.from(table.data.slice(3, 6))).toEqual([0, 0, 1]);
  });

  it('parses the 1D tone fixture into 3 independent per-channel rows', () => {
    const table = parseCubeLut(readCube(TONE_1D_PATH));
    expect(table?.kind).toBe('1d');
    const t = table as CubeLut1D;
    expect(t.size).toBe(3);
    // Float32Array storage — compare with tolerance rather than exact
    // equality (0.2/0.6/0.9 aren't exactly representable in binary float32).
    const expected = [0, 0, 0, 0.2, 0.6, 0.9, 1, 1, 1];
    Array.from(t.data).forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6));
  });

  it('rejects malformed .cube files WITHOUT throwing (returns null)', () => {
    const cases = [
      'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n', // too few data rows for a declared 2^3 table
      'LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n0 0 0\n', // both sizes declared — ambiguous
      'TITLE "no size"\n0 0 0\n1 1 1\n', // no LUT_3D_SIZE/LUT_1D_SIZE at all
      'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + '0 0 0\n'.repeat(8), // non-default domain — v1 unsupported
      'LUT_1D_SIZE 2\n0 0 not-a-number\n1 1 1\n1 1 1\n', // a 3-token row that looks like data but isn't numeric
      'LUT_1D_SIZE 2\n0.1 0.2\n0 0 0\n1 1 1\n', // a digit-led line that looks like data but has the wrong token count
      '', // empty file
      'LUT_3D_SIZE not-a-number\n', // garbage size
    ];
    for (const src of cases) {
      expect(() => parseCubeLut(src)).not.toThrow();
      expect(parseCubeLut(src)).toBeNull();
    }
  });

  it('accepts a well-formed file with unrecognized keyword lines interspersed (forward-compat)', () => {
    const src = [
      'TITLE "extra keywords"',
      'LUT_3D_SIZE 2',
      'LUT_3D_INPUT_RANGE 0.0 1.0', // some tools emit this — must not fail the parse
      '0 0 0',
      '1 0 0',
      '0 1 0',
      '1 1 0',
      '0 0 1',
      '1 0 1',
      '0 1 1',
      '1 1 1',
      '',
    ].join('\n');
    expect(parseCubeLut(src)?.kind).toBe('3d');
  });
});

describe('sampleLut3DTrilinear', () => {
  it('is the identity function for the identity fixture at an arbitrary interior point', () => {
    const table = parseCubeLut(readCube(IDENTITY_3D_PATH)) as CubeLut3D;
    for (const p of [
      [0.25, 0.75, 1.0],
      [0.1, 0.9, 0.4],
      [0, 0, 0],
      [1, 1, 1],
    ] as const) {
      const [r, g, b] = sampleLut3DTrilinear(table, p[0], p[1], p[2]);
      expect(r).toBeCloseTo(p[0], 6);
      expect(g).toBeCloseTo(p[1], 6);
      expect(b).toBeCloseTo(p[2], 6);
    }
  });

  it('matches a hand-computed trilinear value for the red/blue-swap fixture', () => {
    // The swap fixture is an exact (r,g,b) -> (b,g,r) permutation, which is a
    // LINEAR map — a size-2 (single-cell) trilinear grid reproduces any
    // linear map EXACTLY at every point, not just the 8 corners. Hand
    // computation at (r,g,b) = (0.25, 0.75, 1.0): b=1.0 collapses the
    // interpolation onto the b=1 slice's 4 corners (n4..n7 in the .cube file
    // = (r,g,b) -> (b,g,r) triplets (1,0,0),(1,0,1),(1,1,0),(1,1,1)), bilinear
    // over (fr=0.25, fg=0.75):
    //   weights: (1-fr)(1-fg)=0.1875 [n4], fr(1-fg)=0.0625 [n5],
    //            (1-fr)fg=0.5625 [n6], fr*fg=0.1875 [n7]
    //   R = 1*(0.1875+0.0625+0.5625+0.1875) = 1.0
    //   G = 0*0.1875 + 0*0.0625 + 1*0.5625 + 1*0.1875 = 0.75
    //   B = 0*0.1875 + 1*0.0625 + 0*0.5625 + 1*0.1875 = 0.25
    // i.e. exactly (b,g,r) of the input, per the fixture's own construction.
    const table = parseCubeLut(readCube(SWAP_3D_PATH)) as CubeLut3D;
    const [r, g, b] = sampleLut3DTrilinear(table, 0.25, 0.75, 1.0);
    expect(r).toBeCloseTo(1.0, 6);
    expect(g).toBeCloseTo(0.75, 6);
    expect(b).toBeCloseTo(0.25, 6);
  });

  it('clamps out-of-range coordinates to [0,1] (the documented LUT-boundary limitation)', () => {
    const table = parseCubeLut(readCube(IDENTITY_3D_PATH)) as CubeLut3D;
    expect(sampleLut3DTrilinear(table, 1.5, -0.5, 2.0)).toEqual([1, 0, 1]);
  });
});

describe('sampleLut1DLinear', () => {
  it('matches a hand-computed per-channel linear value at a known midpoint', () => {
    // Fixture rows: 0.0 -> (0,0,0), 0.5 -> (0.2,0.6,0.9), 1.0 -> (1,1,1).
    // At input 0.25 (halfway between rows 0 and 1, frac 0.5 on each channel
    // since all three channels share the SAME input value here):
    //   out = row0 + 0.5*(row1-row0) = (0.1, 0.3, 0.45)
    // Float32Array storage (~7 significant digits) — 6 decimal places of
    // tolerance comfortably clears quantization noise while still catching
    // any real interpolation-math error (which would be off by orders of
    // magnitude more).
    const table = parseCubeLut(readCube(TONE_1D_PATH)) as CubeLut1D;
    const [r, g, b] = sampleLut1DLinear(table, 0.25, 0.25, 0.25);
    expect(r).toBeCloseTo(0.1, 6);
    expect(g).toBeCloseTo(0.3, 6);
    expect(b).toBeCloseTo(0.45, 6);
  });

  it('supports three INDEPENDENT channel inputs (not one joint RGB lookup)', () => {
    const table = parseCubeLut(readCube(TONE_1D_PATH)) as CubeLut1D;
    const [r, g, b] = sampleLut1DLinear(table, 0, 0.5, 1);
    expect(r).toBeCloseTo(0, 6);
    expect(g).toBeCloseTo(0.6, 6);
    expect(b).toBeCloseTo(1, 6);
  });
});

describe('buildLutStripPixels', () => {
  it('read matches write: the packed strip, manually trilinear-sampled with the SAME axis convention, reproduces sampleLut3DTrilinear', () => {
    const table = parseCubeLut(readCube(SWAP_3D_PATH)) as CubeLut3D;
    const { data, width, height } = buildLutStripPixels(table);
    expect(width).toBe(table.size * table.size);
    expect(height).toBe(table.size);
    // Manual trilinear over the packed strip — mirrors LUT3D_SHADER exactly
    // (tile index = BLUE, within-tile x = RED, within-tile y = GREEN).
    const sampleStrip = (r: number, g: number, b: number): [number, number, number] => {
      const n = table.size;
      const c = [r, g, b].map((v) => Math.min(Math.max(v, 0), 1) * (n - 1));
      const i0 = c.map((v) => Math.min(Math.floor(v), n - 2));
      const f = [c[0]! - i0[0]!, c[1]! - i0[1]!, c[2]! - i0[2]!];
      let out: [number, number, number] = [0, 0, 0];
      for (let dr = 0; dr < 2; dr++) {
        const wr = dr === 1 ? f[0]! : 1 - f[0]!;
        for (let dg = 0; dg < 2; dg++) {
          const wg = dg === 1 ? f[1]! : 1 - f[1]!;
          for (let db = 0; db < 2; db++) {
            const wb = db === 1 ? f[2]! : 1 - f[2]!;
            const ir = i0[0]! + dr;
            const ig = i0[1]! + dg;
            const ib = i0[2]! + db;
            const px = ib * n + ir;
            const idx = (ig * width + px) * 4;
            const w = wr * wg * wb;
            out = [out[0] + w * data[idx]!, out[1] + w * data[idx + 1]!, out[2] + w * data[idx + 2]!];
          }
        }
      }
      return out;
    };
    for (const p of [
      [0.25, 0.75, 1.0],
      [0.1, 0.9, 0.4],
    ] as const) {
      const viaStrip = sampleStrip(p[0], p[1], p[2]);
      const viaTable = sampleLut3DTrilinear(table, p[0], p[1], p[2]);
      expect(viaStrip[0]).toBeCloseTo(viaTable[0], 6);
      expect(viaStrip[1]).toBeCloseTo(viaTable[1], 6);
      expect(viaStrip[2]).toBeCloseTo(viaTable[2], 6);
    }
  });
});

describe('applyCubeLutCpu', () => {
  it('is an exact no-op for the identity 3D LUT at amount 1 (round-trip encode/sample/decode is clean)', () => {
    // Moderate, in-gamut working-space colors only: WORK_TO_SRGB has
    // negative off-diagonal terms, so a HIGHLY saturated/imbalanced working
    // color (e.g. very different R/G/B magnitudes) can legitimately land
    // outside [0,1] after the primaries matrix, hitting the documented
    // highlight-clip limitation on purpose (see the dedicated clip test
    // below) — this test is about the CLEAN round trip, so it stays away
    // from that edge.
    const table = parseCubeLut(readCube(IDENTITY_3D_PATH)) as CubeLut3D;
    for (const work of [
      [0.1, 0.1, 0.1],
      [0.5, 0.5, 0.5],
      [0.9, 0.9, 0.9],
      [0.3, 0.32, 0.28],
    ] as const) {
      const out = applyCubeLutCpu(table, 1, [work[0], work[1], work[2]]);
      expect(out[0]).toBeCloseTo(work[0], 5);
      expect(out[1]).toBeCloseTo(work[1], 5);
      expect(out[2]).toBeCloseTo(work[2], 5);
    }
  });

  it('is an exact no-op at amount 0 regardless of the table (identity mix)', () => {
    const table = parseCubeLut(readCube(SWAP_3D_PATH)) as CubeLut3D;
    const work: [number, number, number] = [0.2, 0.4, 0.8];
    expect(applyCubeLutCpu(table, 0, work)).toEqual(work);
  });

  it('clips a highly out-of-gamut working color at the LUT boundary (documented limitation)', () => {
    // [0.02, 0.9, 0.4] pushed through WORK_TO_SRGB lands negative on R
    // (linR = 1.6605*0.02 - 0.5876*0.9 - 0.0728*0.4 ≈ -0.525) — srgbEncode
    // clamps a non-positive linear input to 0, so the round trip through
    // even an IDENTITY LUT cannot recover the original value: this is the
    // brief's documented "clamp to [0,1] at the LUT boundary" highlight-
    // clip limitation, not a bug. Asserting the clip actually happens (R
    // lands near 0, not near the original 0.02) pins that behavior down.
    const table = parseCubeLut(readCube(IDENTITY_3D_PATH)) as CubeLut3D;
    const out = applyCubeLutCpu(table, 1, [0.02, 0.9, 0.4]);
    expect(out[0]).not.toBeCloseTo(0.02, 2);
  });
});
