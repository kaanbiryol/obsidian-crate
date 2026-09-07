import { PWA_ASSET_VERSION } from '../pwa-version';
import { PWA_STARTUP_ASSETS } from '../pwa-client-bundle';
import { manifestHrefForUrl, PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from './pwa-params';
import { PWA_LIGHT_THEME_STYLES, PWA_STYLES } from './styles';
import {
	PWA_LIGHT_SCHEME_MEDIA,
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
} from '../../../pwa/theme';

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<style>
:root{--pwa-launch-bg:${PWA_CHROME_COLOR};color-scheme:dark}
html,body,#app{background-color:${PWA_CHROME_COLOR};color-scheme:dark}
@media ${PWA_LIGHT_SCHEME_MEDIA}{:root{--pwa-launch-bg:${PWA_LIGHT_CHROME_COLOR};color-scheme:light}html,body,#app{background-color:${PWA_LIGHT_CHROME_COLOR};color-scheme:light}}
</style>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta id="${PWA_THEME_COLOR_META_ID}" name="theme-color" content="${PWA_CHROME_COLOR}" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="${PWA_LIGHT_CHROME_COLOR}" media="${PWA_LIGHT_SCHEME_MEDIA}">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<title>Crate Reminders</title>
${PWA_STARTUP_ASSETS.filter(name => name !== 'app.js').map(name => `<link rel="modulepreload" href="/notifications/assets/${name}">`).join('\n')}
<style>
${PWA_STYLES}
</style>
<style id="${PWA_LIGHT_THEME_STYLE_ID}" media="${PWA_LIGHT_SCHEME_MEDIA}">
${PWA_LIGHT_THEME_STYLES}
</style>
	<script src="/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}"></script>
</head>
<body>
	<div id="pwa-update-transition" role="status" aria-live="polite">Updating Crate…</div>
	<div id="app"><div class="pwa-launch-splash" role="status" aria-label="Loading Crate"></div></div>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
