import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The client is served by our own Node server (server/index.ts) — Vite runs in middleware
// mode during development, so there is no separate Vite dev server or port.
export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/..." -> client/src (also used by shadcn-registry components such as Rare UI).
    alias: { '@': fileURLToPath(new URL('./client/src', import.meta.url)) },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/**/*.test.ts'],
  },
});
