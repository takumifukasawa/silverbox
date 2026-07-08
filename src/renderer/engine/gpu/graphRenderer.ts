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
import type { RenderPlan } from '../graph/graphDoc';
import { DEFAULT_CUSTOM_CODE, OPS, type OpKind } from '../graph/ops';

const FULLSCREEN_VS = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
`;

// All targets match the image size, so pos.xy maps 1:1 in every pass.
const ENCODE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
fn srgbEncode(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = textureLoad(src, vec2i(pos.xy), 0);
  return vec4f(srgbEncode(t.r), srgbEncode(t.g), srgbEncode(t.b), 1.0);
}
`;

const opShader = (applyOp: string) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: vec4f;
${FULLSCREEN_VS}
${applyOp}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return applyOp(textureLoad(src, vec2i(pos.xy), 0), params);
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

interface ExecStep {
  pipeline: GPURenderPipeline;
  uniformBuffer: GPUBuffer;
  src: number;
  /** Present only on blend steps (second input). */
  srcB?: number;
}

export interface ShaderError {
  nodeId: string;
  message: string;
}

export class GraphRenderer {
  private source: GPUTexture | null = null;
  private stepTextures: GPUTexture[] = [];
  private steps: ExecStep[] = [];
  private outputIndex = -1;
  private blendPipelineCache: GPURenderPipeline | null = null;
  private opPipelines = new Map<OpKind, GPURenderPipeline>();
  /** Custom-code pipelines keyed by source; null = failed to compile. */
  private customPipelines = new Map<string, Promise<GPURenderPipeline>>();
  private setGraphGen = 0;
  /** Resolves when the most recent setGraph() has landed (readback waits on it). */
  private graphReady: Promise<unknown> = Promise.resolve();
  private width = 0;
  private height = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvasEncodePipeline: GPURenderPipeline,
    private readonly readbackEncodePipeline: GPURenderPipeline
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<GraphRenderer> {
    const device = await getGpuDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('webgpu canvas context unavailable');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: ENCODE_SHADER });
    const makeEncodePipeline = (format: GPUTextureFormat) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
    return new GraphRenderer(device, context, makeEncodePipeline(canvasFormat), makeEncodePipeline('rgba8unorm'));
  }

  get hasImage(): boolean {
    return this.source !== null;
  }

  private opPipeline(kind: OpKind): GPURenderPipeline {
    let pipeline = this.opPipelines.get(kind);
    if (!pipeline) {
      const module = this.device.createShaderModule({ code: opShader(OPS[kind].wgsl) });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      });
      this.opPipelines.set(kind, pipeline);
    }
    return pipeline;
  }

  /** Compile user WGSL; rejects with the compiler messages on bad code. */
  private customPipeline(code: string): Promise<GPURenderPipeline> {
    let pipeline = this.customPipelines.get(code);
    if (!pipeline) {
      pipeline = (async () => {
        this.device.pushErrorScope('validation');
        const module = this.device.createShaderModule({ code: opShader(code) });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        try {
          if (errors.length > 0) {
            throw new Error(errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
          }
          return await this.device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
          });
        } finally {
          void this.device.popErrorScope();
        }
      })();
      this.customPipelines.set(code, pipeline);
    }
    return pipeline;
  }

  /** Upload the linear preview as rgba16float (values are in [0,1] after decode). */
  setImage(image: PreparedImage): void {
    const { data, width, height } = image;
    this.source?.destroy();
    this.source = this.device.createTexture({
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
    for (const t of this.stepTextures) t.destroy();
    this.stepTextures = [];
    this.width = width;
    this.height = height;
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

  /** One rgba16float target per plan step so outputs can fan out. */
  private ensureStepTextures(count: number): void {
    while (this.stepTextures.length < count) {
      this.stepTextures.push(
        this.device.createTexture({
          size: [this.width, this.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        })
      );
    }
  }

  /**
   * Set the render plan to execute. Custom code compiles asynchronously; a
   * node whose code fails to compile falls back to the identity pass and is
   * reported in the returned list. Only the newest call wins if several
   * overlap.
   */
  setGraph(plan: RenderPlan): Promise<ShaderError[]> {
    const promise = this.applyGraph(plan);
    this.graphReady = promise.catch(() => {});
    return promise;
  }

  private async resolveSteps(plan: RenderPlan, errors: ShaderError[]): Promise<ExecStep[]> {
    return Promise.all(
      plan.steps.map(async (op): Promise<ExecStep> => {
        let pipeline: GPURenderPipeline;
        if (op.type === 'builtin') {
          pipeline = this.opPipeline(op.kind);
        } else if (op.type === 'blend') {
          pipeline = this.blendPipeline();
        } else {
          try {
            pipeline = await this.customPipeline(op.code);
          } catch (err) {
            errors.push({ nodeId: op.nodeId, message: err instanceof Error ? err.message : String(err) });
            pipeline = await this.customPipeline(DEFAULT_CUSTOM_CODE);
          }
        }
        const uniformBuffer = this.device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(uniformBuffer, 0, new Float32Array(op.uniform));
        return {
          pipeline,
          uniformBuffer,
          src: op.type === 'blend' ? op.srcA : op.src,
          ...(op.type === 'blend' ? { srcB: op.srcB } : {}),
        };
      })
    );
  }

  private async applyGraph(plan: RenderPlan): Promise<ShaderError[]> {
    const gen = ++this.setGraphGen;
    const errors: ShaderError[] = [];
    const steps = await this.resolveSteps(plan, errors);
    if (gen !== this.setGraphGen) {
      for (const step of steps) step.uniformBuffer.destroy();
      return errors;
    }
    for (const step of this.steps) step.uniformBuffer.destroy();
    this.steps = steps;
    this.outputIndex = plan.output;
    return errors;
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

  /** Record a step's passes into per-step textures; shared by all consumers. */
  private static recordSteps(
    addPass: GraphRenderer['addPass'],
    steps: ExecStep[],
    outputIndex: number,
    sourceView: GPUTextureView,
    stepTextures: GPUTexture[],
    encoder: GPUCommandEncoder
  ): GPUTextureView {
    const views = stepTextures.map((t) => t.createView());
    const at = (i: number) => (i < 0 ? sourceView : views[i]!);
    steps.forEach((step, i) => {
      const entries: GPUBindGroupEntry[] =
        step.srcB !== undefined
          ? [
              { binding: 0, resource: at(step.src) },
              { binding: 1, resource: at(step.srcB) },
              { binding: 2, resource: { buffer: step.uniformBuffer } },
            ]
          : [
              { binding: 0, resource: at(step.src) },
              { binding: 1, resource: { buffer: step.uniformBuffer } },
            ];
      addPass(encoder, views[i]!, step.pipeline, entries);
    });
    return at(outputIndex);
  }

  /** Record the plan; returns the view holding the final linear result. */
  private addChainPasses(encoder: GPUCommandEncoder): GPUTextureView {
    this.ensureStepTextures(this.steps.length);
    return GraphRenderer.recordSteps(
      this.addPass.bind(this),
      this.steps,
      this.outputIndex,
      this.source!.createView(),
      this.stepTextures,
      encoder
    );
  }

  /** Execute the chain and draw to the canvas (canvas must match the image size). */
  render(): void {
    if (!this.source) return;
    const encoder = this.device.createCommandEncoder();
    const linear = this.addChainPasses(encoder);
    this.addPass(encoder, this.context.getCurrentTexture().createView(), this.canvasEncodePipeline, [
      { binding: 0, resource: linear },
    ]);
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Run the chain over an arbitrary image (e.g. the full-resolution decode
   * for export) and return tightly-packed sRGB RGBA8 pixels. Independent of
   * the preview state; all GPU resources are transient.
   */
  async renderToPixels(
    image: PreparedImage,
    plan: RenderPlan
  ): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
    const { device } = this;
    const { data, width, height } = image;
    const source = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    device.queue.writeTexture({ texture: source }, half, { bytesPerRow: width * 8, rowsPerImage: height }, [
      width,
      height,
    ]);
    const temps: GPUTexture[] = [source];
    const makeTarget = (format: GPUTextureFormat, usage: number) => {
      const t = device.createTexture({ size: [width, height], format, usage });
      temps.push(t);
      return t;
    };

    const steps = await this.resolveSteps(plan, []);
    try {
      const encoder = device.createCommandEncoder();
      const stepTextures = plan.steps.map(() =>
        makeTarget('rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT)
      );
      const linear = GraphRenderer.recordSteps(
        this.addPass.bind(this),
        steps,
        plan.output,
        source.createView(),
        stepTextures,
        encoder
      );
      const target = makeTarget('rgba8unorm', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.addPass(encoder, target.createView(), this.readbackEncodePipeline, [{ binding: 0, resource: linear }]);
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange());
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      }
      buffer.unmap();
      buffer.destroy();
      return { data: out, width, height };
    } finally {
      for (const t of temps) t.destroy();
      for (const step of steps) step.uniformBuffer.destroy();
    }
  }

  /** Run the chain + encode offscreen and hand the mapped RGBA8 rows to `use`. */
  private async withEncodedPixels<T>(
    use: (px: Uint8Array, bytesPerRow: number, width: number, height: number) => T
  ): Promise<T | null> {
    await this.graphReady;
    if (!this.source) return null;
    const { device, width, height } = this;
    const target = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    const linear = this.addChainPasses(encoder);
    this.addPass(encoder, target.createView(), this.readbackEncodePipeline, [{ binding: 0, resource: linear }]);
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    try {
      return use(new Uint8Array(buffer.getMappedRange()), bytesPerRow, width, height);
    } finally {
      buffer.unmap();
      buffer.destroy();
      target.destroy();
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

  /** Histogram + clipping fractions of the encoded output (for the UI panel). */
  stats(bins = 64): Promise<HistogramData | null> {
    return this.withEncodedPixels((px, bytesPerRow, width, height) => {
      const r = new Uint32Array(bins);
      const g = new Uint32Array(bins);
      const b = new Uint32Array(bins);
      const shift = Math.log2(256 / bins);
      let shadow = 0;
      let highlight = 0;
      for (let y = 0; y < height; y++) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x++) {
          const s = row + x * 4;
          const vr = px[s]!;
          const vg = px[s + 1]!;
          const vb = px[s + 2]!;
          r[vr >> shift]!++;
          g[vg >> shift]!++;
          b[vb >> shift]!++;
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
  /** Fraction of pixels with any channel at 0 / 255 in the encoded output. */
  shadowClip: number;
  highlightClip: number;
  pixels: number;
}
