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
		// 0.6.0 shared dialogs, controls and transcript player styles measure
		// 384.3 KB raw / 46.8 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: 390000,
		maxGzipBytes: 47500,
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
		// Every feature loads at startup. Server-side extraction for encrypted Reading
		// removes Defuddle: 1.143 MB raw / 372.5 KB gzip.
		maxBytes: 1160000,
		maxGzipBytes: 380000,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Server-side extraction for encrypted Reading removes Defuddle: 1.864 MB raw / 613.0 KB gzip.
		maxBytes: 1890000,
		maxGzipBytes: 622000,
	}],
};
