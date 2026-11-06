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
		// 0.12.0 onboarding checklist and dialog spacing styles measure
		// 385.8 KB raw / 47.8 KB gzip across the plugin and shared PWA surfaces.
		maxBytes: 390000,
		maxGzipBytes: 48500,
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
		// Every feature loads at startup. Deleting Reading articles and reader sync
		// feedback in the web app measure 1.166 MB raw / 380.3 KB gzip.
		maxBytes: 1185000,
		maxGzipBytes: 388000,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Importing Web Clipper highlight dates and notes measures 1.888 MB raw / 622.8 KB gzip.
		maxBytes: 1920000,
		maxGzipBytes: 634000,
	}],
};
