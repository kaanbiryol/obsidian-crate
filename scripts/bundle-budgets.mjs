// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Shared navigation and reader highlighting measured 3.82 MB / 2.00 MB gzip.
		// Direct desktop capture bundles Defuddle and its inert DOM parser locally:
		// measured 4.74 MB raw / 2.28 MB gzip. Extraction initializes on demand.
		// Full Reading E2EE adds the browser extractor to the embedded Worker/PWA:
		// measured 5.41 MB raw / 2.74 MB gzip; extraction stays deferred.
		// Durable rename checkpoints and legacy capture recovery add about 10 KB.
		// Authenticated PWA folder following adds about 4.5 KB; measured 5.493 MB raw.
		// Encrypted app approval adds the plugin dialog, relay and shared WebCrypto:
		// measured 5.516 MB raw. YouTube metadata, browser lookup and video UI
		// bring the total to 5.526 MB raw / 2.780 MB gzip; retain a small margin.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '5530000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '2785000', 10),
	},
	{
		path: 'dist/styles.css',
		// Shared controls, sync/history, responsive Reading panes, reader and sheets:
		// Shared list styles, current activity controls and encryption UI measure
		// 308.2 KB raw / 40.1 KB gzip, including compact pairing states.
		// YouTube thumbnails add 1.8 KB raw / 0.22 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '310500', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '40500', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Reading with Defuddle's upstream Markdown/math support and the PWA:
		// about 3.30 MB raw / 1.19 MB gzip, including the numbered shortcut setup and expanding navigation dock.
		// Source-preserving highlights and the deferred review UI: about 3.57 MB / 1.30 MB.
		// Full Reading E2EE includes deferred Defuddle and the inert DOM parser:
		// measured 5.24 MB raw / 1.80 MB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '5340000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_WORKER_GZIP_BUDGET_BYTES ?? '1850000', 10),
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Includes React DOM, shared controls and encryption bootstrap: 355 KB raw / 112 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_BUDGET_BYTES ?? '360000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_ENTRY_GZIP_BUDGET_BYTES ?? '113000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		startupAssets: true,
		// Unified settings, offline Reading fallback and complete loading chrome measure
		// 1.141 MB raw / 380 KB gzip with shared encryption cleanup and settings.
		// App approval adds about 4 KB gzip; measured 387.1 KB including the
		// shared connection gate. Retain a small, explicit growth margin.
		// Includes the editor and recovery UI for synchronous first-tap focus and offline use.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_BUDGET_BYTES ?? '1150000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_GZIP_BUDGET_BYTES ?? '390000', 10),
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Includes deferred cache/session/outbox/draft and expired-operation recovery.
		// Reading and shortcut pairing stay deferred. Unified settings brings totals to
		// 1.208 MB raw / 404.6 KB gzip, including the shared control additions.
		// Deferred Markdown source mapping and highlight review: about 1.37 MB / 470 KB.
		// Expanded PWA article code highlighting: about 1.54 MB raw / 523 KB gzip.
		// Full Reading E2EE adds client article extraction (deferred, inert DOM):
		// measured 2.81 MB raw / 916.3 KB gzip across all assets.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '2880000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '940000', 10),
	}],
};
