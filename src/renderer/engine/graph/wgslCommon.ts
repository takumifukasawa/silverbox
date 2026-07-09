/**
 * Shared WGSL building blocks for node passes.
 *
 * Every node pass is a fullscreen-triangle fragment pass over same-sized
 * rgba16float textures; texels are fetched with textureLoad (exact 1:1, no
 * sampler). The working space inside the pipeline is linear sRGB.
 */

/** Fullscreen triangle vertex stage with uv (for custom shaders). */
export const FULLSCREEN_VS_UV = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f(0.5 * (p[vi].x + 1.0), 1.0 - 0.5 * (p[vi].y + 1.0));
  return out;
}
`;

/** Exact sRGB piecewise encode (linear → display), not the 2.2 approximation. */
export const WGSL_SRGB_ENCODE = /* wgsl */ `
fn srgbEncode1(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn srgbEncode3(c: vec3f) -> vec3f {
  return vec3f(srgbEncode1(c.x), srgbEncode1(c.y), srgbEncode1(c.z));
}
`;

/** Exact sRGB piecewise decode (display → linear) — inverse of the encode. */
export const WGSL_SRGB_DECODE = /* wgsl */ `
fn srgbDecode1(v: f32) -> f32 {
  if (v <= 0.04045) {
    return v / 12.92;
  }
  return pow((v + 0.055) / 1.055, 2.4);
}

fn srgbDecode3(c: vec3f) -> vec3f {
  return vec3f(srgbDecode1(c.x), srgbDecode1(c.y), srgbDecode1(c.z));
}
`;

/** Rec.709 / sRGB luminance of a linear RGB color. */
export const WGSL_LUMA = /* wgsl */ `
fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
`;

export interface NodePassWgslOptions {
  /** WGSL struct + uniform declaration bound at @group(0) @binding(1); omit when the pass has no params. */
  uniformDecl?: string;
  /** Extra helper functions. */
  helpers?: string;
  /** Fragment body; `c` (vec3f, linear, mutable) and `c0` (source texel) are in scope. */
  body: string;
}

/**
 * Compose a complete node-pass shader: fullscreen VS + fragment that loads
 * the source texel 1:1 and applies `body` to `c`.
 */
export function nodePassWgsl(opts: NodePassWgslOptions): string {
  return /* wgsl */ `
${FULLSCREEN_VS_UV}
@group(0) @binding(0) var src: texture_2d<f32>;
${opts.uniformDecl ?? ''}
${opts.helpers ?? ''}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c0 = textureLoad(src, vec2i(in.pos.xy), 0);
  var c = c0.rgb;
${opts.body}
  return vec4f(c, c0.a);
}
`;
}

// --- CPU mirrors of the WGSL helpers (for reference math) -------------------

export function smoothstepCpu(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function lumaCpu(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
