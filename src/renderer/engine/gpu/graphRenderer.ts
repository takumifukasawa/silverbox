/**
 * WebGPU graph renderer (milestone 4, DAG execution since milestone 13).
 *
 * The linear RGBA preview uploads once per image as an rgba16float texture.
 * The RenderPlan executes step by step — ops and custom nodes as one-input
 * fullscreen passes compiled from registry/user WGSL, blend as a two-input
 * mix — each writing its own rgba16float texture so outputs can fan out.
 * A final pass applies the exact piecewise sRGB encode — the same curve as
 * engine/color/srgb.ts — into the canvas. readbackMean() executes the whole
 * plan again into an offscreen rgba8unorm target and averages on the CPU,
 * so it never depends on a prior render() call.
 */
import type { PreparedImage } from '../decoder/decodeWorker';
import { orientedDims, type RenderPlan } from '../graph/graphDoc';
import { WGSL_WORK_TO_P3, WGSL_WORK_TO_SRGB, WGSL_WORKING_LUMA, WORKING_LUMA } from '../color/workingSpace';
import { WGSL_SRGB_ENCODE } from '../graph/wgslCommon';
import type { ExportColorSpace } from '../../../../shared/ipc';

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

  // 2. lens distortion (oriented frame)
  let rel = q - orientedCenter;
  let rn = length(rel) / cornerRadius;
  let kd = u.p1.y;
  let qd = orientedCenter + rel * (1.0 + kd * rn * rn);

  // 3. chromatic aberration — per-channel radial scale of the distorted position (oriented frame)
  let relD = qd - orientedCenter;
  let kr = u.p1.z;
  let kb = u.p1.w;
  let qr = orientedCenter + relD * (1.0 + kr);
  let qb = orientedCenter + relD * (1.0 + kb);

  // 3b. map each oriented-frame sample point to the real decoded-texture SOURCE frame
  let sr = orientInverse(qr, srcDims.x, srcDims.y, k, flip);
  let sd = orientInverse(qd, srcDims.x, srcDims.y, k, flip);
  let sb = orientInverse(qb, srcDims.x, srcDims.y, k, flip);
  let r = textureSampleLevel(src, geomSampler, sr / srcDims, 0.0).r;
  let g = textureSampleLevel(src, geomSampler, sd / srcDims, 0.0).g;
  let b = textureSampleLevel(src, geomSampler, sb / srcDims, 0.0).b;

  // 4. vignetting recovery, linear space, rn of the distortion-corrected position
  let rnD = length(relD) / cornerRadius;
  let vig = u.p2.x;
  let gain = 1.0 + vig * (${LENS_VIG_R2} * rnD * rnD + ${LENS_VIG_R4} * rnD * rnD * rnD * rnD);
  return vec4f(r * gain, g * gain, b * gain, 1.0);
}
`;

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
  src: number;
  /** Present only on blend steps (second input). */
  srcB?: number;
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
  /** Resample target for geometry+lens (crop/straighten/distortion/CA/vignette); dims = (width, height) above. */
  private baseTexture: GPUTexture | null = null;
  private resampleUniform: GPUBuffer | null = null;
  private resamplePipelineCache: GPURenderPipeline | null = null;
  private resampleSamplerCache: GPUSampler | null = null;
  /** Export-only encode pipelines, keyed by shader id ('encode/srgb' | 'encode/p3'); the preview's own pipelines are separate fixed fields above. */
  private exportEncodePipelines = new Map<string, GPURenderPipeline>();

  /** Viewer-only display mode; readbacks/export always use the color encode. */
  viewMode: 'color' | 'grayscale' = 'color';

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvasEncodePipeline: GPURenderPipeline,
    private readonly canvasGrayscalePipeline: GPURenderPipeline,
    private readonly readbackEncodePipeline: GPURenderPipeline
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<GraphRenderer> {
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
    this.destroyTexture(this.baseTexture);
    this.baseTexture = null;
    this.destroyBuffer(this.resampleUniform);
    this.resampleUniform = null;
    this.planGeometry = undefined;
    this.planLens = undefined;
    this.srcWidth = width;
    this.srcHeight = height;
    this.width = width;
    this.height = height;
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

  private resolveSteps(plan: RenderPlan): ExecStep[] {
    return plan.steps.map((op): ExecStep => {
      if (op.type === 'passes') {
        const phases = op.passes.map((pass): ExecPhase => {
          let uniformBuffer: GPUBuffer | null = null;
          if (pass.uniforms.byteLength > 0) {
            uniformBuffer = this.createBuffer({
              size: pass.uniforms.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(uniformBuffer, 0, pass.uniforms);
          }
          return { pipeline: this.passPipeline(pass.shaderId, pass.wgsl), uniformBuffer };
        });
        return { phases, src: op.src };
      }
      return {
        phases: [{ pipeline: this.blendPipeline(), uniformBuffer: this.vec4Buffer(op.uniform) }],
        src: op.srcA,
        srcB: op.srcB,
      };
    });
  }

  private destroySteps(steps: ExecStep[]): void {
    for (const step of steps) for (const phase of step.phases) this.destroyBuffer(phase.uniformBuffer);
  }

  private async applyGraph(plan: RenderPlan): Promise<void> {
    const gen = ++this.setGraphGen;
    const steps = this.resolveSteps(plan);
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
    const { width: nextWidth, height: nextHeight } = GraphRenderer.baseDims(plan, this.srcWidth, this.srcHeight);
    const dimsChanged = nextWidth !== this.width || nextHeight !== this.height;

    // The resample pass activates when EITHER geometry or lens is
    // non-identity — both fold into the same pass, so a lens-only edit still
    // needs the base texture even though geometry itself stays absent.
    if (plan.geometry || plan.lens) {
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
    } else {
      this.destroyTexture(this.baseTexture);
      this.baseTexture = null;
      this.destroyBuffer(this.resampleUniform);
      this.resampleUniform = null;
    }
    this.planGeometry = plan.geometry;
    this.planLens = plan.lens;

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
    encoder: GPUCommandEncoder
  ): GPUTextureView {
    const views = stepTextures.map((t) => t.createView());
    const scratchView = scratch?.createView() ?? null;
    const at = (i: number) => (i < 0 ? sourceView : views[i]!);
    steps.forEach((step, i) => {
      if (step.srcB !== undefined) {
        const phase = step.phases[0]!;
        addPass(encoder, views[i]!, phase.pipeline, [
          { binding: 0, resource: at(step.src) },
          { binding: 1, resource: at(step.srcB) },
          { binding: 2, resource: { buffer: phase.uniformBuffer! } },
        ]);
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
    if (!this.planGeometry && !this.planLens) return this.source!.createView();
    const target = this.baseTexture!.createView();
    this.addPass(encoder, target, this.resamplePipeline(), [
      { binding: 0, resource: this.source!.createView() },
      { binding: 1, resource: this.resampleSampler() },
      { binding: 2, resource: { buffer: this.resampleUniform! } },
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
      encoder
    );
  }

  /** Execute the chain and draw to the canvas (canvas must match the image size). */
  render(): void {
    if (!this.source) return;
    const encoder = this.device.createCommandEncoder();
    const linear = this.addChainPasses(encoder);
    const pipeline = this.viewMode === 'grayscale' ? this.canvasGrayscalePipeline : this.canvasEncodePipeline;
    this.addPass(encoder, this.context.getCurrentTexture().createView(), pipeline, [
      { binding: 0, resource: linear },
    ]);
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

    const steps = this.resolveSteps(plan);
    try {
      const encoder = device.createCommandEncoder();
      let baseView = source.createView();
      if (plan.geometry || plan.lens) {
        const base = makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
        const uniform = this.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        tempBuffers.push(uniform);
        device.queue.writeBuffer(uniform, 0, this.resampleUniformData(plan.geometry, plan.lens, srcWidth, srcHeight));
        this.addPass(encoder, base.createView(), this.resamplePipeline(), [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.resampleSampler() },
          { binding: 2, resource: { buffer: uniform } },
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
        encoder
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

  /** Strided RGB samples of the encoded output for the scope displays. */
  scopeSamples(maxCols = 256, maxRows = 144): Promise<ScopeSamples | null> {
    return this.withEncodedPixels((px, bytesPerRow, width, height) => {
      const strideX = Math.max(1, Math.ceil(width / maxCols));
      const strideY = Math.max(1, Math.ceil(height / maxRows));
      const cols = Math.ceil(width / strideX);
      const rows = Math.ceil(height / strideY);
      const data = new Uint8Array(cols * rows * 3);
      let i = 0;
      for (let y = 0; y < height; y += strideY) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x += strideX) {
          const s = row + x * 4;
          data[i++] = px[s]!;
          data[i++] = px[s + 1]!;
          data[i++] = px[s + 2]!;
        }
      }
      return { cols, rows, data };
    });
  }

  /** 256-bin RGB + luma histogram and clipping fractions of the encoded output. */
  stats(): Promise<HistogramData | null> {
    return this.withEncodedPixels((px, bytesPerRow, width, height) => {
      const bins = 256;
      const r = new Uint32Array(bins);
      const g = new Uint32Array(bins);
      const b = new Uint32Array(bins);
      const luma = new Uint32Array(bins);
      let shadow = 0;
      let highlight = 0;
      for (let y = 0; y < height; y++) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x++) {
          const s = row + x * 4;
          const vr = px[s]!;
          const vg = px[s + 1]!;
          const vb = px[s + 2]!;
          r[vr]!++;
          g[vg]!++;
          b[vb]!++;
          luma[Math.min(255, Math.round(WORKING_LUMA[0] * vr + WORKING_LUMA[1] * vg + WORKING_LUMA[2] * vb))]!++;
          if (vr === 0 || vg === 0 || vb === 0) shadow++;
          if (vr === 255 || vg === 255 || vb === 255) highlight++;
        }
      }
      const n = width * height;
      return {
        bins,
        r: Array.from(r),
        g: Array.from(g),
        b: Array.from(b),
        luma: Array.from(luma),
        shadowClip: shadow / n,
        highlightClip: highlight / n,
        pixels: n,
      };
    });
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
