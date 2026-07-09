import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // sharp is a native addon — it must stay a require()d dependency, not a
  // bundled chunk (same for anything else in "dependencies").
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    server: {
      port: 5172,
      strictPort: true,
    },
    plugins: [react()],
    // libraw-wasm ships a prebuilt worker + wasm; Vite's dep optimizer breaks
    // its relative worker URL, so keep it out of optimizeDeps and emit ES workers.
    optimizeDeps: {
      exclude: ['libraw-wasm'],
    },
    worker: {
      format: 'es',
    },
  },
});
