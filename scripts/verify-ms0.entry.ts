/**
 * Browser entry for verify-ms0-decode.mjs: decode the test ARW through
 * LibrawDecoder and expose the result for Playwright assertions.
 */
import { LibrawDecoder } from '../src/renderer/engine/decoder/librawDecoder';

declare global {
  interface Window {
    __result?: unknown;
    __error?: { message: string; stack?: string };
  }
}

async function main() {
  const res = await fetch('/raw.arw');
  if (!res.ok) throw new Error(`fetch raw.arw: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const t0 = performance.now();
  const decoded = await new LibrawDecoder().decode(bytes);
  const decodeMs = Math.round(performance.now() - t0);

  // Serialize everything except the pixel buffer; summarize that instead.
  const { data, ...rest } = decoded;
  let min = 65535;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 997) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const sampleCount = Math.ceil(data.length / 997);

  window.__result = {
    ...rest,
    dataLength: data.length,
    dataCtor: data.constructor.name,
    sample: { min, max, mean: sum / sampleCount },
    decodeMs,
  };
  document.title = 'DONE';
}

main().catch((err: Error) => {
  window.__error = { message: err.message, stack: err.stack };
  document.title = 'ERROR';
});
