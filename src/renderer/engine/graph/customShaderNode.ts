/**
 * customShader node (REBUILD-SPEC §11) — the "soul" node.
 *
 * The user writes only the body of `shade(color: vec3f, uv: vec2f) -> vec3f`;
 * the engine wraps it with the fullscreen VS, the source-texture binding, a
 * uniform struct generated from the GUI-declared params (`P.<name>`, all f32)
 * and the fragment entry point. `color` is linear RGB.
 *
 * Robustness contract: the plan never emits unvalidated WGSL. Edits go
 * through async validation (engine/shader/validateWgsl.ts); only sources
 * that compiled successfully are committed to the per-node artifact cache
 * below, so a broken edit keeps rendering the last valid shader — never a
 * black frame.
 */
import { FULLSCREEN_VS_UV, WGSL_LUMA, WGSL_SRGB_ENCODE } from './wgslCommon';

// --- schema -------------------------------------------------------------------

/** One GUI-declared float param; `name` becomes the uniform member `P.<name>`. */
export interface CustomShaderParam {
  name: string;
  min: number;
  max: number;
  default: number;
  value: number;
}

export interface CustomShaderCode {
  /** Source currently in the editor — may fail to compile. */
  src: string;
  /** Last source that compiled successfully — this is what renders. */
  lastValidSrc: string;
}

/** The `shader` payload of a GraphNode with kind 'custom'. */
export interface CustomShaderParams {
  code: CustomShaderCode;
  params: CustomShaderParam[];
}

export const DEFAULT_CUSTOM_SHADER_SRC = `// Body of: fn shade(color: vec3f, uv: vec2f) -> vec3f
// color is LINEAR Rec.2020 (working space). Return the new color.
// GUI params: P.<name>   helpers: luma(c), srgbEncode(c), srgbEncode1(v)
return color;
`;

export function createDefaultCustomShaderParams(): CustomShaderParams {
  return {
    code: { src: DEFAULT_CUSTOM_SHADER_SRC, lastValidSrc: DEFAULT_CUSTOM_SHADER_SRC },
    params: [],
  };
}

/** WGSL identifier rule for GUI param names. */
export const WGSL_IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// --- WGSL wrapper generation ---------------------------------------------------

export interface WrappedShader {
  wgsl: string;
  /** Wrapper lines before the user body (editor line = lineNum − offset). */
  userLineOffset: number;
}

/**
 * Uniform struct from the declared param names — plain f32 members in
 * declaration order (WGSL rounds the struct up to 16 bytes; packUniforms
 * matches). No params → no uniform declaration at all.
 */
function uniformDecl(paramNames: string[]): string {
  if (paramNames.length === 0) return '';
  const members = paramNames.map((n) => `  ${n}: f32,`).join('\n');
  return `struct CsParams {\n${members}\n}\n@group(0) @binding(1) var<uniform> P: CsParams;\n`;
}

/** Wrap a user shader body into a complete node-pass WGSL module. */
export function buildCustomShaderWgsl(body: string, paramNames: string[]): WrappedShader {
  const header = `${FULLSCREEN_VS_UV}
@group(0) @binding(0) var src: texture_2d<f32>;
${uniformDecl(paramNames)}${WGSL_LUMA}${WGSL_SRGB_ENCODE}
// --- user code ---
fn shade(color: vec3f, uv: vec2f) -> vec3f {
`;
  // Phony-use P: layout 'auto' drops statically-unused bindings, and the
  // runner always binds the uniform when params exist — a body that never
  // references P must not produce a layout that rejects it.
  const keepUniform = paramNames.length > 0 ? '  _ = P;\n' : '';
  const footer = `
}
// --- engine fragment entry ---
@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
${keepUniform}  let c0 = textureLoad(src, vec2i(in.pos.xy), 0);
  return vec4f(shade(c0.rgb, in.uv), c0.a);
}
`;
  // header ends with '\n' → its split has a trailing '' element, hence −1
  const userLineOffset = header.split('\n').length - 1;
  return { wgsl: header + body + footer, userLineOffset };
}

/** FNV-1a 32-bit — stable pipeline-cache key for a wrapped source. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- validated-artifact cache (nodeId → last successfully compiled) -----------

export interface CustomShaderArtifact {
  /** Pipeline cache key — hash of the wrapped WGSL. */
  shaderId: string;
  wgsl: string;
  /** Param names baked into the uniform struct, in declaration order. */
  paramNames: string[];
  /** Values at validation time — fallback when a param was later removed. */
  fallback: Record<string, number>;
}

const artifacts = new Map<string, CustomShaderArtifact>();

export function makeCustomShaderArtifact(wgsl: string, params: CustomShaderParam[]): CustomShaderArtifact {
  const fallback: Record<string, number> = {};
  for (const p of params) fallback[p.name] = p.value;
  return { shaderId: `custom/${hashString(wgsl)}`, wgsl, paramNames: params.map((p) => p.name), fallback };
}

export function setCustomShaderArtifact(nodeId: string, artifact: CustomShaderArtifact): void {
  artifacts.set(nodeId, artifact);
}

export function getCustomShaderArtifact(nodeId: string): CustomShaderArtifact | undefined {
  return artifacts.get(nodeId);
}

/**
 * Seed a fresh node with the engine-authored (known valid) identity shader.
 * Returns the artifact so callers (appStore.ts) can mirror it into the
 * render worker's own cache without recomputing it (see renderClient.ts).
 */
export function seedDefaultCustomShaderArtifact(nodeId: string): CustomShaderArtifact {
  const { wgsl } = buildCustomShaderWgsl(DEFAULT_CUSTOM_SHADER_SRC, []);
  const artifact = makeCustomShaderArtifact(wgsl, []);
  artifacts.set(nodeId, artifact);
  return artifact;
}

/** Drop everything — a new document's node ids must never alias stale shaders. */
export function clearCustomShaderArtifacts(): void {
  artifacts.clear();
}

// --- uniform packing -----------------------------------------------------------

/**
 * Pack current values in the artifact's struct order (size rounded up to a
 * vec4 boundary). Values come from the CURRENT params so value changes need
 * no recompile; params missing from the doc use the validation-time value.
 */
export function packCustomShaderUniforms(
  artifact: CustomShaderArtifact,
  current: CustomShaderParam[]
): ArrayBuffer {
  const names = artifact.paramNames;
  if (names.length === 0) return new ArrayBuffer(0);
  const floats = Math.ceil(names.length / 4) * 4;
  const buf = new ArrayBuffer(floats * 4);
  const f = new Float32Array(buf);
  const byName = new Map(current.map((p) => [p.name, p.value]));
  names.forEach((name, i) => {
    f[i] = byName.get(name) ?? artifact.fallback[name] ?? 0;
  });
  return buf;
}
