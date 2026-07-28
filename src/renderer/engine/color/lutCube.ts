/**
 * .cube LUT (Adobe/Iridas format) — the READ counterpart of lutExport.ts's
 * WRITE side (LUT import node, docs/brief-bank/lut-import-node.md). Reuses
 * the SAME conventions lutExport.ts already emits: `LUT_3D_SIZE`/
 * `LUT_1D_SIZE`, row-major RGB triplets, RED fastest/then GREEN/then BLUE for
 * the 3D case (see buildCubeText's own doc comment in lutExport.ts) — a
 * Silverbox-exported .cube re-imported through this node samples back
 * exactly what it exported (module-level parity test in lutCube.test.ts).
 *
 * v1 domain: DOMAIN_MIN/DOMAIN_MAX are PARSED (so a file that declares them
 * doesn't fail outright) but only the default [0,1]^3 domain is actually
 * supported — anything else is rejected as malformed. Remapping an
 * arbitrary domain is out of scope for v1; every .cube this engine itself
 * produces uses the default domain, and it is also the norm for
 * display-referred film-sim LUTs.
 *
 * Size caps (LUT3D_SIZE_MAX / LUT1D_SIZE_MAX below) are a practical safety
 * limit on GPU-texture/storage-buffer size, not a .cube spec limit — a file
 * declaring a larger size is rejected as malformed rather than silently
 * truncated.
 */
import { srgbDecode, srgbEncode } from './srgb';
import { SRGB_TO_WORK, WORK_TO_SRGB } from './workingSpace';

type Rgb = [number, number, number];
type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

/** Practical cap on LUT_3D_SIZE (our own export uses 33; 65 covers every real-world film-sim LUT this engine is likely to see). */
export const LUT3D_SIZE_MAX = 65;
/** Practical cap on LUT_1D_SIZE (most per-channel tone LUTs use well under 1024 entries). */
export const LUT1D_SIZE_MAX = 4096;

export interface CubeLut3D {
  readonly kind: '3d';
  readonly size: number;
  /** Flat RGB triplets, .cube file order — index (r + g*size + b*size*size)*3 + c (RED fastest, then GREEN, then BLUE). */
  readonly data: Float32Array;
}

export interface CubeLut1D {
  readonly kind: '1d';
  readonly size: number;
  /** Flat RGB triplets, one row per table entry — index i*3 + c. Each channel is its OWN independent curve: table[i].r/.g/.b are three unrelated 1D lookups sharing one file, not a single joint RGB triplet lookup. */
  readonly data: Float32Array;
}

export type CubeLut = CubeLut3D | CubeLut1D;

/**
 * Parse a .cube file's text. Never throws — any structural problem
 * (ambiguous/missing size declaration, wrong data-row count, non-numeric
 * data, a non-default domain) returns `null` (the sanitizer posture this
 * node's file-reference handling needs throughout: a malformed file must
 * degrade to "couldn't load", never take the document down — see
 * lutNode.ts/lutSource.ts).
 */
export function parseCubeLut(text: string): CubeLut | null {
  try {
    let size3: number | null = null;
    let size1: number | null = null;
    let domainMin: Rgb = [0, 0, 0];
    let domainMax: Rgb = [1, 1, 1];
    const rows: number[] = [];

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('TITLE')) continue;
      if (line.startsWith('LUT_3D_SIZE')) {
        const n = Number(line.slice('LUT_3D_SIZE'.length).trim());
        if (!Number.isInteger(n) || n < 2 || n > LUT3D_SIZE_MAX) return null;
        size3 = n;
        continue;
      }
      if (line.startsWith('LUT_1D_SIZE')) {
        const n = Number(line.slice('LUT_1D_SIZE'.length).trim());
        if (!Number.isInteger(n) || n < 2 || n > LUT1D_SIZE_MAX) return null;
        size1 = n;
        continue;
      }
      if (line.startsWith('DOMAIN_MIN')) {
        const p = line.slice('DOMAIN_MIN'.length).trim().split(/\s+/).map(Number);
        if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
        domainMin = [p[0]!, p[1]!, p[2]!];
        continue;
      }
      if (line.startsWith('DOMAIN_MAX')) {
        const p = line.slice('DOMAIN_MAX'.length).trim().split(/\s+/).map(Number);
        if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
        domainMax = [p[0]!, p[1]!, p[2]!];
        continue;
      }
      const parts = line.split(/\s+/);
      const nums = parts.map(Number);
      if (parts.length === 3 && nums.every((v) => Number.isFinite(v))) {
        rows.push(nums[0]!, nums[1]!, nums[2]!);
        continue;
      }
      // Not a clean 3-number row. A genuine data row always starts with a
      // digit/sign/decimal point; anything else is a keyword this parser
      // doesn't know (LUT_3D_INPUT_RANGE and similar tool-specific hints) —
      // skip it rather than fail the whole file (forward-compat). A line
      // that LOOKS like it was meant as numeric data (leading digit/sign/
      // dot) but doesn't parse as exactly 3 numbers IS treated as malformed.
      if (/^[+\-.\d]/.test(line)) return null;
    }

    if (size3 !== null && size1 !== null) return null; // ambiguous — both declared
    if (size3 === null && size1 === null) return null; // no size declared
    if (domainMin.some((v) => v !== 0) || domainMax.some((v) => v !== 1)) return null; // v1: default domain only

    if (size3 !== null) {
      if (rows.length !== size3 * size3 * size3 * 3) return null;
      return { kind: '3d', size: size3, data: Float32Array.from(rows) };
    }
    const size = size1!;
    if (rows.length !== size * 3) return null;
    return { kind: '1d', size, data: Float32Array.from(rows) };
  } catch {
    return null;
  }
}

/** Row index within a 3D table's flat data — RED fastest, then GREEN, then BLUE (mirrors lutExport.ts's buildCubeText loop order). */
function lut3dRow(ir: number, ig: number, ib: number, size: number): number {
  return ir + ig * size + ib * size * size;
}

/**
 * Trilinear sample of a 3D LUT at continuous (r,g,b) — clamped to [0,1]
 * (the "clamp at the LUT boundary" documented highlight-clip limitation).
 * The CPU mirror of graphRenderer.ts's LUT3D_SHADER manual-trilinear WGSL —
 * same 8-tap weighting, same corner-clamp order; keep them in lockstep.
 */
export function sampleLut3DTrilinear(table: CubeLut3D, r: number, g: number, b: number): Rgb {
  const n = table.size;
  const cr = Math.min(Math.max(r, 0), 1) * (n - 1);
  const cg = Math.min(Math.max(g, 0), 1) * (n - 1);
  const cb = Math.min(Math.max(b, 0), 1) * (n - 1);
  const ir0 = Math.min(Math.floor(cr), n - 2);
  const ig0 = Math.min(Math.floor(cg), n - 2);
  const ib0 = Math.min(Math.floor(cb), n - 2);
  const fr = cr - ir0;
  const fg = cg - ig0;
  const fb = cb - ib0;
  let outR = 0;
  let outG = 0;
  let outB = 0;
  for (let dr = 0; dr < 2; dr++) {
    const wr = dr === 1 ? fr : 1 - fr;
    for (let dg = 0; dg < 2; dg++) {
      const wg = dg === 1 ? fg : 1 - fg;
      for (let db = 0; db < 2; db++) {
        const wb = db === 1 ? fb : 1 - fb;
        const w = wr * wg * wb;
        const row = lut3dRow(ir0 + dr, ig0 + dg, ib0 + db, n) * 3;
        outR += w * table.data[row]!;
        outG += w * table.data[row + 1]!;
        outB += w * table.data[row + 2]!;
      }
    }
  }
  return [outR, outG, outB];
}

/**
 * Per-channel linear sample of a 1D LUT: three INDEPENDENT curves sharing
 * one table (r looks up table[..].r, g looks up table[..].g, b looks up
 * table[..].b — not one joint RGB lookup). The CPU mirror of the WGSL 1D
 * pass (lutNode.ts's buildLut1DWgsl) — keep them in lockstep.
 */
export function sampleLut1DLinear(table: CubeLut1D, r: number, g: number, b: number): Rgb {
  const n = table.size;
  const at = (v: number, ch: number): number => {
    const c = Math.min(Math.max(v, 0), 1) * (n - 1);
    const i0 = Math.min(Math.floor(c), n - 2);
    const f = c - i0;
    const a = table.data[i0 * 3 + ch]!;
    const b2 = table.data[(i0 + 1) * 3 + ch]!;
    return a + (b2 - a) * f;
  };
  return [at(r, 0), at(g, 1), at(b, 2)];
}

/**
 * Pack a 3D LUT table into a 2D "strip" texture — REUSES the exact axis
 * convention lutExport.ts's buildStripPixels already emits on the write
 * side (tile index = BLUE, within-tile x = RED, within-tile y = GREEN, row 0
 * = top = green 0): width = size*size (size tiles of size*size laid side by
 * side), height = size. Read matches write: sampling this layout with
 * graphRenderer.ts's LUT3D_SHADER reproduces sampleLut3DTrilinear above
 * exactly. Unlike buildStripPixels' Uint8 sRGB-quantized PNG output, this
 * feeds an INTERNAL GPU texture sampled with manual trilinear (textureLoad
 * only, no filtering sampler), so full float precision survives end to end
 * instead of an 8-bit round trip.
 */
export function buildLutStripPixels(table: CubeLut3D): { data: Float32Array; width: number; height: number } {
  const size = table.size;
  const width = size * size;
  const height = size;
  const out = new Float32Array(width * height * 4);
  for (let ib = 0; ib < size; ib++) {
    for (let ig = 0; ig < size; ig++) {
      for (let ir = 0; ir < size; ir++) {
        const row = lut3dRow(ir, ig, ib, size) * 3;
        const px = ib * size + ir;
        const idx = (ig * width + px) * 4;
        out[idx] = table.data[row]!;
        out[idx + 1] = table.data[row + 1]!;
        out[idx + 2] = table.data[row + 2]!;
        out[idx + 3] = 1;
      }
    }
  }
  return { data: out, width, height };
}

function mulMat3(m: Mat3, v: Rgb): Rgb {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * CPU reference for the whole LUT node, one pixel: working (linear
 * Rec.2020) → the LUT's expected display space (encode via WORK_TO_SRGB +
 * the exact sRGB OETF — engine invariant: srgb.ts is the only source for
 * this, never re-derived) → sample the table (trilinear 3D / per-channel
 * linear 1D) → decode back to working (SRGB_TO_WORK + the exact sRGB EOTF)
 * → mixed against the untouched input by `amount` (0 = identity, 1 = full
 * LUT). Clamped to [0,1] at the encode step — the documented highlight-clip
 * limitation of applying a display LUT mid-pipeline (same class as the
 * denoise-node round-trip note).
 *
 * `inputSpace` currently has NO effect on this math: sRGB and Rec.709 share
 * the same primaries (so WORK_TO_SRGB/SRGB_TO_WORK apply to both), and the
 * engine has no separately-implemented Rec.709 transfer curve — only
 * srgb.ts's exact sRGB piecewise functions (an engine invariant: they are
 * the ONLY source for this conversion, never re-derived elsewhere). Rather
 * than hand-roll a second, unverified transfer curve, v1 uses the sRGB one
 * for both selector values — a documented simplification (the two curves
 * differ only in the toe below ~0.018, a small practical difference for
 * film-sim LUT purposes). See lutNode.ts's LutInputSpace doc comment.
 *
 * Must mirror graphRenderer.ts's LUT3D_SHADER and lutNode.ts's
 * buildLut1DWgsl EXACTLY (same operation order, same clamp) — the GPU↔CPU
 * parity check (scripts/verify-lut-import.mjs) depends on it.
 */
export function applyCubeLutCpu(table: CubeLut, amount: number, work: Rgb): Rgb {
  const linSrgb = mulMat3(WORK_TO_SRGB, work);
  const enc: Rgb = [clamp01(srgbEncode(linSrgb[0])), clamp01(srgbEncode(linSrgb[1])), clamp01(srgbEncode(linSrgb[2]))];
  const sampled = table.kind === '3d' ? sampleLut3DTrilinear(table, enc[0], enc[1], enc[2]) : sampleLut1DLinear(table, enc[0], enc[1], enc[2]);
  const decLin: Rgb = [srgbDecode(sampled[0]), srgbDecode(sampled[1]), srgbDecode(sampled[2])];
  const outWork = mulMat3(SRGB_TO_WORK, decLin);
  return [
    work[0] + (outWork[0] - work[0]) * amount,
    work[1] + (outWork[1] - work[1]) * amount,
    work[2] + (outWork[2] - work[2]) * amount,
  ];
}
