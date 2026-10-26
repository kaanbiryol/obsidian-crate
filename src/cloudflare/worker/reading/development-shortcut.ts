import statusStyles from '../../../../site/assets/status.css?raw-css';
import { DEVELOPMENT_SHORTCUT_FILE_PATH } from '@/reading/shortcut';

declare const __CRATE_DEVELOPMENT_SHORTCUT__: string | null | undefined;
export const DEVELOPMENT_SHORTCUT = typeof __CRATE_DEVELOPMENT_SHORTCUT__ === 'string' ? __CRATE_DEVELOPMENT_SHORTCUT__ : null;

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

// iOS shows a blank page when a new tab opens the file directly, so like the
// published download, a page offers the file behind a link the user selects.
export function developmentShortcutPage(encoded = DEVELOPMENT_SHORTCUT): Response | null {
	if (!encoded) return null;
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Save to Crate (development)</title><style>${statusStyles}</style></head>
<body><main><div class="brand-lockup"><img src="/notifications/crate-mark-256.png" alt="Crate"></div><section><h1>Save to Crate</h1>
<p class="status-copy">Development build signed from your working tree.</p>
<a class="button" href="${DEVELOPMENT_SHORTCUT_FILE_PATH}">Download shortcut</a>
<p class="helper">Safari may take a few seconds to ask, then saves the file to <strong>Downloads</strong>. Open it from the download icon in the address bar or from <strong>Files → Downloads</strong>, select <strong>Add Shortcut</strong>, then return to Crate to create a pairing code.</p></section></main></body></html>`, {
		headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
	});
}

/** Only development builds embed a locally signed shortcut; release Workers return null. */
export function developmentShortcutResponse(encoded = DEVELOPMENT_SHORTCUT): Response | null {
	if (!encoded) return null;
	return new Response(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), {
		headers: { ...headers, 'Content-Type': 'application/octet-stream' },
	});
}
