import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base='./' so the production build loads from file:// inside Electron.
// The dev server runs on 5173 (the origin the backend CORS allow-list expects)
// and proxies /api/* to the embedded backend on 127.0.0.1:3847 so the frontend
// can use same-origin fetches in both dev and prod without conditional URLs.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
