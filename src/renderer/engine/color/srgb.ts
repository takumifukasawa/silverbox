/**
 * Exact sRGB piecewise transfer functions and lookup tables.
 *
 * Everything internal to the engine is linear; decoders convert incoming
 * gamma-encoded samples to linear with these, and the output stage encodes
 * back. Keeping one implementation here is what makes "identity = bit exact"
 * checkable: decode and encode must be true inverses up to quantization.
 */

/** sRGB electro-optical transfer (encoded [0,1] → linear [0,1]). */
export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB opto-electronic transfer (linear [0,1] → encoded [0,1]). */
export function srgbEncode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** LUT: 16-bit encoded sample → linear float. */
export function buildDecodeLut16(): Float32Array {
  const lut = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = srgbDecode(i / 65535);
  return lut;
}

/** LUT: 8-bit encoded sample → linear float. */
export function buildDecodeLut8(): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbDecode(i / 255);
  return lut;
}
