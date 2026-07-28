/**
 * Unit tier (vitest) for assertShaderCompiles (docs/brief-bank/wgsl-compile-
 * diagnostics.md): the dev/test-only built-in-shader compile check. Exercises
 * the helper directly against a FAKE GPUShaderModule (just an object with a
 * `getCompilationInfo` method) — no real WebGPU device, no real renderer, no
 * real broken WGSL source needed. That's deliberate: the point of this test
 * is "does the helper itself report/throw with the shaderId + line number",
 * not "does Dawn reject this particular shader" — the EXISTING built-in
 * shaders compiling clean is instead proven by a green `npm run verify`
 * (every built-in pipeline gets created, hence checked, during the suite).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertShaderCompiles, setShaderDiagnosticsEnabled } from './graphRenderer';

/** Minimal fake satisfying the one method assertShaderCompiles actually calls. */
function fakeModule(messages: GPUCompilationMessage[]): GPUShaderModule {
  return {
    getCompilationInfo: () => Promise.resolve({ messages } as unknown as GPUCompilationInfo),
  } as unknown as GPUShaderModule;
}

function errorMessage(lineNum: number, message: string): GPUCompilationMessage {
  return { type: 'error', lineNum, linePos: 1, offset: 0, length: 0, message } as GPUCompilationMessage;
}

describe('assertShaderCompiles', () => {
  afterEach(() => {
    // Never leak the enabled flag across tests/files — mirrors the module's
    // own "disabled by default" prod state.
    setShaderDiagnosticsEnabled(false);
    vi.restoreAllMocks();
  });

  it('is a no-op when diagnostics are disabled (the prod path)', async () => {
    setShaderDiagnosticsEnabled(false);
    const module = fakeModule([errorMessage(7, "use of reserved keyword 'meta'")]);
    const spy = vi.spyOn(module, 'getCompilationInfo');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(assertShaderCompiles(module, 'lut3d')).resolves.toBeUndefined();

    // The whole point of the prod no-op: the compile check never even runs.
    expect(spy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reports and throws with the shaderId + line number on a broken shader (test mode)', async () => {
    setShaderDiagnosticsEnabled(true);
    const module = fakeModule([errorMessage(7, "use of reserved keyword 'meta'")]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(assertShaderCompiles(module, 'lut3d')).rejects.toThrow(/lut3d/);
    await expect(assertShaderCompiles(module, 'lut3d')).rejects.toThrow(/L7/);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const logged = errorSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain('lut3d');
    expect(logged).toContain('L7');
    expect(logged).toContain("reserved keyword 'meta'");
  });

  it('resolves cleanly for a shader with no compile errors, even in test mode', async () => {
    setShaderDiagnosticsEnabled(true);
    const module = fakeModule([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(assertShaderCompiles(module, 'blend')).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ignores non-error compilation messages (warning/info)', async () => {
    setShaderDiagnosticsEnabled(true);
    const module = fakeModule([{ type: 'warning', lineNum: 3, linePos: 1, offset: 0, length: 0, message: 'unused variable' } as GPUCompilationMessage]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(assertShaderCompiles(module, 'thumbnail')).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
