/**
 * Develop node — the aggregated "Lightroom right panel" node (REBUILD-SPEC
 * §6). Fixed internal order: WB → exposure → contrast → tone (HL/SH/W/B) →
 * toneCurve → HSL → saturation/vibrance → detail. The schema carries every
 * section from day one; the engine currently implements the Basic passes
 * (tone + color) — toneCurve/HSL/Detail land in their own milestones and are
 * gated by identity checks in the meantime.
 *
 * All Basic math runs in linear sRGB except the tone stages, which weigh by
 * the display-encoded luminance of their own input (four sequential,
 * individually monotone curves — tuning per the rebuild spec: shadows ≈1.9
 * stops over 0–0.75, highlights band 0.35–0.9 with an upper taper, whites
 * ≈0.9 stops, blacks ≈0.018 linear offset fading by mid-tones).
 *
 * Identity invariant: a section at defaults contributes NO pass, so an
 * untouched Develop node is a true bit-exact pass-through.
 */
import { srgbEncode } from '../color/srgb';
import { lumaCpu, nodePassWgsl, smoothstepCpu, WGSL_LUMA, WGSL_SRGB_ENCODE } from './wgslCommon';
import {
  wgslContrast,
  wgslExposure,
  wgslSaturationVibrance,
  wgslWhiteBalance,
  cpuContrast,
  cpuSaturationVibrance,
} from './developOps';

// --- params schema -----------------------------------------------------------

export interface DevelopBasicParams {
  /** Kelvin; 0 = unresolved as-shot placeholder (WB inactive) until SA5. */
  temp: number;
  tint: number;
  /** Exposure in stops; everything else is −100..+100, 0 = no change. */
  ev: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  saturation: number;
  vibrance: number;
}

export type CurvePoints = [number, number][];

export interface ToneCurveParams {
  rgb: CurvePoints;
  r: CurvePoints;
  g: CurvePoints;
  b: CurvePoints;
}

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
export interface HslBandParams {
  h: number;
  s: number;
  l: number;
}

export interface DetailParams {
  sharpen: { amount: number; radius: number; masking: number };
  noiseLuminance: { amount: number };
  noiseColor: { amount: number };
}

export interface DevelopParams {
  basic: DevelopBasicParams;
  toneCurve: ToneCurveParams;
  hsl: Record<HslBand, HslBandParams>;
  detail: DetailParams;
}

export const CURVE_MAX = 255;

export function identityCurvePoints(): CurvePoints {
  return [
    [0, 0],
    [CURVE_MAX, CURVE_MAX],
  ];
}

export function defaultDevelopParams(): DevelopParams {
  return {
    basic: {
      temp: 0,
      tint: 0,
      ev: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 0,
      vibrance: 0,
    },
    toneCurve: { rgb: identityCurvePoints(), r: identityCurvePoints(), g: identityCurvePoints(), b: identityCurvePoints() },
    hsl: Object.fromEntries(HSL_BANDS.map((b) => [b, { h: 0, s: 0, l: 0 }])) as Record<HslBand, HslBandParams>,
    detail: { sharpen: { amount: 0, radius: 1.0, masking: 0 }, noiseLuminance: { amount: 0 }, noiseColor: { amount: 0 } },
  };
}

export function isIdentityCurve(points: CurvePoints): boolean {
  if (points.length < 2) return true;
  if (points[0]![0] !== 0 || points[points.length - 1]![0] !== CURVE_MAX) return false;
  return points.every((p) => p[1] === p[0]);
}

export function isIdentityToneCurve(tc: ToneCurveParams): boolean {
  return isIdentityCurve(tc.rgb) && isIdentityCurve(tc.r) && isIdentityCurve(tc.g) && isIdentityCurve(tc.b);
}

export function isIdentityHsl(hsl: Record<HslBand, HslBandParams>): boolean {
  return HSL_BANDS.every((band) => hsl[band].h === 0 && hsl[band].s === 0 && hsl[band].l === 0);
}

export function isIdentityDetail(d: DetailParams): boolean {
  return d.sharpen.amount === 0 && d.noiseLuminance.amount === 0 && d.noiseColor.amount === 0;
}

// --- GPU passes --------------------------------------------------------------

const TONE_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct ToneParams {
  // xyz = white-balance gains (relative to as-shot), w = exposure EV
  wb_ev: vec4f,
  // x = contrast, y = highlights, z = shadows, w = whites   (all −1..1)
  t0: vec4f,
  // x = blacks (−1..1), yzw unused
  t1: vec4f,
}
@group(0) @binding(1) var<uniform> u: ToneParams;
`,
  helpers: WGSL_SRGB_ENCODE + WGSL_LUMA,
  body: /* wgsl */ `
${wgslWhiteBalance('u.wb_ev.xyz')}
${wgslExposure('u.wb_ev.w')}
${wgslContrast('u.t0.x')}
  // tone: four sequential stages, each weighing by the display-encoded
  // luminance of its OWN input so the composition stays monotone.
  // highlights: band 0.35–0.9, tapered above 0.8 so near-whites keep
  // separation instead of graying out
  var ys = srgbEncode1(clamp(luma(c), 0.0, 1.0));
  c = c * exp2(u.t0.y * 1.1 * smoothstep(0.35, 0.9, ys) * (1.0 - 0.3 * smoothstep(0.8, 1.0, ys)));
  // shadows: strong near black, fading by ~0.75; multiplicative keeps the
  // black point anchored
  ys = srgbEncode1(clamp(luma(c), 0.0, 1.0));
  c = c * exp2(u.t0.z * 1.9 * (1.0 - smoothstep(0.1, 0.75, ys)));
  // whites: white-point control, top-weighted but reaching midtones
  ys = srgbEncode1(clamp(luma(c), 0.0, 1.0));
  c = c * exp2(u.t0.w * 0.9 * smoothstep(0.3, 1.0, ys));
  // blacks: linear black-point offset fading by mid-tones; clamp so negative
  // offsets crush to black instead of going negative downstream
  ys = srgbEncode1(clamp(luma(c), 0.0, 1.0));
  c = max(c + vec3f(u.t1.x * 0.018 * (1.0 - smoothstep(0.0, 0.45, ys))), vec3f(0.0));
`,
});

const COLOR_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct ColorParams {
  // x = saturation (−1..1), y = vibrance (−1..1), zw unused
  sv: vec4f,
}
@group(0) @binding(1) var<uniform> u: ColorParams;
`,
  helpers: WGSL_LUMA,
  body: wgslSaturationVibrance('u.sv.x', 'u.sv.y'),
});

export interface PassSpec {
  /** Pipeline cache key (one compile per distinct id). */
  shaderId: string;
  wgsl: string;
  /** Uniform contents; byteLength 0 = the pass binds no uniform. */
  uniforms: ArrayBuffer;
}

function packTone(b: DevelopBasicParams, wbGains: [number, number, number]): ArrayBuffer {
  const buf = new ArrayBuffer(48);
  const f = new Float32Array(buf);
  f[0] = wbGains[0];
  f[1] = wbGains[1];
  f[2] = wbGains[2];
  f[3] = b.ev;
  f[4] = b.contrast / 100;
  f[5] = b.highlights / 100;
  f[6] = b.shadows / 100;
  f[7] = b.whites / 100;
  f[8] = b.blacks / 100;
  return buf;
}

function packColor(b: DevelopBasicParams): ArrayBuffer {
  const buf = new ArrayBuffer(16);
  const f = new Float32Array(buf);
  f[0] = b.saturation / 100;
  f[1] = b.vibrance / 100;
  return buf;
}

/**
 * Passes for the current params — identity sections contribute none.
 * WB gains are [1,1,1] until the Kelvin/Tint model lands (temp 0 =
 * unresolved as-shot placeholder = inactive).
 */
export function developPasses(params: DevelopParams): PassSpec[] {
  const b = params.basic;
  const wbGains: [number, number, number] = [1, 1, 1];
  const toneActive =
    b.ev !== 0 || b.contrast !== 0 || b.highlights !== 0 || b.shadows !== 0 || b.whites !== 0 || b.blacks !== 0;
  const colorActive = b.saturation !== 0 || b.vibrance !== 0;
  const passes: PassSpec[] = [];
  if (toneActive) passes.push({ shaderId: 'develop/tone', wgsl: TONE_WGSL, uniforms: packTone(b, wbGains) });
  if (colorActive) passes.push({ shaderId: 'develop/color', wgsl: COLOR_WGSL, uniforms: packColor(b) });
  return passes;
}

// --- CPU reference -----------------------------------------------------------

type Rgb = [number, number, number];

/** Mirror of the tone pass (wb, ev, contrast, four tone stages). */
export function cpuDevelopTone(px: Rgb, b: DevelopBasicParams, wbGains: [number, number, number]): Rgb {
  let [r, g, bl] = px;
  r *= wbGains[0];
  g *= wbGains[1];
  bl *= wbGains[2];
  const gain = Math.pow(2, b.ev);
  r *= gain;
  g *= gain;
  bl *= gain;
  [r, g, bl] = cpuContrast([r, g, bl], b.contrast / 100);
  const ysOf = (rr: number, gg: number, bb: number) => srgbEncode(Math.min(Math.max(lumaCpu(rr, gg, bb), 0), 1));
  let ys = ysOf(r, g, bl);
  let k = Math.pow(2, (b.highlights / 100) * 1.1 * smoothstepCpu(0.35, 0.9, ys) * (1 - 0.3 * smoothstepCpu(0.8, 1, ys)));
  r *= k;
  g *= k;
  bl *= k;
  ys = ysOf(r, g, bl);
  k = Math.pow(2, (b.shadows / 100) * 1.9 * (1 - smoothstepCpu(0.1, 0.75, ys)));
  r *= k;
  g *= k;
  bl *= k;
  ys = ysOf(r, g, bl);
  k = Math.pow(2, (b.whites / 100) * 0.9 * smoothstepCpu(0.3, 1, ys));
  r *= k;
  g *= k;
  bl *= k;
  ys = ysOf(r, g, bl);
  const off = (b.blacks / 100) * 0.018 * (1 - smoothstepCpu(0, 0.45, ys));
  return [Math.max(r + off, 0), Math.max(g + off, 0), Math.max(bl + off, 0)];
}

/** Mirror of developPasses() — apply the same active passes in order. */
export function cpuDevelop(px: Rgb, params: DevelopParams): Rgb {
  const b = params.basic;
  let out = px;
  const toneActive =
    b.ev !== 0 || b.contrast !== 0 || b.highlights !== 0 || b.shadows !== 0 || b.whites !== 0 || b.blacks !== 0;
  if (toneActive) out = cpuDevelopTone(out, b, [1, 1, 1]);
  if (b.saturation !== 0 || b.vibrance !== 0) {
    out = cpuSaturationVibrance(out, b.saturation / 100, b.vibrance / 100);
  }
  return out;
}
