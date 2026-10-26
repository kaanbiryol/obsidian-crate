import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readingExtractionVitePlugin } from './scripts/reading-extraction-build.mjs';

const srcPath = new URL('./src', import.meta.url).pathname;

export default defineConfig({
	plugins: [
		// Match the Worker build's Defuddle adapter so extraction runs as deployed.
		readingExtractionVitePlugin(),
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
		setupFiles: ['./src/test/setup-byte-equality.ts'],
		include: ['src/cloudflare/worker/**/*.integration.ts'],
		// The first test in a file pays for loading the Worker and Defuddle (about 2.3 s on CI).
		// A timed-out body keeps writing into the next test, so leave real headroom.
		testTimeout: 20_000,
	},
});
