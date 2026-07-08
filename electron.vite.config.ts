import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {},
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
