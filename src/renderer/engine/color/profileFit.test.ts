import { describe, expect, it } from 'vitest';
import {
  applyProfileCpu,
  packProfileLattice,
  profileResidual,
  PROFILE_LATTICE_N,
  A7C2_PROFILE,
  profileForModel,
  DEFAULT_PROFILE,
} from './profileFit';

const N = PROFILE_LATTICE_N;
const nodes = N * N * N;

/** flat index of node (ix,iy,iz), channel c. */
const idx = (ix: number, iy: number, iz: number, c: number) => (((ix * N + iy) * N + iz) * 3 + c);

/** a zero (identity) residual lattice. */
function zeroLattice(): number[] {
  return new Array(nodes * 3).fill(0);
}

describe('profileFit trilinear mirror', () => {
  it('identity lattice is a bit-exact no-op at any amount', () => {
    const lat = zeroLattice();
    for (const amount of [0, 37, 50, 100]) {
      for (const px of [
        [0, 0, 0],
        [0.3, 0.6, 0.9],
        [1, 1, 1],
        [0.123, 0.456, 0.789],
      ] as [number, number, number][]) {
        expect(applyProfileCpu(lat, px, amount)).toEqual(px);
      }
    }
  });

  it('reads a node residual exactly at that node coordinate', () => {
    const lat = zeroLattice();
    // put a distinct residual on an interior node
    const ix = 5;
    const iy = 9;
    const iz = 12;
    lat[idx(ix, iy, iz, 0)] = 0.02;
    lat[idx(ix, iy, iz, 1)] = -0.03;
    lat[idx(ix, iy, iz, 2)] = 0.05;
    const coord = (i: number) => i / (N - 1);
    const res = profileResidual(lat, coord(ix), coord(iy), coord(iz));
    expect(res[0]).toBeCloseTo(0.02, 12);
    expect(res[1]).toBeCloseTo(-0.03, 12);
    expect(res[2]).toBeCloseTo(0.05, 12);
  });

  it('trilinear-averages the midpoint of two adjacent nodes', () => {
    const lat = zeroLattice();
    const a = 4;
    const b = 5;
    // vary only along the x axis so the midpoint is the mean of the two nodes
    lat[idx(a, 2, 2, 0)] = 0.1;
    lat[idx(b, 2, 2, 0)] = 0.3;
    const coord = (i: number) => i / (N - 1);
    const midX = (coord(a) + coord(b)) / 2;
    const res = profileResidual(lat, midX, coord(2), coord(2));
    expect(res[0]).toBeCloseTo(0.2, 10); // (0.1 + 0.3) / 2
  });

  it('scales the residual linearly with amount', () => {
    const lat = zeroLattice();
    const ix = 8;
    lat[idx(ix, 8, 8, 0)] = 0.04;
    const coord = (i: number) => i / (N - 1);
    const px: [number, number, number] = [coord(ix), coord(8), coord(8)];
    const full = applyProfileCpu(lat, px, 100)[0] - px[0];
    const half = applyProfileCpu(lat, px, 50)[0] - px[0];
    expect(full).toBeCloseTo(0.04, 10);
    expect(half).toBeCloseTo(0.02, 10);
  });

  it('extrapolates to identity outside [0,1] when the hull is zero', () => {
    const lat = zeroLattice();
    // only an interior node is nonzero; the hull stays zero
    lat[idx(8, 8, 8, 0)] = 0.09;
    // inputs outside the gamut clamp to the (zero) hull → identity
    for (const px of [
      [1.5, -0.2, 2.0],
      [-1, -1, -1],
      [3, 0.5, 0.5],
    ] as [number, number, number][]) {
      expect(applyProfileCpu(lat, px, 100)).toEqual(px);
    }
  });

  it('packProfileLattice bakes amount into vec4-padded storage payload', () => {
    const lat = zeroLattice();
    lat[idx(1, 0, 0, 0)] = 0.2;
    lat[idx(1, 0, 0, 1)] = -0.1;
    lat[idx(1, 0, 0, 2)] = 0.05;
    const packed = packProfileLattice(lat, 50);
    expect(packed.length).toBe(nodes * 4); // one vec4 per node
    const node = 1 * N * N; // (ix=1,iy=0,iz=0) flat node index
    expect(packed[node * 4]).toBeCloseTo(0.1, 6); // 0.2 * 0.5
    expect(packed[node * 4 + 1]).toBeCloseTo(-0.05, 6);
    expect(packed[node * 4 + 2]).toBeCloseTo(0.025, 6);
    expect(packed[node * 4 + 3]).toBe(0); // pad
  });

  it('packed storage payload matches the CPU trilinear at amount 100', () => {
    // the GPU adds packProfileLattice(...)[node] via trilinear; at a node
    // coordinate that reduces to the packed node value — parity spot check
    const lat = A7C2_PROFILE.slice();
    const packed = packProfileLattice(lat, 100);
    const ix = 7;
    const iy = 6;
    const iz = 9;
    const cpu = profileResidual(lat, ix / (N - 1), iy / (N - 1), iz / (N - 1));
    const node = (ix * N + iy) * N + iz;
    expect(packed[node * 4]).toBeCloseTo(cpu[0], 5);
    expect(packed[node * 4 + 1]).toBeCloseTo(cpu[1], 5);
    expect(packed[node * 4 + 2]).toBeCloseTo(cpu[2], 5);
  });
});

describe('profileFit shipped constant', () => {
  it('has the expected lattice size', () => {
    expect(A7C2_PROFILE.length).toBe(nodes * 3);
  });

  it('resolves the a7C II model and falls back otherwise', () => {
    expect(profileForModel('ILCE-7CM2')).toBe(A7C2_PROFILE);
    expect(profileForModel(null)).toBe(DEFAULT_PROFILE);
    expect(profileForModel('SOME-OTHER-CAM')).toBe(DEFAULT_PROFILE);
  });

  it('is a small, bounded residual (no wild shifts anywhere)', () => {
    // a residual, not a creative LUT: every delta is a small working-linear
    // nudge. Bounded magnitude is what keeps out-of-gamut/clamped inputs from
    // shifting wildly (identity extrapolation via the clamped look-up).
    let maxAbs = 0;
    for (let i = 0; i < A7C2_PROFILE.length; i++) maxAbs = Math.max(maxAbs, Math.abs(A7C2_PROFILE[i]!));
    expect(maxAbs).toBeLessThan(0.12);
    expect(maxAbs).toBeGreaterThan(0.01); // …but not a no-op
  });

  it('the FAR (bright/high-value) hull is ~identity — unseen wide-gamut passes through', () => {
    // the top corner (near white) and high-value faces have little scene
    // support, so regularization should leave them ~identity
    let maxFar = 0;
    for (let iy = 0; iy < N; iy++)
      for (let iz = 0; iz < N; iz++)
        for (let c = 0; c < 3; c++) maxFar = Math.max(maxFar, Math.abs(A7C2_PROFILE[idx(N - 1, iy, iz, c)]!));
    expect(maxFar).toBeLessThan(0.03);
  });
});
