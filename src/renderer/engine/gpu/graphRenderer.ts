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


export class GraphRenderer {
  private source: GPUTexture | null = null;
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
    this.scratchTexture?.destroy();
    this.scratchTexture = null;
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

  private makeStepTexture(): GPUTexture {
    return this.device.createTexture({
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
    const buffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, new Float32Array(v));
    return buffer;
  }

  private resolveSteps(plan: RenderPlan): ExecStep[] {
    return plan.steps.map((op): ExecStep => {
      if (op.type === 'passes') {
        const phases = op.passes.map((pass): ExecPhase => {
          let uniformBuffer: GPUBuffer | null = null;
          if (pass.uniforms.byteLength > 0) {
            uniformBuffer = this.device.createBuffer({
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

  private static destroySteps(steps: ExecStep[]): void {
    for (const step of steps) for (const phase of step.phases) phase.uniformBuffer?.destroy();
  }

  private async applyGraph(plan: RenderPlan): Promise<void> {
    const gen = ++this.setGraphGen;
    const steps = this.resolveSteps(plan);
    if (gen !== this.setGraphGen) {
      GraphRenderer.destroySteps(steps);
      return;
    }
    GraphRenderer.destroySteps(this.steps);
    this.steps = steps;
    this.outputIndex = plan.output;
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

  /** Record the plan; returns the view holding the final linear result. */
  private addChainPasses(encoder: GPUCommandEncoder): GPUTextureView {
    this.ensureStepTextures(
      this.steps.length,
      this.steps.some((s) => s.phases.length > 1)
    );
    return GraphRenderer.recordSteps(
      this.addPass.bind(this),
      this.steps,
      this.outputIndex,
      this.source!.createView(),
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

    const steps = this.resolveSteps(plan);
    try {
      const encoder = device.createCommandEncoder();
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
        source.createView(),
        stepTextures,
        scratch,
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
      GraphRenderer.destroySteps(steps);
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
          const l0 = 0.2126 * px[s]! + 0.7152 * px[s + 1]! + 0.0722 * px[s + 2]!;
          const l1 = 0.2126 * px[s + 4]! + 0.7152 * px[s + 5]! + 0.0722 * px[s + 6]!;
          sumL += Math.abs(l1 - l0);
          sumC += Math.abs(px[s + 4]! - px[s + 6]! - (px[s]! - px[s + 2]!));
        }
      }
      const n = (width - 1) * height;
      return { luma: sumL / n / 255, chroma: sumC / n / 255 };
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
          luma[Math.min(255, Math.round(0.2126 * vr + 0.7152 * vg + 0.0722 * vb))]!++;
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
