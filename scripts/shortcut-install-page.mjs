import { shortcutName } from './shortcut-release.mjs';

/** Only the release downloader may mark an artifact available, after verification. */
export function shortcutInstallPage(available) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">
<title>Save to Crate for iPhone</title><link rel="stylesheet" href="/assets/callback.css"></head>
<body><main><a class="brand-lockup" href="/"><img src="/assets/logo.png" alt="">Crate</a>
<section class="card"><h1>Save to Crate</h1>
${available ? `<p class="status-copy">Save links from your iPhone share sheet. Works with encrypted vaults.</p>
<a class="button" href="./${encodeURIComponent(shortcutName)}">Download shortcut</a>
<p class="helper">Requires iOS 27 or later. Select <strong>Add Shortcut</strong>, then return to Crate to create a pairing code.</p>`
    : `<p class="status-copy">The new iPhone shortcut is not available yet.</p>
<p class="helper">For now, open <strong>Reading</strong> in Crate and select <strong>Save a link</strong>. Check this page again after the next release.</p>`}
</section></main></body></html>`;
}
