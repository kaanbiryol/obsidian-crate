// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Reading includes the local library, safe reader and compressed server extraction:
		// about 3.16 MB raw / 1.67 MB gzip, including Defuddle's full Markdown bundle.
		// Defuddle/DOM code runs only on the server. In-app backup restore adds
		// about 40 KB raw / 9 KB gzip; the combined plugin is about 3.29 MB / 1.72 MB.
		// Markdown source mapping and the embedded Highlights PWA bring this to
		// about 3.50 MB raw / 1.85 MB gzip. The reader uses no full DOM runtime.
		// Updated dependencies and shared controls: measured 3.64 MB raw / 1.94 MB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '3680000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '1960000', 10),
	},
	{
		path: 'dist/styles.css',
		// Shared controls, sync/history, responsive Reading panes, reader and sheets:
		// measured 267 KB raw / 34.5 KB gzip. The same styles ship to both hosts.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '270000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '35000', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Reading with Defuddle's upstream Markdown/math support and the PWA:
		// about 3.30 MB raw / 1.19 MB gzip, including the numbered shortcut setup and expanding navigation dock.
		// Source-preserving highlights and the deferred review UI: about 3.57 MB / 1.30 MB.
		// Updated dependencies and PWA controls measure 3.85 MB raw / 1.375 MB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '3900000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '1380000', 10),
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Includes React DOM and shared Base UI controls; measured 349 KB raw / 110 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_BUDGET_BYTES ?? '355000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_GZIP_BUDGET_BYTES ?? '110000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		startupAssets: true,
		// Unified settings, offline Reading fallback and complete loading chrome measure
		// 1.104 MB raw / 366.1 KB gzip with the updated dependencies and controls.
		// Retain a small, explicit growth margin.
		// Includes the editor and recovery UI for synchronous first-tap focus and offline use.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_BUDGET_BYTES ?? '1120000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_GZIP_BUDGET_BYTES ?? '375000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Includes deferred cache/session/outbox/draft and expired-operation recovery.
		// Reading and pairing stay deferred. Unified settings brings totals to
		// 1.208 MB raw / 404.6 KB gzip, including the shared control additions.
		// Deferred Markdown source mapping and highlight review: about 1.37 MB / 470 KB.
		// Expanded PWA article code highlighting: about 1.54 MB raw / 523 KB gzip.
		// Entry and startup budgets above remain unchanged.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '1570000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '540000', 10),
	}],
};
