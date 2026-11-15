/**
 * Vite configuration for the India Manufacturing Atlas SPA.
 *
 * - React + Tailwind CSS v4 (via the official Vite plugin).
 * - `@/` resolves to `src/` (mirrors `paths` in tsconfig.app.json).
 * - Dev server on :5173 proxies `/api` to the FastAPI backend on :8000
 *   (override with env `ATLAS_API_TARGET`).
 * - `npm run build` emits `frontend/dist`, which FastAPI serves at `/`
 *   with an SPA fallback, so asset URLs stay root-relative (`base: '/'`).
 * - Heavy, rarely-changing libraries are split into their own chunks so
 *   pages stay small and the vendor chunks cache well.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.ATLAS_API_TARGET ?? 'http://127.0.0.1:8000';

/**
 * Named vendor chunk groups (Rolldown `codeSplitting.groups`). Only modules that are
 * actually reached by a lazily-loaded page end up in these chunks, so the shell stays light.
 */
const SEP = String.raw`[\\/]`;
const pkg = (names: string) => new RegExp(`node_modules${SEP}(?:${names})${SEP}`);

const vendorGroups = [
  { name: 'vendor-echarts', test: pkg('echarts|zrender') },
  { name: 'vendor-graph', test: pkg('cytoscape|cytoscape-dagre|dagre|@dagrejs|graphlib') },
  {
    name: 'vendor-markdown',
    test: pkg('react-markdown|remark-[^\\\\/]+|micromark[^\\\\/]*|mdast-[^\\\\/]+|hast-[^\\\\/]+|unified|unist-[^\\\\/]+|vfile[^\\\\/]*'),
  },
];

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: vendorGroups,
        },
      },
    },
  },
});
