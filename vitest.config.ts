import { defineConfig } from 'vitest/config';
import { rawCssPlugin } from './scripts/raw-css-vite-plugin.mjs';

const srcPath = new URL('./src', import.meta.url).pathname;
const obsidianMockPath = new URL('./src/test/mocks/obsidian.ts', import.meta.url).pathname;

export default defineConfig({
	plugins: [rawCssPlugin()],
	resolve: {
		alias: {
			'@': srcPath,
			'src': srcPath,
			'obsidian': obsidianMockPath,
		},
	},
	test: {
		include: ['src/**/*.test.ts'],
	},
});
