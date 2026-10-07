// Research harness (2026-10-07): render the 5 Italy reference scenes through
// each candidate output DRT (drts.mjs) via a custom-shader node after a neutral
// Develop node, using the headless CLI. Needs test-assets/italy/ symlinks.
// Usage: node scripts/drt-compare/run.mjs  → test-artifacts/drt-compare/out/
import { join } from 'node:path';
import { sidecar, render, root } from './lib.mjs';
import { DRTS } from './drts.mjs';
const SCENES = ['DSC03298', 'DSC04260', 'DSC06787', 'DSC07349', 'DSC09305'];
const jobs = [['linear', sidecar({})], ...Object.entries(DRTS).map(([n, src]) => [n, sidecar({ shader: src })])];
render(SCENES.flatMap((s) => jobs.map(([n, sc]) => [s, n, sc])), join(root, 'test-artifacts/drt-compare/out'));
