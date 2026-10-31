import { defineConfig } from 'vitest/config';
import { rawCssPlugin } from './scripts/vite/raw-css-vite-plugin.mjs';
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
		// Floors for the folders where a silently dropped test risks user data. They
		// sit just under current coverage: raise them as coverage grows, never lower them
		// to make a change pass. The Worker is covered by `test:worker-runtime` instead.
		coverage: {
			provider: 'v8',
			include: ['src/**/*.{ts,tsx}'],
			exclude: ['src/**/*.test.ts', 'src/test/**', 'src/**/*.d.ts'],
			thresholds: {
				'src/sync/**': { statements: 86, branches: 80, functions: 85, lines: 89 },
				'src/encryption/**': { statements: 76, branches: 76, functions: 86, lines: 81 },
				'src/protocol/**': { statements: 94, branches: 89, functions: 97, lines: 97 },
				'src/reminders/core/**': { statements: 93, branches: 88, functions: 95, lines: 95 },
			},
		},
	},
});
