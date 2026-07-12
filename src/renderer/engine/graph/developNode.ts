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
import { srgbDecode, srgbEncode } from '../color/srgb';
import { WGSL_WORKING_LUMA, WORKING_LUMA } from '../color/workingSpace';
import { buildToneCurveLut, TONE_CURVE_LUT_SIZE } from '../color/toneCurve';
import { lumaCpu, nodePassWgsl, smoothstepCpu, WGSL_LUMA, WGSL_SRGB_DECODE, WGSL_SRGB_ENCODE } from './wgslCommon';
import {
  cpuContrast,
  cpuHslBandsEncoded,
  cpuSaturationVibrance,
  WGSL_HSL_HELPERS,
  wgslContrast,
  wgslExposure,
  wgslHslBands,
  wgslSaturationVibrance,
  wgslWhiteBalance,
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

/**
 * Band center hues in degrees (Lightroom-like, NON-uniform: warm bands 30°
 * apart, cool bands 60°). Shared by the shader weighting and the UI track
 * gradients so they can never drift. Order matches HSL_BANDS.
 */
export const HSL_BAND_CENTER_DEG: Record<HslBand, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 270,
  magenta: 300,
};

export interface DetailParams {
  sharpen: { amount: number; radius: number; masking: number };
  /**
   * `detail`/`contrast` are LR Classic's Luminance sub-sliders (0–100),
   * exposing the bilateral NR pass's own degrees of freedom — see packNr's
   * NR_LUM_DETAIL_RANGE_STOPS / NR_LUM_CONTRAST_GAIN mapping constants.
   * Defaults (50/0) reproduce today's fixed formula exactly.
   */
  noiseLuminance: { amount: number; detail: number; contrast: number };
  /**
   * `detail`/`smoothness` are LR Classic's Color sub-sliders (0–100) — see
   * packNr's NR_COLOR_DETAIL_RANGE_STOPS / NR_COLOR_SMOOTHNESS_SIGMA_STOPS.
   * Defaults (50/50) reproduce today's fixed formula exactly.
   */
  noiseColor: { amount: number; detail: number; smoothness: number };
}

/** One color-grading wheel: hue 0–360°, saturation 0–100, luminance −100..+100. */
export interface GradingWheel {
  hue: number;
  sat: number;
  lum: number;
}

export const GRADING_REGIONS = ['shadows', 'midtones', 'highlights', 'global'] as const;
export type GradingRegion = (typeof GRADING_REGIONS)[number];

/** 3-way color grading (+ global): LR "Color Grading" / lift-gamma-gain style. */
export interface GradingParams {
  shadows: GradingWheel;
  midtones: GradingWheel;
  highlights: GradingWheel;
  global: GradingWheel;
  /** 0–100: widens the shadow/highlight crossover overlap (default 50). */
  blending: number;
  /** −100..+100: shifts both crossovers toward shadows/highlights. */
  balance: number;
}

/**
 * "Effects" section: dehaze/vignette/grain are per-pixel (position-aware for
 * vignette/grain, but still no neighborhood reads — a CPU mirror exists);
 * clarity/texture are local-contrast unsharp masks (spatial, no CPU mirror,
 * same rule as Detail).
 */
export interface EffectsParams {
  dehaze: number;
  clarity: number;
  texture: number;
  grain: number;
  grainSize: number;
  vignette: number;
  vignetteMidpoint: number;
}

export interface DevelopParams {
  basic: DevelopBasicParams;
  toneCurve: ToneCurveParams;
  hsl: Record<HslBand, HslBandParams>;
  grading: GradingParams;
  detail: DetailParams;
  effects: EffectsParams;
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
    grading: {
      shadows: { hue: 0, sat: 0, lum: 0 },
      midtones: { hue: 0, sat: 0, lum: 0 },
      highlights: { hue: 0, sat: 0, lum: 0 },
      global: { hue: 0, sat: 0, lum: 0 },
      blending: 50,
      balance: 0,
    },
    detail: {
      sharpen: { amount: 0, radius: 1.0, masking: 0 },
      noiseLuminance: { amount: 0, detail: 50, contrast: 0 },
      noiseColor: { amount: 0, detail: 50, smoothness: 50 },
    },
    effects: {
      dehaze: 0,
      clarity: 0,
      texture: 0,
      grain: 0,
      grainSize: 1.5,
      vignette: 0,
      vignetteMidpoint: 0.5,
    },
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

/** Hue never matters at sat 0; blending/balance only shape active wheels. */
export function isIdentityGrading(g: GradingParams): boolean {
  return GRADING_REGIONS.every((r) => g[r].sat === 0 && g[r].lum === 0);
}

/** Per-pixel Effects ops (dehaze/vignette/grain) — the fx-pixel pass. */
export function isIdentityEffectsPixel(e: EffectsParams): boolean {
  return e.dehaze === 0 && e.grain === 0 && e.vignette === 0;
}

/** Spatial Effects ops (clarity/texture) — the fx-spatial bracket, no CPU mirror. */
export function isIdentityEffectsSpatial(e: EffectsParams): boolean {
  return e.clarity === 0 && e.texture === 0;
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

// Point curves applied in DISPLAY (sRGB-encoded) space, LR-style 0–255 axes:
// linear → encode → per-channel LUT → decode. The LUT is baked on the CPU
// (engine/color/toneCurve.ts) with the per-channel curve composed first,
// then the RGB master, so the shader does exactly one lookup per channel.
// The pass only exists when the curve is non-identity, so the encode/decode
// round-trip can never perturb a pass-through render.
const TONECURVE_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct CurveLut {
  // one vec4 per entry: x/y/z = R/G/B output (display-encoded, 0..1)
  data: array<vec4f, ${TONE_CURVE_LUT_SIZE}>,
}
@group(0) @binding(1) var<uniform> u: CurveLut;
`,
  helpers:
    WGSL_SRGB_ENCODE +
    WGSL_SRGB_DECODE +
    /* wgsl */ `
fn curveLut(v: f32, ch: u32) -> f32 {
  let f = clamp(v, 0.0, 1.0) * ${TONE_CURVE_LUT_SIZE - 1}.0;
  let i0 = u32(f);
  let i1 = min(i0 + 1u, ${TONE_CURVE_LUT_SIZE - 1}u);
  return mix(u.data[i0][ch], u.data[i1][ch], f - f32(i0));
}
`,
  body: /* wgsl */ `
  // >1 highlights clamp into the curve domain — the white point governs them
  let enc = srgbEncode(clamp(c, vec3f(0.0), vec3f(1.0)));
  c = srgbDecode(vec3f(curveLut(enc.x, 0u), curveLut(enc.y, 1u), curveLut(enc.z, 2u)));
`,
});

// 8-band HSL in display space, between ToneCurve and saturation/vibrance
// (spec §6 order). All-zero = identity = skipped, so the RGB↔HSL round-trip
// never touches a pass-through render.
const HSL_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct HslParams {
  // one vec4 per band in HSL_BANDS order: xyz = hue/sat/lum (−1..1), w unused
  bands: array<vec4f, 8>,
}
@group(0) @binding(1) var<uniform> u: HslParams;
`,
  helpers: WGSL_SRGB_ENCODE + WGSL_SRGB_DECODE + WGSL_HSL_HELPERS,
  body: wgslHslBands('u.bands'),
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

function packHsl(hsl: Record<HslBand, HslBandParams>): Float32Array {
  const f = new Float32Array(8 * 4);
  HSL_BANDS.forEach((band, i) => {
    f[i * 4] = hsl[band].h / 100;
    f[i * 4 + 1] = hsl[band].s / 100;
    f[i * 4 + 2] = hsl[band].l / 100;
  });
  return f;
}

function packColor(b: DevelopBasicParams): ArrayBuffer {
  const buf = new ArrayBuffer(16);
  const f = new Float32Array(buf);
  f[0] = b.saturation / 100;
  f[1] = b.vibrance / 100;
  return buf;
}

// --- 3-way color grading (roadmap Phase 1) ------------------------------------
//
// Applied in DISPLAY (sRGB-encoded) space after HSL / saturation: region
// weights come from the encoded luminance (shadows below ~0.33, highlights
// above ~0.67, midtones between; `balance` shifts both crossovers, `blending`
// widens them), each wheel contributes a ZERO-LUMA chroma offset (its hue's
// RGB direction minus its own luma, scaled by sat) plus an exposure-like
// luminance gain. The chroma offset is anchored at pure black/white so
// endpoints never tint. Uniform layout: wheels[i] = (offset.rgb, lum stops),
// packed on the CPU so the CPU mirror shares the exact same numbers.

/** Full-strength chroma offset magnitude (encoded units) at sat 100. */
const GRADING_SAT_SCALE = 0.3;
/** Full-strength luminance gain in stops at lum ±100. */
const GRADING_LUM_STOPS = 0.8;

const GRADING_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct GradingParams {
  // shadows/midtones/highlights/global: xyz = chroma offset, w = lum stops
  wheels: array<vec4f, 4>,
  // x = crossover shift (balance), y = crossover half-width (blending)
  ctrl: vec4f,
}
@group(0) @binding(1) var<uniform> u: GradingParams;
`,
  helpers: WGSL_SRGB_ENCODE + WGSL_SRGB_DECODE + WGSL_LUMA,
  body: /* wgsl */ `
  {
    let enc = srgbEncode(clamp(c, vec3f(0.0), vec3f(1.0)));
    let ys = luma(enc);
    let shift = u.ctrl.x;
    let spread = u.ctrl.y;
    let wS = 1.0 - smoothstep(0.33 + shift - spread, 0.33 + shift + spread, ys);
    let wH = smoothstep(0.67 + shift - spread, 0.67 + shift + spread, ys);
    let wM = clamp(1.0 - wS - wH, 0.0, 1.0);
    let offset = u.wheels[0].xyz * wS + u.wheels[1].xyz * wM + u.wheels[2].xyz * wH + u.wheels[3].xyz;
    let stops = u.wheels[0].w * wS + u.wheels[1].w * wM + u.wheels[2].w * wH + u.wheels[3].w;
    // anchor: pure black/white never tint
    let anchor = smoothstep(0.0, 0.05, ys) * (1.0 - smoothstep(0.95, 1.0, ys));
    c = srgbDecode(clamp(enc * exp2(stops) + offset * anchor, vec3f(0.0), vec3f(1.0)));
  }
`,
});

/** Hue (degrees) → unit-ish RGB direction with zero Rec.709 luma. */
function gradingChromaOffset(hue: number, sat: number): [number, number, number] {
  // hue → saturated RGB (hsl2rgb at s=1, l=0.5), then remove its luma
  const ch = 1;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = ch * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] = [ch, x, 0];
  if (hp >= 1 && hp < 2) rgb = [x, ch, 0];
  else if (hp >= 2 && hp < 3) rgb = [0, ch, x];
  else if (hp >= 3 && hp < 4) rgb = [0, x, ch];
  else if (hp >= 4 && hp < 5) rgb = [x, 0, ch];
  else if (hp >= 5) rgb = [ch, 0, x];
  const y = lumaCpu(rgb[0], rgb[1], rgb[2]);
  const k = (sat / 100) * GRADING_SAT_SCALE;
  return [(rgb[0] - y) * k, (rgb[1] - y) * k, (rgb[2] - y) * k];
}

function packGrading(g: GradingParams): Float32Array {
  const f = new Float32Array(4 * 4 + 4);
  GRADING_REGIONS.forEach((region, i) => {
    const wheel = g[region];
    const off = gradingChromaOffset(wheel.hue, wheel.sat);
    f[i * 4] = off[0];
    f[i * 4 + 1] = off[1];
    f[i * 4 + 2] = off[2];
    f[i * 4 + 3] = (wheel.lum / 100) * GRADING_LUM_STOPS;
  });
  f[16] = (g.balance / 100) * 0.15; // crossover shift
  f[17] = 0.08 + (g.blending / 100) * 0.25; // crossover half-width
  return f;
}

/** Mirror of the grading pass; consumes the same packed uniform. */
function cpuGrading(px: Rgb, u: Float32Array): Rgb {
  const enc: Rgb = [
    srgbEncode(Math.min(Math.max(px[0], 0), 1)),
    srgbEncode(Math.min(Math.max(px[1], 0), 1)),
    srgbEncode(Math.min(Math.max(px[2], 0), 1)),
  ];
  const ys = lumaCpu(enc[0], enc[1], enc[2]);
  const shift = u[16]!;
  const spread = u[17]!;
  const wS = 1 - smoothstepCpu(0.33 + shift - spread, 0.33 + shift + spread, ys);
  const wH = smoothstepCpu(0.67 + shift - spread, 0.67 + shift + spread, ys);
  const wM = Math.min(Math.max(1 - wS - wH, 0), 1);
  const w = [wS, wM, wH, 1];
  let stops = 0;
  const offset: Rgb = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    offset[0] += u[i * 4]! * w[i]!;
    offset[1] += u[i * 4 + 1]! * w[i]!;
    offset[2] += u[i * 4 + 2]! * w[i]!;
    stops += u[i * 4 + 3]! * w[i]!;
  }
  const anchor = smoothstepCpu(0, 0.05, ys) * (1 - smoothstepCpu(0.95, 1, ys));
  const gain = Math.pow(2, stops);
  const out = enc.map((v, i) => Math.min(Math.max(v * gain + offset[i]! * anchor, 0), 1)) as Rgb;
  return [srgbDecode(out[0]), srgbDecode(out[1]), srgbDecode(out[2])];
}

// --- Detail: NR → sharpen in encoded luma/chroma space (spec §10) ------------
//
// Runs LAST in the Develop chain, in DISPLAY (sRGB-encoded) space — noise
// statistics and sharpening halos are perceptually more uniform there. Luma
// and chroma separate with an invertible transform (Y = Rec.709 luma of the
// ENCODED rgb, Cb = b′−Y, Cr = r′−Y), so luminance NR / sharpening never
// shift hue and color NR never softens luminance detail. Encoding once up
// front keeps the kernel passes to loads+MACs (no pow per tap).
//
// RESOLUTION SCALING: kernel radii/sigmas are defined in FULL-RESOLUTION
// pixels and multiplied by renderScale (= renderLongEdge/fullLongEdge, ≤1
// for the preview, 1 for export), so preview and export agree in look as far
// as the preview's resolution allows.

const DETAIL_LUMA = WGSL_WORKING_LUMA;
const [DETAIL_WR, DETAIL_WG, DETAIL_WB] = WORKING_LUMA;
const NR_LUM_SIGMA_FULL = 2.0;
const NR_CHROMA_SIGMA_FULL = 4.0;
/** Floor for any scaled sigma — keeps a visible effect on tiny previews. */
const DETAIL_SIGMA_MIN = 0.4;
/** Kernel radius caps (render px) — perf guard for full-res export. */
const NR_KERNEL_RADIUS_MAX = 10;
const SHARPEN_KERNEL_RADIUS_MAX = 8;

const DETAIL_ENC_WGSL = nodePassWgsl({
  helpers: WGSL_SRGB_ENCODE,
  body: /* wgsl */ `
  // >1 highlights clamp into the display domain (ToneCurve/HSL convention)
  let e = srgbEncode(clamp(c, vec3f(0.0), vec3f(1.0)));
  let y = dot(e, ${DETAIL_LUMA});
  c = vec3f(y, e.b - y, e.r - y);
`,
});

const DETAIL_DEC_WGSL = nodePassWgsl({
  helpers: WGSL_SRGB_DECODE,
  body: /* wgsl */ `
  let r = c.x + c.z;
  let b = c.x + c.y;
  let g = (c.x - ${DETAIL_WR} * r - ${DETAIL_WB} * b) / ${DETAIL_WG};
  c = srgbDecode(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)));
`,
});

// Luminance NR: bilateral on Y — spatial gaussian × range gaussian on the
// luma difference, so noise (small ΔY) averages while edges survive; amount
// drives BOTH the range sigma and the blend with the original. Color NR:
// gaussian on Cb/Cr with a loose luma-edge guard. Y untouched by color NR
// and Cb/Cr by luminance NR.
//
// LR six-knob sub-sliders (manual-noise-reduction pack) ride the SAME
// bilateral math above via four named mapping constants (packNr): Luminance
// Detail/Contrast tune the luma range sigma / re-inject high-frequency luma
// after smoothing; Color Detail/Smoothness tune the chroma luma-edge guard /
// chroma spatial sigma. Every mapping is centered on its default sub-slider
// value (50/0/50/50) so f(default) reproduces today's fixed constants
// exactly — see packNr's doc comment for the f(default)=1 proof.
const DETAIL_NR_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct NrParams {
  // x = 1/(2σ²) luma spatial, y = 1/(2σ²) chroma spatial,
  // z = kernel radius (whole render px), w = 1/(2σ²) luma range
  p0: vec4f,
  // x = luma blend, y = chroma blend, z = 1/(2σ²) chroma luma-edge guard,
  // w = luma high-frequency contrast re-injection fraction (0 at default)
  p1: vec4f,
}
@group(0) @binding(1) var<uniform> u: NrParams;
`,
  body: /* wgsl */ `
  {
    let p = vec2i(in.pos.xy);
    let dims = vec2i(textureDimensions(src));
    let v0 = c0;
    let R = i32(u.p0.z);
    var sumY = 0.0;
    var wY = 0.0;
    var sumC = vec2f(0.0);
    var wC = 0.0;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        let q = clamp(p + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
        let v = textureLoad(src, q, 0);
        let d2 = f32(dx * dx + dy * dy);
        let dl = v.x - v0.x;
        let wl = exp(-d2 * u.p0.x - dl * dl * u.p0.w);
        sumY += v.x * wl;
        wY += wl;
        let wc = exp(-d2 * u.p0.y - dl * dl * u.p1.z);
        sumC += v.yz * wc;
        wC += wc;
      }
    }
    // Luminance Contrast: re-inject a fraction of the high-frequency luma the
    // bilateral filter removed (fights the "plastic" over-smoothed look)
    // BEFORE blending toward the original by amount; 0 at default leaves
    // this numerically identical to the plain filtered result.
    let filteredY = sumY / wY;
    let restoredY = filteredY + u.p1.w * (v0.x - filteredY);
    c = vec3f(mix(v0.x, restoredY, u.p1.x), mix(v0.yz, sumC / wC, u.p1.y));
  }
`,
});

// Sharpen: unsharp mask on Y — y′ = y + amount·mask·(y − gauss(y, σ)). The
// same loop accumulates the gaussian-derivative gradient of the smoothed
// luma; σ-normalized it measures the local EDGE HEIGHT, which drives the
// Masking term (0 = everywhere, 100 = strong edges only, LR Masking).
const DETAIL_SHARPEN_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct SharpenParams {
  // x = 1/(2σ²), y = kernel radius (render px), z = amount, w = masking 0..1
  p0: vec4f,
  // x = 1/σ (gradient normalization)
  p1: vec4f,
}
@group(0) @binding(1) var<uniform> u: SharpenParams;
`,
  body: /* wgsl */ `
  {
    let p = vec2i(in.pos.xy);
    let dims = vec2i(textureDimensions(src));
    let v0 = c0;
    let R = i32(u.p0.y);
    var sum = 0.0;
    var wsum = 0.0;
    var g = vec2f(0.0);
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        let q = clamp(p + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
        let y = textureLoad(src, q, 0).x;
        let w = exp(-f32(dx * dx + dy * dy) * u.p0.x);
        sum += y * w;
        wsum += w;
        g += vec2f(f32(dx), f32(dy)) * (y * w);
      }
    }
    let blur = sum / wsum;
    // σ-normalized gradient of the smoothed luma ≈ 0.4 × edge height
    let grad = length(g) / wsum * u.p1.x;
    var mask = 1.0;
    if (u.p0.w > 0.0) {
      // flat-area noise gradients sit ≲0.005 after smoothing, real edges
      // ≳0.03 — masking 100 zeroes the former, keeps the latter
      let t = 0.05 * u.p0.w;
      mask = smoothstep(0.25 * t, 1.5 * t, grad);
    }
    c = vec3f(clamp(v0.x + u.p0.z * mask * (v0.x - blur), 0.0, 1.0), v0.yz);
  }
`,
});

const inv2s2 = (sigma: number): number => 1 / (2 * sigma * sigma);

/**
 * LR six-knob sub-slider mapping constants — LR-CALIBRATION CANDIDATES.
 * Each sub-slider (0–100) scales an EXISTING bilateral degree of freedom by
 * a ±1-stop (2×) multiplier centered on its default value, so at the
 * default sub-slider the multiplier is exactly 1 and every formula below
 * reduces to today's fixed constant — f(default) = today's behavior, for
 * ANY amount. Only the spread (how many stops 0..100 travels) is a tuning
 * choice; the recentering itself is what buys back-compat.
 */
const NR_LUM_DETAIL_RANGE_STOPS = 1.0;
/** Luminance NR "Contrast": max fraction of the removed high-frequency luma re-injected at contrast=100 (0 at the contrast=0 default — no-op). */
const NR_LUM_CONTRAST_GAIN = 0.6;
const NR_COLOR_DETAIL_RANGE_STOPS = 1.0;
const NR_COLOR_SMOOTHNESS_SIGMA_STOPS = 1.0;

/** 2^((default - v) / 50 * stops): the sub-slider → multiplier curve shared by all four mappings (1 at v = default). */
const subSliderMul = (v: number, defaultV: number, stops: number): number => Math.pow(2, ((defaultV - v) / 50) * stops);

function packNr(d: DetailParams, scale: number): ArrayBuffer {
  const aL = Math.min(1, d.noiseLuminance.amount / 100);
  const aC = Math.min(1, d.noiseColor.amount / 100);
  const sLum = Math.max(DETAIL_SIGMA_MIN, NR_LUM_SIGMA_FULL * scale);
  // Color Smoothness: chroma SPATIAL sigma scale (how large a color blotch
  // gets averaged away) — centered at 50 so the default leaves NR_CHROMA_SIGMA_FULL untouched.
  const chromaSpatialMul = subSliderMul(d.noiseColor.smoothness, 50, -NR_COLOR_SMOOTHNESS_SIGMA_STOPS);
  const sChroma = Math.max(DETAIL_SIGMA_MIN, NR_CHROMA_SIGMA_FULL * scale * chromaSpatialMul);
  // the kernel radius covers only the ACTIVE component(s)
  const sMax = Math.max(aL > 0 ? sLum : 0, aC > 0 ? sChroma : 0);
  const radius = Math.min(NR_KERNEL_RADIUS_MAX, Math.max(1, Math.ceil(2 * sMax)));
  // Luminance Detail: luma RANGE sigma (encoded-luma units) — higher detail
  // = smaller sigma = more structure counts as edge and survives; centered
  // at 50 so the default leaves the old `0.02 + 0.1·amount` formula intact.
  const lumaRangeMul = subSliderMul(d.noiseLuminance.detail, 50, NR_LUM_DETAIL_RANGE_STOPS);
  const sigmaRange = (0.02 + 0.1 * aL) * lumaRangeMul;
  // Color Detail: chroma range sigma — same shape as Luminance Detail, but
  // scales the chroma pass's loose luma-edge guard (was a fixed 0.25).
  const chromaGuardMul = subSliderMul(d.noiseColor.detail, 50, NR_COLOR_DETAIL_RANGE_STOPS);
  const chromaGuardSigma = 0.25 * chromaGuardMul;
  // Luminance Contrast: 0 at the default (contrast=0) — see DETAIL_NR_WGSL.
  const contrastReinject = (d.noiseLuminance.contrast / 100) * NR_LUM_CONTRAST_GAIN;
  const buf = new ArrayBuffer(32);
  const f = new Float32Array(buf);
  f[0] = inv2s2(sLum);
  f[1] = inv2s2(sChroma);
  f[2] = radius;
  f[3] = inv2s2(sigmaRange);
  f[4] = aL;
  f[5] = aC;
  f[6] = inv2s2(chromaGuardSigma);
  f[7] = contrastReinject;
  return buf;
}

/**
 * Sharpen slider scale — LR-CALIBRATION 2026-07-12: per slider unit our
 * unsharp mask measured ~2.4× weaker than LR Classic's (matching LR's
 * default RAW sharpening of amount 40 needed our ~96): fine-scale
 * local-contrast energy Δ at amount 40 was 1.12 vs LR's 2.72. This gain
 * aligns the slider scale so our 40 ≈ LR's 40.
 */
const DETAIL_SHARPEN_GAIN = 2.4;

function packSharpen(d: DetailParams, scale: number): ArrayBuffer {
  const s = d.sharpen;
  const sigma = Math.max(DETAIL_SIGMA_MIN, s.radius * scale);
  const radius = Math.min(SHARPEN_KERNEL_RADIUS_MAX, Math.max(1, Math.ceil(2.5 * sigma)));
  const buf = new ArrayBuffer(32);
  const f = new Float32Array(buf);
  f[0] = inv2s2(sigma);
  f[1] = radius;
  f[2] = DETAIL_SHARPEN_GAIN * (s.amount / 100); // slider 100 → GAIN× the highpass
  f[3] = Math.min(1, Math.max(0, s.masking / 100));
  f[4] = 1 / sigma;
  return buf;
}

// --- Effects: dehaze/vignette/grain (fx-pixel) + clarity/texture (fx-spatial) --
//
// fx-spatial (clarity/texture) mirrors the Detail architecture exactly: the
// SAME luma/chroma encode/decode brackets (DETAIL_ENC_WGSL / DETAIL_DEC_WGSL,
// reused verbatim — they are pure YCbCr-style transforms, not Detail-
// specific) around two independent unsharp-mask stages on Y. It sits BEFORE
// Detail in the chain and has no CPU mirror (spatial, like Detail).
//
// fx-pixel (dehaze, vignette, grain) runs AFTER Detail, in DISPLAY (sRGB-
// encoded) space, in that fixed order (grain last). Vignette and grain are
// POSITION-aware but still per-pixel (no neighborhood reads), so they keep an
// exact CPU mirror — the mirror takes the render-target texel coords (x, y)
// and its (width, height), matching the GPU fragment's `in.pos.xy` /
// `textureDimensions(src)` 1:1 (confirmed: the CPU reference in CanvasView
// iterates the SAME-resolution decoded image the GPU renders at).

// Effects tuning constants — LR-CALIBRATION CANDIDATES. The reference for the
// Effects sliders' range/feel is Lightroom; these first-pass strengths and
// sigmas are meant to be recalibrated against LR side-by-side in a follow-up
// session. Recalibrate HERE only — the passes and CPU mirrors consume these
// named constants, so the formulas never need to change.
/**
 * Dehaze ±100 → black-point shift k = ±this (encoded units; must stay < 1).
 * LR-calibrated 2026-07-12 (0.3 → 0.14): measured on three scenes, our +50
 * darkened mids 2-3× more than LR Classic's (+50 mid-L delta ours −5..−15 vs
 * LR −2..−8); 0.14 puts the luminance response in LR's band.
 */
const FX_DEHAZE_STRENGTH = 0.14;
/**
 * Dehaze ±100 → ±this saturation lift around encoded luma. LR's dehaze
 * REVIVES color as it cuts haze (measured +50 chroma delta up to +12 on a
 * genuinely hazy sunset while ours added ≤ +3) — a black-point stretch
 * alone can't reproduce that, hence the explicit coupling. Same 2026-07-12
 * calibration session.
 */
const FX_DEHAZE_SAT = 0.22;
/**
 * Vignette ±100 → ±this many stops of exp2 gain at the far corners.
 * LR-calibrated 2026-07-12: LR Classic's post-crop vignette −50 moved the
 * corner/center luma ratio ~3× more than our 1.5-stop scale did
 * (Δ −0.383 vs −0.121 on the church interior); 4.5 puts −50 ≈ −2.3 stops
 * at the corner, matching LR's dramatic range.
 */
const FX_VIGNETTE_STOPS = 4.5;
/**
 * Clarity ±100 → this × the (midtone-weighted) luma highpass.
 * LR-calibrated 2026-07-12: +50 measured slightly weak vs LR (local-
 * contrast energy Δ 4.01 vs LR 5.16 at σ≈15px-full-res scale) — 0.6 → 0.75.
 */
const FX_CLARITY_GAIN = 0.75;
/** Clarity gaussian sigma in FULL-RESOLUTION pixels. */
const FX_CLARITY_SIGMA_FULL = 15.0;
/**
 * Texture ±100 → this × the (unweighted) luma highpass.
 * LR-calibrated 2026-07-12: our +50 measured 5-6× STRONGER than LR's on
 * both test scenes (fine-scale local-contrast energy Δ 4.16/1.08 vs LR
 * 0.80/0.17) — LR's texture is a subtle mid-frequency lift; 0.8 → 0.15.
 */
const FX_TEXTURE_GAIN = 0.15;
/** Texture gaussian sigma in FULL-RESOLUTION pixels. */
const FX_TEXTURE_SIGMA_FULL = 3.0;
/** Grain 100 → ±this noise amplitude in encoded units. */
const FX_GRAIN_AMPLITUDE = 0.25;
/** Kernel radius caps (render px) — perf guard, same convention as Detail. */
const FX_CLARITY_KERNEL_RADIUS_MAX = 32;
const FX_TEXTURE_KERNEL_RADIUS_MAX = 10;

// Clarity: gaussian blur of Y (sigma 15px full-res) + midtone-weighted USM.
const FX_CLARITY_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct ClarityParams {
  // x = 1/(2σ²), y = kernel radius (render px), z = amount (already ×0.6)
  p0: vec4f,
}
@group(0) @binding(1) var<uniform> u: ClarityParams;
`,
  body: /* wgsl */ `
  {
    let p = vec2i(in.pos.xy);
    let dims = vec2i(textureDimensions(src));
    let v0 = c0;
    let R = i32(u.p0.y);
    var sum = 0.0;
    var wsum = 0.0;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        let q = clamp(p + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
        let yv = textureLoad(src, q, 0).x;
        let w = exp(-f32(dx * dx + dy * dy) * u.p0.x);
        sum += yv * w;
        wsum += w;
      }
    }
    let blur = sum / wsum;
    // midtone weight: clarity favors midtones, leaves shadows/highlights alone
    let wgt = clamp(4.0 * v0.x * (1.0 - v0.x), 0.0, 1.0);
    c = vec3f(clamp(v0.x + u.p0.z * wgt * (v0.x - blur), 0.0, 1.0), v0.yz);
  }
`,
});

// Texture: gaussian blur of Y (sigma 3px full-res) + flat (unweighted) USM.
const FX_TEXTURE_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct TextureParams {
  // x = 1/(2σ²), y = kernel radius (render px), z = amount (already ×0.8)
  p0: vec4f,
}
@group(0) @binding(1) var<uniform> u: TextureParams;
`,
  body: /* wgsl */ `
  {
    let p = vec2i(in.pos.xy);
    let dims = vec2i(textureDimensions(src));
    let v0 = c0;
    let R = i32(u.p0.y);
    var sum = 0.0;
    var wsum = 0.0;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        let q = clamp(p + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
        let yv = textureLoad(src, q, 0).x;
        let w = exp(-f32(dx * dx + dy * dy) * u.p0.x);
        sum += yv * w;
        wsum += w;
      }
    }
    let blur = sum / wsum;
    c = vec3f(clamp(v0.x + u.p0.z * (v0.x - blur), 0.0, 1.0), v0.yz);
  }
`,
});

function packClarity(e: EffectsParams, scale: number): ArrayBuffer {
  const sigma = Math.max(DETAIL_SIGMA_MIN, FX_CLARITY_SIGMA_FULL * scale);
  const radius = Math.min(FX_CLARITY_KERNEL_RADIUS_MAX, Math.max(1, Math.ceil(2.5 * sigma)));
  const buf = new ArrayBuffer(16);
  const f = new Float32Array(buf);
  f[0] = inv2s2(sigma);
  f[1] = radius;
  f[2] = (e.clarity / 100) * FX_CLARITY_GAIN;
  return buf;
}

function packTexture(e: EffectsParams, scale: number): ArrayBuffer {
  const sigma = Math.max(DETAIL_SIGMA_MIN, FX_TEXTURE_SIGMA_FULL * scale);
  const radius = Math.min(FX_TEXTURE_KERNEL_RADIUS_MAX, Math.max(1, Math.ceil(2.5 * sigma)));
  const buf = new ArrayBuffer(16);
  const f = new Float32Array(buf);
  f[0] = inv2s2(sigma);
  f[1] = radius;
  f[2] = (e.texture / 100) * FX_TEXTURE_GAIN;
  return buf;
}

/** Integer-hash noise (pcg), shared verbatim in spirit between WGSL and CPU. */
const WGSL_PCG_HASH = /* wgsl */ `
fn pcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
`;

// fx-pixel: dehaze → vignette → grain (grain intentionally last), all in
// DISPLAY (sRGB-encoded) space, one pass, one uniform buffer.
const FX_PIXEL_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct FxPixelParams {
  // x = dehaze k (±FX_DEHAZE_STRENGTH), y = vignette exponent scale,
  // z = vignette midpoint, w = grain amplitude
  p0: vec4f,
  // x = grain cell size (render px), y = dehaze saturation lift
  // (±FX_DEHAZE_SAT), zw unused
  p1: vec4f,
}
@group(0) @binding(1) var<uniform> u: FxPixelParams;
`,
  helpers: WGSL_SRGB_ENCODE + WGSL_SRGB_DECODE + WGSL_PCG_HASH + WGSL_LUMA,
  body: /* wgsl */ `
  {
    var e = srgbEncode(clamp(c, vec3f(0.0), vec3f(1.0)));

    // 1. Dehaze: k — black-point stretch (never divides by zero) + the
    // LR-character saturation coupling (haze removal revives color; see
    // FX_DEHAZE_SAT). Branched so dehaze=0 stays numerically untouched.
    let k = u.p0.x;
    e = clamp((e - vec3f(k)) / (1.0 - k), vec3f(0.0), vec3f(1.0));
    let dsat = u.p1.y;
    if (dsat != 0.0) {
      let yD = luma(e);
      e = clamp(vec3f(yD) + (e - vec3f(yD)) * (1.0 + dsat), vec3f(0.0), vec3f(1.0));
    }

    // 2. Vignette: radial falloff from image center; corner r = 1
    let dims = vec2f(textureDimensions(src));
    let uv = in.pos.xy / dims;
    let d = (uv - vec2f(0.5)) * 2.0;
    let r = length(d) / sqrt(2.0);
    let falloff = smoothstep(u.p0.z, 1.0, r);
    let gain = exp2(u.p0.y * falloff);
    e = clamp(e * gain, vec3f(0.0), vec3f(1.0));

    // 3. Grain: monochrome integer-hash noise, applied at RENDER resolution
    // (no renderScale compensation — grain is a stylistic texture, not a
    // measurement, so preview and full-res export show different apparent
    // grain scale).
    let p = vec2i(in.pos.xy);
    let cell = vec2u(vec2i(floor(vec2f(p) / u.p1.x)));
    let h = pcgHash(cell.x + pcgHash(cell.y));
    let n = (f32(h) / 4294967295.0 - 0.5) * 2.0;
    e = clamp(e + vec3f(n * u.p0.w), vec3f(0.0), vec3f(1.0));

    c = srgbDecode(e);
  }
`,
});

function packFxPixel(e: EffectsParams): Float32Array {
  const f = new Float32Array(8); // p0 (4) + p1 (4)
  f[0] = FX_DEHAZE_STRENGTH * (e.dehaze / 100);
  f[1] = FX_VIGNETTE_STOPS * (e.vignette / 100);
  f[2] = e.vignetteMidpoint;
  f[3] = (e.grain / 100) * FX_GRAIN_AMPLITUDE;
  f[4] = e.grainSize;
  f[5] = FX_DEHAZE_SAT * (e.dehaze / 100);
  return f;
}

/** CPU mirror of pcgHash — u32 ops via Math.imul + unsigned shifts, in lockstep with the WGSL. */
function pcgHashCpu(v: number): number {
  const vv = v >>> 0;
  const s = (Math.imul(vv, 747796405) + 2891336453) >>> 0;
  const shift = (s >>> 28) + 4;
  const t = ((s >>> shift) ^ s) >>> 0;
  const w = Math.imul(t, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/**
 * Mirror of the fx-pixel pass: dehaze → vignette → grain, in that order.
 * `x`/`y` are the render-target's integer texel coords, `width`/`height` its
 * dimensions — the CPU-side equivalent of `in.pos.xy` / `textureDimensions`.
 */
function cpuFxPixel(px: Rgb, u: Float32Array, x: number, y: number, width: number, height: number): Rgb {
  let e: Rgb = [
    srgbEncode(Math.min(Math.max(px[0], 0), 1)),
    srgbEncode(Math.min(Math.max(px[1], 0), 1)),
    srgbEncode(Math.min(Math.max(px[2], 0), 1)),
  ];
  // 1. Dehaze: black-point stretch + the LR-character saturation coupling
  // (branched exactly like the WGSL so dehaze=0 stays numerically untouched)
  const k = u[0]!;
  const dehaze = (v: number) => Math.min(Math.max((v - k) / (1 - k), 0), 1);
  e = [dehaze(e[0]), dehaze(e[1]), dehaze(e[2])];
  const dsat = u[5]!;
  if (dsat !== 0) {
    const yD = lumaCpu(e[0], e[1], e[2]);
    const satF = (v: number) => Math.min(Math.max(yD + (v - yD) * (1 + dsat), 0), 1);
    e = [satF(e[0]), satF(e[1]), satF(e[2])];
  }
  // 2. Vignette
  const uvx = (x + 0.5) / width;
  const uvy = (y + 0.5) / height;
  const dx = (uvx - 0.5) * 2;
  const dy = (uvy - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
  const falloff = smoothstepCpu(u[2]!, 1, r);
  const gain = Math.pow(2, u[1]! * falloff);
  const vig = (v: number) => Math.min(Math.max(v * gain, 0), 1);
  e = [vig(e[0]), vig(e[1]), vig(e[2])];
  // 3. Grain
  const grainSize = u[4]!;
  const cellX = Math.floor(x / grainSize) >>> 0;
  const cellY = Math.floor(y / grainSize) >>> 0;
  const h = pcgHashCpu((cellX + pcgHashCpu(cellY)) >>> 0);
  const n = (h / 4294967295 - 0.5) * 2;
  const g = n * u[3]!;
  const grain = (v: number) => Math.min(Math.max(v + g, 0), 1);
  e = [grain(e[0]), grain(e[1]), grain(e[2])];
  return [srgbDecode(e[0]), srgbDecode(e[1]), srgbDecode(e[2])];
}

export interface CompiledDevelop {
  passes: PassSpec[];
  /** null when Detail or fx-spatial is active — spatial kernels have no per-pixel mirror. */
  cpu: ((px: Rgb, x: number, y: number, width: number, height: number) => Rgb) | null;
}

/**
 * Compile the Develop node: passes for the active sections (identity
 * sections contribute none) plus the matching CPU mirror. `wbGains` comes
 * from the per-image Kelvin/Tint model (exactly [1,1,1] at as-shot). The
 * tone-curve LUT is baked once and shared by the GPU pass and the mirror.
 * `renderScale` (renderLongEdge/fullLongEdge) scales the Detail kernels.
 */
export function compileDevelop(
  params: DevelopParams,
  wbGains: [number, number, number],
  renderScale: number
): CompiledDevelop {
  const b = params.basic;
  const wbActive = wbGains[0] !== 1 || wbGains[1] !== 1 || wbGains[2] !== 1;
  const toneActive =
    wbActive ||
    b.ev !== 0 ||
    b.contrast !== 0 ||
    b.highlights !== 0 ||
    b.shadows !== 0 ||
    b.whites !== 0 ||
    b.blacks !== 0;
  const curveActive = !isIdentityToneCurve(params.toneCurve);
  const hslActive = !isIdentityHsl(params.hsl);
  const colorActive = b.saturation !== 0 || b.vibrance !== 0;
  const gradingActive = !isIdentityGrading(params.grading);
  const d = params.detail;
  const nrActive = d.noiseLuminance.amount > 0 || d.noiseColor.amount > 0;
  const sharpenActive = d.sharpen.amount > 0;
  const detailActive = !isIdentityDetail(d);
  const e = params.effects;
  const fxSpatialActive = !isIdentityEffectsSpatial(e);
  const clarityActive = e.clarity !== 0;
  const textureActive = e.texture !== 0;
  const fxPixelActive = !isIdentityEffectsPixel(e);
  const scale = Math.min(1, Math.max(1e-4, renderScale));

  const lut = curveActive ? buildToneCurveLut(params.toneCurve) : null;
  const hslBands = hslActive ? packHsl(params.hsl) : null;
  const grading = gradingActive ? packGrading(params.grading) : null;
  const fxPixel = fxPixelActive ? packFxPixel(e) : null;
  const passes: PassSpec[] = [];
  if (toneActive) passes.push({ shaderId: 'develop/tone', wgsl: TONE_WGSL, uniforms: packTone(b, wbGains) });
  if (lut) {
    passes.push({ shaderId: 'develop/toneCurve', wgsl: TONECURVE_WGSL, uniforms: lut.buffer as ArrayBuffer });
  }
  if (hslBands) {
    passes.push({ shaderId: 'develop/hsl', wgsl: HSL_WGSL, uniforms: hslBands.buffer as ArrayBuffer });
  }
  if (colorActive) passes.push({ shaderId: 'develop/color', wgsl: COLOR_WGSL, uniforms: packColor(b) });
  if (grading) {
    passes.push({ shaderId: 'develop/grading', wgsl: GRADING_WGSL, uniforms: grading.buffer as ArrayBuffer });
  }
  if (fxSpatialActive) {
    // clarity → texture bracketed by the SAME luma/chroma encode/decode
    // passes Detail uses (reused verbatim — they carry no Detail-specific
    // state), placed BEFORE Detail in the chain.
    passes.push({ shaderId: 'develop/detailEnc', wgsl: DETAIL_ENC_WGSL, uniforms: new ArrayBuffer(0) });
    if (clarityActive) {
      passes.push({ shaderId: 'develop/fxClarity', wgsl: FX_CLARITY_WGSL, uniforms: packClarity(e, scale) });
    }
    if (textureActive) {
      passes.push({ shaderId: 'develop/fxTexture', wgsl: FX_TEXTURE_WGSL, uniforms: packTexture(e, scale) });
    }
    passes.push({ shaderId: 'develop/detailDec', wgsl: DETAIL_DEC_WGSL, uniforms: new ArrayBuffer(0) });
  }
  if (detailActive) {
    // NR → sharpen bracketed by the luma/chroma encode/decode passes
    passes.push({ shaderId: 'develop/detailEnc', wgsl: DETAIL_ENC_WGSL, uniforms: new ArrayBuffer(0) });
    if (nrActive) passes.push({ shaderId: 'develop/detailNr', wgsl: DETAIL_NR_WGSL, uniforms: packNr(d, scale) });
    if (sharpenActive) {
      passes.push({ shaderId: 'develop/detailSharpen', wgsl: DETAIL_SHARPEN_WGSL, uniforms: packSharpen(d, scale) });
    }
    passes.push({ shaderId: 'develop/detailDec', wgsl: DETAIL_DEC_WGSL, uniforms: new ArrayBuffer(0) });
  }
  if (fxPixel) {
    // dehaze → vignette → grain (grain intentionally last), always runs LAST
    passes.push({ shaderId: 'develop/fxPixel', wgsl: FX_PIXEL_WGSL, uniforms: fxPixel.buffer as ArrayBuffer });
  }

  const cpu =
    detailActive || fxSpatialActive
      ? null // spatial kernels have no per-pixel CPU mirror
      : (px: Rgb, x: number, y: number, width: number, height: number): Rgb => {
          let out = px;
          if (toneActive) out = cpuDevelopTone(out, b, wbGains);
          if (lut) out = cpuToneCurve(out, lut);
          if (hslBands) out = cpuHsl(out, hslBands);
          if (colorActive) out = cpuSaturationVibrance(out, b.saturation / 100, b.vibrance / 100);
          if (grading) out = cpuGrading(out, grading);
          if (fxPixel) out = cpuFxPixel(out, fxPixel, x, y, width, height);
          return out;
        };
  return { passes, cpu };
}

/** Mirror of the HSL pass: encode → band adjust → decode. */
function cpuHsl(px: Rgb, bands: Float32Array): Rgb {
  const enc: Rgb = [
    srgbEncode(Math.min(Math.max(px[0], 0), 1)),
    srgbEncode(Math.min(Math.max(px[1], 0), 1)),
    srgbEncode(Math.min(Math.max(px[2], 0), 1)),
  ];
  const out = cpuHslBandsEncoded(enc, bands);
  return [srgbDecode(out[0]), srgbDecode(out[1]), srgbDecode(out[2])];
}

/** Mirror of the toneCurve pass: encode → LUT lookup (lerp) → decode. */
function cpuToneCurve(px: Rgb, lut: Float32Array): Rgb {
  const lookup = (v: number, ch: number): number => {
    const f = Math.min(Math.max(v, 0), 1) * (TONE_CURVE_LUT_SIZE - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, TONE_CURVE_LUT_SIZE - 1);
    const a = lut[i0 * 4 + ch]!;
    return a + (lut[i1 * 4 + ch]! - a) * (f - i0);
  };
  return [
    srgbDecode(lookup(srgbEncode(px[0]), 0)),
    srgbDecode(lookup(srgbEncode(px[1]), 1)),
    srgbDecode(lookup(srgbEncode(px[2]), 2)),
  ];
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

