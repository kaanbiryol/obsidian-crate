import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';
import { rawCssPlugin } from './scripts/raw-css-vite-plugin.mjs';

export default defineConfig({
  root: resolve('tests/visual/gallery'),
  plugins: [rawCssPlugin(), preact()],
  css: { postcss: { plugins: [] } },
  resolve: { alias: { '@': resolve('src') } },
  server: { host: '127.0.0.1', port: 8790, strictPort: true, fs: { allow: [process.cwd()] } },
});
