// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
// Each comment records the measurement behind its current limit; git keeps the history.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Server-side extraction for encrypted Reading drops Defuddle from the embedded PWA:
		// 4.922 MB raw / 2.292 MB gzip.
		maxBytes: 4972000,
		maxGzipBytes: 2316000,
	},
	{
		path: 'dist/styles.css',
		// 0.14.3 pending plugin rows and their detail pane measure
		// 392.0 KB raw / 48.6 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: 392500,
		maxGzipBytes: 48700,
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
		// Every feature loads at startup. Floating card sheets, reader menu motion and
		// held Reading section switches measure 1.191 MB raw / 390.9 KB gzip.
		maxBytes: 1192000,
		maxGzipBytes: 391500,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Importing Web Clipper highlight dates and notes measures 1.888 MB raw / 622.8 KB gzip.
		maxBytes: 1920000,
		maxGzipBytes: 634000,
	}],
};
