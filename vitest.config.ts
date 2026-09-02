import { defineConfig } from 'vitest/config';

// Unit tier for PURE functions only (parser, spline eval, correction math) —
// no DOM, no GPU, no electron. Colocated `*.test.ts` under src/, plus
// `shared/` (deltaE.ts and friends live there instead of under
// src/renderer/engine so main can import them too — see shared/color/deltaE.ts's
// doc comment). Fast enough to run inside the parallel verify pool (see
// scripts/run-verify.mjs's `unit` entry) as well as standalone via
// `npm run test:unit`.
//
// `scripts/lib/**/*.test.mjs`: same tier, for pure-Node script helpers that
// aren't part of the app build (e.g. tiffWriter.mjs, the Linear DNG byte
// writer behind scripts/gen-linear-dng.mjs — docs/research/local-adaptive-tone.md
// §5.0). Plain .mjs (no ts-node) since these scripts run directly via `node`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'scripts/lib/**/*.test.mjs'],
    environment: 'node',
  },
});
