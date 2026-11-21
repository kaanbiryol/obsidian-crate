// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
// Each comment records the measurement behind its current limit; git keeps the history.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Self-hosted server health, install-aware commands, pairing links, Reading image
		// and gist saving and Vault history's Deleted files view measure 5.000 MB raw / 2.312 MB gzip.
		maxBytes: 5000500,
		maxGzipBytes: 2316000,
	},
	{
		path: 'dist/styles.css',
		// Vault history's Deleted files view with Reading image highlights and their Highlights rows
		// measure 399.1 KB raw / 49.4 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: 399200,
		maxGzipBytes: 49500,
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
		// encrypted image saves, offline copies, image highlights) and the advertised
		// server file limit measure 1.2055 MB raw / 395.5 KB gzip.
		maxBytes: 1205600,
		maxGzipBytes: 395500,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Reading article images, offline copies, image highlights and the advertised
		// server file limit measure 1.926 MB raw / 636.4 KB gzip.
		maxBytes: 1926100,
		maxGzipBytes: 636500,
	}],
};
