import { PWA_ASSET_VERSION } from '../pwa-version';
import { manifestHrefForUrl, PWA_CHROME_COLOR } from './pwa-params';
import { PWA_LIGHT_THEME_STYLES, PWA_STYLES } from './styles';
import {
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
} from '../../../pwa/theme';

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
</style>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta id="${PWA_THEME_COLOR_META_ID}" name="theme-color" content="${PWA_CHROME_COLOR}">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1206x2622.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1179x2556.png?v=${PWA_ASSET_VERSION}" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1206x2622.png?v=${PWA_ASSET_VERSION}" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1290x2796.png?v=${PWA_ASSET_VERSION}" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<title>Crate Reminders</title>
<style>
${PWA_STYLES}
</style>
<style id="${PWA_LIGHT_THEME_STYLE_ID}" media="not all">
${PWA_LIGHT_THEME_STYLES}
</style>
</head>
<body>
	<div id="app"><div class="pwa-bootstrap-shell" role="status" aria-live="polite" aria-label="Loading reminders"><div class="pwa-loading-state is-visible" aria-hidden="true"><div class="pwa-skeleton-list"><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div><div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div></div></div><div class="pwa-bootstrap-tabs" aria-hidden="true"><span></span><span></span><span></span><span></span></div></div></div>
	<script src="/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}"></script>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
