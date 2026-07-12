/**
 * WebGPU graph renderer (milestone 4, DAG execution since milestone 13).
 * Render-isolation (DESIGN.md §10, phase B): this class now lives ENTIRELY
 * inside the render worker (renderWorker.ts) — the main thread never
 * instantiates it directly, only talks to it through renderClient.ts's
 * message bridge. `create()` takes an OffscreenCanvas for that reason.
 *
 * The linear RGBA preview uploads once per image as an rgba16float texture.
 * The RenderPlan executes step by step — ops and custom nodes as one-input
 * fullscreen passes compiled from registry/user WGSL, blend as a two-input
 * mix — each writing its own rgba16float texture so outputs can fan out.
 * A final pass applies the exact piecewise sRGB encode — the same curve as
 * engine/color/srgb.ts — into the canvas. readbackMean() executes the whole
 * plan again into an offscreen rgba8unorm target and averages on the CPU,
 * so it never depends on a prior render() call (verify-only path; kept as a
 * full CPU readback for readbackMean/readbackSharpness/cpuReferenceMean).
 * stats() and scopeSamples() — the UI-facing, debounced-per-edit readbacks —
 * instead reduce that same encoded target entirely on the GPU (compute
 * passes over HISTOGRAM_SHADER / SCOPE_SAMPLE_SHADER) so only a few KB ever
 * crosses back to the CPU, no matter the preview's pixel count.
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import { isIdentityLens, orientedDims, type RenderPlan } from '../graph/graphDoc';
import {
  distortionNormalizer,
  DISTORTION_KNOT_SCALE,
  CA_KNOT_SCALE,
  LENS_PROFILE_MAX_KNOTS,
  type LensProfile,
} from '../lens/sonyLensProfile';
import { WGSL_SRGB_TO_WORK, WGSL_WORK_TO_P3, WGSL_WORK_TO_SRGB, WGSL_WORKING_LUMA, WORKING_LUMA } from '../color/workingSpace';
import { WGSL_SRGB_DECODE, WGSL_SRGB_ENCODE } from '../graph/wgslCommon';
import type { ExportColorSpace, ExternalToolResult } from '../../../../shared/ipc';

type PlanGeometry = NonNullable<RenderPlan['geometry']>;
type PlanLens = NonNullable<RenderPlan['lens']>;

// Lens correction tuning constants — LR-CALIBRATION CANDIDATES, same
// convention as the FX_* constants in developNode.ts: the reference for
// feel/range is Lightroom's Lens Corrections panel; these first-pass
// strengths are meant to be recalibrated against LR side-by-side in a
// follow-up session. Recalibrate HERE only — the resample pass consumes
// these named constants, so the formulas never need to change.
/** Distortion ±100 → ±this quadratic radial coefficient (corner-normalized r²). */
const LENS_DISTORTION_STRENGTH = 0.15;
/** CA Red/Blue ±100 → ±this relative radial channel scale. */
const LENS_CA_STRENGTH = 0.004;
/** Vignette recovery gain's r² coefficient at vignette=100 (corner). */
const LENS_VIG_R2 = 0.7;
/** Vignette recovery gain's r⁴ coefficient at vignette=100 (corner). */
const LENS_VIG_R4 = 0.7;

// --- Sony embedded lens-profile (task #34, F3b) ------------------------------
// The profile's distortion + CA corrections REPLACE the manual polynomial with
// the file's own splines (uploaded as knot tables, evaluated in WGSL) and
// STACK on top of the manual sliders (LR-style: profile first, manual on top —
// multiplicative factors, so manual=0 leaves pure-profile and profile-off
// leaves pure-manual, both bit-identical to before this feature).
//
// VIGNETTING: the Sony vignette knots' scale DIVISOR is undocumented and could
// not be pinned to a single power of two by the JPEG radial-falloff fit (see
// scripts/analyze-vignette-divisor.mjs / the report), so profile vignetting
// ships OFF — distortion + CA only. Flip LENS_PROFILE_VIGNETTE_ON to true (and
// set the divisor) once a clean fit exists; the WGSL path is already wired.
const LENS_PROFILE_VIGNETTE_ON = false;
const LENS_PROFILE_VIGNETTE_DIVISOR = 16384; // 2^-14 family placeholder; unused while OFF
/** Knot-table cap uploaded to the GPU (Sony ships 11; padded to this). Must match the WGSL array sizes. */
const LENS_PROFILE_KNOT_CAP = LENS_PROFILE_MAX_KNOTS; // 16 → 4 vec4f per table

const FULLSCREEN_VS = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
`;

// The EXIT: convert the linear Rec.2020 working color to linear display
// primaries (WORK_TO_SRGB or, for the export-only P3 variant, WORK_TO_P3),
// then apply the exact sRGB transfer curve — Display P3 shares sRGB's curve,
// only the primaries matrix differs, so `matrixWgsl` is the sole parameter.
// srgbEncode clamps to [0,1] first — that clamp IS the gamut clip (colors
// outside the target gamut go negative after the matrix), and it belongs
// here at the exit, not in the working chain. The sRGB instantiation below
// (ENCODE_SHADER) is shared verbatim by the canvas present, the grayscale
// view and the rgba8unorm readback used by stats/scopes/export, so all of
// those exits stay in lockstep; the P3 instantiation (ENCODE_SHADER_P3) is
// used ONLY by the export path (renderToPixels), never by the preview.
// All targets match the image size, so pos.xy maps 1:1 in every pass.
function buildEncodeShader(matrixWgsl: string): string {
  return /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
${WGSL_SRGB_ENCODE}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(pos.xy), 0);
  let s = clamp(${matrixWgsl} * t.rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(srgbEncode(s), 1.0);
}
`;
}

const ENCODE_SHADER = buildEncodeShader(WGSL_WORK_TO_SRGB);
/** Export-only color-space variant (registered under shader id 'encode/p3'); the preview never uses this. */
const ENCODE_SHADER_P3 = buildEncodeShader(WGSL_WORK_TO_P3);

// --- External-tool hook node (denoise v1, task #41) --------------------------
//
// The round trip's color-space boundary reuses the SAME exact helpers every
// other exit in this file uses — no bespoke math. 'encoded' mode hands the
// tool literally the same numbers ENCODE_SHADER produces (WORK_TO_SRGB +
// exact sRGB OETF), just rendered into an rgba16float target (instead of
// ENCODE_SHADER's fixed rgba8unorm one) so the 16-bit-TIFF round trip keeps
// its precision; EXTERNAL_DECODE_SHADER is the exact inverse (sRGB EOTF then
// SRGB_TO_WORK) for reading the tool's result back in. 'linear' mode needs no
// shader at all beyond a plain identity blit (EXTERNAL_PASSTHROUGH_SHADER),
// reused for three purposes: (1) reading back an external step's LINEAR
// input when encoded=false, (2) the node's default "no cached result yet"
// pass-through render, and (3) blitting a cached/decoded result texture into
// a step's own output slot.
const EXTERNAL_PASSTHROUGH_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`;

const EXTERNAL_DECODE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
${WGSL_SRGB_DECODE}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(pos.xy), 0);
  let lin = ${WGSL_SRGB_TO_WORK} * srgbDecode(t.rgb);
  return vec4f(lin, 1.0);
}
`;

/** In-memory LRU capacity for decoded external-tool RESULT textures (graphRenderer.ts's own cache tier — see `externalResultTextures`); the on-disk tier (src/main/externalCache.ts) is the bounded-by-bytes one. A handful of recent edits' worth, not a formula. */
const EXTERNAL_RESULT_LRU_CAPACITY = 12;
/** Idle debounce before an external node's command actually runs, after the last upstream pixel change (see checkExternalNodes). */
const EXTERNAL_DEBOUNCE_MS = 600;

/** Box-filter taps per axis for THUMBNAIL_SHADER — 4×4 = 16 samples per output texel, plenty of anti-aliasing at a ~64px thumbnail and still trivial GPU cost. */
const THUMBNAIL_TAPS = 4;

// --- Image node (composite/mask-by-another-file feature) ---------------------
//
// A zero-input SOURCE step (graphDoc.ts's PlanStep 'image'): no upstream
// texture to read, so it gets its OWN pair of tiny pipelines instead of the
// generic one-input-transform shape every other node pass uses.
// IMAGE_COVER_SHADER runs when the referenced file has been decoded and
// uploaded (setImageNodeTexture); IMAGE_GRAY_SHADER runs otherwise (no path
// chosen yet, decode still in flight, or the file is missing/unreadable) —
// picking the PIPELINE at the JS level (rather than branching in one shader
// on a "hasImage" uniform) avoids ever needing a dummy placeholder texture
// binding. Both write into the step's own rgba16float texture exactly like
// any other step, so thumbnails()/readbacks/export need no special casing.

/** Linear-space fallback color for a missing/not-yet-decoded image-node reference — a simple, undramatic placeholder, not an LR-calibration constant. */
const IMAGE_NODE_MISSING_GRAY = 0.5;

const IMAGE_GRAY_SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4f; // x = linear gray level
${FULLSCREEN_VS}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(params.x, params.x, params.x, 1.0);
}
`;

/**
 * Cover-fit blit: the referenced image is scaled UNIFORMLY (aspect
 * preserved) and centered so it fully covers the consumer's frame — cropping
 * whichever axis overflows, same "background-size: cover" mapping as CSS.
 * `u.p0` = (scale, offsetX, offsetY, unused), computed CPU-side by
 * GraphRenderer.coverFit from the frame dims and the cached texture's own
 * dims; srcPx = (outputPx - offset) / scale is the inverse of
 * outputPx = srcPx*scale + offset. No sampler filtering surprises at the
 * edges: uv is clamped to [0,1] defensively (the cover math keeps it in
 * range except for float noise at the exact border).
 */
const IMAGE_COVER_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var coverSampler: sampler;
struct CoverParams {
  p0: vec4f, // x = scale, y = offsetX (output px), z = offsetY (output px), w unused
}
@group(0) @binding(2) var<uniform> u: CoverParams;
${FULLSCREEN_VS}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src));
  let srcPx = (pos.xy - vec2f(u.p0.y, u.p0.z)) / u.p0.x;
  let uv = clamp(srcPx / dims, vec2f(0.0), vec2f(1.0));
  return vec4f(textureSampleLevel(src, coverSampler, uv, 0.0).rgb, 1.0);
}
`;

// Node thumbnails (per-node-preview pack, tier 1): downsamples a step's own
// rgba16float output to a tiny display-ready rgba8unorm target — same exit
// transform as ENCODE_SHADER (WORK_TO_SRGB + the exact sRGB curve) so a
// thumbnail's colors always match what the main canvas would show for that
// same texture, just averaged in LINEAR space first (one encode, after the
// box filter, not one per tap) to stay inside the "linear between passes"
// invariant. A single bilinear sample per output texel would alias badly at
// the ~30:1 ratios a 2000px-wide preview downsamples to 64px at — this pass
// instead averages a THUMBNAIL_TAPS×THUMBNAIL_TAPS grid of textureLoad reads
// per output texel (a real box filter, no sampler/mip machinery needed).
const THUMBNAIL_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
struct ThumbParams {
  srcDims: vec2f,
  dstDims: vec2f,
}
@group(0) @binding(1) var<uniform> p: ThumbParams;
${FULLSCREEN_VS}
${WGSL_SRGB_ENCODE}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = p.srcDims / p.dstDims;
  let origin = pos.xy * cell;
  var sum = vec3f(0.0);
  for (var j = 0; j < ${THUMBNAIL_TAPS}; j++) {
    for (var i = 0; i < ${THUMBNAIL_TAPS}; i++) {
      let fx = (f32(i) + 0.5) / ${THUMBNAIL_TAPS}.0;
      let fy = (f32(j) + 0.5) / ${THUMBNAIL_TAPS}.0;
      let s = origin + vec2f(fx, fy) * cell;
      let coord = vec2i(clamp(s, vec2f(0.0), p.srcDims - vec2f(1.0)));
      sum += textureLoad(src, coord, 0).rgb;
    }
  }
  let avg = sum / f32(${THUMBNAIL_TAPS} * ${THUMBNAIL_TAPS});
  let enc = clamp(${WGSL_WORK_TO_SRGB} * avg, vec3f(0.0), vec3f(1.0));
  return vec4f(srgbEncode(enc), 1.0);
}
`;

// Viewer-only grayscale: convert to sRGB + encode (same exit), then show the
// WORKING_LUMA luma of the encoded image on all channels — a tone/contrast
// check that never touches readbacks or export.
const GRAYSCALE_ENCODE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
${WGSL_SRGB_ENCODE}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(pos.xy), 0);
  let s = clamp(${WGSL_WORK_TO_SRGB} * t.rgb, vec3f(0.0), vec3f(1.0));
  let y = dot(srgbEncode(s), ${WGSL_WORKING_LUMA});
  return vec4f(y, y, y, 1.0);
}
`;

const BLEND_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: vec4f;
${FULLSCREEN_VS}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let a = textureLoad(srcA, vec2i(pos.xy), 0);
  let b = textureLoad(srcB, vec2i(pos.xy), 0);
  return vec4f(mix(a.rgb, b.rgb, params.x), 1.0);
}
`;

/**
 * Blend with an optional mask input (masks milestone): out = mix(a, b,
 * maskValue.r * factor), where `factor` is the blend's own uniform (params.x
 * — now acting as an adjustment strength when a mask is connected). A
 * separate pipeline (rather than an always-3-texture BLEND_SHADER) keeps the
 * unmasked path's bind group layout — and every existing masked-blend-free
 * render — completely unchanged.
 */
const BLEND_MASK_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var srcMask: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: vec4f;
${FULLSCREEN_VS}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let a = textureLoad(srcA, vec2i(pos.xy), 0);
  let b = textureLoad(srcB, vec2i(pos.xy), 0);
  let m = textureLoad(srcMask, vec2i(pos.xy), 0);
  let t = clamp(m.r * params.x, 0.0, 1.0);
  return vec4f(mix(a.rgb, b.rgb, t), 1.0);
}
`;

/**
 * Mask-select overlay (masks milestone, UX-only): the normal color exit
 * (WORK_TO_SRGB + srgbEncode, same as ENCODE_SHADER) composited with red at
 * ~50% alpha scaled by the selected mask node's own value — an LR-style "red
 * mask" preview. Used ONLY by the canvas present pass (render()); never by
 * readbackMean/readbackSharpness/stats/scopeSamples/export, so it can never
 * perturb anything the verify harness or the user's export depends on.
 */
const MASK_OVERLAY_ENCODE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
${FULLSCREEN_VS}
${WGSL_SRGB_ENCODE}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(pos.xy), 0);
  let s = clamp(${WGSL_WORK_TO_SRGB} * t.rgb, vec3f(0.0), vec3f(1.0));
  var enc = srgbEncode(s);
  let m = clamp(textureLoad(maskTex, vec2i(pos.xy), 0).r, 0.0, 1.0);
  enc = mix(enc, vec3f(1.0, 0.0, 0.0), m * 0.5);
  return vec4f(enc, 1.0);
}
`;

/**
 * `bins` layout for HISTOGRAM_SHADER: [0..255] = r histogram, [256..511] = g,
 * [512..767] = b, [768..1023] = luma, [1024] = shadow-clip count (any channel
 * == 0), [1025] = highlight-clip count (any channel == 255). One u32 per
 * entry, ~4.1KB total — this is the entire GPU→CPU readback stats() now
 * does, instead of the full encoded frame (~15MB at preview size).
 */
const HISTOGRAM_BIN_COUNT = 4 * 256 + 2;

/**
 * Histogram compute pass: reduces the encoded rgba8unorm output directly on
 * the GPU, restricted to the rectangle `rect = (x0, y0, w, h)` of `src`
 * (stats() always passes the full output rect; statsCrop() — verify-only,
 * see scripts/verify-ms10-histogram.mjs — passes an arbitrary crop so the
 * compute shader's binning can be cross-checked bit-for-bit against a JS
 * recomputation over real pixels without shipping the whole frame across the
 * debug bridge). Workgroup 16×16; out-of-range invocations (rect dims not a
 * multiple of 16) bail via the bounds check before touching `bins`.
 *
 * Reconstructing the u8 channel value from the rgba8unorm texel's decoded
 * float (textureLoad returns c/255 as f32) by rounding is exact: the
 * float32 round-trip error is on the order of 3e-5 in the reconstructed
 * integer, far below the 0.5 needed to flip a rounding decision.
 *
 * Luma binning mirrors the OLD CPU loop's formula bit-for-bit:
 *   luma[Math.min(255, Math.round(WORKING_LUMA[0]*vr + WORKING_LUMA[1]*vg + WORKING_LUMA[2]*vb))]++
 * WGSL's round() is round-half-to-even (unlike Math.round's round-half-away-
 * from-zero); floor(x + 0.5) is used instead everywhere here — for x >= 0
 * (always true for these values) that is bit-for-bit what Math.round computes.
 */
const HISTOGRAM_SHADER = /* wgsl */ `
struct HistogramParams {
  rect: vec4u, // x0, y0, w, h
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: HistogramParams;

@compute @workgroup_size(16, 16)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.rect.z || gid.y >= params.rect.w) {
    return;
  }
  let coord = vec2i(params.rect.xy + gid.xy);
  let texel = textureLoad(src, coord, 0);
  let vr = u32(floor(texel.r * 255.0 + 0.5));
  let vg = u32(floor(texel.g * 255.0 + 0.5));
  let vb = u32(floor(texel.b * 255.0 + 0.5));
  atomicAdd(&bins[vr], 1u);
  atomicAdd(&bins[256u + vg], 1u);
  atomicAdd(&bins[512u + vb], 1u);
  let lumaF = dot(${WGSL_WORKING_LUMA}, vec3f(f32(vr), f32(vg), f32(vb)));
  let lumaBin = min(255u, u32(floor(lumaF + 0.5)));
  atomicAdd(&bins[768u + lumaBin], 1u);
  if (vr == 0u || vg == 0u || vb == 0u) {
    atomicAdd(&bins[1024u], 1u);
  }
  if (vr == 255u || vg == 255u || vb == 255u) {
    atomicAdd(&bins[1025u], 1u);
  }
}
`;

/**
 * Scope-sample compute pass: nearest-samples the encoded rgba8unorm output
 * at each stride cell's TOP-LEFT texel — coord = (col*strideX, row*strideY),
 * exactly the coordinates the old CPU stride loop read (`for (x = 0; x <
 * width; x += strideX)` etc.) — packing each RGB triplet into one u32 (r |
 * g<<8 | b<<16) in a `cols*rows`-entry storage buffer. Only that small grid
 * (≤256×144×4 bytes ≈ 144KB) crosses back to the CPU instead of the whole
 * encoded frame; scopeSamples() unpacks it into the same Uint8Array shape it
 * always returned.
 */
const SCOPE_SAMPLE_SHADER = /* wgsl */ `
struct ScopeParams {
  grid: vec4u, // strideX, strideY, cols, rows
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outSamples: array<u32>;
@group(0) @binding(2) var<uniform> params: ScopeParams;

@compute @workgroup_size(16, 16)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.grid.z || gid.y >= params.grid.w) {
    return;
  }
  let coord = vec2i(gid.xy * params.grid.xy);
  let texel = textureLoad(src, coord, 0);
  let vr = u32(floor(texel.r * 255.0 + 0.5));
  let vg = u32(floor(texel.g * 255.0 + 0.5));
  let vb = u32(floor(texel.b * 255.0 + 0.5));
  let idx = gid.y * params.grid.z + gid.x;
  outSamples[idx] = vr | (vg << 8u) | (vb << 16u);
}
`;

/**
 * Resample pass: crop + straighten (geometry) folded with manual lens
 * corrections (distortion / chromatic aberration / vignette recovery) into
 * ONE pass, so the image is resampled only once no matter how many of the
 * two feature sets are active. The ONLY pass that reads its source with a
 * sampler instead of textureLoad (bilinear, clamp-to-edge — rgba16float is
 * filterable in core WebGPU), because it resamples at non-integer source
 * coordinates. Output dims are the crop rectangle at source resolution
 * (lens never changes dims); for output texel (ox,oy), `pos.xy` is already
 * the texel CENTER (ox+0.5, oy+0.5), so `p` below is exactly
 * crop.origin·srcDims + (ox+0.5, oy+0.5).
 *
 * `rotate` intentionally is NOT the textbook CCW-in-math (y-up) matrix: texel
 * space has y growing DOWNWARD, so that formula would look clockwise on
 * screen. The sin terms are flipped here so rotate(v, +a) turns v
 * counter-clockwise ON SCREEN — the "+angle rotates the displayed image CCW"
 * convention this pass promises. `q = rotate(p - center, -angleRad) + center`
 * is the corresponding INVERSE map (rotate(v,-a) is rotate(v,a)'s inverse for
 * any proper rotation), i.e. "where in the true source does this output
 * texel's content come from".
 *
 * Mapping order for each output texel, all in SOURCE pixel space:
 *   1. crop/rotate inverse map → q (as above, unchanged from the old
 *      geometry-only pass)
 *   2. lens distortion about the source center, radius normalized so the
 *      CORNER = 1 (rn = length(q - center) / length(center)):
 *      q' = center + (q - center) * (1 + kd * rn²)
 *   3. chromatic aberration: each channel samples at its own radial scale of
 *      q' — R at center + (q' - center) * (1 + kr), B at * (1 + kb), G at q'
 *      unscaled. Always three textureSampleLevel calls (G's scale is 1) —
 *      simpler than branching on whether CA is active.
 *   4. vignetting recovery in LINEAR space on the sampled color, using rn of
 *      q' (the DISTORTION-CORRECTED position, before the CA offset):
 *      gain = 1 + vignette * (LENS_VIG_R2 * rn² + LENS_VIG_R4 * rn⁴)
 */
const RESAMPLE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var geomSampler: sampler;
struct ResampleParams {
  // x = crop.x, y = crop.y (normalized to the ORIENTED frame), z = srcWidth, w = srcHeight (px, decoded texture)
  p0: vec4f,
  // x = angleRad, y = distortion k, z = CA red k, w = CA blue k
  p1: vec4f,
  // x = vignette amount (vignette/100, 0..1), y = quarterTurns (0..3), z = flipH (0.0/1.0), w unused
  p2: vec4f,
}
@group(0) @binding(2) var<uniform> u: ResampleParams;

// Sony embedded lens-profile knot tables (task #34). Each curve is capped at
// ${LENS_PROFILE_KNOT_CAP} knots = 4 vec4f. hdr flags each curve on/off + its
// live knot count; cfg carries the distortion normalizer s and the vignette
// divisor. When hdr.x/z/w are 0 the corresponding factor is 1 (pure manual /
// bit-exact) — that is how a profile-off render costs nothing extra here.
struct LensProfile {
  hdr: vec4f, // x = distortion on(0/1), y = distortion knot count, z = CA knot count, w = vignette knot count (0 = off)
  cfg: vec4f, // x = distortion s (edge-max normalizer), y = vignette divisor, z/w unused
  dist: array<vec4f, 4>,
  caR: array<vec4f, 4>,
  caB: array<vec4f, 4>,
  vig: array<vec4f, 4>,
}
@group(0) @binding(3) var<uniform> prof: LensProfile;

const PROF_DIST_SCALE = ${DISTORTION_KNOT_SCALE}; // 2^-14
const PROF_CA_SCALE = ${CA_KNOT_SCALE};           // 2^-21

fn comp(v: vec4f, m: i32) -> f32 {
  return select(select(v.x, v.y, m == 1), select(v.z, v.w, m == 3), m >= 2);
}

// Linear spline through evenly-spaced knots (knot i at parameter i); clamps
// past the ends. Mirrors evalLinearSpline() in sonyLensProfile.ts. x is in
// knot-index units. Packed as 4 vec4f (16 knots).
fn splineEval(tbl: array<vec4f, 4>, n: i32, x: f32) -> f32 {
  if (n <= 0) { return 0.0; }
  var vv = tbl;
  let nf = f32(n - 1);
  let xc = clamp(x, 0.0, nf);
  let i0 = i32(floor(xc));
  let i1 = min(i0 + 1, n - 1);
  let f = xc - floor(xc);
  let k0 = comp(vv[i0 >> 2u], i0 & 3);
  let k1 = comp(vv[i1 >> 2u], i1 & 3);
  return mix(k0, k1, f);
}

${FULLSCREEN_VS}
fn rotate(v: vec2f, angleRad: f32) -> vec2f {
  let s = sin(angleRad);
  let c = cos(angleRad);
  return vec2f(v.x * c + v.y * s, v.y * c - v.x * s);
}

/**
 * Inverse of the orientation step (graphDoc.ts's GeometryOrientation: flipH
 * THEN quarterTurns 90-CCW-on-screen turns). Maps a coordinate in the
 * ORIENTED frame (what crop/straighten/lens all operate in) back to the
 * actual decoded-texture SOURCE frame, so the sample lands on real pixels.
 * w/h are the SOURCE dims (pre-orientation) - exact +1/0/-1 index
 * arithmetic (no trig), so a texel-center input maps to a texel-center
 * output: orientation alone (angle=0, full crop, no lens) never blurs, it
 * only permutes which texel is read.
 */
fn orientInverse(pt: vec2f, w: f32, h: f32, k: i32, flip: f32) -> vec2f {
  var x0: f32;
  var y0: f32;
  if (k == 1) {
    y0 = pt.x;
    x0 = w - pt.y;
  } else if (k == 2) {
    x0 = w - pt.x;
    y0 = h - pt.y;
  } else if (k == 3) {
    y0 = h - pt.x;
    x0 = pt.y;
  } else {
    x0 = pt.x;
    y0 = pt.y;
  }
  let sx = select(x0, w - x0, flip > 0.5);
  return vec2f(sx, y0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let srcDims = u.p0.zw;
  let k = i32(round(u.p2.y));
  let flip = u.p2.z;
  let orientedDims = select(srcDims, srcDims.yx, k == 1 || k == 3);
  let cropOrigin = u.p0.xy * orientedDims;
  let orientedCenter = orientedDims * 0.5;
  let cornerRadius = length(orientedCenter);
  let p = cropOrigin + pos.xy;
  let q = rotate(p - orientedCenter, -u.p1.x) + orientedCenter;

  // 2. lens distortion (oriented frame). Manual polynomial × embedded-profile
  // spline (hdr.x, normalized by the edge-max s = cfg.x): both are radial
  // factors on rel, so they stack — manual=0 ⇒ pure profile, profile-off ⇒
  // pure manual (bit-exact vs before this feature).
  let rel = q - orientedCenter;
  let rn = length(rel) / cornerRadius;
  let kd = u.p1.y;
  var distFactor = 1.0 + kd * rn * rn;
  if (prof.hdr.x > 0.5) {
    let dn = i32(prof.hdr.y);
    let gd = 1.0 + PROF_DIST_SCALE * splineEval(prof.dist, dn, f32(dn - 1) * rn);
    distFactor = distFactor * (gd / prof.cfg.x);
  }
  let qd = orientedCenter + rel * distFactor;

  // Outside the source frame — the rotation void past the photo's corners, or
  // lens distortion pulling the sample past the border — cut hard to black
  // instead of letting the sampler's clamp addressing smear the edge texels
  // across the wedge: the photo ends where the photo ends. Tested on the
  // post-distortion position (what the g channel samples); the CA offsets
  // below are sub-texel-scale and not worth a per-channel cut.
  if (qd.x < 0.0 || qd.y < 0.0 || qd.x > orientedDims.x || qd.y > orientedDims.y) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // 3. chromatic aberration — per-channel radial scale of the distorted
  // position (oriented frame). Manual (1+k) × embedded-profile spline gain
  // (hdr.z) at the distortion-corrected normalized radius rnD.
  let relD = qd - orientedCenter;
  let rnD = length(relD) / cornerRadius;
  let kr = u.p1.z;
  let kb = u.p1.w;
  var scaleR = 1.0 + kr;
  var scaleB = 1.0 + kb;
  if (prof.hdr.z > 0.5) {
    let cn = i32(prof.hdr.z);
    scaleR = scaleR * (1.0 + PROF_CA_SCALE * splineEval(prof.caR, cn, f32(cn - 1) * rnD));
    scaleB = scaleB * (1.0 + PROF_CA_SCALE * splineEval(prof.caB, cn, f32(cn - 1) * rnD));
  }
  let qr = orientedCenter + relD * scaleR;
  let qb = orientedCenter + relD * scaleB;

  // 3b. map each oriented-frame sample point to the real decoded-texture SOURCE frame
  let sr = orientInverse(qr, srcDims.x, srcDims.y, k, flip);
  let sd = orientInverse(qd, srcDims.x, srcDims.y, k, flip);
  let sb = orientInverse(qb, srcDims.x, srcDims.y, k, flip);
  let r = textureSampleLevel(src, geomSampler, sr / srcDims, 0.0).r;
  let g = textureSampleLevel(src, geomSampler, sd / srcDims, 0.0).g;
  let b = textureSampleLevel(src, geomSampler, sb / srcDims, 0.0).b;

  // 4. vignetting recovery, linear space, rn of the distortion-corrected
  // position. Manual polynomial × embedded-profile spline gain (hdr.w; ships
  // OFF — divisor undetermined, see LENS_PROFILE_VIGNETTE_ON).
  let vig = u.p2.x;
  var gain = 1.0 + vig * (${LENS_VIG_R2} * rnD * rnD + ${LENS_VIG_R4} * rnD * rnD * rnD * rnD);
  if (prof.hdr.w > 0.5) {
    let vn = i32(prof.hdr.w);
    gain = gain * (1.0 + splineEval(prof.vig, vn, f32(vn - 1) * rnD) / prof.cfg.y);
  }
  return vec4f(r * gain, g * gain, b * gain, 1.0);
}
`;

/**
 * SHA-256 hex digest via the Web Crypto API (available in both the render
 * worker and the main thread — no new dependency). Used by the external-tool
 * hook node's cache key (checkExternalNodes): hashing real pixel bytes need
 * not be cryptographically hardened here, but SHA-256 is already built in
 * and collision-free enough for a cache key, so there is no reason to reach
 * for anything weaker.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let devicePromise: Promise<GPUDevice> | null = null;

function getGpuDevice(): Promise<GPUDevice> {
  devicePromise ??= (async () => {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this environment');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter found');
    return adapter.requestDevice();
  })();
  return devicePromise;
}

interface ExecPhase {
  pipeline: GPURenderPipeline;
  /** null when the pass declares no uniform. */
  uniformBuffer: GPUBuffer | null;
}

interface ExecStep {
  /** Sequential fullscreen passes; the last one writes the step's output. */
  phases: ExecPhase[];
  /** Unused (-1) for an image-node step (see `imageView`/`imageMissing` below) — it has no upstream. */
  src: number;
  /** Present only on blend steps (second input). */
  srcB?: number;
  /** Present only on masked blend steps (third input). */
  srcMask?: number;
  /** Image-node step (cover-fit case): the cached per-path texture view, read directly instead of `src` — see IMAGE_COVER_SHADER. */
  imageView?: GPUTextureView;
  /** Image-node step (no cached texture yet — missing/loading/no path): renders IMAGE_NODE_MISSING_GRAY instead. */
  imageMissing?: boolean;
  /** External-tool step (task #41) with a FRESH cached result available for its current content hash: blit this view instead of `src` — see resolveSteps' 'external' branch. Absent = plain pass-through of `src` (the phases already read `src` via a passthrough pipeline in that case). */
  externalResultView?: GPUTextureView;
}


/**
 * Live-resource diagnostics (perf-probe instrumentation, see scripts/perf-probe.mjs):
 * cheap running counters updated at every GPUBuffer/GPUTexture create/destroy
 * call site in this class. `live* = *Created - *Destroyed` — a real leak shows
 * up as a monotonically growing `liveBuffers`/`liveTextures` across repeated
 * edits, instead of only failing much later when the GPU device runs out of
 * memory. Cache sizes and the current ExecStep/step-texture counts are
 * included too since an unbounded cache is the same class of bug.
 */
export interface RendererStats {
  liveBuffers: number;
  liveTextures: number;
  buffersCreated: number;
  buffersDestroyed: number;
  texturesCreated: number;
  texturesDestroyed: number;
  /** Compiled-pipeline cache for plan passes (op/develop/custom shaderIds). */
  passPipelineCacheSize: number;
  /** Export-only encode pipeline cache ('encode/srgb' | 'encode/p3'). */
  exportEncodePipelineCacheSize: number;
  /** ExecSteps currently held by the renderer (one per plan step). */
  execStepCount: number;
  /** rgba16float step output textures currently held. */
  stepTextureCount: number;
}

export class GraphRenderer {
  private source: GPUTexture | null = null;
  // --- live-resource counters (diagnostics only, see RendererStats above) ---
  private buffersCreated = 0;
  private buffersDestroyed = 0;
  private texturesCreated = 0;
  private texturesDestroyed = 0;
  private stepTextures: GPUTexture[] = [];
  /** Intra-step ping-pong target for multi-pass steps. */
  private scratchTexture: GPUTexture | null = null;
  /**
   * Image-node feature: per-path decoded-texture cache, keyed by the SAME
   * raw path string a PlanStep 'image' carries (see graphDoc.ts). Populated
   * by setImageNodeTexture (renderWorker.ts's 'imageNode' command, itself
   * fed by the main thread's decode — see imageNodeSource.ts); cleared on
   * setImage (main-image switch — the image-node feature's own fragile-spot
   * note: a doc opened against a DIFFERENT photo must never see a stale
   * relative-path→wrong-file mapping survive from the previous one).
   */
  private imageNodeTextures = new Map<string, GPUTexture>();
  /** Compiled once, on first use — the image-node cover-fit blit (see IMAGE_COVER_SHADER). */
  private imageCoverPipelineCache: GPURenderPipeline | null = null;
  /** Compiled once, on first use — the image-node missing/loading placeholder (see IMAGE_GRAY_SHADER). */
  private imageGrayPipelineCache: GPURenderPipeline | null = null;
  // --- External-tool hook node (denoise v1, task #41) ------------------------
  /** Decoded RESULT textures, keyed by content-hash cacheKey (see checkExternalNodes/setExternalResult) — a bounded LRU (EXTERNAL_RESULT_LRU_CAPACITY), Map insertion order doubling as recency order (re-set on touch). Cleared on setImage (new photo) like every other per-photo cache in this class. */
  private externalResultTextures = new Map<string, GPUTexture>();
  /** Each external node's MOST RECENTLY COMPUTED upstream content-hash cacheKey (updated every render, independent of whether a result texture exists for it yet — see checkExternalNodes). */
  private externalNodeCacheKey = new Map<string, string>();
  /** Per-node idle-debounce timers (EXTERNAL_DEBOUNCE_MS) before a changed cacheKey actually triggers a subprocess request. */
  private externalDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private externalPassthroughPipelineCache: GPURenderPipeline | null = null;
  private externalEncodePipelineCache: GPURenderPipeline | null = null;
  private externalDecodePipelineCache: GPURenderPipeline | null = null;
  private steps: ExecStep[] = [];
  private outputIndex = -1;
  private blendPipelineCache: GPURenderPipeline | null = null;
  /** Pipelines for plan passes, keyed by PassSpec.shaderId. */
  private passPipelines = new Map<string, GPURenderPipeline>();
  /** Custom-code pipelines keyed by source; null = failed to compile. */
  private setGraphGen = 0;
  /** Resolves when the most recent setGraph() has landed (readback waits on it). */
  private graphReady: Promise<unknown> = Promise.resolve();
  /** Base/working dims: equal the source dims when geometry is absent, else the crop rectangle's dims. */
  private width = 0;
  private height = 0;
  /** Raw decoded-image dims (`source`'s own size) — geometry resamples FROM these. */
  private srcWidth = 0;
  private srcHeight = 0;
  /** Non-null only when the current plan has a non-identity geometry. */
  private planGeometry: PlanGeometry | undefined = undefined;
  /** Non-null only when the current plan has non-identity lens corrections. */
  private planLens: PlanLens | undefined = undefined;
  /** The current image's embedded Sony correction splines (task #34), or undefined (JPEG/non-Sony). */
  private profile: LensProfile | undefined = undefined;
  /**
   * Whether the resample pass must actually run for lens reasons this plan:
   * manual non-identity OR (profile toggled on AND the image carries a
   * profile). Distinct from `planLens` presence — a profile-on doc opened
   * against a JPEG has planLens set but nothing to correct, so this stays
   * false and the pass is skipped (bit-exact invariant).
   */
  private lensActive = false;
  /** Resample target for geometry+lens (crop/straighten/distortion/CA/vignette); dims = (width, height) above. */
  private baseTexture: GPUTexture | null = null;
  private resampleUniform: GPUBuffer | null = null;
  /** Profile knot tables uniform (binding 3 of the resample pass); present whenever the resample pass runs. */
  private resampleProfileUniform: GPUBuffer | null = null;
  private resamplePipelineCache: GPURenderPipeline | null = null;
  private resampleSamplerCache: GPUSampler | null = null;
  /** Export-only encode pipelines, keyed by shader id ('encode/srgb' | 'encode/p3'); the preview's own pipelines are separate fixed fields above. */
  private exportEncodePipelines = new Map<string, GPURenderPipeline>();
  /** Compiled once, shared by stats() and statsCrop() (verify-only). */
  private histogramPipelineCache: GPUComputePipeline | null = null;
  /** Compiled once, shared by scopeSamples(). */
  private scopePipelineCache: GPUComputePipeline | null = null;
  /** Compiled once, on first use — the canvas-only mask-select red overlay (see MASK_OVERLAY_ENCODE_SHADER). */
  private maskOverlayPipelineCache: GPURenderPipeline | null = null;
  /** Compiled once, on first use — the masked variant of the blend pass (see BLEND_MASK_SHADER). */
  private blendMaskPipelineCache: GPURenderPipeline | null = null;
  /** Compiled once, on first use — the node-thumbnail box-downsample pass (see THUMBNAIL_SHADER). */
  private thumbnailPipelineCache: GPURenderPipeline | null = null;

  /** Viewer-only display mode; readbacks/export always use the color encode. */
  viewMode: 'color' | 'grayscale' = 'color';

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvasFormat: GPUTextureFormat,
    private readonly canvasEncodePipeline: GPURenderPipeline,
    private readonly canvasGrayscalePipeline: GPURenderPipeline,
    private readonly readbackEncodePipeline: GPURenderPipeline
  ) {}

  static async create(canvas: OffscreenCanvas): Promise<GraphRenderer> {
    const device = await getGpuDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('webgpu canvas context unavailable');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    const makeEncodePipeline = (code: string, format: GPUTextureFormat) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
    };
    return new GraphRenderer(
      device,
      context,
      canvasFormat,
      makeEncodePipeline(ENCODE_SHADER, canvasFormat),
      makeEncodePipeline(GRAYSCALE_ENCODE_SHADER, canvasFormat),
      makeEncodePipeline(ENCODE_SHADER, 'rgba8unorm')
    );
  }

  get hasImage(): boolean {
    return this.source !== null;
  }

  /** Counted GPUBuffer.create — every allocation in this class goes through here. */
  private createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
    this.buffersCreated++;
    return this.device.createBuffer(desc);
  }

  /** Counted GPUBuffer.destroy — no-op on null/undefined (mirrors `buf?.destroy()`). */
  private destroyBuffer(buf: GPUBuffer | null | undefined): void {
    if (!buf) return;
    buf.destroy();
    this.buffersDestroyed++;
  }

  /** Counted GPUTexture.create — every allocation in this class goes through here. */
  private createTexture(desc: GPUTextureDescriptor): GPUTexture {
    this.texturesCreated++;
    return this.device.createTexture(desc);
  }

  /** Counted GPUTexture.destroy — no-op on null/undefined (mirrors `tex?.destroy()`). */
  private destroyTexture(tex: GPUTexture | null | undefined): void {
    if (!tex) return;
    tex.destroy();
    this.texturesDestroyed++;
  }

  /** Live-resource + cache-size snapshot — see RendererStats; exposed via window.__debug.rendererStats(). */
  rendererStats(): RendererStats {
    return {
      liveBuffers: this.buffersCreated - this.buffersDestroyed,
      liveTextures: this.texturesCreated - this.texturesDestroyed,
      buffersCreated: this.buffersCreated,
      buffersDestroyed: this.buffersDestroyed,
      texturesCreated: this.texturesCreated,
      texturesDestroyed: this.texturesDestroyed,
      passPipelineCacheSize: this.passPipelines.size,
      exportEncodePipelineCacheSize: this.exportEncodePipelines.size,
      execStepCount: this.steps.length,
      stepTextureCount: this.stepTextures.length,
    };
  }

  /** Pipeline for a plan pass — compiled once per shaderId. */
  private passPipeline(shaderId: string, wgsl: string): GPURenderPipeline {
    let pipeline = this.passPipelines.get(shaderId);
    if (!pipeline) {
      const module = this.device.createShaderModule({ code: wgsl });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
      this.passPipelines.set(shaderId, pipeline);
    }
    return pipeline;
  }

  /** Upload the linear preview as rgba16float (values are in [0,1] after decode). */
  setImage(image: PreparedImage): void {
    const { data, width, height } = image;
    this.destroyTexture(this.source);
    this.source = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    this.device.queue.writeTexture(
      { texture: this.source },
      half,
      { bytesPerRow: width * 8, rowsPerImage: height },
      [width, height]
    );
    for (const t of this.stepTextures) this.destroyTexture(t);
    this.stepTextures = [];
    this.destroyTexture(this.scratchTexture);
    this.scratchTexture = null;
    // Image-node cache invalidation on main-image switch (see the field's
    // own doc comment) — a fresh photo starts with no referenced-file
    // textures uploaded; syncImageNodeSources (main thread) re-posts
    // whatever the new doc's own image nodes need.
    for (const t of this.imageNodeTextures.values()) this.destroyTexture(t);
    this.imageNodeTextures.clear();
    // External-tool hook node cache invalidation on main-image switch (task
    // #41) — same rationale as imageNodeTextures above: a fresh photo starts
    // with no cached results and no "last seen" hashes, and any in-flight
    // debounce timer belonged to the OLD photo's content and must never fire
    // against the new one.
    for (const t of this.externalResultTextures.values()) this.destroyTexture(t);
    this.externalResultTextures.clear();
    this.externalNodeCacheKey.clear();
    for (const t of this.externalDebounceTimers.values()) clearTimeout(t);
    this.externalDebounceTimers.clear();
    this.destroyTexture(this.baseTexture);
    this.baseTexture = null;
    this.destroyBuffer(this.resampleUniform);
    this.resampleUniform = null;
    this.destroyBuffer(this.resampleProfileUniform);
    this.resampleProfileUniform = null;
    this.planGeometry = undefined;
    this.planLens = undefined;
    this.lensActive = false;
    this.profile = image.profile;
    this.srcWidth = width;
    this.srcHeight = height;
    this.width = width;
    this.height = height;
  }

  /**
   * Upload (or replace) the decoded texture for one image-node path — see
   * `imageNodeTextures`'s doc comment. Independent of the main preview
   * image/step-texture lifecycle: this can land at any time relative to a
   * setGraph()/render() call, same "eventually consistent" tolerance
   * customShaderNode artifacts already get (a step reads whatever is
   * cached AT DRAW TIME — see resolveSteps' 'image' branch — so a decode
   * that lands after this render already started simply shows up on the
   * NEXT one, no different from a custom shader validating a moment late).
   */
  setImageNodeTexture(path: string, image: PreparedImage): void {
    const { data, width, height } = image;
    this.destroyTexture(this.imageNodeTextures.get(path));
    const tex = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    this.device.queue.writeTexture({ texture: tex }, half, { bytesPerRow: width * 8, rowsPerImage: height }, [width, height]);
    this.imageNodeTextures.set(path, tex);
  }

  /**
   * Cover-fit (CSS `background-size: cover`-style) mapping of a `srcW`×`srcH`
   * texture into a `frameW`×`frameH` output: uniformly scaled so it fully
   * covers the frame (cropping whichever axis overflows), centered. Returns
   * the params IMAGE_COVER_SHADER's inverse map consumes directly.
   */
  private static coverFit(
    frameW: number,
    frameH: number,
    srcW: number,
    srcH: number
  ): { scale: number; offsetX: number; offsetY: number } {
    const scale = Math.max(frameW / srcW, frameH / srcH);
    return { scale, offsetX: (frameW - srcW * scale) / 2, offsetY: (frameH - srcH * scale) / 2 };
  }

  /** Pipeline for the image-node missing/loading placeholder (see IMAGE_GRAY_SHADER) — compiled once, on first use. */
  private imageGrayPipeline(): GPURenderPipeline {
    if (!this.imageGrayPipelineCache) {
      const module = this.device.createShaderModule({ code: IMAGE_GRAY_SHADER });
      this.imageGrayPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.imageGrayPipelineCache;
  }

  /** Pipeline for the image-node cover-fit blit (see IMAGE_COVER_SHADER) — compiled once, on first use. */
  private imageCoverPipeline(): GPURenderPipeline {
    if (!this.imageCoverPipelineCache) {
      const module = this.device.createShaderModule({ code: IMAGE_COVER_SHADER });
      this.imageCoverPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.imageCoverPipelineCache;
  }

  /** External-tool step (task #41): identity blit, rgba16float target — the "no cached result yet" pass-through AND the "blit a cached/decoded result texture" pipeline (same shader either way, see EXTERNAL_PASSTHROUGH_SHADER's doc comment). Also reused for the LINEAR-mode readback (no color conversion needed) and for reading a just-decoded result back to CPU. */
  private externalPassthroughPipeline(): GPURenderPipeline {
    if (!this.externalPassthroughPipelineCache) {
      const module = this.device.createShaderModule({ code: EXTERNAL_PASSTHROUGH_SHADER });
      this.externalPassthroughPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.externalPassthroughPipelineCache;
  }

  /** External-tool step (task #41), ENCODED mode: the SAME WGSL as ENCODE_SHADER (WORK_TO_SRGB + exact sRGB OETF), just targeting rgba16float instead of ENCODE_SHADER's fixed rgba8unorm pipelines — preserves 16-bit precision for the TIFF round trip. */
  private externalEncodePipeline(): GPURenderPipeline {
    if (!this.externalEncodePipelineCache) {
      const module = this.device.createShaderModule({ code: ENCODE_SHADER });
      this.externalEncodePipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.externalEncodePipelineCache;
  }

  /** External-tool step (task #41), ENCODED mode re-entry: exact inverse of externalEncodePipeline (sRGB EOTF then SRGB_TO_WORK) — see EXTERNAL_DECODE_SHADER. */
  private externalDecodePipeline(): GPURenderPipeline {
    if (!this.externalDecodePipelineCache) {
      const module = this.device.createShaderModule({ code: EXTERNAL_DECODE_SHADER });
      this.externalDecodePipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.externalDecodePipelineCache;
  }

  /**
   * Render `sourceView` through `pipeline` into a transient rgba16float
   * scratch texture and read it back as tightly packed RGBA float32 (no
   * clamping/scaling beyond whatever the pipeline itself applied) — shared by
   * the external-node preview readback (checkExternalNodes) and the
   * export-time cut-point capture (captureCutPointPixels). The f16→f32
   * upconversion is exact (Float16Array elements read back as full-precision
   * JS numbers), the mirror image of setImage's f32→f16 upload.
   */
  private async captureViaPipeline(
    sourceView: GPUTextureView,
    pipeline: GPURenderPipeline,
    width: number,
    height: number
  ): Promise<Float32Array> {
    const scratch = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = this.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      this.addPass(encoder, scratch.createView(), pipeline, [{ binding: 0, resource: sourceView }]);
      encoder.copyTextureToBuffer({ texture: scratch }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const half = new Float16Array(buffer.getMappedRange());
      const halfPerRow = bytesPerRow / 2;
      const out = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const rowStart = y * halfPerRow;
        const destStart = y * width * 4;
        for (let x = 0; x < width * 4; x++) out[destStart + x] = half[rowStart + x]!;
      }
      buffer.unmap();
      return out;
    } finally {
      this.destroyBuffer(buffer);
      this.destroyTexture(scratch);
    }
  }

  /**
   * Upload a Float32Array RGBA buffer (from an external-tool result — see
   * ExternalToolResult) as an rgba16float texture, decoding it back to LINEAR
   * (via externalDecodePipeline) when `encoded` is true. Returns a texture
   * the caller owns (TEXTURE_BINDING usage) — either cached (preview,
   * setExternalResult) or read back to CPU once more (export,
   * decodeExternalResultToCpu).
   */
  private uploadExternalResult(data: Float32Array, width: number, height: number, encoded: boolean): GPUTexture {
    const raw = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    this.device.queue.writeTexture({ texture: raw }, half, { bytesPerRow: width * 8, rowsPerImage: height }, [width, height]);
    if (!encoded) return raw;
    const linear = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const encoder = this.device.createCommandEncoder();
    this.addPass(encoder, linear.createView(), this.externalDecodePipeline(), [{ binding: 0, resource: raw.createView() }]);
    this.device.queue.submit([encoder.finish()]);
    this.destroyTexture(raw);
    return linear;
  }

  /** Insert/refresh an external-result texture's LRU recency (Map re-insertion order), evicting the oldest entry once over EXTERNAL_RESULT_LRU_CAPACITY. */
  private storeExternalResultTexture(cacheKey: string, tex: GPUTexture): void {
    const existing = this.externalResultTextures.get(cacheKey);
    if (existing) this.destroyTexture(existing);
    this.externalResultTextures.delete(cacheKey);
    this.externalResultTextures.set(cacheKey, tex);
    while (this.externalResultTextures.size > EXTERNAL_RESULT_LRU_CAPACITY) {
      const oldestKey = this.externalResultTextures.keys().next().value;
      if (oldestKey === undefined) break;
      this.destroyTexture(this.externalResultTextures.get(oldestKey));
      this.externalResultTextures.delete(oldestKey);
    }
  }

  /** Bump an existing entry's LRU recency without touching its content (a cache HIT during checkExternalNodes). */
  private touchExternalResultTexture(cacheKey: string): void {
    const tex = this.externalResultTextures.get(cacheKey);
    if (!tex) return;
    this.externalResultTextures.delete(cacheKey);
    this.externalResultTextures.set(cacheKey, tex);
  }

  /**
   * Apply a completed (or failed) external-tool round trip (renderWorker.ts's
   * 'externalResult' command, itself relayed from externalNodeRunner.ts's IPC
   * call): on success, decode + cache the result texture under `cacheKey` so
   * the NEXT render() picks it up (see resolveSteps' 'external' branch) —
   * this method never triggers a render itself; the caller's `onSettled`
   * (main-thread side, appStore.ts) bumps `externalNodeRev` for that. On
   * failure, nothing is cached — the node stays/returns to pass-through,
   * satisfying "ANY failure ⇒ pass through" with zero extra state to check.
   */
  setExternalResult(cacheKey: string, encoded: boolean, result: ExternalToolResult): void {
    if (!result.ok) return;
    const data = new Float32Array(result.data);
    const tex = this.uploadExternalResult(data, result.width, result.height, encoded);
    this.storeExternalResultTexture(cacheKey, tex);
  }

  /**
   * Export-time re-entry (appStore.ts's exportOnePath doc-rewrite, task #41):
   * decode an external-tool result back to a plain CPU Float32Array RGBA
   * (linear Rec.2020) so the caller can wrap it as a PreparedImage and feed
   * it through the EXISTING image-node upload path (setImageNodeTexture) —
   * export needs no persistent GPU cache entry, just the pixels once.
   */
  async decodeExternalResultToCpu(data: Float32Array, width: number, height: number, encoded: boolean): Promise<Float32Array> {
    if (!encoded) return data; // already linear — no GPU round trip needed at all
    const tex = this.uploadExternalResult(data, width, height, true);
    try {
      return await this.captureViaPipeline(tex.createView(), this.externalPassthroughPipeline(), width, height);
    } finally {
      this.destroyTexture(tex);
    }
  }

  /**
   * After every render() (renderWorker.ts's 'render' handler), scan the
   * PLAN's external steps: read back each one's CURRENT upstream pixels
   * (linear when `encoded` is false, GPU-sRGB-encoded when true — the exact
   * bytes the subprocess itself will receive), content-hash them, and act:
   *  - unchanged since the last check ⇒ nothing to do (this is what makes
   *    "re-run ONLY when upstream pixels actually changed" free — a stray
   *    render() with no real upstream edit costs one cheap readback+hash,
   *    never a re-run).
   *  - changed, and a result is ALREADY cached for the new hash (undo/redo
   *    back to previously-seen content) ⇒ touch its LRU recency and tell the
   *    caller to re-render (`notifyReady`) so resolveSteps picks it up —
   *    no subprocess needed.
   *  - changed, no cached result yet ⇒ debounce (EXTERNAL_DEBOUNCE_MS); once
   *    idle AND still the current hash (a further edit during the debounce
   *    window simply re-arms it), hand the caller a full run request
   *    (`requestRun`) — main-thread side (externalNodeRunner.ts) is the
   *    confirm/IPC gate from here.
   * Never throws into the caller: an individual step's readback failing
   * (should not happen in practice — geometry/lens are always resolved by
   * render() first) is simply skipped rather than aborting the whole scan.
   */
  async checkExternalNodes(
    plan: RenderPlan,
    requestRun: (req: { nodeId: string; cacheKey: string; command: string; encoded: boolean; width: number; height: number; data: ArrayBuffer }) => void,
    notifyReady: (nodeId: string) => void
  ): Promise<void> {
    if (!this.source) return;
    const myGen = this.setGraphGen;
    const { width, height } = this;
    for (const step of plan.steps) {
      if (step.type !== 'external') continue;
      try {
        const view =
          step.src < 0
            ? this.planGeometry || this.lensActive
              ? this.baseTexture?.createView()
              : this.source?.createView()
            : this.stepTextures[step.src]?.createView();
        if (!view) continue;
        const pipeline = step.encoded ? this.externalEncodePipeline() : this.externalPassthroughPipeline();
        const rgba = await this.captureViaPipeline(view, pipeline, width, height);
        if (myGen !== this.setGraphGen) return; // a newer render superseded this frame's readback — drop it
        const pixelHash = await sha256Hex(rgba.buffer as ArrayBuffer);
        const cacheKey = await sha256Hex(
          new TextEncoder().encode(`${pixelHash}|${step.command}|${step.encoded ? 1 : 0}|${step.nodeId}`).buffer
        );
        if (this.externalNodeCacheKey.get(step.nodeId) === cacheKey) continue; // unchanged since last check
        this.externalNodeCacheKey.set(step.nodeId, cacheKey);
        if (this.externalResultTextures.has(cacheKey)) {
          this.touchExternalResultTexture(cacheKey);
          notifyReady(step.nodeId);
          continue;
        }
        const nodeId = step.nodeId;
        const command = step.command;
        const encoded = step.encoded;
        clearTimeout(this.externalDebounceTimers.get(nodeId));
        const timer = setTimeout(() => {
          this.externalDebounceTimers.delete(nodeId);
          // Superseded by a later change during the debounce window — the
          // later call already re-armed its own timer for the new hash.
          if (this.externalNodeCacheKey.get(nodeId) !== cacheKey) return;
          requestRun({ nodeId, cacheKey, command, encoded, width, height, data: rgba.buffer as ArrayBuffer });
        }, EXTERNAL_DEBOUNCE_MS);
        this.externalDebounceTimers.set(nodeId, timer);
      } catch {
        // Best-effort scan — one node's readback failing must never break
        // every other node's check, or the render loop itself.
      }
    }
  }

  /** Pipeline for the resample (geometry+lens) pass — compiled once, shared by every consumer. */
  private resamplePipeline(): GPURenderPipeline {
    if (!this.resamplePipelineCache) {
      const module = this.device.createShaderModule({ code: RESAMPLE_SHADER });
      this.resamplePipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.resamplePipelineCache;
  }

  /**
   * Export-only encode pipeline for `colorSpace`, compiled once per id and
   * cached under it ('encode/srgb' | 'encode/p3') — used ONLY by
   * renderToPixels. The preview/readback paths (render, withEncodedPixels and
   * everything built on it) keep using the fixed `readbackEncodePipeline` /
   * canvas pipelines untouched, so this cache can never affect their output.
   */
  private exportEncodePipeline(colorSpace: ExportColorSpace): GPURenderPipeline {
    const shaderId = colorSpace === 'p3' ? 'encode/p3' : 'encode/srgb';
    let pipeline = this.exportEncodePipelines.get(shaderId);
    if (!pipeline) {
      const module = this.device.createShaderModule({ code: colorSpace === 'p3' ? ENCODE_SHADER_P3 : ENCODE_SHADER });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
      this.exportEncodePipelines.set(shaderId, pipeline);
    }
    return pipeline;
  }

  /** Clamp-to-edge bilinear sampler — the resample pass's only non-integer-coordinate read. */
  private resampleSampler(): GPUSampler {
    this.resampleSamplerCache ??= this.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    return this.resampleSamplerCache;
  }

  /** Packs geometry (or its identity default) + lens (or its identity default) into one uniform. */
  private resampleUniformData(
    geometry: PlanGeometry | undefined,
    lens: PlanLens | undefined,
    srcWidth: number,
    srcHeight: number
  ): Float32Array {
    const data = new Float32Array(12);
    data[0] = geometry?.crop.x ?? 0;
    data[1] = geometry?.crop.y ?? 0;
    data[2] = srcWidth;
    data[3] = srcHeight;
    data[4] = geometry?.angleRad ?? 0;
    data[5] = lens ? LENS_DISTORTION_STRENGTH * (lens.distortion / 100) : 0;
    data[6] = lens ? LENS_CA_STRENGTH * (lens.caRed / 100) : 0;
    data[7] = lens ? LENS_CA_STRENGTH * (lens.caBlue / 100) : 0;
    data[8] = lens ? lens.vignette / 100 : 0;
    data[9] = geometry?.orientation.quarterTurns ?? 0;
    data[10] = geometry?.orientation.flipH ? 1 : 0;
    return data;
  }

  /** True when the embedded profile should actually run for this plan (toggle on AND image carries splines). */
  private static profileActive(lens: PlanLens | undefined, profile: LensProfile | undefined): boolean {
    return !!(lens?.profile?.enabled && profile);
  }

  /** True when the resample pass must run for lens reasons (manual non-identity OR active profile). */
  private static lensActiveFor(lens: PlanLens | undefined, profile: LensProfile | undefined): boolean {
    if (!lens) return false;
    return !isIdentityLens(lens) || GraphRenderer.profileActive(lens, profile);
  }

  /**
   * Pack the LensProfile uniform (see the RESAMPLE_SHADER struct): 72 floats =
   * hdr(4) + cfg(4) + 4 knot tables × 16. All-zero (the profile-inactive case)
   * means hdr.x/z/w = 0, so every spline factor collapses to 1 — the pass runs
   * only for geometry/manual and stays bit-exact. `orientW/H` are the ORIENTED
   * frame dims, used to compute the distortion normalizer s (edge-max).
   */
  private static profileUniformData(
    lens: PlanLens | undefined,
    profile: LensProfile | undefined,
    orientW: number,
    orientH: number
  ): Float32Array {
    const data = new Float32Array(8 + 4 * LENS_PROFILE_KNOT_CAP);
    if (!GraphRenderer.profileActive(lens, profile) || !profile) return data;
    const writeTable = (offset: number, knots: number[]) => {
      for (let i = 0; i < knots.length && i < LENS_PROFILE_KNOT_CAP; i++) data[offset + i] = knots[i]!;
    };
    const dN = Math.min(profile.distortion.length, LENS_PROFILE_KNOT_CAP);
    const caN = Math.min(profile.caRed.length, LENS_PROFILE_KNOT_CAP);
    const vN = LENS_PROFILE_VIGNETTE_ON ? Math.min(profile.vignette.length, LENS_PROFILE_KNOT_CAP) : 0;
    data[0] = 1; // distortion on
    data[1] = dN;
    data[2] = caN;
    data[3] = vN; // 0 while vignetting ships off
    data[4] = distortionNormalizer(profile.distortion, orientW, orientH); // s
    data[5] = LENS_PROFILE_VIGNETTE_DIVISOR;
    writeTable(8, profile.distortion);
    writeTable(8 + LENS_PROFILE_KNOT_CAP, profile.caRed);
    writeTable(8 + 2 * LENS_PROFILE_KNOT_CAP, profile.caBlue);
    writeTable(8 + 3 * LENS_PROFILE_KNOT_CAP, profile.vignette);
    return data;
  }

  private static baseDims(plan: RenderPlan, srcWidth: number, srcHeight: number): { width: number; height: number } {
    if (!plan.geometry) return { width: srcWidth, height: srcHeight };
    const oriented = orientedDims(srcWidth, srcHeight, plan.geometry.orientation);
    return {
      width: Math.max(1, Math.round(plan.geometry.crop.w * oriented.width)),
      height: Math.max(1, Math.round(plan.geometry.crop.h * oriented.height)),
    };
  }

  private blendPipeline(): GPURenderPipeline {
    if (!this.blendPipelineCache) {
      const module = this.device.createShaderModule({ code: BLEND_SHADER });
      this.blendPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.blendPipelineCache;
  }

  /** Masked variant of the blend pass (see BLEND_MASK_SHADER) — compiled once, on first use. */
  private blendMaskPipeline(): GPURenderPipeline {
    if (!this.blendMaskPipelineCache) {
      const module = this.device.createShaderModule({ code: BLEND_MASK_SHADER });
      this.blendMaskPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
    }
    return this.blendMaskPipelineCache;
  }

  /** Canvas-only mask-select red overlay pipeline (see MASK_OVERLAY_ENCODE_SHADER) — compiled once, on first use. */
  private maskOverlayPipeline(): GPURenderPipeline {
    if (!this.maskOverlayPipelineCache) {
      const module = this.device.createShaderModule({ code: MASK_OVERLAY_ENCODE_SHADER });
      this.maskOverlayPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      });
    }
    return this.maskOverlayPipelineCache;
  }

  /** Node-thumbnail box-downsample pipeline (see THUMBNAIL_SHADER) — compiled once, on first use. */
  private thumbnailPipeline(): GPURenderPipeline {
    if (!this.thumbnailPipelineCache) {
      const module = this.device.createShaderModule({ code: THUMBNAIL_SHADER });
      this.thumbnailPipelineCache = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
    }
    return this.thumbnailPipelineCache;
  }

  /** Compute pipeline for HISTOGRAM_SHADER — compiled once, shared by stats() and statsCrop(). */
  private histogramPipeline(): GPUComputePipeline {
    if (!this.histogramPipelineCache) {
      const module = this.device.createShaderModule({ code: HISTOGRAM_SHADER });
      this.histogramPipelineCache = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'cs' },
      });
    }
    return this.histogramPipelineCache;
  }

  /** Compute pipeline for SCOPE_SAMPLE_SHADER — compiled once, shared by every scopeSamples() call. */
  private scopePipeline(): GPUComputePipeline {
    if (!this.scopePipelineCache) {
      const module = this.device.createShaderModule({ code: SCOPE_SAMPLE_SHADER });
      this.scopePipelineCache = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'cs' },
      });
    }
    return this.scopePipelineCache;
  }

  private makeStepTexture(): GPUTexture {
    return this.createTexture({
      size: [this.width, this.height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** One rgba16float target per plan step so outputs can fan out. */
  private ensureStepTextures(count: number, needScratch: boolean): void {
    while (this.stepTextures.length < count) this.stepTextures.push(this.makeStepTexture());
    if (needScratch && !this.scratchTexture) this.scratchTexture = this.makeStepTexture();
  }

  /**
   * Set the render plan to execute. Every pass in the plan is pre-validated
   * WGSL (custom shaders go through the validation device before they ever
   * reach a plan). Only the newest call wins if several overlap.
   */
  setGraph(plan: RenderPlan): Promise<void> {
    const promise = this.applyGraph(plan);
    this.graphReady = promise.catch(() => {});
    return promise;
  }

  private vec4Buffer(v: [number, number, number, number]): GPUBuffer {
    const buffer = this.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, new Float32Array(v));
    return buffer;
  }

  /**
   * `frameWidth`/`frameHeight` are the CONSUMER frame every step texture in
   * this plan shares (this.width/this.height for the preview path, the
   * export's own baseDims for renderToPixels) — needed ONLY by an 'image'
   * step's cover-fit math, so both call sites must pass the frame they are
   * ACTUALLY about to render into (not necessarily `this.width/height`,
   * which for applyGraph aren't updated to the new plan's dims until after
   * this call — see applyGraph's own doc comment on ordering).
   */
  private resolveSteps(plan: RenderPlan, frameWidth: number, frameHeight: number): ExecStep[] {
    return plan.steps.map((op): ExecStep => {
      if (op.type === 'passes') {
        const phases = op.passes.map((pass): ExecPhase => {
          let uniformBuffer: GPUBuffer | null = null;
          if (pass.uniforms.byteLength > 0) {
            // profile lattice is a read-only STORAGE buffer (78 KB > uniform
            // cap); everything else binds a uniform. layout:'auto' infers the
            // binding type from the WGSL, so the bind-group entry is identical.
            uniformBuffer = this.createBuffer({
              size: pass.uniforms.byteLength,
              usage: (pass.storage ? GPUBufferUsage.STORAGE : GPUBufferUsage.UNIFORM) | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(uniformBuffer, 0, pass.uniforms);
          }
          return { pipeline: this.passPipeline(pass.shaderId, pass.wgsl), uniformBuffer };
        });
        return { phases, src: op.src };
      }
      if (op.type === 'image') {
        const tex = this.imageNodeTextures.get(op.path);
        if (!tex) {
          // No path chosen yet, decode still in flight, or the file is
          // missing/unreadable — solid gray, no texture binding needed.
          return {
            phases: [{ pipeline: this.imageGrayPipeline(), uniformBuffer: this.vec4Buffer([IMAGE_NODE_MISSING_GRAY, 0, 0, 0]) }],
            src: -1,
            imageMissing: true,
          };
        }
        const fit = GraphRenderer.coverFit(frameWidth, frameHeight, tex.width, tex.height);
        return {
          phases: [{ pipeline: this.imageCoverPipeline(), uniformBuffer: this.vec4Buffer([fit.scale, fit.offsetX, fit.offsetY, 0]) }],
          src: -1,
          imageView: tex.createView(),
        };
      }
      if (op.type === 'external') {
        // A fresh cached result for this node's CURRENT content hash (see
        // checkExternalNodes) blits it in place of `src`; otherwise a plain
        // identity pass-through of `src` — never gray, unlike a missing
        // image-node source (this node's input IS a perfectly good picture,
        // see externalNode.ts's doc comment).
        const cacheKey = this.externalNodeCacheKey.get(op.nodeId);
        const resultTex = cacheKey ? this.externalResultTextures.get(cacheKey) : undefined;
        if (resultTex) {
          return {
            phases: [{ pipeline: this.externalPassthroughPipeline(), uniformBuffer: null }],
            src: op.src,
            externalResultView: resultTex.createView(),
          };
        }
        return {
          phases: [{ pipeline: this.externalPassthroughPipeline(), uniformBuffer: null }],
          src: op.src,
        };
      }
      const hasMask = op.srcMask !== undefined;
      return {
        phases: [{ pipeline: hasMask ? this.blendMaskPipeline() : this.blendPipeline(), uniformBuffer: this.vec4Buffer(op.uniform) }],
        src: op.srcA,
        srcB: op.srcB,
        srcMask: op.srcMask,
      };
    });
  }

  private destroySteps(steps: ExecStep[]): void {
    for (const step of steps) for (const phase of step.phases) this.destroyBuffer(phase.uniformBuffer);
  }

  private async applyGraph(plan: RenderPlan): Promise<void> {
    const gen = ++this.setGraphGen;
    // Base dims computed BEFORE resolveSteps (reordered for the image-node
    // feature): an 'image' step's cover-fit math needs the CONSUMER frame
    // this plan is about to use, which is `nextWidth`/`nextHeight` below —
    // `this.width`/`this.height` still hold the PREVIOUS plan's dims at this
    // point (they're only assigned after the dimsChanged branch further
    // down), so resolveSteps must be handed the freshly computed pair
    // explicitly rather than reading `this.width`/`this.height` itself.
    const { width: nextWidth, height: nextHeight } = GraphRenderer.baseDims(plan, this.srcWidth, this.srcHeight);
    const steps = this.resolveSteps(plan, nextWidth, nextHeight);
    if (gen !== this.setGraphGen) {
      this.destroySteps(steps);
      return;
    }
    this.destroySteps(this.steps);
    this.steps = steps;
    this.outputIndex = plan.output;

    // Base dims: the source itself when geometry is identity (zero cost, no
    // extra texture/pass), else the crop rectangle at source resolution. Lens
    // never changes dims — only geometry's crop does.
    const dimsChanged = nextWidth !== this.width || nextHeight !== this.height;

    // The resample pass activates when EITHER geometry or lens is active —
    // both fold into the same pass, so a lens-only edit still needs the base
    // texture even though geometry itself stays absent. "Lens active" folds in
    // the embedded profile: a profile-on doc against a JPEG (no splines on the
    // image) is NOT active and skips the pass, staying bit-exact.
    const lensActive = GraphRenderer.lensActiveFor(plan.lens, this.profile);
    if (plan.geometry || lensActive) {
      if (!this.baseTexture || this.baseTexture.width !== nextWidth || this.baseTexture.height !== nextHeight) {
        this.destroyTexture(this.baseTexture);
        this.baseTexture = this.createTexture({
          size: [nextWidth, nextHeight],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      this.destroyBuffer(this.resampleUniform);
      this.resampleUniform = this.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(
        this.resampleUniform,
        0,
        this.resampleUniformData(plan.geometry, plan.lens, this.srcWidth, this.srcHeight)
      );
      const orient = plan.geometry?.orientation ?? { quarterTurns: 0 as const, flipH: false };
      const od = orientedDims(this.srcWidth, this.srcHeight, orient);
      this.destroyBuffer(this.resampleProfileUniform);
      this.resampleProfileUniform = this.createBuffer({
        size: (8 + 4 * LENS_PROFILE_KNOT_CAP) * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(
        this.resampleProfileUniform,
        0,
        GraphRenderer.profileUniformData(plan.lens, this.profile, od.width, od.height)
      );
    } else {
      this.destroyTexture(this.baseTexture);
      this.baseTexture = null;
      this.destroyBuffer(this.resampleUniform);
      this.resampleUniform = null;
      this.destroyBuffer(this.resampleProfileUniform);
      this.resampleProfileUniform = null;
    }
    this.planGeometry = plan.geometry;
    this.planLens = plan.lens;
    this.lensActive = lensActive;

    if (dimsChanged) {
      for (const t of this.stepTextures) this.destroyTexture(t);
      this.stepTextures = [];
      this.destroyTexture(this.scratchTexture);
      this.scratchTexture = null;
      this.width = nextWidth;
      this.height = nextHeight;
    }
  }

  /** Output dims of the current render (post-crop when geometry is active). */
  outputDims(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private addPass(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    pipeline: GPURenderPipeline,
    entries: GPUBindGroupEntry[]
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.draw(3);
    pass.end();
  }

  /**
   * Record every step's passes; shared by all consumers. Each step ends in
   * its own texture (so outputs can fan out); multi-phase steps ping-pong
   * through the scratch texture so the LAST phase lands on the step texture.
   */
  private static recordSteps(
    addPass: GraphRenderer['addPass'],
    steps: ExecStep[],
    outputIndex: number,
    sourceView: GPUTextureView,
    stepTextures: GPUTexture[],
    scratch: GPUTexture | null,
    encoder: GPUCommandEncoder,
    /** Bilinear clamp-to-edge sampler for an image-node step's cover-fit blit (see IMAGE_COVER_SHADER) — the SAME sampler `effectiveSourceView`'s resample pass uses, reused rather than compiling a second one. */
    imageSampler: GPUSampler
  ): GPUTextureView {
    const views = stepTextures.map((t) => t.createView());
    const scratchView = scratch?.createView() ?? null;
    const at = (i: number) => (i < 0 ? sourceView : views[i]!);
    steps.forEach((step, i) => {
      if (step.imageMissing || step.imageView) {
        const phase = step.phases[0]!;
        const entries: GPUBindGroupEntry[] = step.imageView
          ? [
              { binding: 0, resource: step.imageView },
              { binding: 1, resource: imageSampler },
              { binding: 2, resource: { buffer: phase.uniformBuffer! } },
            ]
          : [{ binding: 0, resource: { buffer: phase.uniformBuffer! } }];
        addPass(encoder, views[i]!, phase.pipeline, entries);
        return;
      }
      if (step.externalResultView) {
        // External-tool step (task #41) with a fresh cached result: blit IT
        // in, ignoring `at(step.src)` entirely — no uniform, same single-
        // texture-binding shape as the plain pass-through phase below.
        const phase = step.phases[0]!;
        addPass(encoder, views[i]!, phase.pipeline, [{ binding: 0, resource: step.externalResultView }]);
        return;
      }
      if (step.srcB !== undefined) {
        const phase = step.phases[0]!;
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: at(step.src) },
          { binding: 1, resource: at(step.srcB) },
        ];
        if (step.srcMask !== undefined) {
          entries.push({ binding: 2, resource: at(step.srcMask) });
          entries.push({ binding: 3, resource: { buffer: phase.uniformBuffer! } });
        } else {
          entries.push({ binding: 2, resource: { buffer: phase.uniformBuffer! } });
        }
        addPass(encoder, views[i]!, phase.pipeline, entries);
        return;
      }
      const n = step.phases.length;
      let input = at(step.src);
      step.phases.forEach((phase, j) => {
        // choose targets so phase n-1 writes the step texture
        const target = (n - 1 - j) % 2 === 0 ? views[i]! : scratchView!;
        const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: input }];
        if (phase.uniformBuffer) entries.push({ binding: 1, resource: { buffer: phase.uniformBuffer } });
        addPass(encoder, target, phase.pipeline, entries);
        input = target;
      });
    });
    return at(outputIndex);
  }

  /**
   * The chain's source view: the decoded texture itself when BOTH geometry
   * and lens are identity (zero added pass, bit-exact), else a fresh
   * resample of it into `baseTexture` — recorded every call, same cost model
   * as every other pass in the chain (they all re-record each render() too).
   */
  private effectiveSourceView(encoder: GPUCommandEncoder): GPUTextureView {
    if (!this.planGeometry && !this.lensActive) return this.source!.createView();
    const target = this.baseTexture!.createView();
    this.addPass(encoder, target, this.resamplePipeline(), [
      { binding: 0, resource: this.source!.createView() },
      { binding: 1, resource: this.resampleSampler() },
      { binding: 2, resource: { buffer: this.resampleUniform! } },
      { binding: 3, resource: { buffer: this.resampleProfileUniform! } },
    ]);
    return target;
  }

  /** Record the plan; returns the view holding the final linear result. */
  private addChainPasses(encoder: GPUCommandEncoder): GPUTextureView {
    const sourceView = this.effectiveSourceView(encoder);
    this.ensureStepTextures(
      this.steps.length,
      this.steps.some((s) => s.phases.length > 1)
    );
    return GraphRenderer.recordSteps(
      this.addPass.bind(this),
      this.steps,
      this.outputIndex,
      sourceView,
      this.stepTextures,
      this.scratchTexture,
      encoder,
      this.resampleSampler()
    );
  }

  /**
   * Execute the chain and draw to the canvas (canvas must match the image
   * size). `overlayMaskStepIndex` (masks milestone, present-only — see
   * MASK_OVERLAY_ENCODE_SHADER's doc comment): when a valid step index, the
   * canvas shows that step's own mask value composited as a red overlay
   * instead of the plain color/grayscale exit; null/undefined/out-of-range
   * falls back to the normal exit. Never affects readbacks, stats, scopes,
   * or export — those all call addChainPasses/withEncodedPixels directly.
   */
  render(overlayMaskStepIndex?: number | null): void {
    if (!this.source) return;
    const encoder = this.device.createCommandEncoder();
    const linear = this.addChainPasses(encoder);
    const canvasView = this.context.getCurrentTexture().createView();
    if (
      overlayMaskStepIndex !== undefined &&
      overlayMaskStepIndex !== null &&
      overlayMaskStepIndex >= 0 &&
      overlayMaskStepIndex < this.stepTextures.length
    ) {
      const maskView = this.stepTextures[overlayMaskStepIndex]!.createView();
      this.addPass(encoder, canvasView, this.maskOverlayPipeline(), [
        { binding: 0, resource: linear },
        { binding: 1, resource: maskView },
      ]);
    } else {
      const pipeline = this.viewMode === 'grayscale' ? this.canvasGrayscalePipeline : this.canvasEncodePipeline;
      this.addPass(encoder, canvasView, pipeline, [{ binding: 0, resource: linear }]);
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Run the chain over an arbitrary image (e.g. the full-resolution decode
   * for export) and return tightly-packed RGBA8 pixels display-encoded in
   * `colorSpace` (default 'srgb'; the canvas preview always stays sRGB —
   * only this export path selects the P3 variant). Independent of the
   * preview state; all GPU resources are transient.
   */
  async renderToPixels(
    image: PreparedImage,
    plan: RenderPlan,
    colorSpace: ExportColorSpace = 'srgb'
  ): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
    const { device } = this;
    const { data, width: srcWidth, height: srcHeight } = image;
    const source = this.createTexture({
      size: [srcWidth, srcHeight],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    device.queue.writeTexture({ texture: source }, half, { bytesPerRow: srcWidth * 8, rowsPerImage: srcHeight }, [
      srcWidth,
      srcHeight,
    ]);
    // Output dims: the crop rectangle at THIS image's resolution when
    // geometry is active (so a full-res export crops at full-res dims, same
    // normalized fraction as the preview) — else the source dims, unchanged.
    // Lens never changes dims (only geometry's crop does).
    const { width, height } = GraphRenderer.baseDims(plan, srcWidth, srcHeight);
    const temps: GPUTexture[] = [source];
    const tempBuffers: GPUBuffer[] = [];
    const makeTarget = (format: GPUTextureFormat, usage: number) => {
      const t = this.createTexture({ size: [width, height], format, usage });
      temps.push(t);
      return t;
    };

    // Image-node cover-fit target: THIS export's own frame (width/height
    // above), not the preview's this.width/this.height — an image-node
    // reference composites at whatever resolution its consumer renders at,
    // export included (see resolveSteps' doc comment).
    const steps = this.resolveSteps(plan, width, height);
    try {
      const encoder = device.createCommandEncoder();
      let baseView = source.createView();
      // Export uses the PASSED image's profile (this is a stateless render over
      // `image`, independent of the preview's setImage()).
      const lensActive = GraphRenderer.lensActiveFor(plan.lens, image.profile);
      if (plan.geometry || lensActive) {
        const base = makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
        const uniform = this.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        tempBuffers.push(uniform);
        device.queue.writeBuffer(uniform, 0, this.resampleUniformData(plan.geometry, plan.lens, srcWidth, srcHeight));
        const orient = plan.geometry?.orientation ?? { quarterTurns: 0 as const, flipH: false };
        const od = orientedDims(srcWidth, srcHeight, orient);
        const profileUniform = this.createBuffer({
          size: (8 + 4 * LENS_PROFILE_KNOT_CAP) * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        tempBuffers.push(profileUniform);
        device.queue.writeBuffer(
          profileUniform,
          0,
          GraphRenderer.profileUniformData(plan.lens, image.profile, od.width, od.height)
        );
        this.addPass(encoder, base.createView(), this.resamplePipeline(), [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.resampleSampler() },
          { binding: 2, resource: { buffer: uniform } },
          { binding: 3, resource: { buffer: profileUniform } },
        ]);
        baseView = base.createView();
      }
      const stepTextures = plan.steps.map(() =>
        makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT)
      );
      const scratch = steps.some((s) => s.phases.length > 1)
        ? makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT)
        : null;
      const linear = GraphRenderer.recordSteps(
        this.addPass.bind(this),
        steps,
        plan.output,
        baseView,
        stepTextures,
        scratch,
        encoder,
        this.resampleSampler()
      );
      const target = makeTarget('rgba8unorm', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = this.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      // tracked from creation, same as `temps`/`tempBuffers` above — if
      // mapAsync (below) ever rejects, the outer finally still frees it
      // instead of only on the success path.
      tempBuffers.push(buffer);
      this.addPass(encoder, target.createView(), this.exportEncodePipeline(colorSpace), [
        { binding: 0, resource: linear },
      ]);
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange());
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      }
      buffer.unmap();
      return { data: out, width, height };
    } finally {
      for (const t of temps) this.destroyTexture(t);
      for (const b of tempBuffers) this.destroyBuffer(b);
      this.destroySteps(steps);
    }
  }

  /**
   * Export-time cut point (external-tool hook node, task #41): renders
   * `plan` (a plan TRUNCATED at the external node's own INPUT — the caller
   * builds it via buildPlan's `inspectNodeId`, same "cut point" mechanism the
   * per-node-preview inspect mode uses) over an arbitrary full-resolution
   * `image`, and reads the result back as tightly packed RGBA float32 —
   * ENCODED (sRGB, 16-bit-precision-equivalent) when `encoded`, else raw
   * linear Rec.2020 — instead of renderToPixels' fixed rgba8unorm export
   * encode. Structurally a near-twin of renderToPixels (same source
   * upload/resample/steps setup); only the final exit pass + readback format
   * differ, so the two are kept as separate methods rather than threading a
   * format/pipeline choice through renderToPixels' export-specific callers.
   */
  async captureCutPointPixels(
    image: PreparedImage,
    plan: RenderPlan,
    encoded: boolean
  ): Promise<{ data: Float32Array; width: number; height: number }> {
    const { device } = this;
    const { data, width: srcWidth, height: srcHeight } = image;
    const source = this.createTexture({
      size: [srcWidth, srcHeight],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    device.queue.writeTexture({ texture: source }, half, { bytesPerRow: srcWidth * 8, rowsPerImage: srcHeight }, [
      srcWidth,
      srcHeight,
    ]);
    const { width, height } = GraphRenderer.baseDims(plan, srcWidth, srcHeight);
    const temps: GPUTexture[] = [source];
    const tempBuffers: GPUBuffer[] = [];
    const makeTarget = (format: GPUTextureFormat, usage: number) => {
      const t = this.createTexture({ size: [width, height], format, usage });
      temps.push(t);
      return t;
    };
    const steps = this.resolveSteps(plan, width, height);
    try {
      const encoder = device.createCommandEncoder();
      let baseView = source.createView();
      const lensActive = GraphRenderer.lensActiveFor(plan.lens, image.profile);
      if (plan.geometry || lensActive) {
        const base = makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
        const uniform = this.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        tempBuffers.push(uniform);
        device.queue.writeBuffer(uniform, 0, this.resampleUniformData(plan.geometry, plan.lens, srcWidth, srcHeight));
        const orient = plan.geometry?.orientation ?? { quarterTurns: 0 as const, flipH: false };
        const od = orientedDims(srcWidth, srcHeight, orient);
        const profileUniform = this.createBuffer({
          size: (8 + 4 * LENS_PROFILE_KNOT_CAP) * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        tempBuffers.push(profileUniform);
        device.queue.writeBuffer(
          profileUniform,
          0,
          GraphRenderer.profileUniformData(plan.lens, image.profile, od.width, od.height)
        );
        this.addPass(encoder, base.createView(), this.resamplePipeline(), [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.resampleSampler() },
          { binding: 2, resource: { buffer: uniform } },
          { binding: 3, resource: { buffer: profileUniform } },
        ]);
        baseView = base.createView();
      }
      const stepTextures = plan.steps.map(() =>
        makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT)
      );
      const scratch = steps.some((s) => s.phases.length > 1)
        ? makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT)
        : null;
      const linear = GraphRenderer.recordSteps(
        this.addPass.bind(this),
        steps,
        plan.output,
        baseView,
        stepTextures,
        scratch,
        encoder,
        this.resampleSampler()
      );
      const finalTarget = makeTarget('rgba16float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      const pipeline = encoded ? this.externalEncodePipeline() : this.externalPassthroughPipeline();
      this.addPass(encoder, finalTarget.createView(), pipeline, [{ binding: 0, resource: linear }]);
      const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
      const buffer = this.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      tempBuffers.push(buffer);
      encoder.copyTextureToBuffer({ texture: finalTarget }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mappedHalf = new Float16Array(buffer.getMappedRange());
      const halfPerRow = bytesPerRow / 2;
      const out = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const rowStart = y * halfPerRow;
        const destStart = y * width * 4;
        for (let x = 0; x < width * 4; x++) out[destStart + x] = mappedHalf[rowStart + x]!;
      }
      buffer.unmap();
      return { data: out, width, height };
    } finally {
      for (const t of temps) this.destroyTexture(t);
      for (const b of tempBuffers) this.destroyBuffer(b);
      this.destroySteps(steps);
    }
  }

  /**
   * Run the chain + encode offscreen and hand the mapped RGBA8 rows to `use`.
   * `target`/`buffer` are created BEFORE the try so a throw between creation
   * and the try (there is none today, but the original code also left
   * `buffer.mapAsync` — which CAN reject, e.g. on a lost device — outside any
   * try/finally) can never again skip their destroy: the whole GPU round-trip
   * from submit through `use` is now inside one try, with a single finally
   * that always frees both, success or failure.
   */
  private async withEncodedPixels<T>(
    use: (px: Uint8Array, bytesPerRow: number, width: number, height: number) => T
  ): Promise<T | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { width, height } = this;
    const target = this.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      const linear = this.addChainPasses(encoder);
      this.addPass(encoder, target.createView(), this.readbackEncodePipeline, [{ binding: 0, resource: linear }]);
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      return use(new Uint8Array(buffer.getMappedRange()), bytesPerRow, width, height);
    } finally {
      buffer.unmap(); // spec: a no-op when not currently mapped — safe on any exit path
      this.destroyBuffer(buffer);
      this.destroyTexture(target);
    }
  }

  /**
   * Verify-only (external-tool hook node, task #41 — scripts/verify-external.mjs):
   * mean of the chain's FINAL LINEAR (pre-encode) output, unlike readbackMean
   * (which averages the display-ENCODED output every other consumer cares
   * about). Exists because a node's effect in LINEAR space (e.g. "+0.1 to
   * every linear-mode sample") is exactly predictable here, whereas the
   * encoded mean is always warped by the sRGB curve + gamut matrix on top —
   * this is what makes the verify script's numeric assertions possible
   * without duplicating that math in JS.
   */
  async readbackLinearMean(): Promise<{ r: number; g: number; b: number } | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { width, height } = this;
    const scratch = this.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = this.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      const linear = this.addChainPasses(encoder);
      this.addPass(encoder, scratch.createView(), this.externalPassthroughPipeline(), [{ binding: 0, resource: linear }]);
      encoder.copyTextureToBuffer({ texture: scratch }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const half = new Float16Array(buffer.getMappedRange());
      const halfPerRow = bytesPerRow / 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < height; y++) {
        const row = y * halfPerRow;
        for (let x = 0; x < width; x++) {
          const s = row + x * 4;
          r += half[s]!;
          g += half[s + 1]!;
          b += half[s + 2]!;
        }
      }
      const n = width * height;
      buffer.unmap();
      return { r: r / n, g: g / n, b: b / n };
    } finally {
      this.destroyBuffer(buffer);
      this.destroyTexture(scratch);
    }
  }

  /** Execute the chain offscreen and average the encoded output on the CPU. */
  readbackMean(): Promise<{ r: number; g: number; b: number } | null> {
    return this.withEncodedPixels((px, bytesPerRow, width, height) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < height; y++) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x++) {
          const s = row + x * 4;
          r += px[s]!;
          g += px[s + 1]!;
          b += px[s + 2]!;
        }
      }
      const n = width * height;
      return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
    });
  }

  /**
   * High-frequency energy of the encoded output: mean |horizontal gradient|
   * of luma and of the r−b chroma difference. Sharpening raises the luma
   * number, noise reduction lowers it (chroma NR lowers the chroma one) —
   * deterministic, so the verify harness can assert strict inequalities.
   */
  readbackSharpness(): Promise<{ luma: number; chroma: number } | null> {
    return this.withEncodedPixels((px, bytesPerRow, width, height) => {
      let sumL = 0;
      let sumC = 0;
      for (let y = 0; y < height; y++) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width - 1; x++) {
          const s = row + x * 4;
          const l0 = WORKING_LUMA[0] * px[s]! + WORKING_LUMA[1] * px[s + 1]! + WORKING_LUMA[2] * px[s + 2]!;
          const l1 = WORKING_LUMA[0] * px[s + 4]! + WORKING_LUMA[1] * px[s + 5]! + WORKING_LUMA[2] * px[s + 6]!;
          sumL += Math.abs(l1 - l0);
          sumC += Math.abs(px[s + 4]! - px[s + 6]! - (px[s]! - px[s + 2]!));
        }
      }
      const n = (width - 1) * height;
      return { luma: sumL / n / 255, chroma: sumC / n / 255 };
    });
  }

  /**
   * Strided RGB samples of the encoded output for the scope displays, read
   * back as a ≤256×144×4-byte packed buffer (GPU compute reduction — see
   * SCOPE_SAMPLE_SHADER) instead of the whole encoded frame.
   */
  async scopeSamples(maxCols = 256, maxRows = 144): Promise<ScopeSamples | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { width, height } = this;
    const strideX = Math.max(1, Math.ceil(width / maxCols));
    const strideY = Math.max(1, Math.ceil(height / maxRows));
    const cols = Math.ceil(width / strideX);
    const rows = Math.ceil(height / strideY);
    const sampleCount = cols * rows;
    const target = this.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const outBuffer = this.createBuffer({
      size: Math.max(4, sampleCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const paramsBuffer = this.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([strideX, strideY, cols, rows]));
    const readBuffer = this.createBuffer({
      size: Math.max(4, sampleCount * 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      const linear = this.addChainPasses(encoder);
      this.addPass(encoder, target.createView(), this.readbackEncodePipeline, [{ binding: 0, resource: linear }]);
      const pipeline = this.scopePipeline();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: target.createView() },
            { binding: 1, resource: { buffer: outBuffer } },
            { binding: 2, resource: { buffer: paramsBuffer } },
          ],
        })
      );
      pass.dispatchWorkgroups(Math.ceil(cols / 16), Math.ceil(rows / 16));
      pass.end();
      encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, Math.max(4, sampleCount * 4));
      this.device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint32Array(readBuffer.getMappedRange());
      const data = new Uint8Array(sampleCount * 3);
      for (let i = 0; i < sampleCount; i++) {
        const v = mapped[i]!;
        data[i * 3] = v & 0xff;
        data[i * 3 + 1] = (v >> 8) & 0xff;
        data[i * 3 + 2] = (v >> 16) & 0xff;
      }
      return { cols, rows, data };
    } finally {
      readBuffer.unmap();
      this.destroyBuffer(readBuffer);
      this.destroyBuffer(paramsBuffer);
      this.destroyBuffer(outBuffer);
      this.destroyTexture(target);
    }
  }

  /**
   * GPU-reduced 256-bin RGB+luma histogram and clip counts (see
   * HISTOGRAM_SHADER), restricted to the rectangle [x0,x0+w) x [y0,y0+h) of
   * the encoded output. `stats()` calls this with the full output rectangle;
   * `statsCrop()` (verify-only) calls it with an arbitrary crop.
   */
  private async computeHistogram(x0: number, y0: number, w: number, h: number): Promise<HistogramData | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { width, height } = this;
    const target = this.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const binsBuffer = this.createBuffer({
      size: HISTOGRAM_BIN_COUNT * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const paramsBuffer = this.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([x0, y0, w, h]));
    const readBuffer = this.createBuffer({
      size: HISTOGRAM_BIN_COUNT * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      const linear = this.addChainPasses(encoder);
      this.addPass(encoder, target.createView(), this.readbackEncodePipeline, [{ binding: 0, resource: linear }]);
      const pipeline = this.histogramPipeline();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: target.createView() },
            { binding: 1, resource: { buffer: binsBuffer } },
            { binding: 2, resource: { buffer: paramsBuffer } },
          ],
        })
      );
      pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
      pass.end();
      encoder.copyBufferToBuffer(binsBuffer, 0, readBuffer, 0, HISTOGRAM_BIN_COUNT * 4);
      this.device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint32Array(readBuffer.getMappedRange());
      const n = w * h;
      return {
        bins: 256,
        r: Array.from(mapped.subarray(0, 256)),
        g: Array.from(mapped.subarray(256, 512)),
        b: Array.from(mapped.subarray(512, 768)),
        luma: Array.from(mapped.subarray(768, 1024)),
        shadowClip: n > 0 ? mapped[1024]! / n : 0,
        highlightClip: n > 0 ? mapped[1025]! / n : 0,
        pixels: n,
      };
    } finally {
      readBuffer.unmap();
      this.destroyBuffer(readBuffer);
      this.destroyBuffer(paramsBuffer);
      this.destroyBuffer(binsBuffer);
      this.destroyTexture(target);
    }
  }

  /** 256-bin RGB + luma histogram and clipping fractions of the encoded output. */
  stats(): Promise<HistogramData | null> {
    return this.computeHistogram(0, 0, this.width, this.height);
  }

  /**
   * Verify-only: same GPU histogram compute as stats(), restricted to an
   * arbitrary crop rectangle of the encoded output — used by
   * scripts/verify-ms10-histogram.mjs to cross-check HISTOGRAM_SHADER's
   * binning bit-for-bit against a JS recomputation over real pixels (see
   * encodedCropForVerify below for how those real pixels are obtained).
   */
  statsCrop(x0: number, y0: number, w: number, h: number): Promise<HistogramData | null> {
    return this.computeHistogram(x0, y0, w, h);
  }

  /**
   * Verify-only: raw encoded RGBA bytes for a crop rectangle of the current
   * output. Built on withEncodedPixels (the full-frame CPU readback kept for
   * readbackMean/readbackSharpness) purely so scripts/verify-ms10-histogram.mjs
   * can independently recompute histogram bins in JS over real pixels and
   * diff them against statsCrop()'s GPU result — never used by the
   * production stats()/scopeSamples() path, which stays GPU-side end to end.
   */
  encodedCropForVerify(x0: number, y0: number, w: number, h: number): Promise<Uint8Array | null> {
    return this.withEncodedPixels((px, bytesPerRow) => {
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcRow = (y0 + y) * bytesPerRow + x0 * 4;
        out.set(px.subarray(srcRow, srcRow + w * 4), y * w * 4);
      }
      return out;
    });
  }

  /**
   * Node thumbnails (per-node-preview pack, tier 1): downsamples every
   * DISTINCT step index named in `nodeSteps` (a nodeId → step-index map —
   * see RenderPlan.nodeSteps) to a `longEdge`-scaled RGBA buffer, keyed back
   * out to every nodeId that shares it. `-1` reads the same effective source
   * view `render()` itself uses (the geometry/lens-resampled base, or the
   * raw decode when both are identity) — so the input node and any
   * identity/bypassed op both get a real thumbnail with zero special-casing.
   *
   * Retained-texture lifetime vs the step-texture pool (this pack's
   * flagged fragile spot): this method reads `this.stepTextures` as they
   * stand RIGHT NOW, with no re-record of the main chain. That is only safe
   * because the CALLER (renderWorker.ts's 'thumbnails' request handler)
   * never fires until the render-worker message queue has fully drained the
   * most recent 'render' command first — worker message handling has no
   * macrotask hops between "start applying a render" and "submit() the
   * chain" (setGraph/applyGraph do no actual GPU await), so by the time a
   * LATER posted message is even looked at, the prior render's submit() has
   * already happened and `this.stepTextures` holds its final content. The
   * debounce living upstream of that (CanvasView's 300ms post-render timer)
   * is what guarantees no NEWER 'render' is queued behind THIS request
   * either — see CanvasView.tsx's doc comment on the thumbnail timer. The
   * bounds check below is defense-in-depth on top of that ordering argument,
   * not a substitute for it: a `nodeSteps` index from a stale/mismatched
   * plan (more steps than the renderer currently holds) is simply skipped
   * rather than reading past the array.
   */
  async thumbnails(
    nodeSteps: Record<string, number>,
    longEdge: number
  ): Promise<Record<string, { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }> | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { width, height } = this;
    const long = Math.max(width, height);
    const scale = longEdge / long;
    const thumbW = Math.max(1, Math.round(width * scale));
    const thumbH = Math.max(1, Math.round(height * scale));

    const encoder = this.device.createCommandEncoder();
    const sourceView = this.effectiveSourceView(encoder);
    const pipeline = this.thumbnailPipeline();
    const uniform = this.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(uniform, 0, new Float32Array([width, height, thumbW, thumbH]));

    const distinctIndices = new Set(Object.values(nodeSteps));
    const targets = new Map<number, GPUTexture>();
    for (const idx of distinctIndices) {
      // Belt-and-braces guard (see this method's doc comment): a step index
      // this map was computed against but which no longer exists here is
      // simply skipped, never read.
      if (idx >= 0 && idx >= this.stepTextures.length) continue;
      const view = idx < 0 ? sourceView : this.stepTextures[idx]!.createView();
      const target = this.createTexture({
        size: [thumbW, thumbH],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      targets.set(idx, target);
      this.addPass(encoder, target.createView(), pipeline, [
        { binding: 0, resource: view },
        { binding: 1, resource: { buffer: uniform } },
      ]);
    }

    const bytesPerRow = Math.ceil((thumbW * 4) / 256) * 256;
    const buffers = new Map<number, GPUBuffer>();
    for (const [idx, target] of targets) {
      const buf = this.createBuffer({ size: bytesPerRow * thumbH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      buffers.set(idx, buf);
      encoder.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow, rowsPerImage: thumbH }, [thumbW, thumbH]);
    }
    this.device.queue.submit([encoder.finish()]);

    const perIndex = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
    try {
      await Promise.all(
        [...buffers].map(async ([idx, buf]) => {
          await buf.mapAsync(GPUMapMode.READ);
          const padded = new Uint8Array(buf.getMappedRange());
          const out = new Uint8ClampedArray(thumbW * thumbH * 4);
          for (let y = 0; y < thumbH; y++) {
            out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + thumbW * 4), y * thumbW * 4);
          }
          buf.unmap();
          perIndex.set(idx, out);
        })
      );
    } finally {
      for (const target of targets.values()) this.destroyTexture(target);
      for (const buf of buffers.values()) this.destroyBuffer(buf);
      this.destroyBuffer(uniform);
    }

    const result: Record<string, { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }> = {};
    for (const [nodeId, idx] of Object.entries(nodeSteps)) {
      const data = perIndex.get(idx);
      if (data) result[nodeId] = { width: thumbW, height: thumbH, data };
    }
    return result;
  }
}

export interface HistogramData {
  bins: number;
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  /** Fraction of pixels with any channel at 0 / 255 in the encoded output. */
  shadowClip: number;
  highlightClip: number;
  pixels: number;
}

/** Strided RGB samples of the encoded output, row-major, for the scope displays. */
export interface ScopeSamples {
  cols: number;
  rows: number;
  /** RGB triplets, row-major; length === cols * rows * 3. */
  data: Uint8Array;
}
