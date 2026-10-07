// Research harness (2026-10-07): the base-tone candidates for the
// keep/strength decision. Every candidate is now a shipped id and renders
// through the REAL engine stage (profile.baseTone). AgX Punchy moved from a
// custom-shader variant into the engine; DRT_VARIANTS stays only as the
// record of what the first comparison used.
// Optional: pass ids to render only those (e.g. `sigmoid agx_punchy`).
// Usage: node scripts/drt-compare/run-variants.mjs → test-artifacts/drt-compare/variants/
import { join } from 'node:path';
import { sidecar, render, root } from './lib.mjs';
const SCENES = ['DSC03298', 'DSC04260', 'DSC06787', 'DSC07349', 'DSC09305'];
const engine = (baseTone) => sidecar({ profile: { amount: 0, source: 'builtin', dcpPath: '', baseTone } });
const ALL = ['none', 'reinhard', 'sigmoid', 'agx', 'agx_punchy', 'aces'];
const ids = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const jobs = ids.map((id) => [id, engine(id)]);
render(SCENES.flatMap((s) => jobs.map(([n, sc]) => [s, n, sc])), join(root, 'test-artifacts/drt-compare/variants'), { maxDim: 1600, quality: 88 });
