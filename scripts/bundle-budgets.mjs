// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Shared Base UI controls: about 2.061 MB raw / 1.055 MB gzip, including embedded PWA assets.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '2100000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '1080000', 10),
	},
	{
		path: 'dist/styles.css',
		// Base UI controls: about 170 KB raw / 24 KB gzip, including the shared React UI
		// and sync file browser. Keep a small margin for subsequent changes.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '172000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '24500', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Shared Base UI baseline: about 1.707 MB raw / 713 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '1740000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '730000', 10),
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Includes React DOM and shared Base UI controls; about 336 KB raw / 106 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_BUDGET_BYTES ?? '345000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_GZIP_BUDGET_BYTES ?? '108000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		startupAssets: true,
		// Startup graph with shared Base UI controls: about 758 KB raw / 251 KB gzip.
		// Includes the editor and recovery UI for synchronous first-tap focus and offline use.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_BUDGET_BYTES ?? '775000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_GZIP_BUDGET_BYTES ?? '258000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Includes deferred cache/session/outbox/draft and expired-operation recovery.
		// Shared Base UI baseline: about 808 KB raw / 270 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '825000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '275000', 10),
	}],
};
