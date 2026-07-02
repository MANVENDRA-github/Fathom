import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The normalized schema lives in ../shared (imported by app/ and, later, server/).
// Alias it and allow the dev server to read one level up.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: { fs: { allow: ['..'] } },
});
