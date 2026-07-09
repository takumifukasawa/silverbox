/**
 * Runtime WGSL validation on a DEDICATED GPUDevice — separate from the
 * renderer's device so validation garbage never touches the live pipeline.
 * Module compilation (getCompilationInfo) and pipeline creation (entry
 * points / bindings / IO) both run inside a validation error scope; only
 * sources that pass are ever handed to the renderer (customShaderNode's
 * artifact cache).
 */

let devicePromise: Promise<GPUDevice> | null = null;

function getValidationDevice(): Promise<GPUDevice> {
  if (!devicePromise) {
    devicePromise = (async () => {
      if (!navigator.gpu) throw new Error('WebGPU is not available');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU: no adapter available');
      const device = await adapter.requestDevice();
      void device.lost.then(() => {
        devicePromise = null;
      });
      return device;
    })();
    devicePromise.catch(() => {
      devicePromise = null;
    });
  }
  return devicePromise;
}

/**
 * Validate a wrapped node-pass shader. Resolves null when it compiles
 * cleanly, otherwise a human-readable error whose line numbers are shifted
 * by `userLineOffset` to match the editor.
 */
export async function validateWgsl(wgsl: string, userLineOffset: number): Promise<string | null> {
  const device = await getValidationDevice();

  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length === 0) {
    device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });
  }
  const scopeError = await device.popErrorScope();

  if (errors.length > 0) {
    return errors
      .map((m) => {
        const line = m.lineNum > userLineOffset ? `line ${m.lineNum - userLineOffset}` : `wrapper line ${m.lineNum}`;
        return `${line}: ${m.message}`;
      })
      .join('\n');
  }
  if (scopeError) return scopeError.message;
  return null;
}
