import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'client');

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
});
