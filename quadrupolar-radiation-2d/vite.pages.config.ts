import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, 'github-pages'),
  base: '/Electromagnetisme/quadrupolar-radiation-2d/',
  publicDir: path.join(projectRoot, 'public'),
  resolve: {
    alias: {
      '@': projectRoot,
    },
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  build: {
    outDir: path.join(projectRoot, 'dist/pages'),
    emptyOutDir: true,
  },
});
