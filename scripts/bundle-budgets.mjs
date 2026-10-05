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
		// 0.6.0 adds transcript playback, shared dialogs and native settings controls:
		// measured 5.592 MB raw / 2.812 MB gzip, including the embedded app.
		maxBytes: Number.parseInt(process.env.CRATE_MAIN_JS_BUDGET_BYTES ?? '5600000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_MAIN_JS_GZIP_BUDGET_BYTES ?? '2820000', 10),
	},
	{
		path: 'dist/styles.css',
		// Shared controls, sync/history, responsive Reading panes, reader and sheets:
		// Shared list styles, current activity controls and encryption UI measure
		// 308.2 KB raw / 40.1 KB gzip, including compact pairing states.
		// YouTube thumbnails add 1.8 KB raw / 0.22 KB gzip.
		// 0.6.0 shared dialogs, controls and transcript player styles measure
		// 384.3 KB raw / 46.8 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: Number.parseInt(process.env.CRATE_STYLES_BUDGET_BYTES ?? '390000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_STYLES_GZIP_BUDGET_BYTES ?? '47500', 10),
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Reading with Defuddle's upstream Markdown/math support and the PWA:
		// about 3.30 MB raw / 1.19 MB gzip, including the numbered shortcut setup and expanding navigation dock.
		// Source-preserving highlights and the deferred review UI: about 3.57 MB / 1.30 MB.
		// Full Reading E2EE includes deferred Defuddle and the inert DOM parser:
		// measured 5.24 MB raw / 1.80 MB gzip.
		// 0.6.0 playback and shared UI bring the embedded app to 5.389 MB raw;
		// gzip remains within the existing 1.85 MB ceiling.
		maxBytes: Number.parseInt(process.env.CRATE_WORKER_BUDGET_BYTES ?? '5400000', 10),
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
		// 0.6.0 settings and connection recovery: 1.157 MB raw / 392.7 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_BUDGET_BYTES ?? '1165000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_STARTUP_GZIP_BUDGET_BYTES ?? '397000', 10),
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
		// 0.6.0 transcript playback and shared UI: 2.897 MB raw / 951.1 KB gzip.
		maxBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_BUDGET_BYTES ?? '2910000', 10),
		maxGzipBytes: Number.parseInt(process.env.CRATE_PWA_TOTAL_GZIP_BUDGET_BYTES ?? '960000', 10),
	}],
};
