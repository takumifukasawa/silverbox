/**
 * Round-4 tone-experiment images — DR-spread amplitude-law probe.
 *
 * Motivation (stage-1e diagnosis, 2026-09-03): LR's real-photo Shadows
 * response is keyed to per-band percentile anchors (sh ~p75, hi p25 of
 * frame log2-luma) and its Shadows AMPLITUDE grows with the frame's DR
 * spread (p90-p10) — ~0.35 stop/stop over the 4 measurable Italy scenes,
 * which is ~150x the synthetic corner-patch E6 slope. That law is the one
 * unmeasured piece of the stage-1e model (ceiling_sh(DRspread); and
 * whether Highlights truly has none). These images measure it directly:
 * frame-filling two-region scenes sweep the spread while probe patches sit
 * at FIXED offsets from the scene's own p75/p25, so the per-offset deltas
 * vs spread ARE the law. The spread=0 file degenerates to round-3's
 * geometry (continuity check: must reproduce the r3 curve / low-DR limit).
 *
 * Design: 1024^2 canvas. Left half = A (dark region), right half = B
 * (bright region), so p25=A, p75=B exactly and p90-p10 = log2(B/A) = S.
 *  - main set: B=0.5, S in {0,2,4,6,8,10} (A = 0.5*2^-S).
 *  - absolute-anchor variant: B=0.125, S in {0,4,8} — if LR's response is
 *    percentile-relative these match the main set; if absolute they don't.
 * Probes (64px squares, ~0.4% of frame each — percentiles unaffected):
 *  - shadow probes in the BRIGHT half at offsets {1,2,3,4} stops below B.
 *  - highlight probes in the DARK half at offsets {1,2,3,4} stops above A,
 *    skipped when the value would exceed 0.9 (clip safety, r3 convention).
 * Harvested through the EXISTING plugin configs (base/sh_p100/hi_m100 are
 * already in AutoProbe v2.0 — no plugin change, no cp needed): add these
 * files to the src dir, delete DONE, restart LR, one Plug-in Extras click.
 *
 * ADDITIVE ONLY: r4_ filenames, refuses overwrite (writeLinearDngOnce),
 * writes manifest-r4.json, never touches earlier manifests/files.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLinearDngOnce } from './lib/toneExperimentsR2.mjs';

const outDir = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'tone-experiments-out');
mkdirSync(join(outDir, 'r4'), { recursive: true });

const SIZE = 1024;
const PATCH = 64;
const PROBE_OFFSETS = [1, 2, 3, 4];
const HI_CLIP_MAX = 0.9;
const SETS = [
  { tag: 'b050', bright: 0.5, spreads: [0, 2, 4, 6, 8, 10] },
  { tag: 'b0125', bright: 0.125, spreads: [0, 4, 8] }, // absolute-vs-relative anchor disambiguator
];

// probe layout: 4 vertical slots per half, centered horizontally in the half
const slotYs = [0.2, 0.4, 0.6, 0.8].map((f) => Math.round(SIZE * f));
const brightX = Math.round(SIZE * 0.75);
const darkX = Math.round(SIZE * 0.25);
const half = PATCH / 2;

const manifest = [];
for (const { tag, bright, spreads } of SETS) {
  for (const S of spreads) {
    const dark = bright * Math.pow(2, -S);
    const probes = [];
    PROBE_OFFSETS.forEach((o, i) => {
      // shadow probe: o stops below the bright region (p75), placed in the bright half
      probes.push({ band: 'sh', offset: o, value: bright * Math.pow(2, -o), cx: brightX, cy: slotYs[i] });
      // highlight probe: o stops above the dark region (p25), placed in the dark half
      const hv = dark * Math.pow(2, o);
      if (hv <= HI_CLIP_MAX) probes.push({ band: 'hi', offset: o, value: hv, cx: darkX, cy: slotYs[i] });
    });

    const id = `r4_${tag}_s${S}`;
    const rel = join('r4', `${id}.dng`);
    writeLinearDngOnce(join(outDir, rel), {
      width: SIZE,
      height: SIZE,
      generator: (x, y) => {
        for (const p of probes) {
          if (Math.abs(x - p.cx) < half && Math.abs(y - p.cy) < half) return [p.value, p.value, p.value];
        }
        const v = x < SIZE / 2 ? dark : bright;
        return [v, v, v];
      },
    });
    manifest.push({
      experiment: 'r4',
      id,
      file: rel,
      width: SIZE,
      height: SIZE,
      params: { bright, dark, spreadStops: S, p25Expected: dark, p75Expected: bright, patchPx: PATCH, probes },
    });
  }
}

writeFileSync(join(outDir, 'manifest-r4.json'), JSON.stringify(manifest, null, 2));
console.log(`r4: ${manifest.length} files`);
console.log(`manifest: ${join(outDir, 'manifest-r4.json')}`);
