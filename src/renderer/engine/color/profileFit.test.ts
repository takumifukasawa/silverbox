import { describe, expect, it } from 'vitest';
import {
  applyProfileCpu,
  packProfileLattice,
  profileResidual,
  PROFILE_LATTICE_N,
  PROFILE_LUMA_CAP_L_STAR,
  profileLumaCapAt,
  A7C2_PROFILE,
  profileForModel,
  DEFAULT_PROFILE,
} from './profileFit';
import { WORK_TO_SRGB } from './workingSpace';

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
    // …but not a no-op. The round-1/2 lattice's own max was ~0.043 (a looser
    // splat/regularization method); round 4's per-scene-equal-weight splat
    // (which round 5/6 inherit unchanged) consistently produces much smaller
    // maxima (~0.005-0.007 across every attempt in this history) — the lower
    // bound is recalibrated to that actual method's expected range, not the
    // pre-round-4 lattice's.
    expect(maxAbs).toBeGreaterThan(0.001);
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

// --- ROUND 6: luminance-aware displacement, SHIPPED (see the ROUND 6
// doc-comment entry in profileFit.ts's header for the full report). Round 5
// shipped a flat ±2 L* cap that failed its own whole-frame luma percentile
// gate (a shadow-region regression vs LR); round 6 made the cap POSITION-
// DEPENDENT (profileLumaCapAt — zero in shadows, ramping to a smaller full
// cap in midtones/highlights) and halved the ceiling, which cleared every
// gate. A7C2_PROFILE below is that round-6 lattice.
const SRGB_TO_XYZ: readonly (readonly number[])[] = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };
function mul3(m: readonly (readonly number[])[], v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
    m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
    m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
  ];
}
function labF(t: number): number {
  return t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
}
/**
 * working-linear Rec.2020 -> CIE L*a*b* (D65), VALIDATION ONLY (never on the
 * render path — profileResidual/applyProfileCpu/packProfileLattice above
 * stay pure linear-RGB adds). Duplicates scripts/fit-profile.mjs's
 * workToLab (same formula/constants — that file fits the lattice using
 * exactly this math to enforce the same position-dependent cap).
 */
function workToLab(rgb: readonly [number, number, number]): [number, number, number] {
  const s = mul3(WORK_TO_SRGB, rgb);
  const xyz = mul3(SRGB_TO_XYZ, [Math.max(s[0], 0), Math.max(s[1], 0), Math.max(s[2], 0)]);
  const fx = labF(xyz[0] / D65.x);
  const fy = labF(xyz[1] / D65.y);
  const fz = labF(xyz[2] / D65.z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

describe('profileFit round 6 (shipped): shadow-safe luma-cap invariant', () => {
  it('every node displaces CIE L* by at most profileLumaCapAt(its own position L*)', () => {
    // same ABSOLUTE-overage tolerance the fitter's own final clamp uses
    // (see fit-profile.mjs's LUMA_CLAMP_ABS_TOLERANCE doc comment for why a
    // RATIO metric is numerically unstable near cap≈0 — a tiny Lab
    // round-trip residual divided by a near-zero cap reads as a huge, unreal
    // "violation").
    const ABS_TOLERANCE = 0.15;
    let maxOverage = 0;
    for (let ix = 0; ix < N; ix++)
      for (let iy = 0; iy < N; iy++)
        for (let iz = 0; iz < N; iz++) {
          const p: [number, number, number] = [ix / (N - 1), iy / (N - 1), iz / (N - 1)];
          const b = idx(ix, iy, iz, 0);
          const q: [number, number, number] = [p[0] + A7C2_PROFILE[b]!, p[1] + A7C2_PROFILE[b + 1]!, p[2] + A7C2_PROFILE[b + 2]!];
          const dL = Math.abs(workToLab(q)[0] - workToLab(p)[0]);
          const cap = profileLumaCapAt(workToLab(p)[0]);
          maxOverage = Math.max(maxOverage, Math.max(0, dL - cap));
        }
    expect(maxOverage).toBeLessThanOrEqual(ABS_TOLERANCE);
  });

  it('the cap constants are documented, small, and ordered (shadow < midtone)', () => {
    expect(PROFILE_LUMA_CAP_L_STAR).toBeGreaterThan(0);
    expect(PROFILE_LUMA_CAP_L_STAR).toBeLessThanOrEqual(3); // "small", per the round-5/6 design brief
    expect(profileLumaCapAt(0)).toBe(0); // zero in deep shadow
    expect(profileLumaCapAt(100)).toBeCloseTo(PROFILE_LUMA_CAP_L_STAR, 10); // full cap in highlights
  });
});
