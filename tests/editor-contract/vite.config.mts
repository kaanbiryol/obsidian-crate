import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('tests/editor-contract'),
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  resolve: { alias: { '@': resolve('src') } },
  server: { host: '127.0.0.1', port: 8791, strictPort: true, fs: { allow: [process.cwd()] } },
});
