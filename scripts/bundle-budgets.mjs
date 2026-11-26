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
		// grouped connection options, the simplified reader header and the Reading change feed with
		// stored tag counts and its scale fixes, measure 5.0356 MB raw / 2.3297 MB gzip. Lexical 0.53,
		// Motion 14.14, Marked 18.3 and Defuddle 0.19.13 bring it to 5.0960 MB raw / 2.3626 MB gzip.
		// Linkedom 0.18.15, whose CSSOM parser Defuddle reads stylesheets through, and the larger
		// embedded Worker bring it to 5.3489 MB raw / 2.4508 MB gzip.
		maxBytes: 5349000,
		maxGzipBytes: 2450800,
	},
	{
		path: 'dist/styles.css',
		// Vault history's Deleted files view with Reading image highlights and their Highlights rows,
		// the reminder completion animation, Reading title placeholders, the failed article card and
		// the simplified reader header and off-screen library Highlights rows measure 404.0 KB raw / 50.3 KB
		// gzip across the plugin and shared PWA surfaces. Tailwind 4.3.5 brings it to 404.2 KB raw.
		maxBytes: 404200,
		maxGzipBytes: 50300,
	}],
	worker: [{
		path: '.generated/cloudflare/worker.mjs',
		// The deployable Worker embeds the complete reminders PWA assets.
		// Server-side extraction for encrypted Reading drops Defuddle from the embedded PWA:
		// 4.043 MB raw / 1.294 MB gzip. The Lexical, Motion, Marked and Defuddle updates bring it to
		// 4.100 MB raw / 1.311 MB gzip. Linkedom 0.18.15 and web-push 4 bring it to 4.2789 MB raw /
		// 1.3563 MB gzip.
		maxBytes: 4279000,
		maxGzipBytes: 1356400,
	}, {
		path: '.generated/cloudflare/worker-self-hosted.mjs',
		// The server package's Worker: the deployable one plus chunked uploads and ranged
		// downloads, 4.107 MB raw / 1.313 MB gzip after the Lexical, Motion, Marked and Defuddle updates.
		// Linkedom 0.18.15 and web-push 4 bring it to 4.2861 MB raw / 1.3584 MB gzip.
		maxBytes: 4286200,
		maxGzipBytes: 1358500,
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
		// reader header, Reading changes applied to loaded pages, released images and cancelled
		// searches, measure 1.2256 MB raw / 401.7 KB gzip. Lexical 0.53 and Motion 14.14 bring it to
		// 1.2335 MB raw / 404.9 KB gzip.
		maxBytes: 1233500,
		maxGzipBytes: 404900,
	}, {
		path: '.generated/cloudflare/pwa-client.json',
		allAssets: true,
		// Reading article images, offline copies, image highlights and the advertised
		// server file and batch limits, with readable network errors, the Reading connection
		// view, held changes that keep lists and the reader from flickering, the reminder
		// completion animation, Reading title placeholders, recovery key errors with next
		// steps, the failed and pending article states, notice action rows, the simplified
		// reader header, Reading changes applied to loaded pages, released images and cancelled
		// searches, measure 1.9474 MB raw / 643.0 KB gzip. Lexical 0.53, Motion 14.14 and Marked 18.3
		// bring it to 1.9769 MB raw / 654.6 KB gzip; Lucide 1.81 adds a few bytes of gzip.
		maxBytes: 1976900,
		maxGzipBytes: 654700,
	}],
};
