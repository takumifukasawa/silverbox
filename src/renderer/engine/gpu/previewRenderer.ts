/**
 * WebGPU preview renderer (milestone 3).
 *
 * The linear RGBA float preview is uploaded once per image as an rgba16float
 * texture. Drawing runs a fullscreen triangle whose fragment shader applies
 * the exact piecewise sRGB encode — the same curve as engine/color/srgb.ts,
 * which stays the single CPU reference the verify harness compares against.
 * readbackMean() renders the same shader into an offscreen rgba8unorm target
 * and averages on the CPU.
 */
import type { PreparedImage } from '../decoder/decodeWorker';

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn srgbEncode(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Canvas and readback targets match the image size, so pos.xy maps 1:1.
  let t = textureLoad(src, vec2i(pos.xy), 0);
  return vec4f(srgbEncode(t.r), srgbEncode(t.g), srgbEncode(t.b), 1.0);
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

export class PreviewRenderer {
  private texture: GPUTexture | null = null;
  private canvasBindGroup: GPUBindGroup | null = null;
  private readbackBindGroup: GPUBindGroup | null = null;
  private width = 0;
  private height = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvasPipeline: GPURenderPipeline,
    private readonly readbackPipeline: GPURenderPipeline
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<PreviewRenderer> {
    const device = await getGpuDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('webgpu canvas context unavailable');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: SHADER });
    const makePipeline = (format: GPUTextureFormat) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
    return new PreviewRenderer(device, context, makePipeline(canvasFormat), makePipeline('rgba8unorm'));
  }

  get hasImage(): boolean {
    return this.texture !== null;
  }

  /** Upload the linear preview as rgba16float (values are in [0,1] after decode). */
  setImage(image: PreparedImage): void {
    const { data, width, height } = image;
    this.texture?.destroy();
    this.texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const half = new Float16Array(data.length);
    half.set(data);
    this.device.queue.writeTexture(
      { texture: this.texture },
      half,
      { bytesPerRow: width * 8, rowsPerImage: height },
      [width, height]
    );
    this.width = width;
    this.height = height;
    const view = this.texture.createView();
    this.canvasBindGroup = this.device.createBindGroup({
      layout: this.canvasPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }],
    });
    this.readbackBindGroup = this.device.createBindGroup({
      layout: this.readbackPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }],
    });
  }

  private encodePass(target: GPUTextureView, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup): GPUCommandEncoder {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    return encoder;
  }

  /** Draw the current image to the canvas (canvas must already match the image size). */
  render(): void {
    if (!this.canvasBindGroup) return;
    const encoder = this.encodePass(
      this.context.getCurrentTexture().createView(),
      this.canvasPipeline,
      this.canvasBindGroup
    );
    this.device.queue.submit([encoder.finish()]);
  }

  /** Render offscreen and average the encoded output on the CPU. */
  async readbackMean(): Promise<{ r: number; g: number; b: number } | null> {
    if (!this.readbackBindGroup) return null;
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
    const encoder = this.encodePass(target.createView(), this.readbackPipeline, this.readbackBindGroup);
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange());
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
    buffer.unmap();
    buffer.destroy();
    target.destroy();
    const n = width * height;
    return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
  }
}
