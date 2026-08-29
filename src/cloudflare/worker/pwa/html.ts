import { PWA_ASSET_VERSION } from '../pwa-version';
import { manifestHrefForUrl, PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from './pwa-params';
import { PWA_STYLES } from './styles';

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<style>
:root{--pwa-launch-bg:${PWA_CHROME_COLOR};background:${PWA_CHROME_COLOR};color-scheme:dark}
@media (prefers-color-scheme:light){:root{--pwa-launch-bg:${PWA_LIGHT_CHROME_COLOR};background:${PWA_LIGHT_CHROME_COLOR};color-scheme:light}}
</style>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="${PWA_LIGHT_CHROME_COLOR}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${PWA_CHROME_COLOR}" media="(prefers-color-scheme: dark)">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<title>Crate Reminders</title>
<style>
${PWA_STYLES}
</style>
</head>
<body>
	<div id="app"><div class="pwa-bootstrap-shell" role="status" aria-live="polite" aria-label="Loading reminders"><div class="pwa-loading-state is-visible" aria-hidden="true"><div class="pwa-skeleton-list"><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div></div></div><div class="pwa-bootstrap-tabs" aria-hidden="true"><span></span><span></span><span></span><span></span></div></div></div>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
