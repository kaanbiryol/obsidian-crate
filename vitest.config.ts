import { defineConfig } from 'vitest/config';
import { rawCssPlugin } from './scripts/raw-css-vite-plugin.mjs';
import { bundleServiceWorkerRuntime } from './scripts/service-worker-build.mjs';

const srcPath = new URL('./src', import.meta.url).pathname;
const obsidianMockPath = new URL('./src/test/mocks/obsidian.ts', import.meta.url).pathname;

const serviceWorkerRuntime = await bundleServiceWorkerRuntime(import.meta.dirname);

export default defineConfig({
	define: { __CRATE_SERVICE_WORKER_JS__: JSON.stringify(serviceWorkerRuntime.script) },
	plugins: [rawCssPlugin()],
	resolve: {
		alias: {
			'@': srcPath,
			'src': srcPath,
			'obsidian': obsidianMockPath,
		},
	},
	test: {
		setupFiles: ['./src/test/setup-byte-equality.ts'],
		include: ['src/**/*.test.ts'],
	},
});
