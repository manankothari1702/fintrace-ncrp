import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base='./' so the production build loads from file:// inside Electron.
// The dev server runs on 5173 (the origin the backend CORS allow-list expects)
// and proxies /api/* to the embedded backend on 127.0.0.1:3847 so the frontend
// can use same-origin fetches in both dev and prod without conditional URLs.
export default defineConfig({
  plugins: [react()],
  base: './',
  // Vitest (unit/smoke tests) — reads this same config so the React plugin and
  // resolution behave identically to the dev server. `globals` mirrors the
  // backend's jest idiom (describe/test/expect without imports); jsdom stands
  // in for the browser; setup.js adds jest-dom matchers + layout-API stubs.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
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
    // Split the heavy third-party libraries out of the entry chunk. recharts
    // (+ its d3/victory transitive deps) was the bulk of the old 786 KB
    // index-*.js; isolating it — plus the TanStack table/virtual stack and the
    // React runtime — keeps the main chunk small and lets the browser cache
    // each vendor group independently across releases.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Three vendor buckets. `charts` (recharts + its d3/victory transitive
        // deps) is the heavyweight and is only reached from the lazy Dashboard
        // and Timeline pages, so it never touches first paint. `table` is the
        // TanStack stack. Everything else — React, the router, axios — lands in
        // one `vendor` chunk; keeping React and react-router together (rather
        // than in separate buckets) avoids a circular chunk reference.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('recharts') ||
            id.includes('victory-vendor') ||
            id.includes('d3-')
          ) {
            return 'charts';
          }
          if (id.includes('@tanstack')) return 'table';
          return 'vendor';
        },
      },
    },
  },
});
