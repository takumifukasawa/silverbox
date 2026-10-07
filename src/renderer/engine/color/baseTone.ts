/**
 * Base tone — the named display transform that maps the neutral, scene-
 * referred decode into display range (docs/decisions/0001 + 0002). Stored as
 * `develop.profile.baseTone`; applied in LINEAR working space between the
 * Basic tone stage and the user tone curve, so it sees (and rolls off) values
 * above 1.0 that the clamped, display-space tone curve never could.
 *
 * Every id is a FOREVER contract: a sidecar must render the same forever, so
 * never change the math under an existing id — add a new id instead. The
 * formulas match scripts/drt-compare/drts.mjs (the comparison the user chose
 * from, 2026-10-07), except `sigmoid`, re-based before release (below).
 *
 * Third-party math (THIRD_PARTY_NOTICES.md): `agx` and `agx_punchy` are
 * Benjamin Wrensch's minimal AgX and its Punchy look (MIT — its notice must
 * ship with the app); `aces` is Krzysztof Narkowicz's ACES fit (CC0).
 * `sigmoid` uses darktable's sigmoid module DEFAULT parameters (contrast 1.5,
 * skew 0, target white 100 %, target black 0.0152 %, middle grey 0.1845) on
 * a generalized log-logistic curve whose constants we solve ourselves from
 * those targets; its hue preservation is our own hexcone version of the same
 * idea. No darktable (GPL) code is used — see docs/references/
 * display-transforms.md.
 *
 * Each transform starts with the same +1 EV pre-gain (darktable-style: the
 * neutral decode sits ~1.4 EV under LR's default); 'none' has no gain and
 * emits no pass.
 */
import { SRGB_TO_WORK, WGSL_SRGB_TO_WORK, WGSL_WORK_TO_SRGB, WGSL_WORKING_LUMA, WORK_TO_SRGB, WORKING_LUMA } from './workingSpace';

export const BASE_TONE_IDS = ['none', 'reinhard', 'sigmoid', 'agx', 'agx_punchy', 'aces'] as const;
export type BaseToneId = (typeof BASE_TONE_IDS)[number];

export const BASE_TONE_LABELS: Record<BaseToneId, string> = {
  none: 'None',
  reinhard: 'Reinhard',
  sigmoid: 'Sigmoid',
  agx: 'AgX',
  agx_punchy: 'AgX Punchy',
  aces: 'ACES',
};

/** Unknown/absent → 'none' (sidecar-spec.md rule 7: sanitize quietly, never reject). */
export function sanitizeBaseTone(v: unknown): BaseToneId {
  return typeof v === 'string' && (BASE_TONE_IDS as readonly string[]).includes(v) ? (v as BaseToneId) : 'none';
}

const PRE_GAIN = 2.0;
/** rgba16float's max finite value — the pre-gained input is clamped here so a stray Inf can't turn into NaN. */
const INPUT_MAX = 65504.0;
/** Reinhard white point: the pre-gained sensor-saturation peak (≈1.41 · 2). */
const REINHARD_WHITE = 2.83;
/**
 * Sigmoid (darktable sigmoid defaults): f(x) = W · (fog + x)^n / (paper + (fog + x)^n),
 * with f(0) = BLACK, f(GREY) = GREY, f(∞) = W. With skew 0 and W = 1 the
 * slope at GREY is n · (1 − GREY), so n is the contrast parameter itself.
 */
const SIGMOID_GREY = 0.1845;
const SIGMOID_CONTRAST = 1.5;
const SIGMOID_WHITE = 1.0;
const SIGMOID_BLACK = 0.000152;
const SIGMOID_WG = SIGMOID_WHITE / SIGMOID_GREY - 1;
const SIGMOID_WB = SIGMOID_WHITE / SIGMOID_BLACK - 1;
const SIGMOID_FOG =
  (SIGMOID_GREY * Math.pow(SIGMOID_WG, 1 / SIGMOID_CONTRAST)) /
  (Math.pow(SIGMOID_WB, 1 / SIGMOID_CONTRAST) - Math.pow(SIGMOID_WG, 1 / SIGMOID_CONTRAST));
const SIGMOID_PAPER = Math.pow(SIGMOID_FOG + SIGMOID_GREY, SIGMOID_CONTRAST) * SIGMOID_WG;
/** Wrensch's Punchy look (power, saturation), applied in AgX space after the curve. */
const AGX_PUNCHY_POWER = 1.35;
const AGX_PUNCHY_SAT = 1.4;
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
/** AgX inset/outset matrices as COLUMNS (Wrensch's minimal AgX; GLSL/WGSL column order). */
const AGX_INSET_COLS: readonly (readonly [number, number, number])[] = [
  [0.842479062253094, 0.0423282422610123, 0.0423756549057051],
  [0.0784335999999992, 0.878468636469772, 0.0784336],
  [0.0792237451477643, 0.0791661274605434, 0.879142973793104],
];
const AGX_OUTSET_COLS: readonly (readonly [number, number, number])[] = [
  [1.19687900512017, -0.0528968517574562, -0.0529716355144438],
  [-0.0980208811401368, 1.15190312990417, -0.0980434501171241],
  [-0.0990297440797205, -0.0989611768448433, 1.15107367264116],
];

const f = (v: number): string => {
  const s = String(v);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};
const wgslCols = (cols: readonly (readonly [number, number, number])[]): string =>
  `mat3x3f(${cols.map((c) => `vec3f(${c.map(f).join(', ')})`).join(', ')})`;

/**
 * WGSL pass body for `id` (operates on `var c: vec3f`, linear working RGB),
 * or null for 'none'. Wrapped by developNode's nodePassWgsl.
 */
export function baseToneWgslBody(id: BaseToneId): string | null {
  const pre = `  let x = clamp(c * ${f(PRE_GAIN)}, vec3f(0.0), vec3f(${f(INPUT_MAX)}));\n`;
  switch (id) {
    case 'none':
      return null;
    case 'reinhard':
      return (
        pre +
        /* wgsl */ `
  let L = max(dot(x, ${WGSL_WORKING_LUMA}), 1e-6);
  let Ld = L * (1.0 + L / (${f(REINHARD_WHITE)} * ${f(REINHARD_WHITE)})) / (1.0 + L);
  c = x * (Ld / L);
`
      );
    case 'sigmoid':
      // Negatives are desaturated toward the channel mean (not clipped per
      // channel, which would shift hue); then the curve runs on the min and
      // max channels and the middle channel keeps its hexcone position
      // (mid − min)/(max − min), so hue is preserved exactly.
      return /* wgsl */ `
  var x = clamp(c * ${f(PRE_GAIN)}, vec3f(-${f(INPUT_MAX)}), vec3f(${f(INPUT_MAX)}));
  let m = max((x.r + x.g + x.b) / 3.0, 0.0);
  let lo = min(x.r, min(x.g, x.b));
  if (lo < 0.0) {
    x = vec3f(m) + (m / (m - lo)) * (x - vec3f(m));
  }
  x = max(x, vec3f(0.0));
  let xmin = min(x.r, min(x.g, x.b));
  let xmax = max(x.r, max(x.g, x.b));
  let a = pow(vec2f(${f(SIGMOID_FOG)}) + vec2f(xmin, xmax), vec2f(${f(SIGMOID_CONTRAST)}));
  let fm = ${f(SIGMOID_WHITE)} * a / (vec2f(${f(SIGMOID_PAPER)}) + a);
  if (xmax - xmin > 1e-9) {
    c = vec3f(fm.x) + (fm.y - fm.x) * (x - vec3f(xmin)) / (xmax - xmin);
  } else {
    c = vec3f(fm.y);
  }
`;
    case 'agx':
    case 'agx_punchy':
      return (
        pre +
        /* wgsl */ `
  var v = ${wgslCols(AGX_INSET_COLS)} * max(${WGSL_WORK_TO_SRGB} * x, vec3f(1e-10));
  v = clamp(log2(v), vec3f(${f(AGX_MIN_EV)}), vec3f(${f(AGX_MAX_EV)}));
  v = (v - vec3f(${f(AGX_MIN_EV)})) / ${f(AGX_MAX_EV - AGX_MIN_EV)};
  let v2 = v * v;
  let v4 = v2 * v2;
  v = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - vec3f(0.00232);
${
  id === 'agx_punchy'
    ? `  let lum = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3f(0.0)), vec3f(${f(AGX_PUNCHY_POWER)}));
  v = vec3f(lum) + ${f(AGX_PUNCHY_SAT)} * (v - vec3f(lum));
`
    : ''
}  v = ${wgslCols(AGX_OUTSET_COLS)} * v;
  c = ${WGSL_SRGB_TO_WORK} * pow(max(v, vec3f(0.0)), vec3f(2.2));
`
      );
    case 'aces':
      return (
        pre +
        /* wgsl */ `
  let y = x * 0.6;
  c = clamp((y * (2.51 * y + vec3f(0.03))) / (y * (2.43 * y + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));
`
      );
  }
}

type Rgb = [number, number, number];

const mulRows = (m: readonly (readonly number[])[], v: Rgb): Rgb => [
  m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
  m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
  m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
];
const mulCols = (cols: readonly (readonly [number, number, number])[], v: Rgb): Rgb => [
  cols[0]![0] * v[0] + cols[1]![0] * v[1] + cols[2]![0] * v[2],
  cols[0]![1] * v[0] + cols[1]![1] * v[1] + cols[2]![1] * v[2],
  cols[0]![2] * v[0] + cols[1]![2] * v[1] + cols[2]![2] * v[2],
];

/** CPU mirror of baseToneWgslBody — same constants, same operation order. */
export function applyBaseToneCpu(id: BaseToneId, px: Rgb): Rgb {
  if (id === 'none') return px;
  if (id === 'sigmoid') return sigmoidCpu(px);
  const pre = (v: number) => Math.min(Math.max(v * PRE_GAIN, 0), INPUT_MAX);
  const x: Rgb = [pre(px[0]), pre(px[1]), pre(px[2])];
  switch (id) {
    case 'reinhard': {
      const L = Math.max(WORKING_LUMA[0] * x[0] + WORKING_LUMA[1] * x[1] + WORKING_LUMA[2] * x[2], 1e-6);
      const Ld = (L * (1 + L / (REINHARD_WHITE * REINHARD_WHITE))) / (1 + L);
      const k = Ld / L;
      return [x[0] * k, x[1] * k, x[2] * k];
    }
    case 'agx':
    case 'agx_punchy': {
      const s = mulRows(WORK_TO_SRGB, x);
      let v = mulCols(AGX_INSET_COLS, [Math.max(s[0], 1e-10), Math.max(s[1], 1e-10), Math.max(s[2], 1e-10)]);
      const curve = (t: number) => {
        const u = (Math.min(Math.max(Math.log2(t), AGX_MIN_EV), AGX_MAX_EV) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
        const u2 = u * u;
        const u4 = u2 * u2;
        return 15.5 * u4 * u2 - 40.14 * u4 * u + 31.96 * u4 - 6.868 * u2 * u + 0.4298 * u2 + 0.1191 * u - 0.00232;
      };
      v = [curve(v[0]), curve(v[1]), curve(v[2])];
      if (id === 'agx_punchy') {
        const lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        const look = (t: number) => lum + AGX_PUNCHY_SAT * (Math.pow(Math.max(t, 0), AGX_PUNCHY_POWER) - lum);
        v = [look(v[0]), look(v[1]), look(v[2])];
      }
      v = mulCols(AGX_OUTSET_COLS, v);
      return mulRows(SRGB_TO_WORK, [Math.pow(Math.max(v[0], 0), 2.2), Math.pow(Math.max(v[1], 0), 2.2), Math.pow(Math.max(v[2], 0), 2.2)]);
    }
    case 'aces': {
      const g = (v: number) => {
        const y = v * 0.6;
        return Math.min(Math.max((y * (2.51 * y + 0.03)) / (y * (2.43 * y + 0.59) + 0.14), 0), 1);
      };
      return [g(x[0]), g(x[1]), g(x[2])];
    }
  }
}

/** The darktable-default log-logistic curve (see SIGMOID_* above). */
export function sigmoidCurve(v: number): number {
  const a = Math.pow(SIGMOID_FOG + Math.max(v, 0), SIGMOID_CONTRAST);
  return (SIGMOID_WHITE * a) / (SIGMOID_PAPER + a);
}

function sigmoidCpu(px: Rgb): Rgb {
  const g = (v: number) => Math.min(Math.max(v * PRE_GAIN, -INPUT_MAX), INPUT_MAX);
  let x: Rgb = [g(px[0]), g(px[1]), g(px[2])];
  const m = Math.max((x[0] + x[1] + x[2]) / 3, 0);
  const lo = Math.min(x[0], x[1], x[2]);
  if (lo < 0) {
    const k = m / (m - lo);
    x = [m + k * (x[0] - m), m + k * (x[1] - m), m + k * (x[2] - m)];
  }
  x = [Math.max(x[0], 0), Math.max(x[1], 0), Math.max(x[2], 0)];
  const xmin = Math.min(x[0], x[1], x[2]);
  const xmax = Math.max(x[0], x[1], x[2]);
  const fmin = sigmoidCurve(xmin);
  const fmax = sigmoidCurve(xmax);
  if (xmax - xmin <= 1e-9) return [fmax, fmax, fmax];
  const t = (v: number) => fmin + ((fmax - fmin) * (v - xmin)) / (xmax - xmin);
  return [t(x[0]), t(x[1]), t(x[2])];
}
