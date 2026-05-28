import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base='./' so the production build loads from file:// inside Electron.
// The dev server runs on 5173 (the origin the backend CORS allow-list expects).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
