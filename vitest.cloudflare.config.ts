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
		},
	},
	test: {
		include: ['src/cloudflare/worker/**/*.integration.ts'],
	},
});
