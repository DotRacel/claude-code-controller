import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base:'./' → relative asset paths so the SPA works served from the controller server.
// dev proxy forwards the API + web socket to the central server on :8787.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
