import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const srcPath = new URL('./src', import.meta.url).pathname;
/** The one suite that runs the Worker the plugin deploys to Cloudflare. */
export const CLOUDFLARE_BUNDLE_TEST = 'src/cloudflare/worker/cloudflare-bundle.integration.ts';

// Every other Worker runtime suite runs the self-hosted bundle, the superset. This one runs
// `.generated/cloudflare/worker.mjs`, built without self-hosted features, as Cloudflare does.
export default defineConfig({
	define: { __CRATE_SELF_HOSTED__: 'false' },
	plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.cloudflare.jsonc' } })],
	resolve: { alias: { '@': srcPath } },
	test: {
		// This suite runs the built Worker; a stale build is rebuilt first.
		globalSetup: ['./scripts/worker-test-setup.mjs'],
		include: [CLOUDFLARE_BUNDLE_TEST],
		testTimeout: 20_000,
	},
});
