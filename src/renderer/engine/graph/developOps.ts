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

/** Plain linear gain (atomic brightness; no Develop counterpart). `amount` −1..1. */
export function wgslBrightness(amount: string): string {
  return /* wgsl */ `  c = max(c * (1.0 + ${amount}), vec3f(0.0));\n`;
}

export function cpuBrightness(px: [number, number, number], amount: number): [number, number, number] {
  const f = (v: number) => Math.max(v * (1 + amount), 0);
  return [f(px[0]), f(px[1]), f(px[2])];
}
