import { defineConfig } from 'vite';
// Relative base so the built viewer works from GitHub Pages sub-paths and from the local server.
export default defineConfig({ base: './', worker: { format: 'es' }, build: { outDir: 'dist', chunkSizeWarningLimit: 2000 } });
