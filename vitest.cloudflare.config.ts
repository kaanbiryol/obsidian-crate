import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const srcPath = new URL('./src', import.meta.url).pathname;

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	resolve: {
		alias: {
			'@': srcPath,
			'obsidian': new URL('./src/test/mocks/obsidian.ts', import.meta.url).pathname,
		},
	},
	test: {
		include: ['src/cloudflare/worker/**/*.integration.ts'],
	},
});
