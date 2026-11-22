// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
// Each comment records the measurement behind its current limit; git keeps the history.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Self-hosted server health, install-aware commands, pairing links and
		// Reading image and gist saving measure 4.996 MB raw / 2.315 MB gzip.
		maxBytes: 4997000,
		maxGzipBytes: 2316000,
	},
	{
		path: 'dist/styles.css',
		// The Recently deleted list with Reading image highlights and their Highlights rows
		// measure 395.5 KB raw / 49.0 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: 396000,
		maxGzipBytes: 49100,
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Server-side extraction for encrypted Reading drops Defuddle from the embedded PWA:
		// 4.043 MB raw / 1.294 MB gzip.
		maxBytes: 4085000,
		maxGzipBytes: 1307000,
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Every feature loads at startup. Reading article images (vault image loading,
		// encrypted image saves, offline copies, image highlights) measure 1.205 MB raw / 395.2 KB gzip.
		maxBytes: 1205500,
		maxGzipBytes: 395500,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Reading article images, offline copies and image highlights measure 1.925 MB raw / 636.0 KB gzip.
		maxBytes: 1926000,
		maxGzipBytes: 636500,
	}],
};
