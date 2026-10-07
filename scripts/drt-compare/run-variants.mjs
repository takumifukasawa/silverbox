// Research harness (2026-10-07): the base-tone candidates for the
// keep/strength decision. Shipped ids render through the REAL engine stage
// (profile.baseTone); strength variants through a custom-shader node after
// Develop (drts.mjs DRT_VARIANTS — sharpening order differs, negligible).
// Usage: node scripts/drt-compare/run-variants.mjs → test-artifacts/drt-compare/variants/
import { join } from 'node:path';
import { sidecar, render, root } from './lib.mjs';
import { DRT_VARIANTS } from './drts.mjs';
const SCENES = ['DSC03298', 'DSC04260', 'DSC06787', 'DSC07349', 'DSC09305'];
const engine = (baseTone) => sidecar({ profile: { amount: 0, source: 'builtin', dcpPath: '', baseTone } });
const jobs = [
  ...['none', 'reinhard', 'sigmoid', 'agx', 'aces'].map((id) => [id, engine(id)]),
  ...Object.entries(DRT_VARIANTS).map(([n, src]) => [n, sidecar({ shader: src })]),
];
render(SCENES.flatMap((s) => jobs.map(([n, sc]) => [s, n, sc])), join(root, 'test-artifacts/drt-compare/variants'), { maxDim: 1600, quality: 88 });
