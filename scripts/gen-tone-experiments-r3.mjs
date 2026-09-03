/**
 * Round-3 tone-experiment images — sub-σr response-curve probe.
 *
 * Motivation (wip/localtone-stage1 findings + docs/research/
 * lr-tone-measurements*.md): LR's Highlights/Shadows respond at patch↔
 * surround offsets well INSIDE the measured σr ≈ 4 stops (E1's bg=50/90%
 * cases sit at 1.47/2.32 stops and move up to +0.50 stops), while our
 * fe-tail-only remap has a dead zone below σr. These images map LR's
 * response as a DIRECT function of offset, at fixed surround, so the remap
 * onset shape can be fit instead of guessed.
 *
 * Design (E1-comparable geometry: 1024² canvas, 64px centered patch):
 *  - shadows probe: surround 50% linear; patch at surround × 2^-o for
 *    o ∈ {0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5} stops.
 *  - highlights probe: surround 2% linear; patch at surround × 2^+o,
 *    same offsets (max value 0.64 — no clip handling needed).
 * Harvested through the EXISTING plugin configs (sh_p100/sh_p50/hi_m100);
 * patch-center delta-over-base vs offset is the deliverable curve.
 *
 * ADDITIVE ONLY: r3_ filenames, refuses overwrite (writeLinearDngOnce),
 * writes manifest-r3.json, never touches earlier manifests/files.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLinearDngOnce } from './lib/toneExperimentsR2.mjs';

const outDir = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'tone-experiments-out');
mkdirSync(join(outDir, 'r3'), { recursive: true });

const SIZE = 1024;
const PATCH = 64;
const OFFSETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5];
const PROBES = [
  { tag: 'shprobe', surround: 0.5, dir: -1 }, // patch darker than surround
  { tag: 'hiprobe', surround: 0.02, dir: +1 }, // patch brighter than surround
];

const manifest = [];
const half = PATCH / 2;
const c = SIZE / 2;

for (const { tag, surround, dir } of PROBES) {
  for (const o of OFFSETS) {
    const patch = surround * Math.pow(2, dir * o);
    const id = `r3_${tag}_o${o}`;
    const rel = join('r3', `${id}.dng`);
    writeLinearDngOnce(join(outDir, rel), {
      width: SIZE,
      height: SIZE,
      generator: (x, y) => {
        const v = Math.abs(x - c) < half && Math.abs(y - c) < half ? patch : surround;
        return [v, v, v];
      },
    });
    manifest.push({ experiment: 'r3', id, file: rel, width: SIZE, height: SIZE, params: { surround, patch, offsetStops: dir * o } });
  }
}

writeFileSync(join(outDir, 'manifest-r3.json'), JSON.stringify(manifest, null, 2));
console.log(`r3: ${manifest.length} files`);
console.log(`manifest: ${join(outDir, 'manifest-r3.json')}`);
