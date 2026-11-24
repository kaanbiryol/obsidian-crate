// Shared by artifact checks and the browser smoke test. Limits are bytes, not characters.
// Each comment records the measurement behind its current limit; git keeps the history.
export const bundleBudgets = {
	plugin: [{
		path: 'dist/main.js',
		// Includes the compressed, integrity-checked Worker and PWA used by OAuth deployment.
		// Self-hosted server health, install-aware commands, pairing links, Reading image
		// and gist saving, Vault history's Deleted files view and chunked transfers for
		// self-hosted servers, plus readable connection and pairing errors, conflict review
		// links, the recovery key option when requesting keys and revoking replaced Cloudflare
		// logins, with checkpoints saved as change numbers, the PWA's flicker fixes, the reminder
		// completion animation, Reading title placeholders, errors with next steps and the
		// grouped connection options and the simplified reader header, measure 5.0267 MB raw /
		// 2.3235 MB gzip.
		maxBytes: 5026700,
		maxGzipBytes: 2323500,
	},
	{
		path: 'dist/styles.css',
		// Vault history's Deleted files view with Reading image highlights and their Highlights rows,
		// the reminder completion animation, Reading title placeholders, the failed article card and
		// the simplified reader header measure 403.7 KB raw / 50.3 KB gzip across the plugin and
		// shared PWA surfaces.
		maxBytes: 403700,
		maxGzipBytes: 50300,
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Server-side extraction for encrypted Reading drops Defuddle from the embedded PWA:
		// 4.043 MB raw / 1.294 MB gzip.
		maxBytes: 4085000,
		maxGzipBytes: 1307000,
	}, {
		path: '.generated/cloudflare/worker-self-hosted.mjs',
		// The server package's Worker: the deployable one plus chunked uploads and ranged
		// downloads, 4.019 MB raw / 1.282 MB gzip.
		maxBytes: 4085000,
		maxGzipBytes: 1307000,
	}],
	pwa: [{
		path: '.generated/cloudflare/pwa-client.json',
		assetName: 'app.js',
		// Every feature loads at startup. Reading article images (vault image loading,
		// encrypted image saves, offline copies, image highlights) and the advertised
		// server file and batch limits, with readable network errors, the Reading connection
		// view, held changes that keep lists and the reader from flickering, the reminder
		// completion animation, Reading title placeholders, recovery key errors with next
		// steps, the failed and pending article states, notice action rows, the simplified
		// reader header, measure 1.2206 MB raw / 400.0 KB gzip.
		maxBytes: 1220600,
		maxGzipBytes: 400000,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Reading article images, offline copies, image highlights and the advertised
		// server file and batch limits, with readable network errors, the Reading connection
		// view, held changes that keep lists and the reader from flickering, the reminder
		// completion animation, Reading title placeholders, recovery key errors with next
		// steps, the failed and pending article states, notice action rows, the simplified
		// reader header, measure 1.9423 MB raw / 641.3 KB gzip.
		maxBytes: 1942300,
		maxGzipBytes: 641300,
	}],
};
