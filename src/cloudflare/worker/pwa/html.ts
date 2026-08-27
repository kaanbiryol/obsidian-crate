import { PWA_ASSET_VERSION } from '../pwa-version';
import { manifestHrefForUrl, PWA_CHROME_COLOR } from './pwa-params';
import { PWA_STYLES } from './styles';

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="${PWA_CHROME_COLOR}">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<link rel="preload" as="image" href="/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1179x2556.png?v=${PWA_ASSET_VERSION}" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1290x2796.png?v=${PWA_ASSET_VERSION}" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<title>Crate Reminders</title>
<style>
${PWA_STYLES}
</style>
</head>
	<body>
	<div id="app"><div class="auth-card auth-card--loading" role="status" aria-live="polite" aria-label="Loading reminders"><div class="auth-loading__mark-stage" aria-hidden="true"><img src="/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}" alt=""></div></div></div>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
