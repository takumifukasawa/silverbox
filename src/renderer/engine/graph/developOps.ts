/**
 * Shared develop-operation snippets (REBUILD-SPEC §12): the Develop node and
 * the atomic nodes compile the SAME WGSL sequences, so a Develop slider and
 * its atomic counterpart at the same value produce bit-identical pixels.
 * Each builder takes the WGSL expression that supplies its parameter and
 * returns a body operating on `c` (vec3f, linear RGB). Every WGSL snippet
 * has a CPU mirror here — keep the pairs in lockstep.
 */

/** White balance — multiplicative gains relative to as-shot ([1,1,1] there). */
export function wgslWhiteBalance(gains: string): string {
  return /* wgsl */ `  c = c * ${gains};\n`;
}

/** Exposure — linear-space stops. */
export function wgslExposure(ev: string): string {
  return /* wgsl */ `  c = c * exp2(${ev});\n`;
}

/** Contrast — mid-gray (0.18) pivot power in log space; keeps c ≥ 0. `amount` −1..1. */
export function wgslContrast(amount: string): string {
  return /* wgsl */ `  if (abs(${amount}) > 1e-6) {
    let k = exp2(${amount} * 0.8);
    c = 0.18 * pow(max(c, vec3f(0.0)) / 0.18, vec3f(k));
  }
`;
}

export function cpuContrast(px: [number, number, number], amount: number): [number, number, number] {
  if (Math.abs(amount) <= 1e-6) return px;
  const k = Math.pow(2, amount * 0.8);
  const f = (v: number) => 0.18 * Math.pow(Math.max(v, 0) / 0.18, k);
  return [f(px[0]), f(px[1]), f(px[2])];
}

/**
 * Saturation / vibrance — vibrance boosts weakly saturated pixels more than
 * already-vivid ones. `sat` / `vib` are −1..1 expressions; pass `0.0` for the
 * unused control in an atomic node (adding exact 0.0 keeps the math
 * bit-identical to Develop's combined pass). Requires the `luma` helper.
 */
export function wgslSaturationVibrance(sat: string, vib: string): string {
  return /* wgsl */ `  {
    let y = luma(c);
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let satLevel = select(0.0, (mx - mn) / mx, mx > 1e-5);
    let f = clamp(1.0 + ${sat} + ${vib} * (1.0 - satLevel), 0.0, 4.0);
    c = max(mix(vec3f(y), c, f), vec3f(0.0));
  }
`;
}

export function cpuSaturationVibrance(
  px: [number, number, number],
  sat: number,
  vib: number
): [number, number, number] {
  const [r, g, b] = px;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const satLevel = mx > 1e-5 ? (mx - mn) / mx : 0;
  const f = Math.min(Math.max(1 + sat + vib * (1 - satLevel), 0), 4);
  const mix = (v: number) => Math.max(y + (v - y) * f, 0);
  return [mix(r), mix(g), mix(b)];
}

// --- HSL 8-band (REBUILD-SPEC §9) ---------------------------------------------

/**
 * RGB↔HSL conversion in DISPLAY (sRGB-encoded, 0..1) space. Inputs are
 * assumed clamped; achromatic pixels report hue 0 / saturation 0.
 */
export const WGSL_HSL_HELPERS = /* wgsl */ `
fn rgb2hsl(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = 0.5 * (mx + mn);
  let d = mx - mn;
  if (d < 1e-6) {
    return vec3f(0.0, 0.0, l);
  }
  let s = d / (1.0 - abs(2.0 * l - 1.0));
  var h: f32;
  if (mx == c.r) {
    h = (c.g - c.b) / d;
  } else if (mx == c.g) {
    h = (c.b - c.r) / d + 2.0;
  } else {
    h = (c.r - c.g) / d + 4.0;
  }
  h = h * 60.0;
  if (h < 0.0) {
    h = h + 360.0;
  }
  return vec3f(h, s, l);
}

fn hsl2rgb(hsl: vec3f) -> vec3f {
  let ch = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  let hp = hsl.x / 60.0;
  let x = ch * (1.0 - abs(hp % 2.0 - 1.0));
  var rgb = vec3f(ch, x, 0.0);
  if (hp >= 1.0 && hp < 2.0) {
    rgb = vec3f(x, ch, 0.0);
  } else if (hp >= 2.0 && hp < 3.0) {
    rgb = vec3f(0.0, ch, x);
  } else if (hp >= 3.0 && hp < 4.0) {
    rgb = vec3f(0.0, x, ch);
  } else if (hp >= 4.0 && hp < 5.0) {
    rgb = vec3f(x, 0.0, ch);
  } else if (hp >= 5.0) {
    rgb = vec3f(ch, 0.0, x);
  }
  return rgb + vec3f(hsl.z - 0.5 * ch);
}
`;

/** Full-scale (±100) hue rotation in degrees. */
export const HSL_HUE_FULL_SCALE_DEG = 30;
/** Full-scale luminance gain in stops on the display lightness. */
export const HSL_LUM_FULL_SCALE_STOPS = 0.8;
/** Chroma (display max−min) where the band mask reaches full strength. */
export const HSL_CHROMA_MASK_FULL = 0.08;

/** Band centers + wrap sentinel (must match HSL_BAND_CENTER_DEG order). */
const HSL_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300, 360];
const HSL_CENTERS_WGSL = HSL_CENTERS.map((v) => v.toFixed(1)).join(', ');

/**
 * 8-band HSL adjust, applied in DISPLAY (sRGB-encoded) space. `bands` = WGSL
 * expression for an array<vec4f, 8>, xyz = hue/sat/lum amounts (−1..1).
 *
 * A pixel's hue sits between two adjacent band centers (wrapping 300°→360°=
 * red); the two bands blend with a smoothstep falloff — a smooth partition of
 * unity. The chroma mask keeps grays out of every band and eases the effect
 * in on weakly saturated pixels. Requires WGSL_HSL_HELPERS + srgbEncode/
 * srgbDecode. The pass only exists when some band is non-zero.
 */
export function wgslHslBands(bands: string): string {
  return /* wgsl */ `  {
    let enc = srgbEncode(clamp(c, vec3f(0.0), vec3f(1.0)));
    let hsl = rgb2hsl(enc);
    let chroma = max(enc.r, max(enc.g, enc.b)) - min(enc.r, min(enc.g, enc.b));
    let satMask = smoothstep(0.0, ${HSL_CHROMA_MASK_FULL}, chroma);
    var centers = array<f32, 9>(${HSL_CENTERS_WGSL});
    var i = 0u;
    for (; i < 7u; i++) {
      if (hsl.x < centers[i + 1u]) {
        break;
      }
    }
    let t = (hsl.x - centers[i]) / (centers[i + 1u] - centers[i]);
    let w = t * t * (3.0 - 2.0 * t);
    let adj = mix(${bands}[i].xyz, ${bands}[(i + 1u) % 8u].xyz, w) * satMask;
    // hue: ±100 → ±${HSL_HUE_FULL_SCALE_DEG}° rotation (wrapped)
    var hue = (hsl.x + adj.x * ${HSL_HUE_FULL_SCALE_DEG}.0) % 360.0;
    if (hue < 0.0) {
      hue = hue + 360.0;
    }
    // saturation: −100 fully desaturates the band, +100 doubles
    let sat = clamp(hsl.y * (1.0 + adj.y), 0.0, 1.0);
    // luminance: exposure-like gain on the display lightness (black anchored)
    let lum = clamp(hsl.z * exp2(adj.z * ${HSL_LUM_FULL_SCALE_STOPS}), 0.0, 1.0);
    c = srgbDecode(hsl2rgb(vec3f(hue, sat, lum)));
  }
`;
}

/** CPU mirror of wgslHslBands — operates on ENCODED rgb, returns encoded. */
export function cpuHslBandsEncoded(
  enc: [number, number, number],
  bands: Float32Array
): [number, number, number] {
  const [r, g, b] = enc;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = 0.5 * (mx + mn);
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d >= 1e-6) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = (g - b) / d;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const chroma = mx - mn;
  const tMask = Math.min(Math.max(chroma / HSL_CHROMA_MASK_FULL, 0), 1);
  const satMask = tMask * tMask * (3 - 2 * tMask);
  let i = 0;
  while (i < 7 && h >= HSL_CENTERS[i + 1]!) i++;
  const t = (h - HSL_CENTERS[i]!) / (HSL_CENTERS[i + 1]! - HSL_CENTERS[i]!);
  const w = t * t * (3 - 2 * t);
  const j = (i + 1) % 8;
  const adj = [0, 1, 2].map(
    (k) => (bands[i * 4 + k]! + (bands[j * 4 + k]! - bands[i * 4 + k]!) * w) * satMask
  ) as [number, number, number];
  let hue = (h + adj[0] * HSL_HUE_FULL_SCALE_DEG) % 360;
  if (hue < 0) hue += 360;
  const sat = Math.min(Math.max(s * (1 + adj[1]), 0), 1);
  const lum = Math.min(Math.max(l * Math.pow(2, adj[2] * HSL_LUM_FULL_SCALE_STOPS), 0), 1);
  // hsl2rgb mirror
  const ch = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = hue / 60;
  const x = ch * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] = [ch, x, 0];
  if (hp >= 1 && hp < 2) rgb = [x, ch, 0];
  else if (hp >= 2 && hp < 3) rgb = [0, ch, x];
  else if (hp >= 3 && hp < 4) rgb = [0, x, ch];
  else if (hp >= 4 && hp < 5) rgb = [x, 0, ch];
  else if (hp >= 5) rgb = [ch, 0, x];
  const m = lum - 0.5 * ch;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Plain linear gain (atomic brightness; no Develop counterpart). `amount` −1..1. */
export function wgslBrightness(amount: string): string {
  return /* wgsl */ `  c = max(c * (1.0 + ${amount}), vec3f(0.0));\n`;
}

export function cpuBrightness(px: [number, number, number], amount: number): [number, number, number] {
  const f = (v: number) => Math.max(v * (1 + amount), 0);
  return [f(px[0]), f(px[1]), f(px[2])];
}
