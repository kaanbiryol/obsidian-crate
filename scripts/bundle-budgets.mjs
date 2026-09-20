// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Lexical editor plus embedded Worker/PWA: about 2.35 MB raw / 1.19 MB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '2400000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '1220000', 10),
	},
	{
		path: 'dist/styles.css',
		// 0.3.0 shared controls, sync/conflict review and file history:
		// about 212 KB raw / 28 KB gzip. Keep a small margin for subsequent changes.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '225000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '30000', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Lexical PWA baseline: about 1.914 MB raw / 780 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '1950000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '800000', 10),
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Includes React DOM and shared Base UI controls; about 343 KB raw / 109 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_BUDGET_BYTES ?? '345000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_GZIP_BUDGET_BYTES ?? '110000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		startupAssets: true,
		// Startup graph with Lexical: about 963 KB raw / 318 KB gzip.
		// Includes the editor and recovery UI for synchronous first-tap focus and offline use.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_BUDGET_BYTES ?? '985000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_GZIP_BUDGET_BYTES ?? '326000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Includes deferred cache/session/outbox/draft and expired-operation recovery.
		// Lexical baseline: about 1.012 MB raw / 336 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '1040000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '345000', 10),
	}],
};
