import { defineConfig } from 'vitest/config';

const srcPath = new URL('./src', import.meta.url).pathname;
const obsidianMockPath = new URL('./src/test/mocks/obsidian.ts', import.meta.url).pathname;

export default defineConfig({
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
