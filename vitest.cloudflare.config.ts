import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readingExtractionVitePlugin } from './scripts/reading-extraction-build.mjs';
import { CLOUDFLARE_BUNDLE_TEST } from './vitest.cloudflare-bundle.config';

const srcPath = new URL('./src', import.meta.url).pathname;

export default defineConfig({
	// The self-hosted Worker, the superset; the Cloudflare build is checked by build-worker.
	define: { __CRATE_SELF_HOSTED__: 'true' },
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
		// Durable Objects run the built Worker; a stale build is rebuilt first.
		globalSetup: ['./scripts/worker-test-setup.mjs'],
		setupFiles: ['./src/test/setup-byte-equality.ts'],
		include: ['src/cloudflare/**/*.integration.ts'],
		// Runs against the Cloudflare bundle in vitest.cloudflare-bundle.config.ts.
		exclude: [CLOUDFLARE_BUNDLE_TEST],
		// The first test in a file pays for loading the Worker and Defuddle (about 2.3 s on CI).
		// A timed-out body keeps writing into the next test, so leave real headroom.
		testTimeout: 20_000,
	},
});
