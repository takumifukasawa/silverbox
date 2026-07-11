import { defineConfig } from 'vitest/config';

// Unit tier for PURE functions only (parser, spline eval, correction math) —
// no DOM, no GPU, no electron. Colocated `*.test.ts` under src/. Fast enough
// to run inside the parallel verify pool (see scripts/run-verify.mjs's `unit`
// entry) as well as standalone via `npm run test:unit`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
