import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The normalized schema lives in ../shared (imported by app/ and, later, server/).
// Alias it and allow the dev server to read one level up.
export default defineConfig({
  // Relative base so the built bundle works both at a host root and under a
  // subpath (GitHub Pages serves at /Fathom/). BASE_URL becomes './', so the
  // replay-data fetch (App.tsx) resolves correctly wherever it's mounted, and
  // the local recorder can serve app/dist at root unchanged. Fathom routes only
  // via query params (?source/?view), so relative base has no downside.
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: { fs: { allow: ['..'] } },
});
