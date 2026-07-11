/**
 * LUT export encoder (task #33) — main-process side.
 *
 * The renderer computes every deliverable's bytes purely from the graph doc
 * (engine/color/lutExport.ts — no decoded image involved at all); this
 * module only writes them to disk: the .cube and the WebGL snippet are plain
 * UTF-8 text (node:fs), the Unity/UE strips are raw RGBA8 encoded through
 * sharp — a native addon, hence main-process only, same reason
 * imageExport.ts lives here. Deliberately WITHOUT `withIccProfile`: the brief
 * requires the strip PNGs untagged (no ICC), raw 8-bit sRGB values, so a game
 * engine's own import pipeline decides how to interpret them.
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import type { ExportLutRequest, ExportLutResult } from '../../shared/ipc';

// Must match engine/color/lutExport.ts's UNITY_LUT_SIZE/UE_LUT_SIZE — hardcoded
// rather than imported because src/main is a separate bundle from
// src/renderer (see electron.vite.config.ts / tsconfig.node.json's `include`,
// which deliberately excludes src/renderer).
const UNITY_LUT_SIZE = 32;
const UE_LUT_SIZE = 16;

function checkStripBytes(buf: Buffer, size: number, label: string): void {
  const expected = size * size * size * 4;
  if (buf.byteLength !== expected) {
    throw new Error(`exportLut: ${label} strip is ${buf.byteLength} bytes, expected ${expected}`);
  }
}

export async function encodeLutExport(req: ExportLutRequest): Promise<ExportLutResult> {
  const cubePath = `${req.basePath}.cube`;
  const unityPath = `${req.basePath}-unity.png`;
  const uePath = `${req.basePath}-ue.png`;
  const webglPath = `${req.basePath}-webgl.txt`;

  const unityBuf = Buffer.from(req.unityRgba);
  const ueBuf = Buffer.from(req.ueRgba);
  checkStripBytes(unityBuf, UNITY_LUT_SIZE, 'unity');
  checkStripBytes(ueBuf, UE_LUT_SIZE, 'ue');

  await writeFile(cubePath, req.cubeText, 'utf8');
  await sharp(unityBuf, { raw: { width: UNITY_LUT_SIZE * UNITY_LUT_SIZE, height: UNITY_LUT_SIZE, channels: 4 } })
    .png()
    .toFile(unityPath);
  await sharp(ueBuf, { raw: { width: UE_LUT_SIZE * UE_LUT_SIZE, height: UE_LUT_SIZE, channels: 4 } })
    .png()
    .toFile(uePath);
  await writeFile(webglPath, req.webglText, 'utf8');

  return { paths: [cubePath, unityPath, uePath, webglPath] };
}
